import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { db } from "../db";
import { projects, tractatusArchive } from "../../shared/schema";
import { eq, and, isNull } from "drizzle-orm";

// @ts-ignore
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "default_key" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "default_key" });

const COMPRESSION_THRESHOLD = 200;
const TIER_CHAR_BUDGETS: Record<number, number> = { 1: 8000, 2: 4000, 3: 2000 };

// =============================================================================
// CORE HELPERS
// =============================================================================

/**
 * Render a Tractatus tree as compact `key: value\n` lines — 30-40% smaller
 * than JSON.stringify with zero semantic loss.
 */
export function compactTreeString(tree: Record<string, string>): string {
  return Object.entries(tree)
    .sort(([a], [b]) => {
      const aParts = a.split(".").map(Number);
      const bParts = b.split(".").map(Number);
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const diff = (aParts[i] || 0) - (bParts[i] || 0);
        if (diff !== 0) return diff;
      }
      return 0;
    })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/**
 * Tolerant JSON parser for Tractatus update output.
 * Strips markdown fences, handles truncated JSON, retries on malformed output.
 */
export function tryParseTractatusJSON(text: string): Record<string, string> | null {
  // Strip markdown fences
  let cleaned = text
    .replace(/^```json\s*/m, "")
    .replace(/^```\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();

  // Try direct parse
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {}

  // Try to extract the first {...} block
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {}
  }

  // Last resort: try to close unclosed JSON
  if (cleaned.startsWith("{") && !cleaned.endsWith("}")) {
    try {
      const parsed = JSON.parse(cleaned + '"}');
      if (typeof parsed === "object") return parsed;
    } catch {}
  }

  return null;
}

// =============================================================================
// TIERED MEMORY LOADING
// =============================================================================

interface TieredMemory {
  tiers: Array<{
    tier: number;
    label: string;
    nodeCount: number;
    compactString: string;
    charBudget: number;
  }>;
  totalChars: number;
}

/**
 * Walk the parent_project_id chain BFS and assemble all memory tiers,
 * highest (oldest) tier first so the system prompt is chronologically ordered.
 */
export async function loadTieredMemory(projectId: number): Promise<TieredMemory> {
  const tiers: TieredMemory["tiers"] = [];

  // Load all tier rows for this project family (live + summary tiers)
  const allRows = await db
    .select()
    .from(projects)
    .where(
      // Get the live project and all summary-tier children
      eq(projects.id, projectId)
    );

  // Also load summary tier rows (parent_project_id = projectId, tractatusTier > 1)
  const summaryRows = await db
    .select()
    .from(projects)
    .where(eq(projects.parentProjectId, projectId));

  const allProjectRows = [...allRows, ...summaryRows].sort(
    (a, b) => (b.tractatusTier ?? 1) - (a.tractatusTier ?? 1)
  );

  let totalChars = 0;

  for (const row of allProjectRows) {
    const tier = row.tractatusTier ?? 1;
    const tree = (row.tractatusTree as Record<string, string>) || {};
    const nodeCount = Object.keys(tree).length;
    if (nodeCount === 0) continue;

    const charBudget = TIER_CHAR_BUDGETS[tier] ?? 2000;
    let compactString = compactTreeString(tree);
    if (compactString.length > charBudget) {
      compactString = compactString.substring(0, charBudget) + "\n... [truncated]";
    }

    const tierLabel =
      tier === 1
        ? "Recent (high resolution)"
        : tier === 2
        ? "Summary (medium resolution)"
        : `Archive Tier ${tier} (lower resolution)`;

    tiers.push({ tier, label: tierLabel, nodeCount, compactString, charBudget });
    totalChars += compactString.length;
  }

  return { tiers, totalChars };
}

// =============================================================================
// SYSTEM PROMPT BUILDER
// =============================================================================

/**
 * Build the system prompt with tiered Tractatus memory injected.
 * Anti-sycophancy rules are mandatory across all three enforcement points.
 */
export function buildTractatusSystemPrompt(
  tieredMemory: TieredMemory,
  projectName: string,
  sessionTranscript?: Array<{ role: string; content: string }>
): string {
  const lines: string[] = [];

  lines.push(`You are a long-term academic and research assistant working on the project: "${projectName}".`);
  lines.push("");
  lines.push("UNIVERSAL RULES (non-negotiable):");
  lines.push("- NEVER fabricate facts, citations, dates, or outcomes.");
  lines.push("- NEVER reframe a defeat, failure, or negative finding as an opportunity or lesson.");
  lines.push("- If the user lost an argument, record it as a loss — not as strategic repositioning.");
  lines.push("- Preserve adverse findings with FULL fidelity and equal weight to positive ones.");
  lines.push("- Every analysis must be rigorous: name specific sources, give exact figures, take explicit positions.");
  lines.push("- No padding, no preamble, no editorializing. Direct and compressed output only.");
  lines.push("");

  if (tieredMemory.tiers.length > 0) {
    lines.push("=== PROJECT MEMORY (Tractatus Tree) ===");
    lines.push("");
    lines.push("The following is the cumulative memory of this project, organized by tier.");
    lines.push("Tier 1 is the most recent and highest-resolution. Higher tiers are compressed summaries of older sessions.");
    lines.push("Tag vocabulary: ASSERTS (positive claim), REJECTS (denied claim), ASSUMES (working assumption),");
    lines.push("OPEN (unresolved question), RESOLVED (closed item), DOCUMENT (uploaded source), QUESTION (inquiry).");
    lines.push("");

    for (const tier of tieredMemory.tiers) {
      lines.push(`### Tier ${tier.tier} — ${tier.label} (${tier.nodeCount} nodes):`);
      lines.push(tier.compactString);
      lines.push("");
    }
  } else {
    lines.push("=== PROJECT MEMORY ===");
    lines.push("No memory recorded yet. This is the first session.");
    lines.push("");
  }

  lines.push("=== YOUR TASK ===");
  lines.push("Answer the user's message using the project memory above as full context.");
  lines.push("If the memory contains a relevant prior conclusion, cite it explicitly rather than rediscovering it.");
  lines.push("If the memory is stale or incomplete, say so — do not fabricate missing details.");

  return lines.join("\n");
}

// =============================================================================
// TRACTATUS UPDATE (runs after each chat exchange, SSE)
// =============================================================================

const TRACTATUS_UPDATE_SYSTEM = `You output ONLY a valid JSON object. No markdown fences, no commentary, nothing else.
The object maps Wittgenstein-style decimal keys ("1.0", "1.1", "1.1.1", "2.0") to tagged summary strings.
Tag vocabulary — each value MUST begin with one of these tags:
  ASSERTS:   a positive claim now in the record
  REJECTS:   a claim explicitly denied or refuted
  ASSUMES:   a working assumption not yet verified
  OPEN:      an unresolved question or thread
  RESOLVED:  a previously open item now closed
  DOCUMENT:  a reference to an uploaded or cited source
  QUESTION:  a question the project is trying to answer
Rules:
- Add ONLY new nodes for what was genuinely new in this exchange.
- Use existing numbering context to pick the right parent. New top-level topics get the next major number.
- If the user LOST an argument or received a negative finding, record it as a REJECTS or note the defeat explicitly under ASSERTS.
- NEVER reframe a defeat as an opportunity. NEVER fabricate outcomes.
- Return 1 to 8 new nodes maximum. Output only the JSON object.`;

/**
 * Update the Tractatus tree after a chat exchange.
 * Returns an SSE send function to stream the update progress to the client.
 * Merges new nodes into the existing tree, triggers compression if needed.
 */
export async function updateTractatusTree(
  projectId: number,
  existingTree: Record<string, string>,
  userMessage: string,
  assistantMessage: string,
  sendFn: (data: string) => void
): Promise<Record<string, string>> {
  const existingCompact = compactTreeString(existingTree);
  const userExcerpt = userMessage.substring(0, 4000);
  const assistantExcerpt = assistantMessage.substring(0, 8000);

  const userPrompt = `EXISTING TREE:
${existingCompact || "(empty — this is the first message)"}

USER MESSAGE:
${userExcerpt}

ASSISTANT RESPONSE:
${assistantExcerpt}

Produce a JSON object with 1-8 new Tractatus nodes capturing only what is genuinely new from this exchange.`;

  let rawJson = "";

  try {
    // Stream the update so the client sees it forming
    const stream = await anthropic.messages.stream({
      model: "claude-opus-4-5",
      max_tokens: 2048,
      system: TRACTATUS_UPDATE_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        rawJson += event.delta.text;
        sendFn(JSON.stringify({ type: "tractatus_delta", delta: event.delta.text }));
      }
    }

    let newNodes = tryParseTractatusJSON(rawJson);

    // Retry with simpler prompt if parsing fails
    if (!newNodes) {
      const retryRaw = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 1024,
        system: "Output ONLY a valid JSON object with string keys and string values. No markdown.",
        messages: [
          {
            role: "user",
            content: `Summarize this exchange into 1-3 Tractatus tree nodes. Keys: decimal strings like "1.0". Values: start with ASSERTS/REJECTS/ASSUMES/OPEN/RESOLVED/DOCUMENT/QUESTION.\n\nUser: ${userExcerpt.substring(0, 1000)}\nAssistant: ${assistantExcerpt.substring(0, 2000)}`,
          },
        ],
      });
      const retryText = retryRaw.content[0].type === "text" ? retryRaw.content[0].text : "";
      newNodes = tryParseTractatusJSON(retryText);
    }

    if (!newNodes) {
      sendFn(JSON.stringify({ type: "tractatus_error", message: "Parse failed — skipping update" }));
      return existingTree;
    }

    // Merge new nodes into existing tree
    const mergedTree = { ...existingTree, ...newNodes };
    const nodeCount = Object.keys(mergedTree).length;

    // Persist to DB
    await db
      .update(projects)
      .set({
        tractatusTree: mergedTree,
        lastTreeUpdate: new Date(),
      })
      .where(eq(projects.id, projectId));

    sendFn(JSON.stringify({ type: "tractatus_complete", nodeCount }));

    // Trigger compression if threshold reached
    if (nodeCount >= COMPRESSION_THRESHOLD) {
      await compressTractatusTier(projectId, mergedTree, nodeCount, sendFn);
      // Return the trimmed live tree
      const [updated] = await db.select().from(projects).where(eq(projects.id, projectId));
      return (updated?.tractatusTree as Record<string, string>) || {};
    }

    return mergedTree;
  } catch (err: any) {
    sendFn(JSON.stringify({ type: "tractatus_error", message: err.message }));
    return existingTree;
  }
}

// =============================================================================
// COMPRESSION (transactional — runs when node count >= 200)
// =============================================================================

const COMPRESSION_SYSTEM = `You are a memory compressor for a Tractatus tree.
You output ONLY a valid JSON object. No markdown fences, no commentary.
Rules:
- Reduce to 50-80 nodes that preserve the most important claims, decisions, and findings.
- PRESERVE adverse findings, defeats, rejections, dates, and amounts EXACTLY — word for word.
- NEVER reframe a defeat as an opportunity. NEVER soften bad news.
- Use the same tag vocabulary: ASSERTS, REJECTS, ASSUMES, OPEN, RESOLVED, DOCUMENT, QUESTION.
- Renumber keys starting from 1.0 in the compressed output.
- Return ONLY the JSON object.`;

/**
 * Compress a Tier N Tractatus tree into a Tier N+1 summary.
 * Runs inside a logical transaction: snapshot → LLM compress → merge/create tier → trim live tree.
 */
export async function compressTractatusTier(
  projectId: number,
  fullTree: Record<string, string>,
  nodeCount: number,
  sendFn: (data: string) => void
): Promise<void> {
  sendFn(JSON.stringify({ type: "compression_start", nodeCount }));

  try {
    // Step 1: Snapshot into tractatus_archive
    const [liveProject] = await db.select().from(projects).where(eq(projects.id, projectId));
    const currentTier = liveProject?.tractatusTier ?? 1;

    await db.insert(tractatusArchive).values({
      projectId,
      tier: currentTier,
      tree: fullTree,
      nodeCount,
    });

    // Step 2: Compress via LLM
    const compressPrompt = `Compress this Tractatus tree (${nodeCount} nodes) to 50-80 nodes. Preserve all adverse findings, defeats, and factual specifics exactly:\n\n${compactTreeString(fullTree)}`;

    const compressResult = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 8192,
      system: COMPRESSION_SYSTEM,
      messages: [{ role: "user", content: compressPrompt }],
    });

    const rawJson = compressResult.content[0].type === "text" ? compressResult.content[0].text : "";
    const summaryTree = tryParseTractatusJSON(rawJson);

    if (!summaryTree) {
      sendFn(JSON.stringify({ type: "compression_error", message: "Summary parse failed — skipping compression" }));
      return;
    }

    const summaryNodeCount = Object.keys(summaryTree).length;
    const nextTier = currentTier + 1;

    // Step 3: Merge into existing tier+1 summary, or create new summary project row
    const [existingSummary] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.parentProjectId, projectId), eq(projects.tractatusTier, nextTier)));

    if (existingSummary) {
      const merged = { ...(existingSummary.tractatusTree as Record<string, string>), ...summaryTree };
      await db
        .update(projects)
        .set({ tractatusTree: merged, lastTreeUpdate: new Date() })
        .where(eq(projects.id, existingSummary.id));

      // If the merged summary itself exceeds threshold, recurse
      if (Object.keys(merged).length >= COMPRESSION_THRESHOLD) {
        await compressTractatusTier(existingSummary.id, merged, Object.keys(merged).length, sendFn);
      }
    } else {
      // Create new summary project row
      const [summaryProject] = await db
        .insert(projects)
        .values({
          userId: liveProject?.userId ?? null,
          name: `${liveProject?.name ?? "Project"} — Tier ${nextTier} Summary`,
          tractatusTree: summaryTree,
          tractatusTier: nextTier,
          parentProjectId: projectId,
          lastTreeUpdate: new Date(),
        })
        .returning();

      if (summaryProject && Object.keys(summaryTree).length >= COMPRESSION_THRESHOLD) {
        await compressTractatusTier(summaryProject.id, summaryTree, Object.keys(summaryTree).length, sendFn);
      }
    }

    // Step 4: Trim live tree to the 30 most recent nodes (no cliff drop)
    const allEntries = Object.entries(fullTree);
    const keptEntries = allEntries.slice(-30);
    const trimmedTree = Object.fromEntries(keptEntries);

    await db
      .update(projects)
      .set({
        tractatusTree: trimmedTree,
        compressionCount: (liveProject?.compressionCount ?? 0) + 1,
        lastTreeUpdate: new Date(),
      })
      .where(eq(projects.id, projectId));

    sendFn(
      JSON.stringify({
        type: "compression_complete",
        originalNodes: nodeCount,
        summaryNodes: summaryNodeCount,
        liveTrimmedTo: keptEntries.length,
        tier: nextTier,
      })
    );
  } catch (err: any) {
    sendFn(JSON.stringify({ type: "compression_error", message: err.message }));
  }
}

// =============================================================================
// STALENESS DETECTION
// =============================================================================

export function getStalenessSeverity(
  lastTreeUpdate: Date | null,
  compressionCount: number
): { severity: "none" | "mild" | "warning" | "critical"; daysSinceUpdate: number } {
  if (!lastTreeUpdate) return { severity: "none", daysSinceUpdate: 0 };

  const daysSinceUpdate = Math.floor(
    (Date.now() - lastTreeUpdate.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (daysSinceUpdate >= 14 || compressionCount >= 5) {
    return { severity: "critical", daysSinceUpdate };
  }
  if (daysSinceUpdate >= 7 || compressionCount >= 3) {
    return { severity: "warning", daysSinceUpdate };
  }
  if (daysSinceUpdate >= 3 || compressionCount >= 2) {
    return { severity: "mild", daysSinceUpdate };
  }
  return { severity: "none", daysSinceUpdate };
}

// =============================================================================
// LONG-FORM GENERATION ENGINE (50K-word coherent documents)
// =============================================================================

/**
 * Three-pass large document generator.
 * Pass 1: Outline (sections with targets)
 * Pass 2: Section writing with continuation (streams each section live)
 * Pass 3: Global stitch — coherence check and repair pass
 */
export async function* generateLargeDocument(
  userPrompt: string,
  targetWords: number,
  llmProvider: "anthropic" | "openai" = "anthropic",
  sendFn?: (event: any) => void
): AsyncGenerator<{ type: string; data: any }> {
  function countWords(text: string): number {
    return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  }

  async function callLLM(system: string, user: string, maxTokens = 4096): Promise<string> {
    if (llmProvider === "anthropic") {
      const msg = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      });
      return msg.content[0].type === "text" ? msg.content[0].text : "";
    } else {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o",
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      return resp.choices[0].message.content || "";
    }
  }

  async function* streamLLM(system: string, user: string, maxTokens = 4096): AsyncGenerator<string> {
    if (llmProvider === "anthropic") {
      const stream = await anthropic.messages.stream({
        model: "claude-opus-4-5",
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield event.delta.text;
        }
      }
    } else {
      const stream = await openai.chat.completions.create({
        model: "gpt-4o",
        max_tokens: maxTokens,
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || "";
        if (delta) yield delta;
      }
    }
  }

  // ---- PASS 1: OUTLINE ----

  yield { type: "status", data: "Pass 1: Building outline..." };

  // Scale sections by target size
  const wordsPerSection =
    targetWords < 10000 ? 1500 : targetWords < 25000 ? 2500 : 3500;
  const estimatedSections = Math.ceil(targetWords / wordsPerSection);

  const outlineSystem = `You are a structural planner for long academic documents. Output ONLY a valid JSON object with this structure:
{
  "title": "string",
  "thesis": "string",
  "sections": [
    { "id": "s1", "title": "string", "description": "string", "targetWords": number, "mandatoryPoints": ["string"] }
  ],
  "globalConstraints": { "style": "string", "keyTerms": {"term": "definition"} }
}
No markdown fences. No commentary.`;

  const outlinePrompt = `Task: ${userPrompt}

Target: ${targetWords.toLocaleString()} words across approximately ${estimatedSections} sections (~${wordsPerSection} words each).

Produce a rigorous section-by-section outline. Each section must have a clear thesis, mandatory points, and a realistic word target summing close to ${targetWords}.`;

  let outlineRaw: string;
  try {
    outlineRaw = await callLLM(outlineSystem, outlinePrompt, 4096);
  } catch (err: any) {
    yield { type: "error", data: `Outline generation failed: ${err.message}` };
    return;
  }

  let outline: any;
  try {
    const cleaned = outlineRaw.replace(/^```json\s*/m, "").replace(/^```\s*/m, "").replace(/```\s*$/m, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    outline = JSON.parse(match ? match[0] : cleaned);
  } catch {
    yield { type: "error", data: "Could not parse outline JSON. Try a simpler prompt." };
    return;
  }

  const sections: Array<{ id: string; title: string; description: string; targetWords: number; mandatoryPoints: string[] }> =
    outline.sections || [];

  if (sections.length === 0) {
    yield { type: "error", data: "Outline produced no sections." };
    return;
  }

  yield {
    type: "outline_complete",
    data: { title: outline.title, thesis: outline.thesis, sections: sections.map((s) => ({ id: s.id, title: s.title, targetWords: s.targetWords })) },
  };

  // ---- PASS 2: SECTION WRITING ----

  yield { type: "status", data: `Pass 2: Writing ${sections.length} sections...` };

  const generatedSections: string[] = [];
  let totalWordsGenerated = 0;

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const previousSectionEnd = generatedSections.length > 0
      ? generatedSections[generatedSections.length - 1].slice(-2000)
      : null;

    // Recalculate per-section target accounting for words already generated
    const wordsRemaining = targetWords - totalWordsGenerated;
    const sectionsRemaining = sections.length - i;
    const adjustedTarget = Math.max(
      section.targetWords,
      Math.floor(wordsRemaining / Math.max(sectionsRemaining, 1))
    );

    yield {
      type: "section_start",
      data: { index: i, title: section.title, targetWords: adjustedTarget, totalSections: sections.length },
    };

    const sectionSystem = `You are writing section ${i + 1} of ${sections.length} of a ${targetWords.toLocaleString()}-word document.

DOCUMENT TASK: ${userPrompt.substring(0, 1000)}

THESIS: ${outline.thesis || ""}

YOUR SECTION: "${section.title}"
${section.description}

MANDATORY POINTS FOR THIS SECTION:
${section.mandatoryPoints.map((p: string, j: number) => `${j + 1}. ${p}`).join("\n")}

${previousSectionEnd ? `END OF PREVIOUS SECTION (for seamless continuation):\n${previousSectionEnd}` : ""}

CONSTRAINTS:
- Write EXACTLY ~${adjustedTarget} words (±10%). Count carefully.
- No headers unless the section title warrants one.
- No padding, no preamble ("In this section..."), no summarizing what you just said.
- Compressed, direct, academically rigorous prose.
- Cover ALL mandatory points.`;

    const sectionPrompt = `Write section ${i + 1}: "${section.title}" (target: ~${adjustedTarget} words).`;

    let sectionContent = "";
    let tokenBudget = Math.min(Math.ceil(adjustedTarget * 1.8), 8000);

    // Stream the section
    try {
      for await (const delta of streamLLM(sectionSystem, sectionPrompt, tokenBudget)) {
        sectionContent += delta;
        yield { type: "section_delta", data: { index: i, delta } };
      }
    } catch (err: any) {
      yield { type: "section_error", data: { index: i, message: err.message } };
      sectionContent = `[Section ${i + 1} generation failed: ${err.message}]`;
    }

    // If section is too short, continue writing
    let sectionWords = countWords(sectionContent);
    const shortfallThreshold = adjustedTarget * 0.75;

    if (sectionWords < shortfallThreshold && sectionWords > 0) {
      yield { type: "status", data: `Section ${i + 1}: ${sectionWords}/${adjustedTarget} words — extending...` };

      const continuationSystem = `Continue writing. DO NOT repeat what was already written. 
Target additional words: ~${adjustedTarget - sectionWords}.
Previous content ends with: ...${sectionContent.slice(-1500)}`;

      try {
        for await (const delta of streamLLM(continuationSystem, "Continue:", Math.ceil((adjustedTarget - sectionWords) * 1.8))) {
          sectionContent += delta;
          yield { type: "section_delta", data: { index: i, delta } };
        }
      } catch {}

      sectionWords = countWords(sectionContent);
    }

    generatedSections.push(sectionContent);
    totalWordsGenerated += sectionWords;

    yield {
      type: "section_complete",
      data: { index: i, title: section.title, wordCount: sectionWords, totalSoFar: totalWordsGenerated },
    };

    // Brief pause between sections to avoid rate limits
    if (i < sections.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // ---- PASS 3: GLOBAL STITCH ----

  yield { type: "status", data: "Pass 3: Global coherence check and stitch..." };

  const fullDraftRaw = generatedSections.join("\n\n");
  const fullDraftWords = countWords(fullDraftRaw);

  // Stitch summary (only read first/last 8K of document to fit context)
  const docSample = fullDraftRaw.length > 16000
    ? fullDraftRaw.substring(0, 8000) + "\n\n[... middle sections ...]\n\n" + fullDraftRaw.slice(-8000)
    : fullDraftRaw;

  const stitchSystem = `You are a coherence auditor for a long academic document.
Review the document sample and identify:
1. Cross-section contradictions or thesis drift
2. Terminology that shifts meaning between sections
3. Missing connective tissue between sections
4. Word count vs. target gap

Output ONLY a JSON object:
{
  "coherent": boolean,
  "issues": ["string"],
  "repairInstructions": "string",
  "estimatedWordCount": number
}`;

  let stitchResult: any = { coherent: true, issues: [], repairInstructions: "", estimatedWordCount: fullDraftWords };
  try {
    const stitchRaw = await callLLM(stitchSystem, `Document to audit:\n\n${docSample}\n\nTotal target: ${targetWords} words. Current count: ~${fullDraftWords}.`, 2048);
    const cleaned = stitchRaw.replace(/^```json\s*/m, "").replace(/^```\s*/m, "").replace(/```\s*$/m, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) stitchResult = JSON.parse(match[0]);
  } catch {}

  let finalOutput = fullDraftRaw;

  // Apply repairs if needed
  if (!stitchResult.coherent && stitchResult.repairInstructions) {
    yield { type: "status", data: "Applying coherence repairs..." };

    const repairSystem = `You are a document editor. Apply the following repairs to the document while preserving ALL content.
Do not remove sections. Do not change the thesis. Only improve transitions, resolve contradictions, and unify terminology.
Return the complete repaired document.`;

    try {
      let repaired = "";
      for await (const delta of streamLLM(
        repairSystem,
        `REPAIR INSTRUCTIONS: ${stitchResult.repairInstructions}\n\nDOCUMENT:\n${fullDraftRaw.substring(0, 40000)}`,
        Math.min(Math.ceil(fullDraftWords * 1.5), 8192)
      )) {
        repaired += delta;
        yield { type: "stitch_delta", data: delta };
      }
      if (countWords(repaired) > countWords(finalOutput) * 0.8) {
        finalOutput = repaired;
      }
    } catch {}
  }

  const finalWordCount = countWords(finalOutput);

  yield {
    type: "complete",
    data: {
      content: finalOutput,
      totalWords: finalWordCount,
      targetWords,
      sectionsGenerated: sections.length,
      coherenceIssues: stitchResult.issues || [],
    },
  };
}
