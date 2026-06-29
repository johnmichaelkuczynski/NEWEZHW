---
name: Tractatus tiered memory
description: How long-document coherence (CC engine) memory works and the key-collision trap to avoid.
---

# Tractatus-Skeleton Fusion (CC long-document coherence)

`server/services/tractatusMemory.ts` is the single owner of the tiered memory that keeps
long-document generation coherent. It is injected into `ccService.ts` `runCCPipeline`
Pass 2: Tier 0 (skeleton) seeded after extraction, `buildTieredPromptContext` injected per
chunk, `updateLiveTier` called after each chunk delta. Short answers (`/api/process-text`)
never touch this — keep that path untouched and fast.

## Node-id allocation must be max-suffix+1, never `Object.keys(tree).length`
**Rule:** when appending nodes to a tier (`1.${n}`, `${tier}.${n}`), compute the next id as
`max(existing numeric suffixes for that tier) + 1` (see `nextSeq`).
**Why:** compression *trims* a source tier to sparse keys (e.g. `1.120..1.149` plus
never-evicted load-bearing nodes). A length-based counter then restarts low and silently
**overwrites** surviving nodes — losing memory and reintroducing the exact drift/contradiction
the architecture exists to prevent. This was a real bug caught in review.
**How to apply:** any future tier that appends nodes after a trim/compression must use the
same monotonic allocator. Load-bearing keys use a different prefix (`lb.<origkey>`) so they
don't interfere with the per-tier numeric counter.

## Other load-bearing invariants (from the spec)
- REJECTS and CONFLICT_FLAG nodes are never evicted (budget) and never dropped (compression);
  re-inject them verbatim if the compressor omits them. Bust the char budget + warn rather
  than drop them.
- Archive-before-compression: snapshot to `cc_tractatus_archive` first; if that write fails,
  abort compression (archive is canonical).
- ANTI_SYCOPHANCY_CLAUSES is one shared constant used verbatim in 3 prompt sites (chunk gen,
  live-tier update, compression). Do not paraphrase per-site.
- Tables are `cc_`-prefixed (`cc_tractatus_tiers`, `cc_tractatus_archive`) to avoid colliding
  with the pre-existing project-scoped drizzle `tractatus_archive` table (different shape).
- LLM access is injected via a `callLLM(system,user,maxTokens)` closure so the module has no
  circular import with ccService.
