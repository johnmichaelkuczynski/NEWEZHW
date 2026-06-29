import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// In-memory mock of the Postgres pool used by tractatusMemory.ts.
//
// tractatusMemory is the only writer of the cc_tractatus_* tables, so we only
// have to emulate the handful of SQL statements it issues. Trees are stored as
// parsed objects (Neon's JSONB driver returns parsed objects, not strings) so
// reads round-trip the same way the real module sees them.
// ---------------------------------------------------------------------------

const store = vi.hoisted(() => {
  type TierRow = {
    id: string;
    job_id: string;
    job_type: string;
    tier: number;
    tree: Record<string, string>;
    node_count: number;
    parent_tier_id: string | null;
    compression_count: number;
  };
  type ArchiveRow = {
    job_id: string;
    job_type: string;
    tier: number;
    tree_snapshot: Record<string, string>;
    reason: string;
  };
  const tiers: TierRow[] = [];
  const archive: ArchiveRow[] = [];

  const failNextArchive = { value: false };

  async function query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, " ").trim();

    if (s.startsWith("CREATE")) return { rows: [] };

    if (s.startsWith("INSERT INTO cc_tractatus_archive")) {
      if (failNextArchive.value) {
        failNextArchive.value = false;
        throw new Error("simulated archive write failure");
      }
      archive.push({
        job_id: params[0],
        job_type: params[1],
        tier: params[2],
        tree_snapshot: JSON.parse(params[3]),
        reason: params[5],
      });
      return { rows: [] };
    }

    if (s.startsWith("INSERT INTO cc_tractatus_tiers")) {
      tiers.push({
        id: randomUUID(),
        job_id: params[0],
        job_type: params[1],
        tier: params[2],
        tree: JSON.parse(params[3]),
        node_count: params[4],
        parent_tier_id: params[5] ?? null,
        compression_count: params[6] ?? 0,
      });
      return { rows: [] };
    }

    if (s.startsWith("UPDATE cc_tractatus_tiers")) {
      const row = tiers.find((t) => t.id === params[3]);
      if (row) {
        row.tree = JSON.parse(params[0]);
        row.node_count = params[1];
        if (params[2] != null) row.compression_count = params[2];
      }
      return { rows: [] };
    }

    if (s.startsWith("SELECT id, tree, node_count, compression_count FROM cc_tractatus_tiers")) {
      const row = tiers.find(
        (t) => t.job_id === params[0] && t.job_type === params[1] && t.tier === params[2]
      );
      return {
        rows: row
          ? [{ id: row.id, tree: row.tree, node_count: row.node_count, compression_count: row.compression_count }]
          : [],
      };
    }

    if (s.startsWith("SELECT tier, tree, node_count FROM cc_tractatus_tiers")) {
      const rows = tiers
        .filter((t) => t.job_id === params[0] && t.job_type === params[1])
        .sort((a, b) => a.tier - b.tier)
        .map((t) => ({ tier: t.tier, tree: t.tree, node_count: t.node_count }));
      return { rows };
    }

    if (s.startsWith("SELECT tier, tree FROM cc_tractatus_tiers")) {
      const rows = tiers
        .filter((t) => t.job_id === params[0] && t.job_type === params[1])
        .sort((a, b) => a.tier - b.tier)
        .map((t) => ({ tier: t.tier, tree: t.tree }));
      return { rows };
    }

    throw new Error("Unhandled SQL in mock pool: " + s);
  }

  return { tiers, archive, failNextArchive, query };
});

vi.mock("../db", () => ({
  pool: { query: store.query },
  db: {},
}));

import {
  skeletonToTier0,
  updateLiveTier,
  compressTier,
  buildTieredPromptContext,
  loadAllTiers,
} from "./tractatusMemory";

// A fake compressor LLM that DROPS every load-bearing node (REJECTS /
// CONFLICT_FLAG) and returns only a single summary node. This is deliberately
// adversarial: it proves the module's own re-injection invariant — not the
// model — is what guarantees load-bearing survival.
function makeDroppingLLM(): (s: string, u: string, m: number) => Promise<string> {
  let call = 0;
  return async () => {
    call++;
    return JSON.stringify({ "x.0": `ASSERTS: compressed summary ${call}` });
  };
}

function collectValues(trees: Array<{ tree: Record<string, string> }>): string[] {
  return trees.flatMap((t) => Object.values(t.tree));
}

beforeEach(() => {
  store.tiers.length = 0;
  store.archive.length = 0;
  store.failNextArchive.value = false;
  vi.restoreAllMocks();
});

describe("tractatusMemory — load-bearing survival across compressions", () => {
  it("keeps 100% of REJECTS and CONFLICT_FLAG nodes after three sequential compressions", async () => {
    const jobId = randomUUID();
    const llm = makeDroppingLLM();

    // Seed Tier 1 with a mix of normal claims and load-bearing entries.
    // updateLiveTier wraps claims as "ASSERTS: <text>" and conflicts as
    // "CONFLICT_FLAG: <text>", so the verbatim stored form (what must survive
    // compression) is the wrapped string — capture exactly that.
    const rejectClaims: string[] = [];
    const conflictTexts: string[] = [];
    for (let i = 0; i < 5; i++) {
      rejectClaims.push(`REJECTS: the system does NOT support feature ${i}`);
      conflictTexts.push(`section ${i} says X but section ${i + 10} says not-X`);
    }

    // Fill tier 1 with ~60 normal claims plus the load-bearing ones.
    const newClaims: string[] = [];
    for (let i = 0; i < 60; i++) newClaims.push(`plain claim number ${i}`);
    await updateLiveTier(jobId, { newClaims }, llm);
    // Seed REJECTS entries as claims (their REJECTS substring makes them
    // load-bearing) and CONFLICT_FLAG entries via the conflicts channel.
    for (let i = 0; i < 5; i++) {
      await updateLiveTier(jobId, { newClaims: [rejectClaims[i]] }, llm);
      await updateLiveTier(jobId, { conflicts: conflictTexts[i] }, llm);
    }

    // The exact verbatim node values that must survive every compression.
    const plantedLoadBearing = [
      ...rejectClaims.map((r) => `ASSERTS: ${r}`),
      ...conflictTexts.map((c) => `CONFLICT_FLAG: ${c}`),
    ];

    // Sanity: confirm each planted load-bearing node exists verbatim in tier 1.
    let tiers = await loadAllTiers(jobId);
    const t1Values = Object.values(tiers.find((t) => t.tier === 1)!.tree);
    for (const entry of plantedLoadBearing) {
      expect(t1Values).toContain(entry);
    }

    // Force THREE sequential compressions: 1->2, then 2->3, then 3->4.
    expect(await compressTier(jobId, 1, llm)).toBe(true);
    expect(await compressTier(jobId, 2, llm)).toBe(true);
    expect(await compressTier(jobId, 3, llm)).toBe(true);

    tiers = await loadAllTiers(jobId);
    const deepest = tiers.reduce((a, b) => (b.tier > a.tier ? b : a));
    expect(deepest.tier).toBeGreaterThanOrEqual(4);

    // 100% identity check: every originally-planted REJECTS and CONFLICT_FLAG
    // entry is present VERBATIM in the deepest tier, even though the compressor
    // LLM dropped all of them. Assert exact containment per entry — not counts —
    // so a regression that drops one original (even while duplicating others)
    // fails here.
    const deepValues = Object.values(deepest.tree);
    for (const entry of plantedLoadBearing) {
      expect(deepValues).toContain(entry);
    }
    // And no original load-bearing entry was silently softened/renamed: the
    // count of surviving load-bearing nodes is at least the number planted.
    const deepLoadBearing = deepValues.filter(
      (v) => v.toUpperCase().includes("REJECTS") || v.toUpperCase().includes("CONFLICT_FLAG")
    );
    expect(deepLoadBearing.length).toBeGreaterThanOrEqual(plantedLoadBearing.length);
  });

  it("aborts compression (source untouched) when the archive snapshot write fails", async () => {
    const jobId = randomUUID();
    const llm = makeDroppingLLM();
    await updateLiveTier(
      jobId,
      { newClaims: ["a", "b", "c"], conflicts: "CONFLICT between a and b" },
      llm
    );
    const before = await loadAllTiers(jobId);
    const t1Before = before.find((t) => t.tier === 1)!;

    store.failNextArchive.value = true;
    const ok = await compressTier(jobId, 1, llm);
    expect(ok).toBe(false);

    const after = await loadAllTiers(jobId);
    // No tier 2 created, tier 1 unchanged.
    expect(after.find((t) => t.tier === 2)).toBeUndefined();
    expect(after.find((t) => t.tier === 1)!.tree).toEqual(t1Before.tree);
  });
});

describe("tractatusMemory — no key collisions when appending after a trim", () => {
  it("never overwrites an existing node when appending after a compression trim", async () => {
    const jobId = randomUUID();
    const llm = makeDroppingLLM();

    // Build a large tier 1 with load-bearing nodes so trimming leaves sparse,
    // high-numbered keys (the exact condition that broke a length-based counter).
    const newClaims: string[] = [];
    for (let i = 0; i < 80; i++) newClaims.push(`claim ${i}`);
    await updateLiveTier(jobId, { newClaims }, llm);
    await updateLiveTier(jobId, { conflicts: "CONFLICT_FLAG: early-vs-late mismatch" }, llm);

    // Compress 1 -> 2. Tier 1 is now trimmed to load-bearing + 30 most recent,
    // so its remaining keys are sparse and high-numbered (e.g. 1.51..1.80).
    expect(await compressTier(jobId, 1, llm)).toBe(true);

    const trimmed = (await loadAllTiers(jobId)).find((t) => t.tier === 1)!.tree;
    const keysBefore = Object.keys(trimmed);
    const snapshotBefore: Record<string, string> = { ...trimmed };
    const maxSuffixBefore = Math.max(
      ...keysBefore.filter((k) => /^1\.\d+$/.test(k)).map((k) => parseInt(k.split(".")[1], 10))
    );

    // Append new nodes AFTER the trim.
    await updateLiveTier(jobId, { newClaims: ["post-trim claim 1", "post-trim claim 2"] }, llm);

    const afterTree = (await loadAllTiers(jobId)).find((t) => t.tier === 1)!.tree;

    // Every pre-existing key still maps to its original value (nothing overwritten).
    for (const k of keysBefore) {
      expect(afterTree[k]).toBe(snapshotBefore[k]);
    }
    // The new nodes were appended with strictly higher suffixes (max+1 allocator).
    const newKeys = Object.keys(afterTree).filter((k) => !keysBefore.includes(k));
    expect(newKeys.length).toBe(2);
    for (const k of newKeys) {
      const suffix = parseInt(k.split(".")[1], 10);
      expect(suffix).toBeGreaterThan(maxSuffixBefore);
    }
    // No keys lost.
    expect(Object.keys(afterTree).length).toBe(keysBefore.length + 2);
  });
});

describe("tractatusMemory — buildTieredPromptContext char budget", () => {
  it("stays within the 15,000-char budget under normal (non-load-bearing) load", async () => {
    const jobId = randomUUID();
    const llm = makeDroppingLLM();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Small immutable skeleton (tier 0 is never truncated, so keep it small).
    await skeletonToTier0(jobId, {
      thesis: "Main thesis of the document.",
      outline: ["Intro", "Body", "Conclusion"],
      keyTerms: { foo: "a foo", bar: "a bar" },
      commitmentLedger: ["ASSERTS: the sky is blue"],
      entities: ["Alice", "Bob"],
    });

    // Flood tiers 1/2/3 with many large, NON-load-bearing claims so each tier's
    // budgeted renderer has to truncate.
    const big = (n: number) => `plain detailed claim ${n} ` + "x".repeat(80);
    await updateLiveTier(jobId, { newClaims: Array.from({ length: 200 }, (_, i) => big(i)) }, llm);
    await compressTier(jobId, 1, llm); // create tier 2 with some content

    // Manually push lots into tier 2 and a deep tier via more compressions.
    await updateLiveTier(jobId, { newClaims: Array.from({ length: 200 }, (_, i) => big(1000 + i)) }, llm);
    await compressTier(jobId, 1, llm);

    const context = await buildTieredPromptContext(jobId);
    expect(context.length).toBeLessThanOrEqual(15000);

    // Under normal load no load-bearing over-budget warning should fire.
    const overBudgetWarn = warn.mock.calls.some((c) =>
      String(c[0]).includes("exceeds budget")
    );
    expect(overBudgetWarn).toBe(false);
  });

  it("exceeds a tier budget AND warns only when load-bearing entries force it", async () => {
    const jobId = randomUUID();
    const llm = makeDroppingLLM();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Plant enough large REJECTS entries to blow past the Tier-1 budget (5000).
    // Each REJECTS line is ~300 chars; 30 of them ~9000 chars of load-bearing
    // content that cannot be dropped.
    for (let i = 0; i < 30; i++) {
      await updateLiveTier(
        jobId,
        { conflicts: `CONFLICT_FLAG: ${"detail ".repeat(40)} #${i}` },
        llm
      );
    }

    const context = await buildTieredPromptContext(jobId);

    // Every load-bearing node is present VERBATIM (none dropped to fit budget).
    for (let i = 0; i < 30; i++) {
      expect(context).toContain(`#${i}`);
    }

    // Boundary assertion: the rendered Tier-1 section is the ONLY content here
    // (no tier 0 seeded, no compression). Its TIER_BUDGETS[1] cap is 5000 chars,
    // yet the load-bearing entries push the rendered content past that cap —
    // proving the budget is exceeded ONLY because load-bearing entries are
    // retained rather than truncated.
    const TIER1_BUDGET = 5000;
    expect(context.length).toBeGreaterThan(TIER1_BUDGET);

    // A budget-exceeded warning was emitted for exactly that reason.
    const overBudgetWarn = warn.mock.calls.some((c) =>
      String(c[0]).includes("exceeds budget")
    );
    expect(overBudgetWarn).toBe(true);
  });
});

describe("tractatusMemory — skeleton + live-tier basics (spec Part 12)", () => {
  it("preserves every commitment-ledger entry verbatim in Tier 0", async () => {
    const jobId = randomUUID();
    const ledger = [
      "ASSERTS: claim one",
      "REJECTS: claim two is false",
      "ASSUMES: assumption three",
    ];
    await skeletonToTier0(jobId, { thesis: "T", commitmentLedger: ledger });
    const t0 = (await loadAllTiers(jobId)).find((t) => t.tier === 0)!;
    const values = Object.values(t0.tree);
    for (const entry of ledger) expect(values).toContain(entry);
  });

  it("appends to Tier 1 without mutating prior nodes", async () => {
    const jobId = randomUUID();
    const llm = makeDroppingLLM();
    await updateLiveTier(jobId, { newClaims: ["first"] }, llm);
    const before = { ...(await loadAllTiers(jobId)).find((t) => t.tier === 1)!.tree };
    await updateLiveTier(jobId, { newClaims: ["second"] }, llm);
    const after = (await loadAllTiers(jobId)).find((t) => t.tier === 1)!.tree;
    for (const k of Object.keys(before)) expect(after[k]).toBe(before[k]);
    expect(Object.keys(after).length).toBe(Object.keys(before).length + 1);
  });
});
