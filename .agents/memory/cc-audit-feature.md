---
name: CC per-job post-processing pattern
description: How to safely add features that act on a finished CC long-answer job
---
To add any feature that operates on a specific finished CC answer (audit, citation-check, repair):
- The client only learns the job's identity from the CC pipeline's `complete` SSE event — capture it there. Non-CC answer paths have no job and no coherence memory, so reset that captured id on every non-CC result or a stale action button lingers.
- Expose a thin server wrapper that injects the provider call into the coherence helper, rather than exporting the low-level provider function.
- **Authorization:** jobs are looked up by id only (no owner filter in the lookup), so any per-job route MUST verify the job belongs to the session user, returning 404 on mismatch. Skipping this is an IDOR.

**Why:** a code review rejected the first cut of the audit feature for exactly this missing ownership check.
