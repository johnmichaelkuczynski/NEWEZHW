import OpenAI from "openai";
import { db } from "../db";
import { coherentSessions, coherentChunks, stitchResults } from "../../shared/schema";
import { eq, asc, and } from "drizzle-orm";
import { z } from "zod";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "default_key",
});

const CHUNK_PAUSE_MS = 15000;
const MAX_WORDS_PER_CHUNK = 1400;
const LLM_TIMEOUT_MS = 180000;
const MAX_CHUNK_RETRIES = 3;
const MAX_REPAIR_ITERATIONS = 4;

// =============================================================================
// TYPES
// =============================================================================

interface SourceClaim {
  id: string;
  claim: string;
  category: string;
  dependencies: string[];
}

interface StructuralRequirement {
  id: string;
  requirement: string;
  appliesTo: "all" | "first" | "middle" | "final";
  verifiable: string;
}

interface GlobalSkeleton {
  sourceClaims: SourceClaim[];
  allowedTopics: string[];
  forbiddenTopics: string[];
  keyTerms: Record<string, string>;
  outputFormat: string;
  structuralRequirements: StructuralRequirement[];
  mustReferenceEarlier: boolean;
  referenceInstructions: string;
  requiresBalance: boolean;
  balanceDescription: string;
  totalTargetWords: number;
  wordsPerChunk: number;
  logicalSections: string[];
  speakerNames?: string[];
  strictOutline?: StrictOutline; // NEW: the strict enforceable outline
}

interface ChunkPlan {
  chunkIndex: number;
  position: "first" | "middle" | "final";
  claimsToAddress: string[];
  structuralRequirementsForThisChunk: string[];
  mustReference: string[];
  targetWords: number;
  section: string;
}

interface ChunkDelta {
  claimsAddressed: string[];
  quotableContent: string[];
  topicsIntroduced: string[];
  wordCount: number;
  speakerBalance?: { speaker1: number; speaker2: number };
  violations: string[];
}

interface StitchValidation {
  claimsCovered: Record<string, boolean>;
  claimsMissing: string[];
  topicViolations: string[];
  structuralViolations: string[];
  balanceIssue: string | null;
  backReferenceCheck: { required: boolean; satisfied: boolean; details: string };
  repairPlan: { chunkIndex: number; issue: string; action: string }[];
  coherenceScore: "pass" | "needs_repair" | "critical_failure";
}

interface StreamEvent {
  type: "skeleton" | "plan" | "chunk" | "pause" | "stitch" | "repair" | "complete" | "error" | "status";
  data?: any;
}

// NEW: Strict Outline Schema
const OutlineSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  estimatedWords: z.number().int().positive(),
  mandatoryElements: z.array(z.string()),
  format: z.enum(["dialogue", "prose", "list", "mixed", "quote-heavy"]).optional(),
});

const StrictOutlineSchema = z.object({
  taskSummary: z.string(),
  totalEstimatedWords: z.number().int().positive(),
  sections: z.array(OutlineSectionSchema),
  globalConstraints: z.object({
    outputFormat: z.string().optional(),
    speakerNames: z.array(z.string()).optional(),
    requiresBalance: z.boolean().optional(),
    mustReferenceEarlier: z.boolean().optional(),
    forbiddenPatterns: z.array(z.string()).optional(),
    keyTerms: z.record(z.string(), z.string()).optional(),
  }).optional(),
});

export type StrictOutline = z.infer<typeof StrictOutlineSchema>;

// =============================================================================
// UTILITIES
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  expectJson: boolean = false
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await openai.chat.completions.create(
      {
        model: "gpt-4o", // changed to real model; adjust if you have access to others
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 4096,
        response_format: expectJson ? { type: "json_object" } : undefined,
      },
      { signal: controller.signal }
    );
    return response.choices[0].message.content || "";
  } finally {
    clearTimeout(timeoutId);
  }
}

async function safeParseJson(result: string): Promise<any> {
  try {
    return JSON.parse(result);
  } catch {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {}
    }
    return null;
  }
}

function computeOptimalWordCount(
  totalTarget: number,
  currentChunk: number,
  totalChunks: number,
  priorWordCounts: number[]
): number {
  const wordsSoFar = priorWordCounts.reduce((sum, wc) => sum + wc, 0);
  const remainingWords = totalTarget - wordsSoFar;
  const remainingChunks = totalChunks - currentChunk;
  return Math.floor(remainingWords / Math.max(1, remainingChunks));
}

async function compareAndModifyChunk(
  chunkOutput: string,
  instructions: string,
  previousChunk: string | null,
  optimalWords: number
): Promise<string> {
  const systemPrompt = `You are a coherence enforcer.
INSTRUCTIONS (first 2000 chars): ${instructions.substring(0, 2000)}
PREVIOUS CHUNK (if any): ${previousChunk ? previousChunk.substring(0, 2000) : "None - this is the first chunk"}
CURRENT CHUNK: ${chunkOutput.substring(0, 4000)}
TASK:
- Ensure perfect flow from previous chunk
- Enforce all user instructions exactly
- Target ~${optimalWords} words (±10%)
- Remove any drift, repetition, or format violation
- Modify only what's necessary; preserve content
- Return the full modified chunk text only
Output the modified chunk. Nothing else.`;
  return await callLLM(systemPrompt, "Modify the chunk.", false);
}

// =============================================================================
// PASS 1: BUILD STRICT OUTLINE (Enhanced Skeleton)
// =============================================================================

async function buildGlobalSkeleton(
  userPrompt: string,
  inputText: string,
  targetChunks: number
): Promise<GlobalSkeleton> {
  const systemPrompt = `You are an expert structural planner for long-form, highly constrained writing tasks.
Your ONLY job is to produce a strict, machine-enforceable section-by-section outline in valid JSON.
- Break the task into logical sections (acts, phases, arguments, etc.)
- Assign realistic word counts per section
- List concrete, machine-checkable mandatory elements for each section
- Detect format (especially dialogue) and speaker names
- Never output anything besides the JSON object.`;

  const userMessage = `TASK: ${userPrompt}

INPUT TEXT (if relevant): ${inputText.substring(0, 12000)}

Approximate target chunks: ${targetChunks}

Output exactly this JSON structure:
{
  "taskSummary": "string",
  "totalEstimatedWords": number,
  "sections": [
    {
      "id": "string",
      "title": "string",
      "description": "string",
      "estimatedWords": number,
      "mandatoryElements": ["string"],
      "format": "dialogue|prose|list|mixed|quote-heavy" (optional)
    }
  ],
  "globalConstraints": {
    "outputFormat": "string (e.g. pure dialogue, no narration)",
    "speakerNames": ["Speaker1", "Speaker2"] (optional),
    "requiresBalance": boolean (optional),
    "mustReferenceEarlier": boolean (optional),
    "forbiddenPatterns": ["string"] (optional),
    "keyTerms": { "term": "definition" } (optional)
  }
}`;

  const raw = await callLLM(systemPrompt, userMessage, true);
  const parsed = await safeParseJson(raw);

  let strictOutline: StrictOutline;
  try {
    strictOutline = StrictOutlineSchema.parse(parsed);
  } catch (err) {
    console.error("Strict outline validation failed:", err);
    // Fallback minimal outline
    strictOutline = {
      taskSummary: "Complete the requested task",
      totalEstimatedWords: 4000,
      sections: [{
        id: "sec-1",
        title: "Main Content",
        description: "Generate the full response according to the prompt",
        estimatedWords: 4000,
        mandatoryElements: [],
      }],
      globalConstraints: { outputFormat: "text" },
    };
  }

  // Convert to legacy GlobalSkeleton format for backward compatibility
  const sourceClaims: SourceClaim[] = strictOutline.sections.flatMap((sec, i) =>
    sec.mandatoryElements.map((el, j) => ({
      id: `${sec.id}-mand-${j}`,
      claim: el,
      category: sec.title,
      dependencies: [],
    }))
  );

  const logicalSections = strictOutline.sections.map(s => s.title);

  return {
    sourceClaims,
    allowedTopics: [],
    forbiddenTopics: strictOutline.globalConstraints?.forbiddenPatterns || [],
    keyTerms: strictOutline.globalConstraints?.keyTerms || {},
    outputFormat: strictOutline.globalConstraints?.outputFormat || "text",
    structuralRequirements: strictOutline.sections.map((sec, i) => ({
      id: `struct-${i}`,
      requirement: `${sec.title}: ${sec.description}`,
      appliesTo: i === 0 ? "first" : "all",
      verifiable: sec.mandatoryElements.join(", "),
    })),
    mustReferenceEarlier: strictOutline.globalConstraints?.mustReferenceEarlier ?? false,
    referenceInstructions: "Refer back to earlier arguments naturally",
    requiresBalance: strictOutline.globalConstraints?.requiresBalance ?? false,
    balanceDescription: "Roughly equal contribution from all speakers",
    totalTargetWords: strictOutline.totalEstimatedWords,
    wordsPerChunk: Math.floor(strictOutline.totalEstimatedWords / Math.max(1, targetChunks)),
    logicalSections,
    speakerNames: strictOutline.globalConstraints?.speakerNames,
    strictOutline, // <-- NEW: available for the rest of the pipeline
  };
}

// =============================================================================
// CHUNK PLANNING (unchanged - you can keep your existing implementation)
// =============================================================================

function buildChunkPlans(/* your existing params */): ChunkPlan[] {
  // Keep your current logic — it will now use the richer skeleton
  // For now, you can leave this as-is
  return [];
}

// =============================================================================
// PROCESS CHUNK, VALIDATE CHUNK, STITCH, REPAIR
// =============================================================================

// Keep ALL your existing implementations of:
// - processChunk
// - validateChunk
// - runStitchPass
// - executeRepair
// exactly as they were. They will continue to work.

async function processChunk(/* ... */) {
  // your existing code
}

async function validateChunk(/* ... */) {
  // your existing code
}

async function runStitchPass(/* ... */) {
  // your existing code
}

async function executeRepair(/* ... */) {
  // your existing code
}

// =============================================================================
// MAIN SERVICE CLASS
// =============================================================================

export class CoherenceService {
  async generateSkeletonOnly(userPrompt: string, inputText: string): Promise<StrictOutline | null> {
    try {
      const skeleton = await buildGlobalSkeleton(userPrompt, inputText, 10);
      return skeleton.strictOutline || null;
    } catch (err) {
      console.error("generateSkeletonOnly error:", err);
      return null;
    }
  }

  async *processLargeDocument(
    userId: number,
    sessionType: string,
    userPrompt: string,
    inputText: string,
    estimatedChunks: number = 10
  ): AsyncGenerator<StreamEvent> {
    let fullOutput = "";
    let generatedSections: string[] = [];

    try {
      // === PHASE 1: Build Strict Outline ===
      const skeleton = await buildGlobalSkeleton(userPrompt, inputText, estimatedChunks);

      if (!skeleton.strictOutline) {
        throw new Error("Failed to generate strict outline");
      }

      const { strictOutline } = skeleton;

      yield {
        type: "skeleton",
        data: {
          ...skeleton,
          strictOutline,
        },
      };

      // === PHASE 2: Section-by-Section Generation ===
      for (let i = 0; i < strictOutline.sections.length; i++) {
        const section = strictOutline.sections[i];
        const isFirst = i === 0;
        const isLast = i === strictOutline.sections.length - 1;

        yield {
          type: "status",
          data: `Generating section ${i + 1}/${strictOutline.sections.length}: ${section.title} (~${section.estimatedWords} words)`,
        };

        const previousContent = generatedSections.slice(-2).join("\n\n");
        
        const systemPrompt = `You are an expert writer producing high-quality, constrained long-form output.

TASK SUMMARY: ${strictOutline.taskSummary}

CURRENT SECTION: ${section.title}
SECTION DESCRIPTION: ${section.description}
TARGET WORDS: ${section.estimatedWords}
MANDATORY ELEMENTS for this section: ${section.mandatoryElements.join("; ") || "None specified"}

${strictOutline.globalConstraints?.outputFormat ? `OUTPUT FORMAT: ${strictOutline.globalConstraints.outputFormat}` : ""}
${strictOutline.globalConstraints?.speakerNames?.length ? `SPEAKER NAMES: ${strictOutline.globalConstraints.speakerNames.join(", ")}` : ""}
${strictOutline.globalConstraints?.forbiddenPatterns?.length ? `FORBIDDEN PATTERNS: ${strictOutline.globalConstraints.forbiddenPatterns.join(", ")}` : ""}

${isFirst ? "This is the FIRST section. Open strong." : ""}
${isLast ? "This is the FINAL section. Provide closure and refer back to earlier points." : ""}
${!isFirst && previousContent ? `PREVIOUS CONTENT (for continuity):\n${previousContent.substring(0, 3000)}` : ""}

CRITICAL RULES:
- Produce exactly the content for this section only
- Meet the target word count (${section.estimatedWords} words ±15%)
- Include ALL mandatory elements listed above
- Maintain perfect continuity with previous sections
- No meta-commentary or explanations - just the content
- Write in compressed, clear style - one claim per sentence, no puffery`;

        const userMessage = `Generate the content for section "${section.title}" now. Input context (if relevant): ${inputText.substring(0, 5000)}`;

        let sectionContent = await callLLM(systemPrompt, userMessage, false);
        let sectionWordCount = countWords(sectionContent);
        const minRequiredWords = Math.floor(section.estimatedWords * 0.8);
        
        // RETRY LOOP: If section is too short, retry with expansion feedback
        let retryAttempt = 0;
        const maxRetries = 2;
        while (sectionWordCount < minRequiredWords && retryAttempt < maxRetries) {
          retryAttempt++;
          yield {
            type: "status",
            data: `Section ${i + 1} too short (${sectionWordCount}/${minRequiredWords} min words). Expanding... (attempt ${retryAttempt})`,
          };
          
          const expansionPrompt = `${systemPrompt}

CRITICAL EXPANSION REQUIRED: Your previous output was only ${sectionWordCount} words. The minimum required is ${minRequiredWords} words.
Expand to FULL estimated words (${section.estimatedWords}). Cover ALL mandatory elements thoroughly: ${section.mandatoryElements.join("; ")}.
Do NOT summarize - provide complete, detailed content for every point.`;

          sectionContent = await callLLM(expansionPrompt, userMessage, false);
          sectionWordCount = countWords(sectionContent);
        }
        
        // Add to accumulated output
        generatedSections.push(sectionContent);
        fullOutput += sectionContent + "\n\n";

        yield {
          type: "chunk",
          data: {
            sectionIndex: i,
            sectionTitle: section.title,
            content: sectionContent,
            wordCount: sectionWordCount,
          },
        };

        // Pause between sections (except after the last one)
        if (!isLast && strictOutline.sections.length > 1) {
          yield {
            type: "pause",
            data: "Pausing before next section...",
          };
          await sleep(5000);
        }
      }

      // === PHASE 2.5: Validate Mandatory Elements Coverage ===
      yield {
        type: "status",
        data: "Validating mandatory elements coverage...",
      };

      // Check each section's mandatory elements are present
      for (let i = 0; i < strictOutline.sections.length; i++) {
        const section = strictOutline.sections[i];
        const sectionContent = generatedSections[i] || "";
        const sectionLower = sectionContent.toLowerCase();
        
        const missingElements = section.mandatoryElements.filter(elem => {
          // Check if element keywords appear in section
          const keywords = elem.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          const matchCount = keywords.filter(kw => sectionLower.includes(kw)).length;
          return matchCount < Math.ceil(keywords.length * 0.5); // At least 50% of keywords should appear
        });

        if (missingElements.length > 0) {
          yield {
            type: "status",
            data: `Section ${i + 1} missing elements: ${missingElements.slice(0, 3).join(", ")}. Regenerating...`,
          };

          const regeneratePrompt = `You are an expert writer. Your previous section FAILED to include mandatory elements.

SECTION: ${section.title}
MISSING MANDATORY ELEMENTS: ${missingElements.join("; ")}

You MUST include ALL of these elements in your regenerated content.
Previous content for context: ${sectionContent.substring(0, 2000)}

TARGET WORDS: ${section.estimatedWords}
Write the complete section now, ensuring ALL mandatory elements are explicitly addressed.`;

          const regeneratedContent = await callLLM(regeneratePrompt, `Regenerate section "${section.title}" with ALL mandatory elements.`, false);
          
          // Replace the section
          generatedSections[i] = regeneratedContent;
          
          // Rebuild fullOutput
          fullOutput = generatedSections.join("\n\n");
          
          yield {
            type: "chunk",
            data: {
              sectionIndex: i,
              sectionTitle: section.title + " (regenerated)",
              content: regeneratedContent,
              wordCount: countWords(regeneratedContent),
            },
          };
        }
      }

      // === PHASE 3: Final stitch/polish pass ===
      yield {
        type: "status",
        data: "Running final coherence check and polish...",
      };

      // Check for multi-question tasks and ensure completion
      const questionPatterns = [
        /answer(?:ing)?\s+(?:all\s+)?(\d+)\s+questions?/i,
        /(\d+)\s+questions?\s+(?:to\s+)?answer/i,
        /questions?\s+(\d+)/i,
        /\b(\d+)\s+(?:problems?|exercises?|items?)\b/i,
      ];
      
      let expectedQuestionCount = 0;
      for (const pattern of questionPatterns) {
        const match = userPrompt.match(pattern) || inputText.match(pattern);
        if (match && parseInt(match[1]) > 1) {
          expectedQuestionCount = parseInt(match[1]);
          break;
        }
      }

      // If multi-question task detected, do final synthesis check
      if (expectedQuestionCount > 5) {
        yield {
          type: "status",
          data: `Verifying all ${expectedQuestionCount} questions are fully answered...`,
        };

        const synthesisPrompt = `You are a completion validator. Review this output and verify it answers ALL ${expectedQuestionCount} questions/items requested.

ORIGINAL TASK: ${userPrompt.substring(0, 2000)}

CURRENT OUTPUT (first 8000 chars):
${fullOutput.substring(0, 8000)}

If any questions are missing or incompletely answered, list them. Otherwise respond with "COMPLETE".`;

        const validationResult = await callLLM(synthesisPrompt, "Check completion", false);
        // Force numbered question check
        const numberedMatches = fullOutput.match(/(\d+)\.\s/g) || [];
        const highestNumber = numberedMatches.reduce((max, match) => {
          const num = parseInt(match);
          return num > max ? num : max;
        }, 0);

        if (highestNumber < expectedQuestionCount) {
          yield {
            type: "status",
            data: `Only ${highestNumber}/${expectedQuestionCount} questions answered. Adding missing ones...`,
          };
          const missingPrompt = `Complete the missing numbered questions ${highestNumber + 1} to ${expectedQuestionCount}.
        Original task: ${userPrompt.substring(0, 2000)}
        Previous content: ${fullOutput.substring(-4000)}
        Answer each missing question in one paragraph, numbered correctly.
        Then add the full 2-page synthesis at the end.`;
          const missingAnswers = await callLLM("You are completing a multi-question assignment.", missingPrompt, false);
          fullOutput += "\n\n" + missingAnswers;
          yield {
            type: "chunk",
            data: {
              content: missingAnswers,
              wordCount: countWords(missingAnswers),
            },
          };
        }
        // If incomplete, add a final synthesis section
        if (!validationResult.includes("COMPLETE")) {
          yield {
            type: "status",
            data: "Adding missing content for incomplete questions...",
          };

          const completionPrompt = `Complete the following task by providing ONLY the missing answers. 
The user requested ${expectedQuestionCount} questions/items be answered.

Missing items identified: ${validationResult.substring(0, 1500)}

TASK CONTEXT: ${userPrompt.substring(0, 2000)}

Provide the missing answers now in the same format as the previous content. Ensure all ${expectedQuestionCount} questions are answered with full synthesis.`;

          const missingContent = await callLLM(completionPrompt, "Provide missing answers", false);
          
          if (countWords(missingContent) > 50) {
            fullOutput += "\n\n" + missingContent;
            generatedSections.push(missingContent);
            
            yield {
              type: "chunk",
              data: {
                sectionIndex: generatedSections.length - 1,
                sectionTitle: "Additional Answers (completion)",
                content: missingContent,
                wordCount: countWords(missingContent),
              },
            };
          }
        }
      }

      yield {
        type: "complete",
        data: {
          content: fullOutput.trim(),
          totalWords: countWords(fullOutput),
          sectionsGenerated: generatedSections.length,
        },
      };
    } catch (error: any) {
      yield {
        type: "error",
        data: error.message || "Unknown error during document generation",
      };
    }
  }
}

export const coherenceService = new CoherenceService();