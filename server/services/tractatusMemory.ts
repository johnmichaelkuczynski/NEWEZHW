/**
 * Tractatus Memory Module
 *
 * The SINGLE owner of all Tractatus tiered-memory operations. No other module
 * is permitted to read or write the tractatus tier/archive tables directly —
 * everything goes through this module. This is what keeps the load-bearing
 * invariants (REJECTS / CONFLICT_FLAG survival, anti-sycophancy, archive-before-
 * compression) intact across the whole application.
 *
 * Implements the TRACTATUS-SKELETON FUSION architecture:
 *   - Tier 0 = Skeleton (immutable, never truncated)
 *   - Tier 1 = Live accumulator (grows as chunks complete)
 *   - Tier 2+ = Recursively compressed summaries of older tiers
 *
 * Intermediate state persisted to Neon Postgres. Tables are cc_-prefixed to
 * avoid collision with the project-scoped `tractatus_archive` drizzle table.
 *
 * LLM access is injected (callLLM) so this module has no dependency on, and no
 * circular import with, ccService.
 */

import { pool } from '../db';

// ============================================================================
// FEATURE FLAG
// ============================================================================

export function isTractatusEnabled(): boolean {
  return process.env.TRACTATUS_MEMORY_ENABLED !== 'false';
}

// ============================================================================
// ANTI-SYCOPHANCY BLOCK  (verbatim — used identically in 3 prompt sites)
// ============================================================================

export const ANTI_SYCOPHANCY_CLAUSES = `ANTI_SYCOPHANCY_CLAUSES:
- Preserve every REJECTS entry verbatim. Do not soften, qualify, or
  convert a REJECTS into an OPEN.
- Preserve every numerical value, date, proper name, citation, and
  quoted phrase exactly as it appears.
- If two entries contradict, do not silently merge them. Emit a
  CONFLICT_FLAG entry that quotes both.
- Defeats, negative results, and counterexamples are load-bearing.
  They cost more to preserve than positive claims. Preserve them
  anyway.
- You are not being graded on smoothness, harmony, or readability.
  You are being graded on whether the tier you emit can be used to
  detect a hallucination two chunks from now.`;

// ============================================================================
// CONSTANTS
// ============================================================================

const TIER_BUDGETS: Record<number, number> = { 0: 6000, 1: 5000, 2: 2500 };
const DEEP_TIER_BUDGET = 1500; // total across tiers 3+
const TOTAL_BUDGET = 15000;

const COMPRESS_THRESHOLD: Record<number, number> = { 1: 150, 2: 200, 3: 250 };
const TRIM_RECENT = 30;       // nodes retained on a source tier after compression
const MAX_COMPRESS_NODES = 80;
const COMPRESS_TOKENS = 8192;

type LLMCall = (system: string, user: string, maxTokens: number) => Promise<string>;
type Tree = Record<string, string>;

// ============================================================================
// TABLE INITIALIZATION
// ============================================================================

let tablesReady = false;

export async function ensureTractatusTables(): Promise<void> {
  if (tablesReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_tractatus_tiers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id UUID NOT NULL,
        job_type TEXT NOT NULL DEFAULT 'cc',
        tier INTEGER NOT NULL,
        tree JSONB NOT NULL DEFAULT '{}',
        node_count INTEGER NOT NULL DEFAULT 0,
        parent_tier_id UUID,
        compression_count INTEGER NOT NULL DEFAULT 0,
        last_update TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_tractatus_archive (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id UUID NOT NULL,
        job_type TEXT NOT NULL DEFAULT 'cc',
        tier INTEGER NOT NULL,
        tree_snapshot JSONB NOT NULL,
        node_count_at_snapshot INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cc_tiers_job ON cc_tractatus_tiers(job_id, job_type, tier)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cc_tractatus_archive_job ON cc_tractatus_archive(job_id, job_type, created_at)`);
    tablesReady = true;
    console.log('[TRACTATUS] Memory tables ready');
  } catch (err: any) {
    console.error('[TRACTATUS] Table init error:', err.message);
    tablesReady = false;
  }
}

// ============================================================================
// LOAD-BEARING DETECTION
// ============================================================================

/** REJECTS and CONFLICT_FLAG nodes are never evicted and never dropped. */
function isLoadBearing(value: string): boolean {
  const v = value.toUpperCase();
  return v.includes('REJECTS') || v.includes('CONFLICT_FLAG');
}

function countTag(tree: Tree, tag: string): number {
  return Object.values(tree).filter(v => v.toUpperCase().includes(tag)).length;
}

/**
 * Next monotonic node-id suffix for a tier. Must use max(existing)+1, NOT
 * Object.keys().length: after compression trims a tier to sparse keys (e.g.
 * 1.120..1.149 + load-bearing), a length-based counter would collide with and
 * overwrite existing nodes, silently losing memory.
 */
function nextSeq(tree: Tree, tier: number): number {
  const re = new RegExp(`^${tier}\\.(\\d+)$`);
  let max = -1;
  for (const k of Object.keys(tree)) {
    const m = k.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

// ============================================================================
// TIER PERSISTENCE (raw SQL — this module is the only writer)
// ============================================================================

async function getTier(
  jobId: string,
  jobType: string,
  tier: number
): Promise<{ id: string; tree: Tree; nodeCount: number; compressionCount: number } | null> {
  const r = await pool.query(
    `SELECT id, tree, node_count, compression_count FROM cc_tractatus_tiers
     WHERE job_id=$1 AND job_type=$2 AND tier=$3 LIMIT 1`,
    [jobId, jobType, tier]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: row.id,
    tree: (row.tree as Tree) || {},
    nodeCount: row.node_count ?? 0,
    compressionCount: row.compression_count ?? 0,
  };
}

async function upsertTier(
  jobId: string,
  jobType: string,
  tier: number,
  tree: Tree,
  opts: { parentTierId?: string | null; compressionCount?: number } = {}
): Promise<void> {
  const nodeCount = Object.keys(tree).length;
  const existing = await getTier(jobId, jobType, tier);
  if (existing) {
    await pool.query(
      `UPDATE cc_tractatus_tiers
       SET tree=$1, node_count=$2, compression_count=COALESCE($3, compression_count), last_update=NOW()
       WHERE id=$4`,
      [JSON.stringify(tree), nodeCount, opts.compressionCount ?? null, existing.id]
    );
  } else {
    await pool.query(
      `INSERT INTO cc_tractatus_tiers (job_id, job_type, tier, tree, node_count, parent_tier_id, compression_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [jobId, jobType, tier, JSON.stringify(tree), nodeCount, opts.parentTierId ?? null, opts.compressionCount ?? 0]
    );
  }
}

async function archiveTier(
  jobId: string,
  jobType: string,
  tier: number,
  tree: Tree,
  reason: string
): Promise<void> {
  // Snapshot first. If this throws, the caller aborts — no compression without archive.
  await pool.query(
    `INSERT INTO cc_tractatus_archive (job_id, job_type, tier, tree_snapshot, node_count_at_snapshot, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [jobId, jobType, tier, JSON.stringify(tree), Object.keys(tree).length, reason]
  );
}

// ============================================================================
// TIER 0 — SKELETON
// ============================================================================

/**
 * Converts the extracted skeleton into immutable Tier 0 nodes. Handles the CC
 * skeleton shape: { thesis, outline[], keyTerms{}, commitmentLedger[] (already
 * "TAG: ..." strings), entities[] }.
 */
export async function skeletonToTier0(
  jobId: string,
  skeleton: any,
  jobType: string = 'cc'
): Promise<void> {
  if (!isTractatusEnabled()) return;
  const tree: Tree = {};

  if (skeleton?.thesis) tree['0.0'] = `ASSERTS: ${skeleton.thesis}`;

  const outline: string[] = Array.isArray(skeleton?.outline) ? skeleton.outline : [];
  outline.forEach((o, i) => { tree[`0.1.${i}`] = `OUTLINE: ${o}`; });

  const keyTerms = skeleton?.keyTerms || {};
  Object.entries(keyTerms).forEach(([term, def], i) => {
    tree[`0.2.${i}`] = `KEY_TERM: "${term}" = ${def}`;
  });

  const ledger: string[] = Array.isArray(skeleton?.commitmentLedger) ? skeleton.commitmentLedger : [];
  ledger.forEach((entry, i) => {
    // Entries already carry their tag (ASSERTS:/REJECTS:/ASSUMES:). Preserve verbatim.
    const e = String(entry).trim();
    tree[`0.3.${i}`] = /^(ASSERTS|REJECTS|ASSUMES|OPEN|CONFLICT_FLAG)/i.test(e) ? e : `ASSUMES: ${e}`;
  });

  const entities: string[] = Array.isArray(skeleton?.entities) ? skeleton.entities : [];
  entities.forEach((ent, i) => { tree[`0.4.${i}`] = `ENTITY: ${ent}`; });

  await upsertTier(jobId, jobType, 0, tree);
  // Initialize an empty live tier so updateLiveTier always has a target.
  if (!(await getTier(jobId, jobType, 1))) {
    await upsertTier(jobId, jobType, 1, {});
  }
  console.log(`[TRACTATUS] Tier 0 seeded: ${Object.keys(tree).length} nodes (${countTag(tree, 'REJECTS')} REJECTS)`);
}

// ============================================================================
// TIER 1 — LIVE UPDATE
// ============================================================================

interface ChunkDelta {
  newClaims?: string[];
  termsUsed?: string[];
  conflicts?: string;
}

/**
 * Appends a completed chunk's delta to the live tier (Tier 1). Returns the new
 * node count and whether a compression was triggered. Never mutates prior nodes.
 */
export async function updateLiveTier(
  jobId: string,
  delta: ChunkDelta,
  callLLM: LLMCall,
  jobType: string = 'cc'
): Promise<{ nodeCount: number; compressed: boolean }> {
  if (!isTractatusEnabled()) return { nodeCount: 0, compressed: false };

  const live = (await getTier(jobId, jobType, 1)) || { tree: {} as Tree };
  const tree: Tree = { ...live.tree };
  let seq = nextSeq(tree, 1);

  for (const claim of delta.newClaims || []) {
    const c = String(claim).trim();
    if (c) tree[`1.${seq++}`] = `ASSERTS: ${c}`;
  }

  const conflicts = (delta.conflicts || '').trim();
  if (conflicts && conflicts.toLowerCase() !== 'none' && conflicts !== '[]') {
    tree[`1.${seq++}`] = `CONFLICT_FLAG: ${conflicts}`;
  }

  const terms = (delta.termsUsed || []).filter(Boolean);
  if (terms.length > 0) {
    tree[`1.${seq++}`] = `CROSS_REF: terms used — ${terms.join(', ')}`;
  }

  await upsertTier(jobId, jobType, 1, tree);

  let compressed = false;
  if (Object.keys(tree).length >= (COMPRESS_THRESHOLD[1] ?? 150)) {
    compressed = await compressTier(jobId, 1, callLLM, jobType);
  }

  return { nodeCount: Object.keys(tree).length, compressed };
}

// ============================================================================
// COMPRESSION
// ============================================================================

function renderTreeFlat(tree: Tree): string {
  return Object.entries(tree).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function parseNodesDefensive(raw: string): Tree | null {
  let txt = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) txt = m[0];
  try {
    const obj = JSON.parse(txt);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out: Tree = {};
      for (const [k, v] of Object.entries(obj)) out[String(k)] = String(v);
      return out;
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Compress sourceTier into sourceTier+1. Transactional order:
 *   1. Snapshot to archive (abort if it fails — no compression without archive)
 *   2. Render flat, call LLM with anti-sycophancy clauses (<=80 nodes JSON)
 *   3. Parse defensively (retry once, else abort leaving source untouched)
 *   4. Merge/insert into next tier, preserving ALL load-bearing nodes
 *   5. Trim source to its 30 most recent nodes (load-bearing always kept)
 *   6. Recurse if the merged higher tier crosses its own threshold
 */
export async function compressTier(
  jobId: string,
  sourceTier: number,
  callLLM: LLMCall,
  jobType: string = 'cc'
): Promise<boolean> {
  if (!isTractatusEnabled()) return false;

  const source = await getTier(jobId, jobType, sourceTier);
  if (!source || Object.keys(source.tree).length === 0) return false;
  const sourceTree = source.tree;

  // 1. Snapshot first — abort entirely if the archive write fails.
  try {
    await archiveTier(jobId, jobType, sourceTier, sourceTree, 'pre_compression');
  } catch (err: any) {
    console.error(`[TRACTATUS] Archive failed for tier ${sourceTier}; aborting compression: ${err.message}`);
    return false;
  }

  const rejectsBefore = countTag(sourceTree, 'REJECTS');
  const conflictsBefore = countTag(sourceTree, 'CONFLICT_FLAG');

  // 2 + 3. Compress via LLM, defensive parse + one retry.
  const system = `You are compressing a memory tier of a long document into fewer nodes WITHOUT losing load-bearing information.

${ANTI_SYCOPHANCY_CLAUSES}

Emit AT MOST ${MAX_COMPRESS_NODES} nodes as a flat JSON object of "key": "value" pairs, where each value keeps its leading tag (ASSERTS / REJECTS / ASSUMES / OPEN / KEY_TERM / ENTITY / CROSS_REF / CONFLICT_FLAG). Output VALID JSON ONLY — no markdown fences, no preamble, no commentary.`;

  const user = `Compress the following tier. Merge redundant ASSERTS/ASSUMES, but preserve every REJECTS and CONFLICT_FLAG verbatim.\n\nTIER ${sourceTier}:\n${renderTreeFlat(sourceTree).substring(0, 14000)}`;

  let compressed: Tree | null = null;
  try {
    compressed = parseNodesDefensive(await callLLM(system, user, COMPRESS_TOKENS));
    if (!compressed) {
      compressed = parseNodesDefensive(
        await callLLM(system, `Return ONLY a JSON object. ${user}`, COMPRESS_TOKENS)
      );
    }
  } catch (err: any) {
    console.error(`[TRACTATUS] Compression LLM error tier ${sourceTier}: ${err.message}`);
  }

  if (!compressed) {
    // Snapshot is canonical; leave source untouched.
    console.error(`[TRACTATUS] Compression parse failed tier ${sourceTier}; source left intact (archive is canonical)`);
    return false;
  }

  // INVARIANT: re-inject every load-bearing node from the source verbatim, in
  // case the model dropped or softened any.
  for (const [k, v] of Object.entries(sourceTree)) {
    if (isLoadBearing(v) && !Object.values(compressed).some(cv => cv === v)) {
      compressed[`lb.${k}`] = v;
    }
  }

  // 4. Merge/insert into next tier.
  const targetTier = sourceTier + 1;
  const existingHigher = await getTier(jobId, jobType, targetTier);
  const mergedTree: Tree = { ...(existingHigher?.tree || {}) };
  let mseq = nextSeq(mergedTree, targetTier);
  for (const [, v] of Object.entries(compressed)) {
    mergedTree[`${targetTier}.${mseq++}`] = v;
  }
  await upsertTier(jobId, jobType, targetTier, mergedTree, {
    parentTierId: source.id,
    compressionCount: (existingHigher?.compressionCount ?? 0) + 1,
  });

  // Drift detection on the merged higher tier.
  const rejectsAfter = countTag(mergedTree, 'REJECTS');
  const conflictsAfter = countTag(mergedTree, 'CONFLICT_FLAG');
  if (rejectsBefore > 0 && rejectsAfter < rejectsBefore) {
    console.warn(`[TRACTATUS][DRIFT] REJECTS dropped ${rejectsBefore}->${rejectsAfter} on tier ${sourceTier} compression`);
  }
  if (conflictsAfter < conflictsBefore) {
    console.warn(`[TRACTATUS][DRIFT] CONFLICT_FLAG dropped ${conflictsBefore}->${conflictsAfter} on tier ${sourceTier} compression`);
  }

  // 5. Trim source: keep all load-bearing + 30 most recent.
  const entries = Object.entries(sourceTree);
  const recent = entries.slice(-TRIM_RECENT);
  const trimmed: Tree = {};
  for (const [k, v] of entries) if (isLoadBearing(v)) trimmed[k] = v;
  for (const [k, v] of recent) trimmed[k] = v;
  await upsertTier(jobId, jobType, sourceTier, trimmed, {
    compressionCount: (source.compressionCount ?? 0) + 1,
  });

  console.log(`[TRACTATUS] Compressed tier ${sourceTier} (${Object.keys(sourceTree).length} nodes) -> tier ${targetTier} (${Object.keys(mergedTree).length} nodes)`);

  // 6. Recurse if the merged higher tier itself overflows.
  const higherThreshold = COMPRESS_THRESHOLD[targetTier];
  if (higherThreshold && Object.keys(mergedTree).length >= higherThreshold) {
    await compressTier(jobId, targetTier, callLLM, jobType);
  }

  return true;
}

// ============================================================================
// PROMPT CONTEXT RENDERING
// ============================================================================

/** Render a tier into flat lines that fit a char budget, newest-first, never
 *  dropping load-bearing nodes (busts budget + warns if forced). */
function renderTierBudgeted(tree: Tree, budget: number, newestFirst: boolean, tierLabel: string): string {
  let entries = Object.entries(tree);
  if (newestFirst) entries = entries.reverse();

  const loadBearing: string[] = [];
  const normal: string[] = [];
  for (const [k, v] of entries) {
    (isLoadBearing(v) ? loadBearing : normal).push(`${k}: ${v}`);
  }

  const lines: string[] = [...loadBearing]; // always included first
  let used = lines.join('\n').length;
  for (const line of normal) {
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }

  if (used > budget) {
    console.warn(`[TRACTATUS] ${tierLabel} exceeds budget (${used}/${budget}) to preserve load-bearing entries`);
  }
  // Restore reading order for normal lines (load-bearing stay on top is fine).
  return lines.join('\n');
}

/**
 * Renders all tiers into a single prompt-injectable string within the 15K char
 * budget. Replaces any prior "running summary" mechanism.
 */
export async function buildTieredPromptContext(jobId: string, jobType: string = 'cc'): Promise<string> {
  if (!isTractatusEnabled()) return '';

  const r = await pool.query(
    `SELECT tier, tree FROM cc_tractatus_tiers WHERE job_id=$1 AND job_type=$2 ORDER BY tier ASC`,
    [jobId, jobType]
  );
  if (r.rows.length === 0) return '';

  const byTier = new Map<number, Tree>();
  for (const row of r.rows) byTier.set(row.tier, (row.tree as Tree) || {});

  const parts: string[] = [];

  const t0 = byTier.get(0);
  if (t0 && Object.keys(t0).length) {
    // Tier 0 is never truncated.
    parts.push(`═══ SKELETON (Tier 0 — immutable constraints) ═══\n${renderTreeFlat(t0)}`);
  }

  const t1 = byTier.get(1);
  if (t1 && Object.keys(t1).length) {
    parts.push(`═══ LIVE MEMORY (Tier 1 — what earlier sections established; build forward, do NOT repeat) ═══\n${renderTierBudgeted(t1, TIER_BUDGETS[1], true, 'Tier 1')}`);
  }

  const t2 = byTier.get(2);
  if (t2 && Object.keys(t2).length) {
    parts.push(`═══ COMPRESSED MEMORY (Tier 2) ═══\n${renderTierBudgeted(t2, TIER_BUDGETS[2], false, 'Tier 2')}`);
  }

  // Tiers 3+ share a single deep budget.
  const deepTiers = Array.from(byTier.entries()).filter(([t]) => t >= 3).sort((a, b) => a[0] - b[0]);
  if (deepTiers.length) {
    const deepTree: Tree = {};
    for (const [, tree] of deepTiers) Object.assign(deepTree, tree);
    if (Object.keys(deepTree).length) {
      parts.push(`═══ DEEP MEMORY (Tier 3+) ═══\n${renderTierBudgeted(deepTree, DEEP_TIER_BUDGET, false, 'Tier 3+')}`);
    }
  }

  let context = parts.join('\n\n');
  if (context.length > TOTAL_BUDGET * 1.5) {
    // Hard safety cap (only reached if load-bearing entries are enormous).
    console.warn(`[TRACTATUS] Total context ${context.length} chars well over budget — load-bearing heavy job`);
  }
  return context;
}

// ============================================================================
// LOAD ALL TIERS (for stitch / audit)
// ============================================================================

export async function loadAllTiers(jobId: string, jobType: string = 'cc'): Promise<Array<{ tier: number; tree: Tree; nodeCount: number }>> {
  const r = await pool.query(
    `SELECT tier, tree, node_count FROM cc_tractatus_tiers WHERE job_id=$1 AND job_type=$2 ORDER BY tier ASC`,
    [jobId, jobType]
  );
  return r.rows.map(row => ({ tier: row.tier, tree: (row.tree as Tree) || {}, nodeCount: row.node_count ?? 0 }));
}

// ============================================================================
// AUDIT — cross-reference claims in text against Skeleton + all tiers
// ============================================================================

export async function auditChunkAgainstMemory(
  chunkText: string,
  jobId: string,
  callLLM: LLMCall,
  jobType: string = 'cc'
): Promise<{ claims: Array<{ text: string; status: string; evidence: string[] }>; summary: { verified: number; unverifiable: number; contradicted: number } }> {
  const empty = { claims: [], summary: { verified: 0, unverifiable: 0, contradicted: 0 } };
  if (!isTractatusEnabled()) return empty;

  const memory = await buildTieredPromptContext(jobId, jobType);
  if (!memory) return empty;

  const system = `You are auditing claims in a passage against an established memory of a document.

${ANTI_SYCOPHANCY_CLAUSES}

For each substantive claim in the passage, classify it:
- VERIFIED: supported by a memory entry (cite the entry as evidence)
- CONTRADICTED: refuted by a memory entry (cite the conflicting entry)
- UNVERIFIABLE: neither supported nor refuted by any memory entry (evidence empty)
Apply exact-match for numbers, dates, and proper names; fuzzy-match for paraphrased claims.

Return ONLY valid JSON:
{"claims":[{"text":"...","status":"VERIFIED|CONTRADICTED|UNVERIFIABLE","evidence":["..."]}]}`;

  const user = `MEMORY:\n${memory.substring(0, 12000)}\n\nPASSAGE TO AUDIT:\n${chunkText.substring(0, 6000)}`;

  try {
    const raw = await callLLM(system, user, 3000);
    const m = raw.match(/\{[\s\S]*\}/);
    const obj = m ? JSON.parse(m[0]) : { claims: [] };
    const claims = Array.isArray(obj.claims) ? obj.claims : [];
    const summary = { verified: 0, unverifiable: 0, contradicted: 0 };
    for (const c of claims) {
      if (c.status === 'VERIFIED') summary.verified++;
      else if (c.status === 'CONTRADICTED') summary.contradicted++;
      else summary.unverifiable++;
    }
    return { claims, summary };
  } catch (err: any) {
    console.error(`[TRACTATUS] Audit error: ${err.message}`);
    return empty;
  }
}
