import { callOpenAI } from '../utils/openai';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

interface RewriteParams {
  inputText: string;
  styleText?: string;
  contentMixText?: string;
  customInstructions?: string;
  selectedPresets?: string[];
  mixingMode?: string;
}

function buildRewritePrompt(params: RewriteParams): string {
  const { inputText, styleText, contentMixText, customInstructions, selectedPresets, mixingMode } = params;
  
  let systemPrompt = `You are an expert rewriter. Your task is to rewrite the given text while maintaining its meaning but making it sound more natural and human-written.

MANDATORY WRITING RULES:
- Use compressed, Kuczynski-style writing: clear, direct, one claim per sentence
- Maximize content density
- NO meta-discourse ("In this essay...", "As we shall see...")
- NO throat-clearing phrases
- NO empty elaboration
- Temperature 0.2 - be precise, not creative

`;

  if (styleText) {
    systemPrompt += `\nMimic this writing style:\n${styleText.substring(0, 2000)}\n`;
  }

  if (contentMixText) {
    systemPrompt += `\nBlend in ideas/content from:\n${contentMixText.substring(0, 1500)}\n`;
  }

  if (selectedPresets && selectedPresets.length > 0) {
    systemPrompt += `\nApply these style presets: ${selectedPresets.join(", ")}\n`;
  }

  if (customInstructions) {
    systemPrompt += `\nAdditional instructions: ${customInstructions}\n`;
  }

  systemPrompt += `\nRewrite the following text. Output ONLY the rewritten text, nothing else:\n\n${inputText}`;

  return systemPrompt;
}

async function rewriteWithOpenAI(params: RewriteParams): Promise<string> {
  const prompt = buildRewritePrompt(params);
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 4096,
  });
  return response.choices[0]?.message?.content || params.inputText;
}

async function rewriteWithAnthropic(params: RewriteParams): Promise<string> {
  const prompt = buildRewritePrompt(params);
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });
  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock ? (textBlock as any).text : params.inputText;
}

async function rewriteWithDeepSeek(params: RewriteParams): Promise<string> {
  const prompt = buildRewritePrompt(params);
  const deepseekClient = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY || "",
  });
  const response = await deepseekClient.chat.completions.create({
    model: "deepseek-chat",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 4096,
  });
  return response.choices[0]?.message?.content || params.inputText;
}

export const aiProviderService = {
  async rewrite(provider: string, params: RewriteParams): Promise<string> {
    switch (provider.toLowerCase()) {
      case 'openai':
      case 'gpt-4':
      case 'gpt-4o':
        return rewriteWithOpenAI(params);
      case 'anthropic':
      case 'claude':
        return rewriteWithAnthropic(params);
      case 'deepseek':
        return rewriteWithDeepSeek(params);
      default:
        return rewriteWithOpenAI(params);
    }
  }
};

// Define the strict schema for the outline using Zod (great for validation + types)
const OutlineSectionSchema = z.object({
  id: z.string().describe("Unique identifier like 'act-1', 'section-2'"),
  title: z.string().describe("Short descriptive title"),
  estimatedWords: z.number().int().positive(),
  mandatoryElements: z.array(z.string()).describe("e.g., ['biochem_example', 'cite_study_2023', 'strong_recollection']"),
  description: z.string().describe("What this section should cover, in detail"),
  format: z.enum(["dialogue", "prose", "list", "code", "mixed"]).optional(),
});

const OutlineSchema = z.object({
  taskSummary: z.string(),
  totalEstimatedWords: z.number().int().positive(),
  sections: z.array(OutlineSectionSchema),
  globalConstraints: z.object({
    style: z.string().optional(),
    forbidden: z.array(z.string()).optional(), // e.g., ["essay_summary", "concluding_paragraph_early"]
  }).optional(),
});

export type Outline = z.infer<typeof OutlineSchema>;

export async function generateOutline(userPrompt: string, requirements: string): Promise<Outline> {
  const systemPrompt = `
You are an expert structural planner for long-form constrained generation.
Your job is to create a complete, enforceable outline in JSON for the requested output.
Break the task into logical sections/acts with precise boundaries.
Assign realistic word counts that sum close to the target.
Explicitly list mandatory elements that MUST appear in each section.

Rules:
- Use only the JSON format defined below.
- Do not add any explanation or text outside the JSON.
- Ensure mandatoryElements use clear, machine-checkable tags.
`;

  const userMessage = `
Task: ${userPrompt}

Additional requirements/constraints: ${requirements}

Target approximate word count (if any): extract from task or estimate reasonably.

Output exactly this JSON structure:
{
  "taskSummary": string,
  "totalEstimatedWords": number,
  "sections": [
    {
      "id": string,
      "title": string,
      "estimatedWords": number,
      "mandatoryElements": string[],
      "description": string,
      "format": "dialogue" | "prose" | "list" | etc (optional)
    }
    // ... more sections
  ],
  "globalConstraints": {
    "style": string (optional),
    "forbidden": string[] (optional)
  }
}
`;

  const raw = await callOpenAI({
    model: "gpt-4o", // or whatever strongest model you have access to
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ],
    temperature: 0.3, // low for structure
    response_format: { type: "json_object" } // crucial — forces valid JSON
  });

  // Parse and validate with Zod
  const parsed = JSON.parse(raw);
  const validated = OutlineSchema.parse(parsed);

  return validated;
}