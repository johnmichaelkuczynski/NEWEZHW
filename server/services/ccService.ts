/**
 * Cross-Chunk Coherence (CC) Service
 *
 * Three-pass architecture for generating and processing large documents:
 *   Pass 1 — Global Skeleton Extraction
 *   Pass 2 — Constrained Chunk Processing (with length enforcement + retry)
 *   Pass 3 — Global Consistency Stitch + Targeted Repairs
 *
 * Intermediate state persisted to Neon Postgres for resumability.
 */

import { pool } from '../db';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { auditChunkAgainstMemory } from './tractatusMemory';

// ============================================================================
// CONSTANTS
// ============================================================================

const CHUNK_WORDS        = 600;        // Target words per chunk (paragraph-boundary respected)
const CHUNK_PAUSE_MS     = 2000;       // Pause between chunks (pacing)
const SKELETON_TOKENS    = 3000;
const CHUNK_TOKENS       = 4096;
const STITCH_TOKENS      = 3000;
const MAX_REPAIRS        = 5;          // Max chunks to repair in stitch pass

// ============================================================================
// API CLIENTS (one per provider)
// ============================================================================

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

const openaiClient   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY   || '' });
const deepseekClient = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY || '', baseURL: 'https://api.deepseek.com' });
const grokClient     = new OpenAI({ apiKey: process.env.XAI_API_KEY      || '', baseURL: 'https://api.x.ai/v1' });
const veniceClient   = new OpenAI({ apiKey: process.env.VENICE_API_KEY   || '', baseURL: 'https://api.venice.ai/api/v1' });

// ============================================================================
// DATABASE TABLE INITIALIZATION
// ============================================================================

let tablesReady = false;

export async function ensureCCTables(): Promise<void> {
  if (tablesReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id INTEGER,
        prompt TEXT,
        input_text TEXT,
        provider TEXT DEFAULT 'openai',
        total_input_words INTEGER DEFAULT 0,
        target_min_words INTEGER DEFAULT 0,
        target_max_words INTEGER DEFAULT 0,
        target_mid_words INTEGER DEFAULT 0,
        length_ratio DECIMAL DEFAULT 1.0,
        length_mode TEXT DEFAULT 'maintain',
        num_chunks INTEGER DEFAULT 0,
        chunk_target_words INTEGER DEFAULT 0,
        global_skeleton JSONB,
        status TEXT DEFAULT 'pending',
        current_chunk INTEGER DEFAULT 0,
        final_output TEXT,
        final_word_count INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id UUID REFERENCES cc_jobs(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        chunk_input_text TEXT DEFAULT '',
        chunk_input_words INTEGER DEFAULT 0,
        target_words INTEGER DEFAULT 0,
        min_words INTEGER DEFAULT 0,
        max_words INTEGER DEFAULT 0,
        chunk_output_text TEXT,
        actual_words INTEGER DEFAULT 0,
        chunk_delta JSONB,
        retry_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cc_chunks_job ON cc_chunks(job_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cc_chunks_order ON cc_chunks(job_id, chunk_index)`);

    tablesReady = true;
    console.log('[CC] Database tables ready');
  } catch (err: any) {
    console.error('[CC] Table init error:', err.message);
    tablesReady = false;
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Split text into chunks respecting paragraph boundaries.
 * Target CHUNK_WORDS per chunk; never breaks mid-sentence.
 */
function splitIntoChunks(text: string, targetWordsPerChunk: number = CHUNK_WORDS): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';
  let currentWords = 0;

  for (const para of paragraphs) {
    if (!para.trim()) continue;
    const paraWords = countWords(para);

    if (currentWords > 0 && currentWords + paraWords > targetWordsPerChunk * 1.25) {
      chunks.push(current.trim());
      current = para;
      currentWords = paraWords;
    } else {
      current += (current ? '\n\n' : '') + para;
      currentWords += paraWords;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 0);
}

/**
 * Parse an explicit target word/page count from a prompt.
 * Returns {targetMin, targetMax} or {0,0} if not found.
 */
function parseTargetLength(prompt: string): { targetMin: number; targetMax: number } {
  const p = prompt.toLowerCase();

  const atLeast = p.match(/at\s+least\s+([\d,]+)\s+words?/);
  if (atLeast) {
    const n = parseInt(atLeast[1].replace(/,/g, ''));
    return { targetMin: n, targetMax: Math.ceil(n * 1.2) };
  }

  const range = p.match(/([\d,]+)\s*[-–]\s*([\d,]+)\s+words?/);
  if (range) {
    return {
      targetMin: parseInt(range[1].replace(/,/g, '')),
      targetMax: parseInt(range[2].replace(/,/g, '')),
    };
  }

  const exact = p.match(/(?:approximately|about|around|~|exactly)?\s*([\d,]{3,})\s+words?/);
  if (exact) {
    const n = parseInt(exact[1].replace(/,/g, ''));
    if (n >= 200) return { targetMin: Math.floor(n * 0.9), targetMax: Math.ceil(n * 1.1) };
  }

  const pages = p.match(/(\d+)\s+(?:full\s+)?pages?/);
  if (pages) {
    const n = parseInt(pages[1]) * 500;
    return { targetMin: Math.floor(n * 0.9), targetMax: Math.ceil(n * 1.1) };
  }

  return { targetMin: 0, targetMax: 0 };
}

function getLengthMode(ratio: number): string {
  if (ratio < 0.5) return 'heavy_compression';
  if (ratio < 0.8) return 'moderate_compression';
  if (ratio < 1.2) return 'maintain';
  if (ratio < 1.8) return 'moderate_expansion';
  return 'heavy_expansion';
}

function getLengthGuidance(mode: string): string {
  const g: Record<string, string> = {
    heavy_compression:   'LENGTH MODE: HEAVY COMPRESSION — significantly condense while preserving core arguments. Remove weaker examples, convert explanations to concise statements. Keep all key claims verbatim.',
    moderate_compression:'LENGTH MODE: MODERATE COMPRESSION — tighten prose, keep strongest 1-2 examples per claim, remove redundancy without losing structure.',
    maintain:            'LENGTH MODE: MAINTAIN — output should match input length. Improve clarity and coherence; do not add or remove substantial content.',
    moderate_expansion:  'LENGTH MODE: MODERATE EXPANSION — add 1-2 supporting examples per major claim, elaborate implications, add transitions. No tangential content.',
    heavy_expansion:     'LENGTH MODE: HEAVY EXPANSION — add 2-3 concrete examples, elaborate each major claim with analysis, provide background and context. ALL additions must be substantive—no filler.',
  };
  return g[mode] ?? g.maintain;
}

// ============================================================================
// LLM PROVIDER ABSTRACTION
// ============================================================================

async function callProvider(
  systemPrompt: string,
  userContent: string,
  provider: string,
  maxTokens: number = CHUNK_TOKENS
): Promise<string> {
  try {
    if (provider === 'anthropic') {
      const resp = await anthropic.messages.create({
        model: 'claude-3-7-sonnet-20250219',
        max_tokens: maxTokens,
        temperature: 0.3,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      });
      return resp.content[0]?.type === 'text' ? resp.content[0].text : '';
    }

    let client: OpenAI = openaiClient;
    let model = 'gpt-4o';
    if (provider === 'deepseek') { client = deepseekClient; model = 'deepseek-chat'; }
    else if (provider === 'grok')   { client = grokClient;     model = 'grok-3-latest'; }
    else if (provider === 'venice') { client = veniceClient;   model = 'llama-3.3-70b'; }

    const resp = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent  },
      ],
    });
    return resp.choices[0]?.message?.content ?? '';

  } catch (err: any) {
    console.error(`[CC] Provider "${provider}" error: ${err.message}`);
    if (provider !== 'openai') {
      console.log('[CC] Falling back to OpenAI gpt-4o');
      const resp = await openaiClient.chat.completions.create({
        model: 'gpt-4o', max_tokens: maxTokens, temperature: 0.3,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
      });
      return resp.choices[0]?.message?.content ?? '';
    }
    throw err;
  }
}

// ============================================================================
// DATABASE HELPERS
// ============================================================================

async function dbCreateJob(p: {
  userId: number; prompt: string; inputText: string; provider: string;
  totalInputWords: number; targetMin: number; targetMax: number; targetMid: number;
  lengthRatio: number; lengthMode: string; numChunks: number; chunkTargetWords: number;
}): Promise<string> {
  const r = await pool.query(
    `INSERT INTO cc_jobs
       (user_id, prompt, input_text, provider, total_input_words,
        target_min_words, target_max_words, target_mid_words,
        length_ratio, length_mode, num_chunks, chunk_target_words, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending') RETURNING id`,
    [p.userId, p.prompt, p.inputText, p.provider, p.totalInputWords,
     p.targetMin, p.targetMax, p.targetMid,
     p.lengthRatio, p.lengthMode, p.numChunks, p.chunkTargetWords]
  );
  return r.rows[0].id as string;
}

async function dbUpdateJob(jobId: string, fields: Record<string, any>): Promise<void> {
  const keys   = Object.keys(fields);
  const values = Object.values(fields);
  const setClauses = keys.map((k, i) => `${toSnake(k)} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE cc_jobs SET ${setClauses}, updated_at = NOW() WHERE id = $1`,
    [jobId, ...values]
  );
}

async function dbGetJob(jobId: string): Promise<any> {
  const r = await pool.query('SELECT * FROM cc_jobs WHERE id = $1', [jobId]);
  return r.rows[0];
}

async function dbCreateChunk(p: {
  jobId: string; chunkIndex: number; inputText: string; inputWords: number;
  targetWords: number; minWords: number; maxWords: number;
}): Promise<string> {
  const r = await pool.query(
    `INSERT INTO cc_chunks
       (job_id, chunk_index, chunk_input_text, chunk_input_words,
        target_words, min_words, max_words, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
    [p.jobId, p.chunkIndex, p.inputText, p.inputWords,
     p.targetWords, p.minWords, p.maxWords]
  );
  return r.rows[0].id as string;
}

async function dbUpdateChunk(chunkId: string, fields: Record<string, any>): Promise<void> {
  const keys   = Object.keys(fields);
  const values = Object.values(fields).map(v =>
    (typeof v === 'object' && v !== null && !Array.isArray(v)) ? JSON.stringify(v) : v
  );
  const setClauses = keys.map((k, i) => `${toSnake(k)} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE cc_chunks SET ${setClauses}, updated_at = NOW() WHERE id = $1`,
    [chunkId, ...values]
  );
}

async function dbGetChunks(jobId: string): Promise<any[]> {
  const r = await pool.query(
    'SELECT * FROM cc_chunks WHERE job_id = $1 ORDER BY chunk_index',
    [jobId]
  );
  return r.rows;
}

function toSnake(s: string): string {
  return s.replace(/[A-Z]/g, l => `_${l.toLowerCase()}`);
}

// ============================================================================
// PASS 1 — GLOBAL SKELETON EXTRACTION
// ============================================================================

async function extractSkeleton(
  jobId: string,
  prompt: string,
  inputText: string,
  provider: string
): Promise<any> {
  await pool.query(`UPDATE cc_jobs SET status='skeleton_extraction', updated_at=NOW() WHERE id=$1`, [jobId]);

  const isGen = countWords(inputText) < 200;

  const systemPrompt = `You are extracting a structural skeleton from a document or task description.
This skeleton will constrain ALL downstream processing — errors here propagate everywhere.

Extract the following (keep total under 2000 tokens):

1. THESIS (1-3 sentences): The central argument or purpose
2. OUTLINE (8-20 items): Main sections/claims and their purpose, numbered
3. KEY_TERMS: Important terms with exact meanings as used in this document
4. COMMITMENT_LEDGER: What the document asserts, rejects, assumes
   Use format: "ASSERTS: X" / "REJECTS: Y" / "ASSUMES: Z"
5. ENTITIES: People, organizations, concepts requiring consistent naming

Return ONLY valid JSON:
{
  "thesis": "...",
  "outline": ["1. ...", "2. ...", ...],
  "keyTerms": {"term": "definition", ...},
  "commitmentLedger": ["ASSERTS: ...", "REJECTS: ...", "ASSUMES: ..."],
  "entities": ["Name/Term", ...]
}`;

  const userContent = isGen
    ? `TASK: ${prompt}\n\nExtract a skeleton describing what this document should contain and argue.`
    : `DOCUMENT (up to 12,000 chars):\n${inputText.substring(0, 12000)}\n\nUSER INSTRUCTION: ${prompt.substring(0, 1000)}`;

  const raw = await callProvider(systemPrompt, userContent, provider, SKELETON_TOKENS);

  let skeleton: any;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    skeleton = JSON.parse(m ? m[0] : raw);
  } catch {
    skeleton = {
      thesis: 'Provide a coherent, comprehensive response to the given task.',
      outline: ['1. Introduction', '2. Main Body', '3. Conclusion'],
      keyTerms: {},
      commitmentLedger: [],
      entities: [],
    };
  }

  await pool.query(
    `UPDATE cc_jobs SET global_skeleton=$1, updated_at=NOW() WHERE id=$2`,
    [JSON.stringify(skeleton), jobId]
  );

  console.log(`[CC] Skeleton extracted: ${skeleton.outline?.length ?? 0} outline points, ${skeleton.commitmentLedger?.length ?? 0} commitments`);
  return skeleton;
}

// ============================================================================
// PASS 2 — CONSTRAINED CHUNK PROCESSING
// ============================================================================

async function processOneChunk(
  chunk: any,
  job: any,
  skeleton: any,
  provider: string,
  isGenMode: boolean
): Promise<{ outputText: string; actualWords: number; delta: any }> {

  const skeletonBlock = [
    `Thesis: ${skeleton.thesis ?? ''}`,
    `Outline: ${(skeleton.outline ?? []).join(' | ')}`,
    `Key Terms: ${Object.entries(skeleton.keyTerms ?? {}).map(([k, v]) => `${k}="${v}"`).join(', ')}`,
    `Commitments: ${(skeleton.commitmentLedger ?? []).join(' | ')}`,
    `Entities: ${(skeleton.entities ?? []).join(', ')}`,
  ].join('\n');

  const systemPrompt = `You are processing one section of a larger document.
You MUST honor the global skeleton at all times.

═══ GLOBAL SKELETON (mandatory constraints) ═══
${skeletonBlock}
═══════════════════════════════════════════════

User task: ${job.prompt.substring(0, 800)}

═══ LENGTH REQUIREMENT (HARD) ═══
Chunk ${chunk.chunk_index + 1} of ${job.num_chunks}
Input: ${chunk.chunk_input_words} words
YOUR OUTPUT MUST BE: ${chunk.min_words}–${chunk.max_words} words (target: ${chunk.target_words})
Count your words. If outside range, you have failed.
${getLengthGuidance(job.length_mode)}
═════════════════════════════════

CONSTRAINTS:
• Do NOT contradict any commitment in the skeleton
• Use key terms EXACTLY as defined — no synonym drift
• If you detect a conflict, write CONFLICT: [description] at the very end
• No padding — every sentence must add substance

After your main content write exactly this line:
DELTA: new_claims=[...], terms_used=[...], conflicts=[none or description]`;

  const userContent = isGenMode
    ? `Generate substantive content for section ${chunk.chunk_index + 1} of ${job.num_chunks}.
Based on the outline, this section covers: ${(skeleton.outline ?? [])[chunk.chunk_index] ?? 'main content'}.
Write ${chunk.target_words} words of focused, high-quality content now.`
    : `Process this chunk according to the user instruction and global skeleton:

CHUNK TEXT:
${chunk.chunk_input_text}`;

  let outputText = await callProvider(systemPrompt, userContent, provider, CHUNK_TOKENS);

  // Strip delta line from output
  const deltaMatch = outputText.match(/\nDELTA:\s*(.+)$/ms);
  let delta: any = { newClaims: [], termsUsed: [], conflicts: 'none' };
  if (deltaMatch) {
    outputText = outputText.replace(/\nDELTA:\s*.+$/ms, '').trim();
    try {
      const dt = deltaMatch[1];
      delta.newClaims  = dt.match(/new_claims=\[([^\]]*)\]/)?.[1]?.split(',').map((s: string) => s.trim()).filter(Boolean) ?? [];
      delta.termsUsed  = dt.match(/terms_used=\[([^\]]*)\]/)?.[1]?.split(',').map((s: string) => s.trim()).filter(Boolean) ?? [];
      delta.conflicts  = dt.match(/conflicts=\[([^\]]*)\]/)?.[1] ?? 'none';
    } catch {}
  }

  let actualWords = countWords(outputText);

  // Retry: too short
  if (actualWords < chunk.min_words * 0.8) {
    console.log(`[CC] Chunk ${chunk.chunk_index + 1}: ${actualWords} words < min ${chunk.min_words}. Expanding...`);
    await sleep(3000);
    const retrySystem = `You are expanding a document section. Task: ${job.prompt.substring(0, 400)}`;
    const retryPrompt = `Your previous output was ${actualWords} words. Target: ${chunk.min_words}–${chunk.max_words} words.

PREVIOUS OUTPUT:
${outputText}

Expand with:
• Additional examples or evidence for key claims
• Fuller explanations (not repetitions)
• Stronger transitions and connective tissue
All additions must be substantive. Write the expanded version now (${chunk.target_words} words).`;
    const expanded = await callProvider(retrySystem, retryPrompt, provider, CHUNK_TOKENS);
    outputText = expanded.replace(/\nDELTA:\s*.+$/ms, '').trim();
    actualWords = countWords(outputText);
    console.log(`[CC] After expansion: ${actualWords} words`);
  }

  // Retry: too long
  if (actualWords > chunk.max_words * 1.2) {
    console.log(`[CC] Chunk ${chunk.chunk_index + 1}: ${actualWords} words > max ${chunk.max_words}. Compressing...`);
    await sleep(3000);
    const retrySystem = `You are compressing a document section without losing substance.`;
    const retryPrompt = `Your previous output was ${actualWords} words. Target: ${chunk.min_words}–${chunk.max_words} words.

PREVIOUS OUTPUT:
${outputText.substring(0, 8000)}

Compress by:
• Removing weaker examples (keep only the strongest)
• Eliminating redundancy
• Tightening prose — say more in fewer words
Preserve ALL key claims and core argument.`;
    const compressed = await callProvider(retrySystem, retryPrompt, provider, CHUNK_TOKENS);
    outputText = compressed.replace(/\nDELTA:\s*.+$/ms, '').trim();
    actualWords = countWords(outputText);
    console.log(`[CC] After compression: ${actualWords} words`);
  }

  return { outputText, actualWords, delta };
}

// ============================================================================
// PASS 3 — GLOBAL CONSISTENCY STITCH
// ============================================================================

async function runStitchPass(
  skeleton: any,
  chunks: any[],
  provider: string
): Promise<{ conflicts: string[]; repairPlan: Array<{ chunkIndex: number; issue: string; action: string }> }> {

  const deltaReports = chunks.map(c => ({
    index:   c.chunk_index,
    words:   c.actual_words,
    delta:   c.chunk_delta ?? {},
  }));

  const systemPrompt = `You are reviewing processed document chunks for cross-chunk coherence problems.
Report ONLY real issues — do not invent problems.

GLOBAL SKELETON:
Thesis: ${skeleton.thesis ?? ''}
Key Terms: ${Object.entries(skeleton.keyTerms ?? {}).map(([k, v]) => `${k}="${v}"`).join(', ')}
Commitments: ${(skeleton.commitmentLedger ?? []).join(' | ')}

Review delta reports for:
1. CONTRADICTIONS — chunks that contradict each other or the skeleton
2. TERM DRIFT — key term used with different meanings across chunks
3. REDUNDANCIES — multiple chunks making the same point unnecessarily
4. GAPS — skeleton elements missing from ALL chunks

Return ONLY valid JSON:
{
  "conflicts": ["description of issue 1", ...],
  "repairPlan": [
    {"chunkIndex": 0, "issue": "...", "action": "precise repair instruction"},
    ...
  ]
}
If no issues: {"conflicts": [], "repairPlan": []}`;

  const userContent = `CHUNK DELTA REPORTS:\n${JSON.stringify(deltaReports, null, 2).substring(0, 6000)}`;

  try {
    const raw = await callProvider(systemPrompt, userContent, provider, STITCH_TOKENS);
    const m = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : raw);
  } catch {
    return { conflicts: [], repairPlan: [] };
  }
}

async function executeRepair(
  chunkRecord: any,
  repairAction: string,
  skeleton: any,
  job: any,
  provider: string
): Promise<string> {
  const systemPrompt = `You are performing a targeted micro-repair on a document chunk.
Apply ONLY the specified repair. Preserve all other content exactly.

REPAIR INSTRUCTION: ${repairAction}
Skeleton thesis: ${skeleton.thesis ?? ''}
Key terms: ${Object.entries(skeleton.keyTerms ?? {}).map(([k, v]) => `${k}="${v}"`).join(', ')}`;

  const userContent = `ORIGINAL CHUNK (${chunkRecord.actual_words} words, target ${chunkRecord.target_words}):
${(chunkRecord.chunk_output_text ?? '').substring(0, 6000)}

Return the repaired chunk text only. No meta-commentary. Keep approximately ${chunkRecord.target_words} words.`;

  return callProvider(systemPrompt, userContent, provider, CHUNK_TOKENS);
}

// ============================================================================
// MAIN PIPELINE — ASYNC GENERATOR (yields SSE-compatible events)
// ============================================================================

export async function* runCCPipeline(
  userId: number,
  prompt: string,
  inputText: string,
  provider: string
): AsyncGenerator<{ type: string; data: any }> {

  let jobId: string | null = null;

  try {
    await ensureCCTables();

    // ─── INITIALIZATION ──────────────────────────────────────────────────────

    const totalInputWords = countWords(inputText);
    const isGenMode       = totalInputWords < 200;

    const { targetMin, targetMax } = parseTargetLength(prompt);

    let targetMid: number;
    if (targetMin > 0) {
      targetMid = Math.floor((targetMin + targetMax) / 2);
    } else if (isGenMode) {
      targetMid = 3000; // sensible default for pure generation
    } else {
      targetMid = totalInputWords; // maintain length by default
    }

    const effMin = targetMin > 0 ? targetMin : Math.floor(targetMid * 0.85);
    const effMax = targetMax > 0 ? targetMax : Math.ceil(targetMid * 1.15);

    const lengthRatio = isGenMode ? 1.0 : (targetMid / Math.max(1, totalInputWords));
    const lengthMode  = getLengthMode(lengthRatio);

    // For generation: num_chunks based on target output size
    // For processing: num_chunks based on input size
    const baseWordCount  = isGenMode ? targetMid : totalInputWords;
    const numChunks      = Math.max(1, Math.ceil(baseWordCount / CHUNK_WORDS));
    const chunkTarget    = Math.ceil(targetMid / numChunks);

    yield { type: 'status', data: `CC Pipeline starting: ${numChunks} chunks, ${targetMid} word target (${lengthMode})` };

    // Create job record
    jobId = await dbCreateJob({
      userId, prompt, inputText, provider,
      totalInputWords,
      targetMin: effMin, targetMax: effMax, targetMid,
      lengthRatio, lengthMode,
      numChunks, chunkTargetWords: chunkTarget,
    });

    console.log(`[CC] Job ${jobId} created | mode=${isGenMode?'GENERATE':'PROCESS'} | chunks=${numChunks} | target=${targetMid}w | provider=${provider}`);

    // Create chunk records
    if (isGenMode) {
      for (let i = 0; i < numChunks; i++) {
        await dbCreateChunk({
          jobId, chunkIndex: i, inputText: '', inputWords: 0,
          targetWords: chunkTarget,
          minWords:    Math.floor(chunkTarget * 0.85),
          maxWords:    Math.ceil(chunkTarget  * 1.15),
        });
      }
    } else {
      const textChunks = splitIntoChunks(inputText, CHUNK_WORDS);
      for (let i = 0; i < textChunks.length; i++) {
        const inputW   = countWords(textChunks[i]);
        const chunkTgt = Math.ceil(inputW * lengthRatio);
        await dbCreateChunk({
          jobId, chunkIndex: i,
          inputText: textChunks[i], inputWords: inputW,
          targetWords: chunkTgt,
          minWords:    Math.floor(chunkTgt * 0.85),
          maxWords:    Math.ceil(chunkTgt  * 1.15),
        });
      }
      await pool.query(`UPDATE cc_jobs SET num_chunks=$1 WHERE id=$2`, [textChunks.length, jobId]);
    }

    // ─── PASS 1: SKELETON ─────────────────────────────────────────────────────

    yield { type: 'status', data: 'Pass 1 of 3: Extracting global skeleton (thesis · outline · key terms · commitment ledger)...' };

    const skeleton = await extractSkeleton(jobId, prompt, inputText, provider);

    yield {
      type: 'skeleton',
      data: { skeleton, numChunks, targetWords: targetMid, lengthMode },
    };

    await sleep(2000);

    // ─── PASS 2: CHUNK PROCESSING ─────────────────────────────────────────────

    yield { type: 'status', data: `Pass 2 of 3: Processing ${numChunks} chunks with skeleton constraints...` };

    await dbUpdateJob(jobId, { status: 'chunk_processing' });

    const job          = await dbGetJob(jobId);
    const chunkRecords = await dbGetChunks(jobId);
    const actualN      = chunkRecords.length;

    for (let i = 0; i < chunkRecords.length; i++) {
      const cr = chunkRecords[i];

      yield {
        type: 'status',
        data: `Processing chunk ${i + 1}/${actualN} · target ${cr.target_words} words...`,
      };

      await sleep(CHUNK_PAUSE_MS);

      await dbUpdateChunk(cr.id, { status: 'processing' });

      try {
        const { outputText, actualWords, delta } = await processOneChunk(cr, job, skeleton, provider, isGenMode);

        await dbUpdateChunk(cr.id, {
          chunkOutputText: outputText,
          actualWords,
          chunkDelta:      delta,
          status:          'complete',
        });
        await dbUpdateJob(jobId, { currentChunk: i + 1 });

        console.log(`[CC] Chunk ${i + 1}/${actualN}: ${actualWords}/${cr.target_words} words`);

        yield {
          type: 'chunk',
          data: {
            sectionIndex: i,
            sectionTitle: `Section ${i + 1}/${actualN}`,
            content:      outputText,
            wordCount:    actualWords,
            targetWords:  cr.target_words,
          },
        };

      } catch (err: any) {
        console.error(`[CC] Chunk ${i + 1} error: ${err.message}`);
        await dbUpdateChunk(cr.id, { status: 'failed' });
        yield { type: 'status', data: `Warning: chunk ${i + 1} failed — continuing (${err.message})` };
      }
    }

    // ─── PASS 3: STITCH ───────────────────────────────────────────────────────

    yield { type: 'status', data: 'Pass 3 of 3: Global coherence stitch — checking for contradictions, drift, and gaps...' };

    await dbUpdateJob(jobId, { status: 'stitching' });

    const allChunks    = await dbGetChunks(jobId);
    const validChunks  = allChunks.filter(c => c.status === 'complete' && c.chunk_output_text);

    const stitchResult = await runStitchPass(skeleton, validChunks, provider);

    if (stitchResult.conflicts.length > 0) {
      yield {
        type: 'status',
        data: `Found ${stitchResult.conflicts.length} coherence issue(s). Applying targeted repairs...`,
      };

      for (const repair of stitchResult.repairPlan.slice(0, MAX_REPAIRS)) {
        const target = validChunks.find(c => c.chunk_index === repair.chunkIndex);
        if (!target?.chunk_output_text) continue;

        yield {
          type: 'status',
          data: `Repairing chunk ${repair.chunkIndex + 1}: ${repair.issue.substring(0, 80)}`,
        };
        await sleep(2000);

        try {
          const repaired = await executeRepair(target, repair.action, skeleton, job, provider);
          await dbUpdateChunk(target.id, {
            chunkOutputText: repaired,
            actualWords:     countWords(repaired),
          });
          target.chunk_output_text = repaired;
          target.actual_words      = countWords(repaired);
        } catch (rErr: any) {
          console.error(`[CC] Repair chunk ${repair.chunkIndex} failed: ${rErr.message}`);
        }
      }
    } else {
      yield { type: 'status', data: 'Stitch pass: no coherence issues detected.' };
    }

    // ─── FINAL ASSEMBLY ───────────────────────────────────────────────────────

    yield { type: 'status', data: 'Assembling final output...' };

    const finalChunks = await dbGetChunks(jobId);
    const finalOutput = finalChunks
      .filter(c => c.chunk_output_text)
      .sort((a, b) => a.chunk_index - b.chunk_index)
      .map(c => c.chunk_output_text as string)
      .join('\n\n');

    const finalWords = countWords(finalOutput);

    await pool.query(
      `UPDATE cc_jobs SET final_output=$1, final_word_count=$2, status='complete', updated_at=NOW() WHERE id=$3`,
      [finalOutput, finalWords, jobId]
    );

    console.log(`[CC] Job ${jobId} COMPLETE: ${finalWords} words (target ${effMin}–${effMax})`);

    yield {
      type: 'complete',
      data: {
        content:           finalOutput,
        totalWords:        finalWords,
        targetMin:         effMin,
        targetMax:         effMax,
        sectionsGenerated: validChunks.length,
        jobId,
      },
    };

  } catch (error: any) {
    console.error('[CC] Pipeline failed:', error.message);

    if (jobId) {
      await pool.query(
        `UPDATE cc_jobs SET status='failed', updated_at=NOW() WHERE id=$1`,
        [jobId]
      ).catch(() => {});
    }

    yield { type: 'error', data: error.message ?? 'CC pipeline failed unexpectedly' };
  }
}

// ============================================================================
// AUDIT — on-demand consistency / hallucination check of a job's output
// ============================================================================

export async function auditCCJob(
  jobId: string,
  text: string | undefined,
  provider: string = 'openai',
  userId?: number
): Promise<{
  jobStatus: string;
  auditedWords: number;
  claims: Array<{ text: string; status: string; evidence: string[] }>;
  summary: { verified: number; unverifiable: number; contradicted: number };
}> {
  const job = await dbGetJob(jobId);
  if (!job) {
    const err: any = new Error('Job not found');
    err.statusCode = 404;
    throw err;
  }

  // Object-level authorization: a job may only be audited by its owner.
  if (userId !== undefined && job.user_id !== userId) {
    const err: any = new Error('Job not found');
    err.statusCode = 404;
    throw err;
  }

  // Prefer caller-supplied passage; otherwise use the final output, and if the
  // job has not finished, fall back to whatever chunks have been produced so far.
  let passage = (text && text.trim()) ? text.trim() : '';
  if (!passage) {
    passage = (job.final_output as string | null)?.trim() || '';
  }
  if (!passage) {
    const chunks = await dbGetChunks(jobId);
    passage = chunks
      .filter(c => c.chunk_output_text)
      .sort((a, b) => a.chunk_index - b.chunk_index)
      .map(c => c.chunk_output_text as string)
      .join('\n\n')
      .trim();
  }

  if (!passage) {
    return {
      jobStatus: job.status,
      auditedWords: 0,
      claims: [],
      summary: { verified: 0, unverifiable: 0, contradicted: 0 },
    };
  }

  const callLLM = (s: string, u: string, m: number) => callProvider(s, u, provider, m);
  const result = await auditChunkAgainstMemory(passage, jobId, callLLM, 'cc');

  return {
    jobStatus: job.status,
    auditedWords: countWords(passage),
    claims: result.claims,
    summary: result.summary,
  };
}

// ============================================================================
// THRESHOLD HELPER — used by routes to decide when to engage CC
// ============================================================================

export function shouldUseCCPipeline(prompt: string, inputText: string): boolean {
  const inputWords = countWords(inputText);
  if (inputWords > 1500) return true;          // substantial input document → always CC

  const { targetMin, targetMax } = parseTargetLength(prompt);
  const targetMid = targetMin > 0 ? Math.floor((targetMin + targetMax) / 2) : 0;
  if (targetMid > 2500) return true;           // long output requested → CC

  return false;
}
