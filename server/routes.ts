import type { Express } from "express";
import { createServer, type Server } from "http";
import { createRequire } from "module";
import multer from "multer";
import session from "express-session";
import ConnectPgSimple from "connect-pg-simple";
import { storage } from "./storage";
import { processAssignmentSchema, emailSolutionSchema, registerSchema, loginSchema, purchaseCreditsSchema, tokenCheckSchema, type ProcessAssignmentRequest, type ProcessAssignmentResponse, type EmailSolutionRequest, type AssignmentListItem } from "@shared/schema";
import { ZodError } from "zod";
import Tesseract from "tesseract.js";
import pdf2json from "pdf2json";
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib/dist/pdf-lib.js');
import { authService } from './auth';
import { clerkMiddleware, getAuth, clerkClient } from '@clerk/express';
import { countTokens, estimateOutputTokens, truncateResponse, TOKEN_LIMITS, generateSessionId, getTodayDate } from './tokenUtils';
import Stripe from 'stripe';
import { createPaypalOrder, capturePaypalOrder, loadPaypalDefault } from "./paypal";
import './types';

// GPT BYPASS service imports
import { aiProviderService } from './services/aiProviders';
import { gptZeroService } from './services/gptZero';
import { fileProcessorService } from './services/fileProcessor';
import { textChunkerService } from './services/textChunker';
import { enrichWithPhilosophicalContentIfNeeded } from './services/philosopherApi';
import { coherenceService } from './services/coherenceService';
import { runCCPipeline, shouldUseCCPipeline, ensureCCTables } from './services/ccService';

// LLM imports
// @ts-ignore
import Anthropic from "@anthropic-ai/sdk";
// @ts-ignore
import OpenAI from "openai";
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Initialize LLM clients
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY || "default_key",
});

const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY || "default_key" 
});

// Grok (xAI) client
const grok = new OpenAI({
  apiKey: process.env.XAI_API_KEY || "default_key",
  baseURL: "https://api.x.ai/v1"
});

// DeepSeek client
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || process.env.VITE_DEEPSEEK_API_KEY || "default_key",
  baseURL: "https://api.deepseek.com/v1"
});

// Venice client (OpenAI-compatible)
const venice = new OpenAI({
  apiKey: process.env.VENICE_API_KEY || "default_key",
  baseURL: "https://api.venice.ai/api/v1"
});

// Stripe is optional and not used by this app.
// Initialize only if a key is present so the app boots without it.
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
  : (null as any);

// DeepSeek processing function
function detectContentType(text: string): 'math' | 'document' | 'general' {
  // Writing/creative indicators (highest priority - should NOT get math treatment)
  const writingIndicators = [
    /write\s+(a\s+)?(short\s+)?(paper|essay|article|story|paragraph|report)/i,
    /rewrite\s+(as|in|into|to)/i,
    /convert\s+(to|into)\s+(dialogue|conversation|script)/i,
    /turn\s+(this|into)\s+(dialogue|conversation)/i,
    /make\s+(this|into)\s+(dialogue|conversation)/i,
    /write\s+(as|in)\s+(dialogue|conversation)/i,
    /dialogue\s+(format|form)/i,
    /format\s+(as|into)\s+(dialogue|conversation)/i,
    /compose\s+(a|an)/i,
    /draft\s+(a|an)/i,
    /create\s+(a|an)\s+(essay|paper|article|story)/i
  ];
  
  // Very specific mathematical problem indicators (much more restrictive)
  const mathIndicators = [
    /solve\s+(for\s+[xyz]|the\s+equation|this\s+equation)/i,
    /calculate\s+(the\s+(derivative|integral|limit|sum))/i,
    /find\s+(the\s+(derivative|integral|limit|solution|value\s+of\s+[xyz]))/i,
    /\b\d+[xyz]\s*[+\-*\/]\s*\d+[xyz]/,  // Mathematical expressions like 2x + 3y
    /[xyz]\s*=\s*[\d\-+*/^()xyz\s]+/,    // Equations like x = 2y + 3
    /differential\s+equation/i,
    /\bintegrate\s+[\w()^*+\-\/\s]*dx\b/i,
    /\bderivative\s+of\s+[\w()^*+\-\/\s]+/i,
    /solve\s+the\s+equation/i,
    /algebraic\s+equation/i,
    /quadratic\s+(equation|formula)/i
  ];
  
  // Document/text analysis indicators
  const docIndicators = [
    /summarize\s+(this|the)\s+(text|document|article|chapter|paper|passage)/i,
    /analyze\s+(this|the)\s+(text|document|article|chapter|paper|passage)/i,
    /summary\s+of\s+(this|the)\s+(text|document|article|chapter|paper|passage)/i,
    /analysis\s+of\s+(this|the)\s+(text|document|article|chapter|paper|passage)/i,
    /(given|following|attached)\s+(text|document|article|chapter|paper|passage)/i,
    /what\s+(does|is)\s+this\s+(text|document|article|chapter|paper|passage)/i,
    /the\s+author\s+(argues|states|claims|concludes)/i
  ];
  
  const writingScore = writingIndicators.filter(regex => regex.test(text)).length;
  const mathScore = mathIndicators.filter(regex => regex.test(text)).length;
  const docScore = docIndicators.filter(regex => regex.test(text)).length;
  
  // Prioritize writing requests (no math LaTeX treatment)
  if (writingScore > 0) return 'general';
  if (docScore > mathScore && docScore > 0) return 'document';
  if (mathScore > 0) return 'math';
  return 'general';
}

// Generate preview for freemium model - DISABLED - ALWAYS RETURN FULL RESPONSE
function generatePreview(fullResponse: string): string {
  // PAYWALL DISABLED - RETURN FULL CONTENT ALWAYS, NO PREVIEW TRUNCATION
  return fullResponse;
}

// Extract word count requirement from text
function extractWordCountRequirement(text: string): number | null {
  const patterns = [
    /(\d+)\s*words?/i,
    /(\d+)\s*word\s*essay/i,
    /(\d+)\s*word\s*paper/i,
    /(\d+)\s*word\s*document/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return parseInt(match[1]);
    }
  }
  return null;
}

// Extract page count requirement and convert to words (500 words per page)
function extractPageCountRequirement(text: string): number | null {
  const patterns = [
    /(\d+)\s*pages?/i,
    /(\d+)\s*page\s*essay/i,
    /(\d+)\s*page\s*paper/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return parseInt(match[1]) * 500; // 500 words per page
    }
  }
  return null;
}

// Count words in text
function countWords(text: string): number {
  // Remove markdown, LaTeX, and special characters for accurate word count
  const cleanText = text
    .replace(/\$\$[\s\S]*?\$\$/g, '') // Remove display math
    .replace(/\$[^\$]+\$/g, '') // Remove inline math
    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
    .replace(/#{1,6}\s/g, '') // Remove markdown headers
    .replace(/[*_~`]/g, '') // Remove markdown formatting
    .replace(/GRAPH_DATA_START[\s\S]*?GRAPH_DATA_END/g, ''); // Remove graph data
  
  const words = cleanText.trim().split(/\s+/).filter(word => word.length > 0);
  return words.length;
}

// Direct DeepSeek processing without content detection (for refinements)
async function processDirectWithDeepSeek(prompt: string): Promise<{response: string, graphData?: GraphRequest[]}> {
  try {
    if (!process.env.DEEPSEEK_API_KEY) {
      throw new Error('DeepSeek API key not configured');
    }

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 8192,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || 'No response generated';

    return { response: content };
  } catch (error) {
    console.error('DeepSeek direct processing error:', error);
    throw new Error('Failed to process with DeepSeek');
  }
}

async function processWithDeepSeekFixed(text: string): Promise<{response: string, graphData?: GraphRequest[]}> {
  try {
    const contentType = detectContentType(text);
    const needsGraph = detectGraphRequirements(text);
    
    const isMath = contentType === 'math';
    
    let prompt = `You are an advanced academic assignment solver. Your outputs must demonstrate genuine intellectual rigor, not just structural competence. Students use your work as a model, so mediocrity is harmful.

MANDATORY QUALITY STANDARDS:

1. SPECIFICITY OVER GENERALITY
❌ NEVER SAY: "Research shows...", "This can be computed as...", "Various scholars argue...", "≈ a non-zero value", "It depends on one's interpretation"
✓ INSTEAD: Name specific studies with results, complete ALL calculations with numerical answers, cite specific scholars, calculate exact values, take clear positions

2. COMPLETE THE HARD PARTS
Every assignment has a critical difficulty—the part that separates A from B work. You MUST complete it fully.
- Math: Explicit proofs with EVERY step justified, no "it can be shown"
- Philosophy: Defend a specific thesis with counterarguments
- Physics: Complete numerical calculations with substitution and units
- Essays: Original synthesis that identifies tensions between sources and resolves them

3. DOMAIN-SPECIFIC REQUIREMENTS:

MATHEMATICS:
- State theorem/claim precisely
- Prove with complete justification (no skipped steps, no "clearly" or "obviously")
- Work a specific numerical example
- Explain intuition (why is this true?)
- Address one common misconception
- Define ALL notation before use
- Box or highlight final results

PHYSICS/CHEMISTRY/ENGINEERING:
- Set up problem with diagram/coordinate system
- Write governing equations with variable definitions
- Solve step-by-step with intermediate results
- Substitute numerical values: E = mc² = (5kg)(3×10⁸ m/s)² = ...
- Box final answer with units
- Verify reasonableness (dimensional analysis, limiting cases)
- Physical interpretation

PHILOSOPHY/HUMANITIES:
- Introduction with SPECIFIC thesis (not "I will explore X")
- Steel-man objection: present the STRONGEST counterargument
- Evidence-based rebuttal with citations
- Defend ONE clear position
- Cite specific passages/studies, not vague "scholars say"
- Use examples to ground abstract claims

ESSAYS/RESEARCH PAPERS:
- Thesis that someone could disagree with (not vague)
- At least 3 PRIMARY sources (not textbooks/Wikipedia)
- Sources must interact, not just be listed sequentially
- Original insight beyond source summary
- Claims supported by specific data/quotes
- Address strongest alternative explanation

4. ANTI-PADDING RULES
Length requirements are for SUBSTANCE, not filler.
❌ FORBIDDEN: Repeating points in different words, tangentially related background, generic "implications for future research", motivational closing paragraphs
✓ IF SHORT: Deepen existing sections (add calculations, examples, critiques), address another counterargument, work through concrete examples

5. SELF-CRITIQUE CHECKLIST
RED FLAGS (fix before submitting):
- "It can be shown that..." → Show it
- "Research indicates..." → Which research? What findings?
- "Approximately" → Calculate exact value
- Conclusion just restates introduction → Add synthesis/new insight
- No specific numbers in quantitative problem → Do the calculation
- Thesis could be "It's complicated" → Take a side
- Generic phrases ("further research needed", "in conclusion")

GREEN FLAGS (signs of quality):
✓ Boxed/highlighted final results
✓ Specific citations with data
✓ Worked examples with numbers
✓ Assumptions explicitly stated and justified
✓ Compared approaches and explained trade-offs

6. EMPIRICAL SPECIFICITY REQUIREMENTS
When citing empirical studies, you MUST include ALL FIVE elements:
- Sample size: "N = 24 participants"
- Key manipulation: "Participants viewed predictable (80%) vs. unpredictable (20%) image sequences"
- Primary dependent measure: "BOLD response in V1 measured via 3T fMRI"
- Quantitative result with effect size: "Predictable trials showed 23% reduction in V1 activation (t(23) = 3.8, p < 0.001, Cohen's d = 0.78)"
- Critical control: "Stimuli were matched for luminance and spatial frequency"

RED FLAGS for insufficient empirical detail:
❌ "Research shows..." ❌ "Studies have found..." ❌ "Significantly greater (p < 0.05)" without specifying what was measured ❌ "Increased activity" without specifying where, by how much, or compared to what

If you cannot provide these five elements for a study, DO NOT CITE IT.

7. CONCRETE EXAMPLE REQUIREMENT
When providing concrete examples, include ALL FIVE components:
1. Phenomenological description: What does the person experience?
2. Experimental procedure: Step-by-step what happens in the lab
3. Quantitative behavioral result: How does behavior change? (RT, accuracy, illusion magnitude)
4. Neural mechanism: Which brain regions? What signals?
5. Interpretation: How does theory explain steps 1-4?

8. STRICT LENGTH DISCIPLINE
After meeting minimum word count, every additional paragraph must directly advance the argument.
ALLOWED: Addressing unstated objections, providing additional evidence for contested claims, resolving tensions between sources
FORBIDDEN: "Future directions" speculation, applications to unrelated fields (AI, education, therapy) unless explicitly requested, repetition of earlier points, tangential content with "Moreover," "Furthermore," "Additionally"

Test: "Does removing this weaken my thesis defense?" If no → cut it.

9. REBUTTAL REQUIREMENTS
When defending your position against counterarguments, your rebuttal MUST include:
1. Acknowledge overlap: "It's true that both X and Y..."
2. Identify the specific novel claim: "However, X uniquely predicts..."
3. Provide distinguishing evidence: "This is supported by [finding], which Y cannot explain because..."
4. Address residual doubt: "While this doesn't fully resolve concerns about Z, it demonstrates that..."

RED FLAGS for weak rebuttals:
❌ "Transcends," "goes beyond," "provides a richer" without explaining how
❌ Reasserting your position without addressing the objection
❌ Appealing to authority
❌ Changing the subject

10. PAUSE AND REFLECT MECHANISM
CRITICAL: After writing approximately 500 words, you MUST pause your generation and take a 20-second mental break to:
- Review what you've written for depth and detail
- Ensure you're not rushing or being superficial
- Plan the next 500 words with even MORE depth, analysis, and specificity
- Then continue with renewed focus on quality over speed

This pause-and-reflect cycle repeats every ~500 words throughout your response. Each cycle should produce DEEPER analysis than the previous one, not just more words.

${isMath ? `
CRITICAL LATEX REQUIREMENT FOR MATHEMATICS:
You MUST use perfect LaTeX mathematical notation for ALL mathematical content:
- Inline math: $x^2$, $\\frac{a}{b}$, $\\sin(x)$, $\\pi$, $\\alpha$
- Display equations: $$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$
- Fractions: $\\frac{a}{b}$, exponents: $x^n$, roots: $\\sqrt{x}$
- Integrals: $\\int_a^b f(x)dx$, summations: $\\sum_{i=1}^n$
- Limits: $\\lim_{x \\to 0}$, derivatives: $\\frac{d}{dx}$
- Greek: $\\alpha$, $\\beta$, $\\gamma$, $\\delta$, $\\pi$, $\\theta$
- Functions: $\\sin(x)$, $\\cos(x)$, $\\tan(x)$, $\\log(x)$, $e^x$
- Never use plain text for mathematical symbols/expressions
` : ''}

Assignment to solve:`;

    if (needsGraph) {
      prompt += `

ADDITIONAL GRAPH REQUIREMENT:
This assignment may require one or more graphs/plots. After solving the problem, you MUST provide graph data for EACH required graph in this EXACT JSON format at the very end of your response:

For each graph needed:
GRAPH_DATA_START
{
  "type": "line|bar|scatter",
  "title": "Graph Title",
  "xLabel": "X-axis Label", 
  "yLabel": "Y-axis Label",
  "data": [
    {"x": value1, "y": value1},
    {"x": value2, "y": value2}
  ],
  "description": "Brief description of what the graph shows"
}
GRAPH_DATA_END

If multiple graphs are needed, provide multiple GRAPH_DATA_START...GRAPH_DATA_END blocks.
Generate realistic data points based on the scientific/mathematical principles in the assignment.`;
    }

    prompt += `\n\n${text}`;

    const response = await deepseek.chat.completions.create({
      model: "deepseek-chat",
      messages: [{ 
        role: "user", 
        content: prompt
      }],
      max_tokens: 8192,
      temperature: 0.1,
    });

    const responseText = response.choices[0]?.message?.content || 'No response generated';
    
    // Extract multiple graph data if present
    const graphData: GraphRequest[] = [];
    if (needsGraph && responseText.includes('GRAPH_DATA_START')) {
      try {
        const graphRegex = /GRAPH_DATA_START([\s\S]*?)GRAPH_DATA_END/g;
        let match;
        while ((match = graphRegex.exec(responseText)) !== null) {
          try {
            const graphJson = match[1].trim();
            const parsedGraph = JSON.parse(graphJson);
            graphData.push(parsedGraph);
          } catch (error) {
            console.error('Failed to parse individual graph data:', error);
          }
        }
      } catch (error) {
        console.error('Failed to parse graph data:', error);
      }
    }

    // Clean the response to remove graph data markers
    const cleanedResponse = responseText
      .replace(/GRAPH_DATA_START[\s\S]*?GRAPH_DATA_END/g, '')
      .trim();

    return { 
      response: cleanedResponse, 
      graphData: graphData.length > 0 ? graphData : undefined 
    };
  } catch (error) {
    console.error('DeepSeek API error:', error);
    throw new Error('Failed to process with DeepSeek');
  }
}

async function performMathpixOCR(buffer: Buffer): Promise<string> {
  if (!process.env.MATHPIX_APP_ID || !process.env.MATHPIX_APP_KEY) {
    throw new Error('Mathpix credentials not configured');
  }

  try {
    const base64Image = buffer.toString('base64');
    const response = await fetch('https://api.mathpix.com/v3/text', {
      method: 'POST',
      headers: {
        'app_id': process.env.MATHPIX_APP_ID,
        'app_key': process.env.MATHPIX_APP_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        src: `data:image/jpeg;base64,${base64Image}`,
        formats: ['text', 'latex_styled', 'latex_simplified', 'asciimath'],
        data_options: {
          include_asciimath: true,
          include_latex: true,
          include_mathml: true,
          include_word_data: false,
          include_line_data: false
        },
        format_options: {
          math_inline_delimiters: ['$', '$'],
          math_display_delimiters: ['$$', '$$'],
          rm_spaces: true,
          rm_fonts: false
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Mathpix API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    // Prefer LaTeX styled format for perfect mathematical notation
    let extractedText = data.latex_styled || data.latex_simplified || data.text || '';
    
    // Log confidence if available
    if (data.confidence && data.confidence < 0.8) {
      console.warn('Low confidence Mathpix OCR result:', data.confidence);
    }
    
    // Enhance LaTeX formatting
    if (extractedText) {
      // Ensure proper LaTeX math delimiters
      extractedText = extractedText.replace(/\\\(/g, '$').replace(/\\\)/g, '$');
      extractedText = extractedText.replace(/\\\[/g, '$$').replace(/\\\]/g, '$$');
      
      // Clean up any double spaces
      extractedText = extractedText.replace(/\s+/g, ' ').trim();
    }
    
    return extractedText;
  } catch (error) {
    console.error('Mathpix OCR error:', error);
    throw error;
  }
}

async function performOCR(buffer: Buffer, fileName: string): Promise<string> {
  // Try Mathpix first for mathematical content
  if (process.env.MATHPIX_APP_ID && process.env.MATHPIX_APP_KEY) {
    try {
      const mathpixResult = await performMathpixOCR(buffer);
      if (mathpixResult && mathpixResult.trim().length > 0) {
        return mathpixResult;
      }
    } catch (error) {
      console.log('Mathpix failed, falling back to Tesseract');
    }
  }

  // Fallback to Tesseract
  try {
    const result = await Tesseract.recognize(buffer, 'eng', {
      logger: m => console.log(m)
    });
    return result.data.text;
  } catch (error) {
    console.error('OCR error:', error);
    throw new Error('Failed to extract text from image');
  }
}

async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  // Try multiple PDF extraction methods
  
  // Method 1: pdf2json
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const pdfParser = new pdf2json();
      
      const timeout = setTimeout(() => {
        reject(new Error('PDF parsing timeout'));
      }, 10000); // 10 second timeout
      
      pdfParser.on("pdfParser_dataError", (errData: any) => {
        clearTimeout(timeout);
        reject(new Error('PDF parsing failed'));
      });
      
      pdfParser.on("pdfParser_dataReady", (pdfData: any) => {
        clearTimeout(timeout);
        try {
          let text = '';
          if (pdfData.Pages) {
            for (const page of pdfData.Pages) {
              if (page.Texts) {
                for (const textItem of page.Texts) {
                  if (textItem.R) {
                    for (const textRun of textItem.R) {
                      if (textRun.T) {
                        text += decodeURIComponent(textRun.T) + ' ';
                      }
                    }
                  }
                }
                text += '\n'; // Add line break between text blocks
              }
            }
          }
          resolve(text.trim());
        } catch (error) {
          reject(new Error('Failed to process PDF data'));
        }
      });
      
      pdfParser.parseBuffer(buffer);
    });
    
    if (result && result.trim().length > 10) {
      return result;
    }
  } catch (error) {
    console.log('pdf2json failed, trying alternative method');
  }
  
  // Method 2: Fallback to OCR using Tesseract on PDF pages
  try {
    console.log('Attempting OCR fallback for PDF');
    // Convert PDF to image and use OCR
    const text = await performOCR(buffer, 'document.pdf');
    if (text && text.trim().length > 10) {
      return text;
    }
  } catch (error) {
    console.log('OCR fallback also failed');
  }
  
  // If all methods fail, provide helpful error message
  throw new Error('Unable to extract text from this PDF. Please try: 1) Converting to Word document (.docx), 2) Taking screenshots and uploading as images (.png/.jpg), or 3) Copying and pasting the text directly.');
}

async function extractTextFromWord(buffer: Buffer): Promise<string> {
  try {
    // Use mammoth for .docx files
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (error) {
    console.error('Word document parsing error:', error);
    throw new Error('Failed to extract text from Word document');
  }
}

// Helper function to clean HTML and formatting from text
function cleanResponse(text: string): string {
  return text
    // Remove HTML tags
    .replace(/<[^>]*>/g, '')
    // Remove markdown formatting
    .replace(/\*\*(.*?)\*\*/g, '$1') // Bold
    .replace(/\*(.*?)\*/g, '$1') // Italic
    .replace(/#{1,6}\s*/g, '') // Headers
    .replace(/`{1,3}(.*?)`{1,3}/g, '$1') // Code blocks
    // Clean up multiple line breaks
    .replace(/\n{3,}/g, '\n\n')
    // Decode HTML entities
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// Graph generation functions
interface GraphRequest {
  type: string;
  title: string;
  xLabel: string;
  yLabel: string;
  data: Array<{x: number | string, y: number}>;
  description?: string;
}

function detectGraphRequirements(text: string): boolean {
  // Only generate graphs when explicitly requested with specific visual commands
  const explicitGraphKeywords = [
    'plot the', 'graph the', 'chart the', 'sketch the',
    'draw a graph', 'draw a plot', 'draw a chart',
    'create a graph', 'create a plot', 'create a chart',
    'show graphically', 'illustrate graphically',
    'sketch a graph', 'sketch a plot',
    'graph this', 'plot this',
    'draw the graph', 'draw the plot',
    'make a graph', 'make a plot',
    'construct a graph', 'construct a plot'
  ];
  
  const lowerText = text.toLowerCase();
  return explicitGraphKeywords.some(keyword => lowerText.includes(keyword));
}

// PDF combining function
async function combinePDFs(pdfBuffers: Buffer[]): Promise<Buffer> {
  const mergedPdf = await PDFDocument.create();
  
  for (const pdfBuffer of pdfBuffers) {
    const pdf = await PDFDocument.load(pdfBuffer);
    const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }
  
  return Buffer.from(await mergedPdf.save());
}

async function generateGraph(graphData: GraphRequest): Promise<string> {
  const width = 800;
  const height = 600;
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

  // Determine chart type based on data and request
  let chartType: 'line' | 'bar' | 'scatter' = 'line';
  if (graphData.type.toLowerCase().includes('bar')) {
    chartType = 'bar';
  } else if (graphData.type.toLowerCase().includes('scatter')) {
    chartType = 'scatter';
  }

  let chartData: any;
  let chartLabels: any;

  if (chartType === 'scatter') {
    chartData = graphData.data.map(d => ({
      x: typeof d.x === 'string' ? parseFloat(d.x) || 0 : d.x,
      y: d.y
    }));
    chartLabels = undefined;
  } else {
    chartData = graphData.data.map(d => d.y);
    chartLabels = graphData.data.map(d => d.x);
  }

  const configuration: any = {
    type: chartType,
    data: {
      labels: chartLabels,
      datasets: [{
        label: graphData.title,
        data: chartData,
        borderColor: 'rgb(59, 130, 246)',
        backgroundColor: chartType === 'bar' ? 'rgba(59, 130, 246, 0.6)' : 'rgba(59, 130, 246, 0.1)',
        borderWidth: 2,
        fill: chartType === 'line',
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: graphData.title,
          font: { size: 16, weight: 'bold' }
        },
        legend: {
          display: false
        }
      },
      scales: {
        x: {
          display: true,
          title: {
            display: true,
            text: graphData.xLabel,
            font: { size: 14, weight: 'bold' }
          },
          grid: { color: 'rgba(0,0,0,0.1)' }
        },
        y: {
          display: true,
          title: {
            display: true,
            text: graphData.yLabel,
            font: { size: 14, weight: 'bold' }
          },
          grid: { color: 'rgba(0,0,0,0.1)' }
        }
      }
    }
  };

  const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
  return imageBuffer.toString('base64');
}

async function processWithAnthropicChat(message: string, conversationHistory: Array<{role: string, content: string}>, context?: any): Promise<{response: string, graphData?: GraphRequest[]}> {
  try {
    // Build conversation messages with proper typing
    const messages: Array<{role: 'user' | 'assistant', content: string}> = [];
    
    // Add context if available
    if (context) {
      messages.push({
        role: "user",
        content: `Context: I'm working on this problem: "${context.problem}" and got this solution: "${context.solution}"`
      });
    }
    
    // Add conversation history
    conversationHistory.forEach(msg => {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
      });
    });
    
    // Add current message
    messages.push({
      role: "user",
      content: message
    });

    const response = await anthropic.messages.create({
      model: "claude-3-sonnet-20240229",
      max_tokens: 16000,
      messages: messages
    });

    const responseText = response.content[0]?.type === 'text' ? response.content[0].text : 'No response generated';
    return { response: responseText };
  } catch (error) {
    console.error('Anthropic chat error:', error);
    throw new Error('Failed to process chat with Anthropic');
  }
}

async function processWithAnthropic(text: string): Promise<{response: string, graphData?: GraphRequest[]}> {
  try {
    const contentType = detectContentType(text);
    const needsGraph = detectGraphRequirements(text);
    
    // Check for word/page count requirements
    const wordCountReq = extractWordCountRequirement(text);
    const pageCountReq = extractPageCountRequirement(text);
    const targetWordCount = wordCountReq || pageCountReq;
    
    const isMath = contentType === 'math';
    
    let prompt = `You are an advanced academic assignment solver. Your outputs must demonstrate genuine intellectual rigor, not just structural competence. Students use your work as a model, so mediocrity is harmful.

MANDATORY QUALITY STANDARDS:

1. SPECIFICITY OVER GENERALITY
❌ NEVER SAY: "Research shows...", "This can be computed as...", "Various scholars argue...", "≈ a non-zero value", "It depends on one's interpretation"
✓ INSTEAD: Name specific studies with results, complete ALL calculations with numerical answers, cite specific scholars, calculate exact values, take clear positions

2. COMPLETE THE HARD PARTS
Every assignment has a critical difficulty—the part that separates A from B work. You MUST complete it fully.
- Math: Explicit proofs with EVERY step justified, no "it can be shown"
- Philosophy: Defend a specific thesis with counterarguments
- Physics: Complete numerical calculations with substitution and units
- Essays: Original synthesis that identifies tensions between sources and resolves them

3. DOMAIN-SPECIFIC REQUIREMENTS:

MATHEMATICS:
- State theorem/claim precisely
- Prove with complete justification (no skipped steps, no "clearly" or "obviously")
- Work a specific numerical example
- Explain intuition (why is this true?)
- Address one common misconception
- Define ALL notation before use
- Box or highlight final results

PHYSICS/CHEMISTRY/ENGINEERING:
- Set up problem with diagram/coordinate system
- Write governing equations with variable definitions
- Solve step-by-step with intermediate results
- Substitute numerical values: E = mc² = (5kg)(3×10⁸ m/s)² = ...
- Box final answer with units
- Verify reasonableness (dimensional analysis, limiting cases)
- Physical interpretation

PHILOSOPHY/HUMANITIES:
- Introduction with SPECIFIC thesis (not "I will explore X")
- Steel-man objection: present the STRONGEST counterargument
- Evidence-based rebuttal with citations
- Defend ONE clear position
- Cite specific passages/studies, not vague "scholars say"
- Use examples to ground abstract claims

ESSAYS/RESEARCH PAPERS:
- Thesis that someone could disagree with (not vague)
- At least 3 PRIMARY sources (not textbooks/Wikipedia)
- Sources must interact, not just be listed sequentially
- Original insight beyond source summary
- Claims supported by specific data/quotes
- Address strongest alternative explanation

4. ANTI-PADDING RULES
Length requirements are for SUBSTANCE, not filler.
❌ FORBIDDEN: Repeating points in different words, tangentially related background, generic "implications for future research", motivational closing paragraphs
✓ IF SHORT: Deepen existing sections (add calculations, examples, critiques), address another counterargument, work through concrete examples

5. SELF-CRITIQUE CHECKLIST
RED FLAGS (fix before submitting):
- "It can be shown that..." → Show it
- "Research indicates..." → Which research? What findings?
- "Approximately" → Calculate exact value
- Conclusion just restates introduction → Add synthesis/new insight
- No specific numbers in quantitative problem → Do the calculation
- Thesis could be "It's complicated" → Take a side
- Generic phrases ("further research needed", "in conclusion")

GREEN FLAGS (signs of quality):
✓ Boxed/highlighted final results
✓ Specific citations with data
✓ Worked examples with numbers
✓ Assumptions explicitly stated and justified
✓ Compared approaches and explained trade-offs

6. EMPIRICAL SPECIFICITY REQUIREMENTS
When citing empirical studies, you MUST include ALL FIVE elements:
- Sample size: "N = 24 participants"
- Key manipulation: "Participants viewed predictable (80%) vs. unpredictable (20%) image sequences"
- Primary dependent measure: "BOLD response in V1 measured via 3T fMRI"
- Quantitative result with effect size: "Predictable trials showed 23% reduction in V1 activation (t(23) = 3.8, p < 0.001, Cohen's d = 0.78)"
- Critical control: "Stimuli were matched for luminance and spatial frequency"

RED FLAGS for insufficient empirical detail:
❌ "Research shows..." ❌ "Studies have found..." ❌ "Significantly greater (p < 0.05)" without specifying what was measured ❌ "Increased activity" without specifying where, by how much, or compared to what

If you cannot provide these five elements for a study, DO NOT CITE IT.

7. CONCRETE EXAMPLE REQUIREMENT
When providing concrete examples, include ALL FIVE components:
1. Phenomenological description: What does the person experience?
2. Experimental procedure: Step-by-step what happens in the lab
3. Quantitative behavioral result: How does behavior change? (RT, accuracy, illusion magnitude)
4. Neural mechanism: Which brain regions? What signals?
5. Interpretation: How does theory explain steps 1-4?

8. STRICT LENGTH DISCIPLINE
After meeting minimum word count, every additional paragraph must directly advance the argument.
ALLOWED: Addressing unstated objections, providing additional evidence for contested claims, resolving tensions between sources
FORBIDDEN: "Future directions" speculation, applications to unrelated fields (AI, education, therapy) unless explicitly requested, repetition of earlier points, tangential content with "Moreover," "Furthermore," "Additionally"

Test: "Does removing this weaken my thesis defense?" If no → cut it.

9. REBUTTAL REQUIREMENTS
When defending your position against counterarguments, your rebuttal MUST include:
1. Acknowledge overlap: "It's true that both X and Y..."
2. Identify the specific novel claim: "However, X uniquely predicts..."
3. Provide distinguishing evidence: "This is supported by [finding], which Y cannot explain because..."
4. Address residual doubt: "While this doesn't fully resolve concerns about Z, it demonstrates that..."

RED FLAGS for weak rebuttals:
❌ "Transcends," "goes beyond," "provides a richer" without explaining how
❌ Reasserting your position without addressing the objection
❌ Appealing to authority
❌ Changing the subject

10. PAUSE AND REFLECT MECHANISM
CRITICAL: After writing approximately 500 words, you MUST pause your generation and take a 20-second mental break to:
- Review what you've written for depth and detail
- Ensure you're not rushing or being superficial
- Plan the next 500 words with even MORE depth, analysis, and specificity
- Then continue with renewed focus on quality over speed

This pause-and-reflect cycle repeats every ~500 words throughout your response. Each cycle should produce DEEPER analysis than the previous one, not just more words.

${isMath ? `
CRITICAL LATEX REQUIREMENT FOR MATHEMATICS:
You MUST use perfect LaTeX mathematical notation for ALL mathematical content:
- Inline math: $x^2$, $\\frac{a}{b}$, $\\sin(x)$, $\\pi$, $\\alpha$
- Display equations: $$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$
- Fractions: $\\frac{a}{b}$, exponents: $x^n$, roots: $\\sqrt{x}$
- Integrals: $\\int_a^b f(x)dx$, summations: $\\sum_{i=1}^n$
- Limits: $\\lim_{x \\to 0}$, derivatives: $\\frac{d}{dx}$
- Greek: $\\alpha$, $\\beta$, $\\gamma$, $\\delta$, $\\pi$, $\\theta$
- Functions: $\\sin(x)$, $\\cos(x)$, $\\tan(x)$, $\\log(x)$, $e^x$
- Never use plain text for mathematical symbols/expressions
` : ''}

Assignment to solve:`;

    if (needsGraph) {
      prompt += `

ADDITIONAL GRAPH REQUIREMENT:
This assignment may require one or more graphs/plots. After solving the problem, you MUST provide graph data for EACH required graph in this EXACT JSON format at the very end of your response:

For each graph needed:
GRAPH_DATA_START
{
  "type": "line|bar|scatter",
  "title": "Graph Title",
  "xLabel": "X-axis Label", 
  "yLabel": "Y-axis Label",
  "data": [
    {"x": value1, "y": value1},
    {"x": value2, "y": value2}
  ],
  "description": "Brief description of what the graph shows"
}
GRAPH_DATA_END

If multiple graphs are needed, provide multiple GRAPH_DATA_START...GRAPH_DATA_END blocks.
Generate realistic data points based on the scientific/mathematical principles in the assignment.`;
    }

    prompt += `\n\n${text}`;

    // Initial generation
    let message = await anthropic.messages.create({
      max_tokens: 16000,
      messages: [{ 
        role: 'user', 
        content: prompt
      }],
      model: 'claude-3-7-sonnet-20250219',
    });

    let responseText = message.content[0]?.type === 'text' ? message.content[0].text : 'No response generated';
    
    // If word count requirement exists and not met, continue generating
    if (targetWordCount && targetWordCount > 0) {
      let currentWordCount = countWords(responseText);
      let attempts = 0;
      const maxAttempts = 10;
      
      while (currentWordCount < targetWordCount && attempts < maxAttempts) {
        console.log(`[ANTHROPIC CONTINUATION] Current: ${currentWordCount} words, Target: ${targetWordCount} words, Continuing...`);
        
        const continuationPrompt = `Continue writing the essay from where you left off. You have written ${currentWordCount} words so far, and need to reach ${targetWordCount} words total. 

Continue seamlessly from:
"${responseText.slice(-500)}"

DO NOT repeat what was already written. DO NOT add a new title or introduction. Simply continue the essay naturally to reach the full ${targetWordCount} word requirement. Write approximately ${Math.min(targetWordCount - currentWordCount, 3000)} more words.`;
        
        const continuation = await anthropic.messages.create({
          max_tokens: 16000,
          messages: [{ 
            role: 'user', 
            content: continuationPrompt
          }],
          model: 'claude-3-7-sonnet-20250219',
        });
        
        const contText = continuation.content[0]?.type === 'text' ? continuation.content[0].text : '';
        responseText += '\n\n' + contText;
        currentWordCount = countWords(responseText);
        attempts++;
      }
      
      console.log(`[ANTHROPIC FINAL] Generated ${currentWordCount} words (target: ${targetWordCount})`);
    }
    
    // Extract multiple graph data if present
    const graphData: GraphRequest[] = [];
    if (needsGraph && responseText.includes('GRAPH_DATA_START')) {
      try {
        const graphRegex = /GRAPH_DATA_START([\s\S]*?)GRAPH_DATA_END/g;
        let match;
        while ((match = graphRegex.exec(responseText)) !== null) {
          try {
            const graphJson = match[1].trim();
            const parsedGraph = JSON.parse(graphJson);
            graphData.push(parsedGraph);
          } catch (error) {
            console.error('Failed to parse individual graph data:', error);
          }
        }
      } catch (error) {
        console.error('Failed to parse graph data:', error);
      }
    }

    // Clean the response to remove graph data markers
    const cleanedResponse = responseText
      .replace(/GRAPH_DATA_START[\s\S]*?GRAPH_DATA_END/g, '')
      .trim();

    return { 
      response: cleanedResponse, 
      graphData: graphData.length > 0 ? graphData : undefined 
    };
  } catch (error) {
    console.error('Anthropic API error:', error);
    throw new Error('Failed to process with Anthropic');
  }
}

async function processWithOpenAIChat(message: string, conversationHistory: Array<{role: string, content: string}>, context?: any): Promise<{response: string, graphData?: GraphRequest[]}> {
  try {
    // Build conversation messages with proper typing
    const messages: Array<{role: 'user' | 'assistant' | 'system', content: string}> = [];
    
    // Add context if available
    if (context) {
      messages.push({
        role: "user",
        content: `Context: I'm working on this problem: "${context.problem}" and got this solution: "${context.solution}"`
      });
    }
    
    // Add conversation history
    conversationHistory.forEach(msg => {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
      });
    });
    
    // Add current message
    messages.push({
      role: "user",
      content: message
    });

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: messages,
      max_tokens: 16000,
    });

    const responseText = response.choices[0]?.message?.content || 'No response generated';
    return { response: responseText };
  } catch (error) {
    console.error('OpenAI chat error:', error);  
    throw new Error('Failed to process chat with OpenAI');
  }
}

async function processWithOpenAI(text: string): Promise<{response: string, graphData?: GraphRequest[]}> {
  try {
    const contentType = detectContentType(text);
    const needsGraph = detectGraphRequirements(text);
    
    // Check for word/page count requirements
    const wordCountReq = extractWordCountRequirement(text);
    const pageCountReq = extractPageCountRequirement(text);
    const targetWordCount = wordCountReq || pageCountReq;
    
    const isMath = contentType === 'math';
    
    let prompt = `You are an advanced academic assignment solver. Your outputs must demonstrate genuine intellectual rigor, not just structural competence. Students use your work as a model, so mediocrity is harmful.

MANDATORY QUALITY STANDARDS:

1. SPECIFICITY OVER GENERALITY
❌ NEVER SAY: "Research shows...", "This can be computed as...", "Various scholars argue...", "≈ a non-zero value", "It depends on one's interpretation"
✓ INSTEAD: Name specific studies with results, complete ALL calculations with numerical answers, cite specific scholars, calculate exact values, take clear positions

2. COMPLETE THE HARD PARTS
Every assignment has a critical difficulty—the part that separates A from B work. You MUST complete it fully.
- Math: Explicit proofs with EVERY step justified, no "it can be shown"
- Philosophy: Defend a specific thesis with counterarguments
- Physics: Complete numerical calculations with substitution and units
- Essays: Original synthesis that identifies tensions between sources and resolves them

3. DOMAIN-SPECIFIC REQUIREMENTS:

MATHEMATICS:
- State theorem/claim precisely
- Prove with complete justification (no skipped steps, no "clearly" or "obviously")
- Work a specific numerical example
- Explain intuition (why is this true?)
- Address one common misconception
- Define ALL notation before use
- Box or highlight final results

PHYSICS/CHEMISTRY/ENGINEERING:
- Set up problem with diagram/coordinate system
- Write governing equations with variable definitions
- Solve step-by-step with intermediate results
- Substitute numerical values: E = mc² = (5kg)(3×10⁸ m/s)² = ...
- Box final answer with units
- Verify reasonableness (dimensional analysis, limiting cases)
- Physical interpretation

PHILOSOPHY/HUMANITIES:
- Introduction with SPECIFIC thesis (not "I will explore X")
- Steel-man objection: present the STRONGEST counterargument
- Evidence-based rebuttal with citations
- Defend ONE clear position
- Cite specific passages/studies, not vague "scholars say"
- Use examples to ground abstract claims

ESSAYS/RESEARCH PAPERS:
- Thesis that someone could disagree with (not vague)
- At least 3 PRIMARY sources (not textbooks/Wikipedia)
- Sources must interact, not just be listed sequentially
- Original insight beyond source summary
- Claims supported by specific data/quotes
- Address strongest alternative explanation

4. ANTI-PADDING RULES
Length requirements are for SUBSTANCE, not filler.
❌ FORBIDDEN: Repeating points in different words, tangentially related background, generic "implications for future research", motivational closing paragraphs
✓ IF SHORT: Deepen existing sections (add calculations, examples, critiques), address another counterargument, work through concrete examples

5. SELF-CRITIQUE CHECKLIST
RED FLAGS (fix before submitting):
- "It can be shown that..." → Show it
- "Research indicates..." → Which research? What findings?
- "Approximately" → Calculate exact value
- Conclusion just restates introduction → Add synthesis/new insight
- No specific numbers in quantitative problem → Do the calculation
- Thesis could be "It's complicated" → Take a side
- Generic phrases ("further research needed", "in conclusion")

GREEN FLAGS (signs of quality):
✓ Boxed/highlighted final results
✓ Specific citations with data
✓ Worked examples with numbers
✓ Assumptions explicitly stated and justified
✓ Compared approaches and explained trade-offs

6. EMPIRICAL SPECIFICITY REQUIREMENTS
When citing empirical studies, you MUST include ALL FIVE elements:
- Sample size: "N = 24 participants"
- Key manipulation: "Participants viewed predictable (80%) vs. unpredictable (20%) image sequences"
- Primary dependent measure: "BOLD response in V1 measured via 3T fMRI"
- Quantitative result with effect size: "Predictable trials showed 23% reduction in V1 activation (t(23) = 3.8, p < 0.001, Cohen's d = 0.78)"
- Critical control: "Stimuli were matched for luminance and spatial frequency"

RED FLAGS for insufficient empirical detail:
❌ "Research shows..." ❌ "Studies have found..." ❌ "Significantly greater (p < 0.05)" without specifying what was measured ❌ "Increased activity" without specifying where, by how much, or compared to what

If you cannot provide these five elements for a study, DO NOT CITE IT.

7. CONCRETE EXAMPLE REQUIREMENT
When providing concrete examples, include ALL FIVE components:
1. Phenomenological description: What does the person experience?
2. Experimental procedure: Step-by-step what happens in the lab
3. Quantitative behavioral result: How does behavior change? (RT, accuracy, illusion magnitude)
4. Neural mechanism: Which brain regions? What signals?
5. Interpretation: How does theory explain steps 1-4?

8. STRICT LENGTH DISCIPLINE
After meeting minimum word count, every additional paragraph must directly advance the argument.
ALLOWED: Addressing unstated objections, providing additional evidence for contested claims, resolving tensions between sources
FORBIDDEN: "Future directions" speculation, applications to unrelated fields (AI, education, therapy) unless explicitly requested, repetition of earlier points, tangential content with "Moreover," "Furthermore," "Additionally"

Test: "Does removing this weaken my thesis defense?" If no → cut it.

9. REBUTTAL REQUIREMENTS
When defending your position against counterarguments, your rebuttal MUST include:
1. Acknowledge overlap: "It's true that both X and Y..."
2. Identify the specific novel claim: "However, X uniquely predicts..."
3. Provide distinguishing evidence: "This is supported by [finding], which Y cannot explain because..."
4. Address residual doubt: "While this doesn't fully resolve concerns about Z, it demonstrates that..."

RED FLAGS for weak rebuttals:
❌ "Transcends," "goes beyond," "provides a richer" without explaining how
❌ Reasserting your position without addressing the objection
❌ Appealing to authority
❌ Changing the subject

10. PAUSE AND REFLECT MECHANISM
CRITICAL: After writing approximately 500 words, you MUST pause your generation and take a 20-second mental break to:
- Review what you've written for depth and detail
- Ensure you're not rushing or being superficial
- Plan the next 500 words with even MORE depth, analysis, and specificity
- Then continue with renewed focus on quality over speed

This pause-and-reflect cycle repeats every ~500 words throughout your response. Each cycle should produce DEEPER analysis than the previous one, not just more words.

${isMath ? `
CRITICAL LATEX REQUIREMENT FOR MATHEMATICS:
You MUST use perfect LaTeX mathematical notation for ALL mathematical content:
- Inline math: $x^2$, $\\frac{a}{b}$, $\\sin(x)$, $\\pi$, $\\alpha$
- Display equations: $$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$
- Fractions: $\\frac{a}{b}$, exponents: $x^n$, roots: $\\sqrt{x}$
- Integrals: $\\int_a^b f(x)dx$, summations: $\\sum_{i=1}^n$
- Limits: $\\lim_{x \\to 0}$, derivatives: $\\frac{d}{dx}$
- Greek: $\\alpha$, $\\beta$, $\\gamma$, $\\delta$, $\\pi$, $\\theta$
- Functions: $\\sin(x)$, $\\cos(x)$, $\\tan(x)$, $\\log(x)$, $e^x$
- Never use plain text for mathematical symbols/expressions
` : ''}

Assignment to solve:`;

    if (needsGraph) {
      prompt += `

ADDITIONAL GRAPH REQUIREMENT:
This assignment may require one or more graphs/plots. After solving the problem, you MUST provide graph data for EACH required graph in this EXACT JSON format at the very end of your response:

For each graph needed:
GRAPH_DATA_START
{
  "type": "line|bar|scatter",
  "title": "Graph Title",
  "xLabel": "X-axis Label", 
  "yLabel": "Y-axis Label",
  "data": [
    {"x": value1, "y": value1},
    {"x": value2, "y": value2}
  ],
  "description": "Brief description of what the graph shows"
}
GRAPH_DATA_END

If multiple graphs are needed, provide multiple GRAPH_DATA_START...GRAPH_DATA_END blocks.
Generate realistic data points based on the scientific/mathematical principles in the assignment.`;
    }

    prompt += `\n\nAssignment to solve:\n\n${text}`;

    // Initial generation
    let response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ 
        role: "user", 
        content: prompt
      }],
      max_tokens: 16000,
    });

    let responseText = response.choices[0]?.message?.content || 'No response generated';
    
    // If word count requirement exists and not met, continue generating
    if (targetWordCount && targetWordCount > 0) {
      let currentWordCount = countWords(responseText);
      let attempts = 0;
      const maxAttempts = 10; // Safety limit
      
      while (currentWordCount < targetWordCount && attempts < maxAttempts) {
        console.log(`[CONTINUATION] Current: ${currentWordCount} words, Target: ${targetWordCount} words, Continuing...`);
        
        // Continue the essay
        const continuationPrompt = `Continue writing the essay from where you left off. You have written ${currentWordCount} words so far, and need to reach ${targetWordCount} words total. 

Continue seamlessly from:
"${responseText.slice(-500)}"

DO NOT repeat what was already written. DO NOT add a new title or introduction. Simply continue the essay naturally to reach the full ${targetWordCount} word requirement. Write approximately ${Math.min(targetWordCount - currentWordCount, 3000)} more words.`;
        
        const continuationResponse = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [{ 
            role: "user", 
            content: continuationPrompt
          }],
          max_tokens: 16000,
        });
        
        const continuation = continuationResponse.choices[0]?.message?.content || '';
        responseText += '\n\n' + continuation;
        currentWordCount = countWords(responseText);
        attempts++;
      }
      
      console.log(`[FINAL] Generated ${currentWordCount} words (target: ${targetWordCount})`);
    }
    
    // Extract multiple graph data if present
    const graphData: GraphRequest[] = [];
    if (needsGraph && responseText.includes('GRAPH_DATA_START')) {
      try {
        const graphRegex = /GRAPH_DATA_START([\s\S]*?)GRAPH_DATA_END/g;
        let match;
        while ((match = graphRegex.exec(responseText)) !== null) {
          try {
            const graphJson = match[1].trim();
            const parsedGraph = JSON.parse(graphJson);
            graphData.push(parsedGraph);
          } catch (error) {
            console.error('Failed to parse individual graph data:', error);
          }
        }
      } catch (error) {
        console.error('Failed to parse graph data:', error);
      }
    }

    // Clean the response to remove graph data markers
    const cleanedResponse = responseText
      .replace(/GRAPH_DATA_START[\s\S]*?GRAPH_DATA_END/g, '')
      .trim();

    return { 
      response: cleanedResponse, 
      graphData: graphData.length > 0 ? graphData : undefined 
    };
  } catch (error) {
    console.error('OpenAI API error:', error);
    throw new Error('Failed to process with OpenAI');
  }
}

async function processWithGrok(text: string): Promise<{response: string, graphData?: GraphRequest[]}> {

  try {
    const contentType = detectContentType(text);
    const needsGraph = detectGraphRequirements(text);
    
    const isMath = contentType === 'math';
    
    let prompt = `You are an advanced academic assignment solver. Your outputs must demonstrate genuine intellectual rigor, not just structural competence. Students use your work as a model, so mediocrity is harmful.

MANDATORY QUALITY STANDARDS:

1. SPECIFICITY OVER GENERALITY
❌ NEVER SAY: "Research shows...", "This can be computed as...", "Various scholars argue...", "≈ a non-zero value", "It depends on one's interpretation"
✓ INSTEAD: Name specific studies with results, complete ALL calculations with numerical answers, cite specific scholars, calculate exact values, take clear positions

2. COMPLETE THE HARD PARTS
Every assignment has a critical difficulty—the part that separates A from B work. You MUST complete it fully.
- Math: Explicit proofs with EVERY step justified, no "it can be shown"
- Philosophy: Defend a specific thesis with counterarguments
- Physics: Complete numerical calculations with substitution and units
- Essays: Original synthesis that identifies tensions between sources and resolves them

3. DOMAIN-SPECIFIC REQUIREMENTS:

MATHEMATICS:
- State theorem/claim precisely
- Prove with complete justification (no skipped steps, no "clearly" or "obviously")
- Work a specific numerical example
- Explain intuition (why is this true?)
- Address one common misconception
- Define ALL notation before use
- Box or highlight final results

PHYSICS/CHEMISTRY/ENGINEERING:
- Set up problem with diagram/coordinate system
- Write governing equations with variable definitions
- Solve step-by-step with intermediate results
- Substitute numerical values: E = mc² = (5kg)(3×10⁸ m/s)² = ...
- Box final answer with units
- Verify reasonableness (dimensional analysis, limiting cases)
- Physical interpretation

PHILOSOPHY/HUMANITIES:
- Introduction with SPECIFIC thesis (not "I will explore X")
- Steel-man objection: present the STRONGEST counterargument
- Evidence-based rebuttal with citations
- Defend ONE clear position
- Cite specific passages/studies, not vague "scholars say"
- Use examples to ground abstract claims

ESSAYS/RESEARCH PAPERS:
- Thesis that someone could disagree with (not vague)
- At least 3 PRIMARY sources (not textbooks/Wikipedia)
- Sources must interact, not just be listed sequentially
- Original insight beyond source summary
- Claims supported by specific data/quotes
- Address strongest alternative explanation

4. ANTI-PADDING RULES
Length requirements are for SUBSTANCE, not filler.
❌ FORBIDDEN: Repeating points in different words, tangentially related background, generic "implications for future research", motivational closing paragraphs
✓ IF SHORT: Deepen existing sections (add calculations, examples, critiques), address another counterargument, work through concrete examples

5. SELF-CRITIQUE CHECKLIST
RED FLAGS (fix before submitting):
- "It can be shown that..." → Show it
- "Research indicates..." → Which research? What findings?
- "Approximately" → Calculate exact value
- Conclusion just restates introduction → Add synthesis/new insight
- No specific numbers in quantitative problem → Do the calculation
- Thesis could be "It's complicated" → Take a side
- Generic phrases ("further research needed", "in conclusion")

GREEN FLAGS (signs of quality):
✓ Boxed/highlighted final results
✓ Specific citations with data
✓ Worked examples with numbers
✓ Assumptions explicitly stated and justified
✓ Compared approaches and explained trade-offs

6. EMPIRICAL SPECIFICITY REQUIREMENTS
When citing empirical studies, you MUST include ALL FIVE elements:
- Sample size: "N = 24 participants"
- Key manipulation: "Participants viewed predictable (80%) vs. unpredictable (20%) image sequences"
- Primary dependent measure: "BOLD response in V1 measured via 3T fMRI"
- Quantitative result with effect size: "Predictable trials showed 23% reduction in V1 activation (t(23) = 3.8, p < 0.001, Cohen's d = 0.78)"
- Critical control: "Stimuli were matched for luminance and spatial frequency"

RED FLAGS for insufficient empirical detail:
❌ "Research shows..." ❌ "Studies have found..." ❌ "Significantly greater (p < 0.05)" without specifying what was measured ❌ "Increased activity" without specifying where, by how much, or compared to what

If you cannot provide these five elements for a study, DO NOT CITE IT.

7. CONCRETE EXAMPLE REQUIREMENT
When providing concrete examples, include ALL FIVE components:
1. Phenomenological description: What does the person experience?
2. Experimental procedure: Step-by-step what happens in the lab
3. Quantitative behavioral result: How does behavior change? (RT, accuracy, illusion magnitude)
4. Neural mechanism: Which brain regions? What signals?
5. Interpretation: How does theory explain steps 1-4?

8. STRICT LENGTH DISCIPLINE
After meeting minimum word count, every additional paragraph must directly advance the argument.
ALLOWED: Addressing unstated objections, providing additional evidence for contested claims, resolving tensions between sources
FORBIDDEN: "Future directions" speculation, applications to unrelated fields (AI, education, therapy) unless explicitly requested, repetition of earlier points, tangential content with "Moreover," "Furthermore," "Additionally"

Test: "Does removing this weaken my thesis defense?" If no → cut it.

9. REBUTTAL REQUIREMENTS
When defending your position against counterarguments, your rebuttal MUST include:
1. Acknowledge overlap: "It's true that both X and Y..."
2. Identify the specific novel claim: "However, X uniquely predicts..."
3. Provide distinguishing evidence: "This is supported by [finding], which Y cannot explain because..."
4. Address residual doubt: "While this doesn't fully resolve concerns about Z, it demonstrates that..."

RED FLAGS for weak rebuttals:
❌ "Transcends," "goes beyond," "provides a richer" without explaining how
❌ Reasserting your position without addressing the objection
❌ Appealing to authority
❌ Changing the subject

10. PAUSE AND REFLECT MECHANISM
CRITICAL: After writing approximately 500 words, you MUST pause your generation and take a 20-second mental break to:
- Review what you've written for depth and detail
- Ensure you're not rushing or being superficial
- Plan the next 500 words with even MORE depth, analysis, and specificity
- Then continue with renewed focus on quality over speed

This pause-and-reflect cycle repeats every ~500 words throughout your response. Each cycle should produce DEEPER analysis than the previous one, not just more words.

${isMath ? `
CRITICAL LATEX REQUIREMENT FOR MATHEMATICS:
You MUST use perfect LaTeX mathematical notation for ALL mathematical content:
- Inline math: $x^2$, $\\frac{a}{b}$, $\\sin(x)$, $\\pi$, $\\alpha$
- Display equations: $$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$
- Fractions: $\\frac{a}{b}$, exponents: $x^n$, roots: $\\sqrt{x}$
- Integrals: $\\int_a^b f(x)dx$, summations: $\\sum_{i=1}^n$
- Limits: $\\lim_{x \\to 0}$, derivatives: $\\frac{d}{dx}$
- Greek: $\\alpha$, $\\beta$, $\\gamma$, $\\delta$, $\\pi$, $\\theta$
- Functions: $\\sin(x)$, $\\cos(x)$, $\\tan(x)$, $\\log(x)$, $e^x$
- Never use plain text for mathematical symbols/expressions
` : ''}

Assignment to solve:`;

    if (needsGraph) {
      prompt += `

ADDITIONAL GRAPH REQUIREMENT:
This assignment may require one or more graphs/plots. After solving the problem, you MUST provide graph data for EACH required graph in this EXACT JSON format at the very end of your response:

For each graph needed:
GRAPH_DATA_START
{
  "type": "line|bar|scatter",
  "title": "Graph Title",
  "xLabel": "X-axis Label", 
  "yLabel": "Y-axis Label",
  "data": [
    {"x": value1, "y": value1},
    {"x": value2, "y": value2}
  ],
  "description": "Brief description of what the graph shows"
}
GRAPH_DATA_END

If multiple graphs are needed, provide multiple GRAPH_DATA_START...GRAPH_DATA_END blocks.
Generate realistic data points based on the scientific/mathematical principles in the assignment.`;
    }

    prompt += `\n\nAssignment to solve:\n\n${text}`;

    const response = await grok.chat.completions.create({
      model: "grok-beta",
      messages: [{ 
        role: "user", 
        content: prompt
      }],
      max_tokens: 16000,
    });

    const responseText = response.choices[0]?.message?.content || 'No response generated';
    
    // Extract multiple graph data if present
    const graphData: GraphRequest[] = [];
    if (needsGraph && responseText.includes('GRAPH_DATA_START')) {
      try {
        const graphRegex = /GRAPH_DATA_START([\s\S]*?)GRAPH_DATA_END/g;
        let match;
        while ((match = graphRegex.exec(responseText)) !== null) {
          try {
            const graphJson = match[1].trim();
            const parsedGraph = JSON.parse(graphJson);
            graphData.push(parsedGraph);
          } catch (error) {
            console.error('Failed to parse individual graph data:', error);
          }
        }
      } catch (error) {
        console.error('Failed to parse graph data:', error);
      }
    }

    // Clean the response to remove graph data markers
    const cleanedResponse = responseText
      .replace(/GRAPH_DATA_START[\s\S]*?GRAPH_DATA_END/g, '')
      .trim();

    return { 
      response: cleanedResponse, 
      graphData: graphData.length > 0 ? graphData : undefined 
    };
  } catch (error) {
    console.error('Grok API error:', error);
    throw new Error('Failed to process with Grok');
  }
}

async function processWithVenice(text: string): Promise<{response: string, graphData?: GraphRequest[]}> {
  try {
    const contentType = detectContentType(text);
    const needsGraph = detectGraphRequirements(text);
    const isMath = contentType === 'math';

    let prompt = `You are an advanced academic assignment solver. Your outputs must demonstrate genuine intellectual rigor, not just structural competence.

MANDATORY QUALITY STANDARDS:
1. SPECIFICITY OVER GENERALITY — name specific studies, complete all calculations, cite specific scholars, take clear positions.
2. COMPLETE THE HARD PARTS — every math proof must show every step; every essay must defend a specific thesis.
3. ANTI-PADDING RULES — no filler phrases, no hedging without justification.

${isMath ? `For mathematics: state theorem precisely, prove with complete justification, work a numerical example, explain intuition.` : `For essays/humanities: thesis someone could disagree with, at least 3 primary sources that interact, original insight.`}

Assignment to solve:

${text}`;

    if (needsGraph) {
      prompt += `\n\nThis assignment may require graphs. After solving, provide graph data in GRAPH_DATA_START...GRAPH_DATA_END blocks as JSON with type, title, xLabel, yLabel, data (array of {x,y}), and description fields.`;
    }

    const response = await venice.chat.completions.create({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 16000,
    });

    const responseText = response.choices[0]?.message?.content || 'No response generated';

    const graphData: GraphRequest[] = [];
    if (needsGraph && responseText.includes('GRAPH_DATA_START')) {
      try {
        const graphRegex = /GRAPH_DATA_START([\s\S]*?)GRAPH_DATA_END/g;
        let match;
        while ((match = graphRegex.exec(responseText)) !== null) {
          try { graphData.push(JSON.parse(match[1].trim())); } catch {}
        }
      } catch {}
    }

    const cleanedResponse = responseText.replace(/GRAPH_DATA_START[\s\S]*?GRAPH_DATA_END/g, '').trim();
    return { response: cleanedResponse, graphData: graphData.length > 0 ? graphData : undefined };
  } catch (error) {
    console.error('Venice API error:', error);
    throw new Error('Failed to process with Venice');
  }
}

async function processWithPerplexityChat(message: string, conversationHistory: Array<{role: string, content: string}>, context?: any): Promise<{response: string, graphData?: GraphRequest[]}> {
  try {
    // Build conversation messages
    const messages = [];
    
    // Add context if available
    if (context) {
      messages.push({
        role: "user",
        content: `Context: I'm working on this problem: "${context.problem}" and got this solution: "${context.solution}"`
      });
    }
    
    // Add conversation history
    conversationHistory.forEach(msg => {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
      });
    });
    
    // Add current message
    messages.push({
      role: "user",
      content: message
    });

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY || process.env.VITE_PERPLEXITY_API_KEY || "default_key"}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-sonar-large-128k-online',
        messages: messages,
        max_tokens: 16000,
        temperature: 0.1,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.status}`);
    }

    const data = await response.json();
    const responseText = data.choices[0]?.message?.content || 'No response generated';
    return { response: responseText };
  } catch (error) {
    console.error('Perplexity chat error:', error);
    throw new Error('Failed to process chat with Perplexity');
  }
}

async function processWithPerplexity(text: string): Promise<{response: string, graphData?: GraphRequest[]}> {
  try {
    const contentType = detectContentType(text);
    const needsGraph = detectGraphRequirements(text);
    
    const isMath = contentType === 'math';
    
    let prompt = `You are an advanced academic assignment solver. Your outputs must demonstrate genuine intellectual rigor, not just structural competence. Students use your work as a model, so mediocrity is harmful.

MANDATORY QUALITY STANDARDS:

1. SPECIFICITY OVER GENERALITY
❌ NEVER SAY: "Research shows...", "This can be computed as...", "Various scholars argue...", "≈ a non-zero value", "It depends on one's interpretation"
✓ INSTEAD: Name specific studies with results, complete ALL calculations with numerical answers, cite specific scholars, calculate exact values, take clear positions

2. COMPLETE THE HARD PARTS
Every assignment has a critical difficulty—the part that separates A from B work. You MUST complete it fully.
- Math: Explicit proofs with EVERY step justified, no "it can be shown"
- Philosophy: Defend a specific thesis with counterarguments
- Physics: Complete numerical calculations with substitution and units
- Essays: Original synthesis that identifies tensions between sources and resolves them

3. DOMAIN-SPECIFIC REQUIREMENTS:

MATHEMATICS:
- State theorem/claim precisely
- Prove with complete justification (no skipped steps, no "clearly" or "obviously")
- Work a specific numerical example
- Explain intuition (why is this true?)
- Address one common misconception
- Define ALL notation before use
- Box or highlight final results

PHYSICS/CHEMISTRY/ENGINEERING:
- Set up problem with diagram/coordinate system
- Write governing equations with variable definitions
- Solve step-by-step with intermediate results
- Substitute numerical values: E = mc² = (5kg)(3×10⁸ m/s)² = ...
- Box final answer with units
- Verify reasonableness (dimensional analysis, limiting cases)
- Physical interpretation

PHILOSOPHY/HUMANITIES:
- Introduction with SPECIFIC thesis (not "I will explore X")
- Steel-man objection: present the STRONGEST counterargument
- Evidence-based rebuttal with citations
- Defend ONE clear position
- Cite specific passages/studies, not vague "scholars say"
- Use examples to ground abstract claims

ESSAYS/RESEARCH PAPERS:
- Thesis that someone could disagree with (not vague)
- At least 3 PRIMARY sources (not textbooks/Wikipedia)
- Sources must interact, not just be listed sequentially
- Original insight beyond source summary
- Claims supported by specific data/quotes
- Address strongest alternative explanation

4. ANTI-PADDING RULES
Length requirements are for SUBSTANCE, not filler.
❌ FORBIDDEN: Repeating points in different words, tangentially related background, generic "implications for future research", motivational closing paragraphs
✓ IF SHORT: Deepen existing sections (add calculations, examples, critiques), address another counterargument, work through concrete examples

5. SELF-CRITIQUE CHECKLIST
RED FLAGS (fix before submitting):
- "It can be shown that..." → Show it
- "Research indicates..." → Which research? What findings?
- "Approximately" → Calculate exact value
- Conclusion just restates introduction → Add synthesis/new insight
- No specific numbers in quantitative problem → Do the calculation
- Thesis could be "It's complicated" → Take a side
- Generic phrases ("further research needed", "in conclusion")

GREEN FLAGS (signs of quality):
✓ Boxed/highlighted final results
✓ Specific citations with data
✓ Worked examples with numbers
✓ Assumptions explicitly stated and justified
✓ Compared approaches and explained trade-offs

6. EMPIRICAL SPECIFICITY REQUIREMENTS
When citing empirical studies, you MUST include ALL FIVE elements:
- Sample size: "N = 24 participants"
- Key manipulation: "Participants viewed predictable (80%) vs. unpredictable (20%) image sequences"
- Primary dependent measure: "BOLD response in V1 measured via 3T fMRI"
- Quantitative result with effect size: "Predictable trials showed 23% reduction in V1 activation (t(23) = 3.8, p < 0.001, Cohen's d = 0.78)"
- Critical control: "Stimuli were matched for luminance and spatial frequency"

RED FLAGS for insufficient empirical detail:
❌ "Research shows..." ❌ "Studies have found..." ❌ "Significantly greater (p < 0.05)" without specifying what was measured ❌ "Increased activity" without specifying where, by how much, or compared to what

If you cannot provide these five elements for a study, DO NOT CITE IT.

7. CONCRETE EXAMPLE REQUIREMENT
When providing concrete examples, include ALL FIVE components:
1. Phenomenological description: What does the person experience?
2. Experimental procedure: Step-by-step what happens in the lab
3. Quantitative behavioral result: How does behavior change? (RT, accuracy, illusion magnitude)
4. Neural mechanism: Which brain regions? What signals?
5. Interpretation: How does theory explain steps 1-4?

8. STRICT LENGTH DISCIPLINE
After meeting minimum word count, every additional paragraph must directly advance the argument.
ALLOWED: Addressing unstated objections, providing additional evidence for contested claims, resolving tensions between sources
FORBIDDEN: "Future directions" speculation, applications to unrelated fields (AI, education, therapy) unless explicitly requested, repetition of earlier points, tangential content with "Moreover," "Furthermore," "Additionally"

Test: "Does removing this weaken my thesis defense?" If no → cut it.

9. REBUTTAL REQUIREMENTS
When defending your position against counterarguments, your rebuttal MUST include:
1. Acknowledge overlap: "It's true that both X and Y..."
2. Identify the specific novel claim: "However, X uniquely predicts..."
3. Provide distinguishing evidence: "This is supported by [finding], which Y cannot explain because..."
4. Address residual doubt: "While this doesn't fully resolve concerns about Z, it demonstrates that..."

RED FLAGS for weak rebuttals:
❌ "Transcends," "goes beyond," "provides a richer" without explaining how
❌ Reasserting your position without addressing the objection
❌ Appealing to authority
❌ Changing the subject

10. PAUSE AND REFLECT MECHANISM
CRITICAL: After writing approximately 500 words, you MUST pause your generation and take a 20-second mental break to:
- Review what you've written for depth and detail
- Ensure you're not rushing or being superficial
- Plan the next 500 words with even MORE depth, analysis, and specificity
- Then continue with renewed focus on quality over speed

This pause-and-reflect cycle repeats every ~500 words throughout your response. Each cycle should produce DEEPER analysis than the previous one, not just more words.

${isMath ? `
CRITICAL LATEX REQUIREMENT FOR MATHEMATICS:
You MUST use perfect LaTeX mathematical notation for ALL mathematical content:
- Inline math: $x^2$, $\\frac{a}{b}$, $\\sin(x)$, $\\pi$, $\\alpha$
- Display equations: $$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$
- Fractions: $\\frac{a}{b}$, exponents: $x^n$, roots: $\\sqrt{x}$
- Integrals: $\\int_a^b f(x)dx$, summations: $\\sum_{i=1}^n$
- Limits: $\\lim_{x \\to 0}$, derivatives: $\\frac{d}{dx}$
- Greek: $\\alpha$, $\\beta$, $\\gamma$, $\\delta$, $\\pi$, $\\theta$
- Functions: $\\sin(x)$, $\\cos(x)$, $\\tan(x)$, $\\log(x)$, $e^x$
- Never use plain text for mathematical symbols/expressions
` : ''}

Assignment to solve:`;

    if (needsGraph) {
      prompt += `

ADDITIONAL GRAPH REQUIREMENT:
This assignment may require one or more graphs/plots. After solving the problem, you MUST provide graph data for EACH required graph in this EXACT JSON format at the very end of your response:

For each graph needed:
GRAPH_DATA_START
{
  "type": "line|bar|scatter",
  "title": "Graph Title",
  "xLabel": "X-axis Label", 
  "yLabel": "Y-axis Label",
  "data": [
    {"x": value1, "y": value1},
    {"x": value2, "y": value2}
  ],
  "description": "Brief description of what the graph shows"
}
GRAPH_DATA_END

If multiple graphs are needed, provide multiple GRAPH_DATA_START...GRAPH_DATA_END blocks.
Generate realistic data points based on the scientific/mathematical principles in the assignment.`;
    }

    prompt += `\n\nAssignment to solve:\n\n${text}`;

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY || process.env.VITE_PERPLEXITY_API_KEY || "default_key"}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-sonar-large-128k-online',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 16000,
        temperature: 0.1,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.status}`);
    }

    const data = await response.json();
    const responseText = data.choices[0]?.message?.content || 'No response generated';
    
    // Extract multiple graph data if present
    const graphData: GraphRequest[] = [];
    if (needsGraph && responseText.includes('GRAPH_DATA_START')) {
      try {
        const graphRegex = /GRAPH_DATA_START([\s\S]*?)GRAPH_DATA_END/g;
        let match;
        while ((match = graphRegex.exec(responseText)) !== null) {
          try {
            const graphJson = match[1].trim();
            const parsedGraph = JSON.parse(graphJson);
            graphData.push(parsedGraph);
          } catch (error) {
            console.error('Failed to parse individual graph data:', error);
          }
        }
      } catch (error) {
        console.error('Failed to parse graph data:', error);
      }
    }

    // Clean the response to remove graph data markers
    const cleanedResponse = responseText
      .replace(/GRAPH_DATA_START[\s\S]*?GRAPH_DATA_END/g, '')
      .trim();

    return { 
      response: cleanedResponse, 
      graphData: graphData.length > 0 ? graphData : undefined 
    };
  } catch (error) {
    console.error('Perplexity API error:', error);
    throw new Error('Failed to process with Perplexity');
  }
}

async function searchWithGoogle(query: string): Promise<string> {
  if (!process.env.GOOGLE_API_KEY || !process.env.GOOGLE_CSE_ID) {
    return '';
  }

  try {
    const response = await fetch(
      `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&num=3`
    );

    if (!response.ok) {
      throw new Error(`Google CSE API error: ${response.status}`);
    }

    const data = await response.json();
    const results = data.items?.slice(0, 3) || [];
    
    return results.map((item: any) => 
      `**${item.title}**\n${item.snippet}\nSource: ${item.link}`
    ).join('\n\n');
  } catch (error) {
    console.error('Google Search error:', error);
    return '';
  }
}

async function checkAIDetection(text: string): Promise<any> {
  if (!process.env.GPTZERO_API_KEY) {
    return { probability: 0, message: 'AI detection not configured' };
  }

  const response = await fetch('https://api.gptzero.me/v2/predict/text', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GPTZERO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      document: text
    }),
  });

  if (!response.ok) {
    throw new Error(`GPTZero API error: ${response.statusText}`);
  }

  return await response.json();
}

// HTML to PDF conversion using Puppeteer
async function convertHtmlToPdf(htmlContent: string, title: string = 'Assignment Solution', graphImage?: string): Promise<Buffer> {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: '/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium',
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--font-render-hinting=none'
      ]
    });
    
    const page = await browser.newPage();
    
    // Set content with enhanced HTML structure and perfect math rendering
    const fullHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <script>
        window.MathJax = {
            tex: {
                inlineMath: [['$', '$'], ['\\(', '\\)']],
                displayMath: [['$$', '$$'], ['\\[', '\\]']],
                processEscapes: true,
                processEnvironments: true,
                packages: {'[+]': ['ams', 'newcommand', 'mathtools', 'physics']}
            },
            chtml: {
                scale: 1.2,
                minScale: 0.8,
                matchFontHeight: false,
                fontURL: 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/output/chtml/fonts/woff-v2'
            },
            loader: {
                load: ['[tex]/ams', '[tex]/newcommand', '[tex]/mathtools', '[tex]/physics']
            },
            startup: {
                ready: () => {
                    MathJax.startup.defaultReady();
                    window.mathJaxReady = true;
                }
            }
        };
    </script>
    <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
    <style>
        body {
            font-family: 'Computer Modern', 'Times New Roman', serif;
            font-size: 12pt;
            line-height: 1.8;
            color: #000;
            margin: 40px;
            background: white;
            max-width: none;
        }
        h1, h2, h3 {
            color: #000;
            margin-bottom: 20px;
            font-weight: bold;
            page-break-after: avoid;
        }
        h1 { font-size: 18pt; }
        h2 { font-size: 16pt; }
        h3 { font-size: 14pt; }
        .solution-content {
            white-space: pre-wrap;
            word-wrap: break-word;
            font-size: 12pt;
            line-height: 1.8;
        }
        .mjx-chtml {
            font-size: 120% !important;
            line-height: 1.8 !important;
        }
        .MJXc-display {
            margin: 1em 0 !important;
        }
        p {
            margin-bottom: 12pt;
            text-align: justify;
        }
        @page {
            margin: 1in;
            size: letter;
        }
        .graph-image {
            max-width: 100%;
            height: auto;
            margin: 20px 0;
            display: block;
            border: 1px solid #ddd;
            border-radius: 4px;
            page-break-inside: avoid;
        }
        @media print {
            body { 
                margin: 0; 
                font-size: 12pt;
            }
            .mjx-chtml {
                font-size: 120% !important;
            }
            .graph-image {
                max-width: 100%;
                page-break-inside: avoid;
            }
        }
    </style>
</head>
<body>
    <h1>${title}</h1>
    ${graphImage ? `<img src="data:image/png;base64,${graphImage}" alt="Generated Graph" class="graph-image" />` : ''}
    <div class="solution-content">${htmlContent}</div>
    <script>
        // Wait for MathJax to finish rendering
        if (window.MathJax) {
            window.MathJax.startup.promise.then(() => {
                window.mathJaxReady = true;
            });
        } else {
            window.mathJaxReady = true;
        }
    </script>
</body>
</html>`;

    await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
    
    // Wait for MathJax to fully load and render all mathematics
    await page.waitForFunction(() => {
      return window.MathJax && window.MathJax.typesetPromise !== undefined;
    }, { timeout: 15000 });
    
    // Force MathJax to render all math elements
    await page.evaluate(() => {
      if (window.MathJax && window.MathJax.typesetPromise) {
        return window.MathJax.typesetPromise();
      }
    });
    
    // Additional wait to ensure complete rendering
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Generate PDF with high quality settings
    const pdfBuffer = await page.pdf({
      format: 'letter',
      margin: {
        top: '0.75in',
        bottom: '0.75in',
        left: '0.75in',
        right: '0.75in'
      },
      printBackground: true,
      preferCSSPageSize: true
    });

    return Buffer.from(pdfBuffer);
  } catch (error) {
    console.error('HTML to PDF conversion error:', error);
    throw new Error('Failed to convert HTML to PDF');
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// PDF Generation function using LaTeX/Tectonic
// Enhanced Math PDF generation with pre-rendered HTML support
async function generateMathPDF(content: string, title: string = 'Assignment Solution', extractedText?: string): Promise<Buffer> {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: '/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium',
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--font-render-hinting=none'
      ]
    });
    
    const page = await browser.newPage();
    
    // Enhanced HTML structure for perfect math rendering
    const fullHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <script>
    window.MathJax = {
      tex: {
        inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
        displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']],
        processEscapes: true,
        processEnvironments: true
      },
      options: {
        skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre']
      },
      startup: {
        ready: () => {
          console.log('MathJax is loaded, but not yet initialized');
          MathJax.startup.defaultReady();
          console.log('MathJax is initialized, and the initial typeset is queued');
        }
      }
    };
    </script>
    <script async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
    <style>
        body {
            font-family: 'Computer Modern', 'Times New Roman', serif;
            font-size: 12pt;
            line-height: 1.8;
            color: #000;
            margin: 40px;
            background: white;
            max-width: none;
        }
        h1, h2, h3 {
            color: #000;
            margin-bottom: 20px;
            font-weight: bold;
            page-break-after: avoid;
        }
        h1 { font-size: 18pt; text-align: center; }
        h2 { font-size: 16pt; }
        h3 { font-size: 14pt; }
        .problem-section {
            background: #f9f9f9;
            padding: 15px;
            border-left: 4px solid #3b82f6;
            margin-bottom: 20px;
            page-break-inside: avoid;
        }
        .solution-content {
            font-size: 12pt;
            line-height: 1.8;
        }
        /* Preserve all math rendering from client */
        mjx-container, .mjx-chtml, .MathJax {
            display: inline-block !important;
            font-size: 120% !important;
            line-height: 1.8 !important;
            margin: 0.1em !important;
            color: #000 !important;
        }
        mjx-container[display="true"] {
            display: block !important;
            text-align: center !important;
            margin: 1em 0 !important;
        }
        p {
            margin-bottom: 12pt;
            text-align: justify;
        }
        @page {
            margin: 1in;
            size: letter;
        }
        @media print {
            body { 
                margin: 0; 
                font-size: 12pt;
            }
            mjx-container, .mjx-chtml, .MathJax {
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
                color: #000 !important;
            }
        }
    </style>
</head>
<body>
    <h1>${title}</h1>
    
    ${extractedText ? `
    <div class="problem-section">
        <h2>Problem Statement</h2>
        <p>${extractedText.replace(/\n/g, '<br>')}</p>
    </div>
    ` : ''}
    
    <div class="solution-section">
        <h2>Solution</h2>
        <div class="solution-content">${content}</div>
    </div>
</body>
</html>`;

    await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
    
    // Wait for MathJax to load and render all math
    await page.evaluate(() => {
      return new Promise((resolve) => {
        if (window.MathJax && window.MathJax.startup && window.MathJax.startup.promise) {
          window.MathJax.startup.promise.then(() => {
            if (window.MathJax.typesetPromise) {
              window.MathJax.typesetPromise.then(resolve);
            } else {
              resolve();
            }
          });
        } else {
          // Fallback timeout if MathJax doesn't load
          setTimeout(resolve, 3000);
        }
      });
    });
    
    // Additional wait to ensure complete rendering
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Generate PDF with high quality settings
    const pdfBuffer = await page.pdf({
      format: 'letter',
      margin: {
        top: '0.75in',
        bottom: '0.75in',
        left: '0.75in',
        right: '0.75in'
      },
      printBackground: true,
      preferCSSPageSize: true
    });

    return Buffer.from(pdfBuffer);
  } catch (error) {
    console.error('Math PDF generation error:', error);
    throw new Error('Failed to generate math PDF');
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function generatePDF(content: string, title: string = 'Assignment Solution', extractedText?: string, graphImage?: string): Promise<Buffer> {
  const tempId = randomBytes(16).toString('hex');
  const tempDir = path.join('/tmp', `latex_${tempId}`);
  const texFile = path.join(tempDir, 'document.tex');
  const pdfFile = path.join(tempDir, 'document.pdf');

  try {
    // Create temp directory
    fs.mkdirSync(tempDir, { recursive: true });

    // Escape LaTeX special characters in content
    const escapedContent = content
      .replace(/\\/g, '\\textbackslash{}')
      .replace(/\$/g, '\\$')
      .replace(/#/g, '\\#')
      .replace(/%/g, '\\%')
      .replace(/&/g, '\\&')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/_/g, '\\_')
      .replace(/\^/g, '\\textasciicircum{}')
      .replace(/~/g, '\\textasciitilde{}');

    const escapedExtractedText = extractedText ? extractedText
      .replace(/\\/g, '\\textbackslash{}')
      .replace(/\$/g, '\\$')
      .replace(/#/g, '\\#')
      .replace(/%/g, '\\%')
      .replace(/&/g, '\\&')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/_/g, '\\_')
      .replace(/\^/g, '\\textasciicircum{}')
      .replace(/~/g, '\\textasciitilde{}') : '';

    // Create LaTeX document
    const latexContent = `\\documentclass[12pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath}
\\usepackage{amsfonts}
\\usepackage{amssymb}
\\usepackage{geometry}
\\usepackage{fancyhdr}

\\geometry{letterpaper, margin=1in}
\\pagestyle{fancy}
\\fancyhf{}
\\rhead{${new Date().toLocaleDateString()}}
\\lhead{Assignment Solution}
\\cfoot{\\thepage}

\\title{${title}}
\\author{AI-Generated Solution}
\\date{${new Date().toLocaleDateString()}}

\\begin{document}

\\maketitle

${extractedText ? `
\\section{Problem Statement}
\\begin{quote}
${escapedExtractedText}
\\end{quote}

` : ''}
\\section{Solution}

${escapedContent}

\\end{document}`;

    // Write LaTeX file
    fs.writeFileSync(texFile, latexContent, 'utf8');

    // Compile with tectonic
    execSync(`cd ${tempDir} && tectonic document.tex`, {
      stdio: 'pipe',
      timeout: 30000
    });

    // Read the generated PDF
    const pdfBuffer = fs.readFileSync(pdfFile);

    return pdfBuffer;
  } catch (error) {
    console.error('PDF generation error:', error);
    throw new Error('Failed to generate PDF');
  } finally {
    // Clean up temp files
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }
  }
}



export async function registerRoutes(app: Express): Promise<Server> {
  
  // Clerk is only enabled when valid keys are configured; otherwise fall back to legacy auto-login.
  const clerkEnabled =
    (process.env.CLERK_PUBLISHABLE_KEY || '').startsWith('pk_') &&
    (process.env.CLERK_SECRET_KEY || '').startsWith('sk_');

  if (clerkEnabled) {
    // Clerk authentication middleware - reads the Clerk session cookie/header on every request
    app.use(clerkMiddleware());
  } else {
    console.warn('[CLERK] Valid Clerk keys not configured (need pk_/sk_). Falling back to legacy auto-login.');
  }

  // Initialize session middleware
  const PgSession = ConnectPgSimple(session);
  
  app.use(session({
    store: new PgSession({
      conString: process.env.DATABASE_URL,
      tableName: 'session',
      createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || 'homework-pro-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // Allow HTTP in development and deployment
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    }
  }));

  if (clerkEnabled) {
    // CLERK SYNC MIDDLEWARE: map the signed-in Clerk user to a database user.
    // When a Clerk session is present, find-or-create a DB user keyed by Clerk identity
    // and bind it to the express session. Falls back to clearing stale sessions on sign-out.
    app.use(async (req, res, next) => {
      try {
        const { userId: clerkUserId } = getAuth(req);

        if (clerkUserId) {
          // Resolve the DB user once per Clerk session, then reuse req.session.userId.
          if (req.session.clerkUserId !== clerkUserId || !req.session.userId) {
            let username = `clerk:${clerkUserId}`;
            try {
              const clerkUser = await clerkClient.users.getUser(clerkUserId);
              const email =
                clerkUser.primaryEmailAddress?.emailAddress ||
                clerkUser.emailAddresses?.[0]?.emailAddress;
              if (email) username = email.toLowerCase();
            } catch (e) {
              console.error('[CLERK-SYNC] Failed to fetch Clerk user profile:', e);
            }

            let user = await storage.getUserByUsername(username);
            if (!user) {
              user = await storage.createUser({
                username,
                password: 'clerk_oauth_no_password_needed',
                tokenBalance: 99999999 // TESTING MODE: all users get unlimited credits
              });
              console.log(`[CLERK-SYNC] Created DB user for Clerk account: ${username}`);
            }

            req.session.userId = user.id;
            req.session.clerkUserId = clerkUserId;
          }
        } else if (req.session.clerkUserId) {
          // Clerk session ended (signed out) but express session still references it - clear it.
          req.session.userId = undefined;
          req.session.clerkUserId = undefined;
        }
      } catch (err) {
        console.error('[CLERK-SYNC] Error resolving Clerk user:', err);
      }
      next();
    });
  } else {
    // LEGACY AUTO-LOGIN MIDDLEWARE: log in as JMK (used when Clerk is not configured)
    app.use(async (req, res, next) => {
      if (!req.session.userId) {
        try {
          let jmkUser = await storage.getUserByUsername('JMK');
          if (!jmkUser) {
            jmkUser = await storage.createUser({
              username: 'JMK',
              password: 'auto_login_no_password_needed',
              tokenBalance: 99999999
            });
            console.log('[AUTO-LOGIN] Created JMK user with unlimited tokens');
          }
          req.session.userId = jmkUser.id;
        } catch (err) {
          console.error('[AUTO-LOGIN] Failed to auto-login JMK:', err);
        }
      }
      next();
    });
  }

  // SSE Streaming endpoint for coherent large document processing
  app.get('/api/coherent-stream', async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const prompt = req.query.prompt as string;
    const inputText = req.query.inputText as string;
    const sessionType = (req.query.sessionType as string) || 'homework';

    if (!prompt || !inputText) {
      res.status(400).json({ error: 'Missing prompt or inputText' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');

    // Heartbeat every 15s to prevent proxy timeouts
    const heartbeatInterval = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 15000);

    try {
      for await (const event of coherenceService.processLargeDocument(userId, sessionType, prompt, inputText)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    } finally {
      clearInterval(heartbeatInterval);
    }

    res.end();
  });

  // POST version for larger inputs
  app.post('/api/coherent-stream', async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { prompt, userPrompt, inputText = '', sessionType = 'homework' } = req.body;
    const actualPrompt = userPrompt || prompt;

    if (!actualPrompt) {
      res.status(400).json({ error: 'Missing prompt or userPrompt' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');

    // Heartbeat every 15s to prevent proxy timeouts
    const heartbeatInterval = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 15000);

    try {
      for await (const event of coherenceService.processLargeDocument(userId, sessionType, actualPrompt, inputText)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    } finally {
      clearInterval(heartbeatInterval);
    }

    res.end();
  });

  // ─── CC STREAM: Cross-Chunk Coherence pipeline (3-pass architecture) ──────
  // Triggered automatically for large input documents (>1500 words) or
  // large output targets (>2500 words). Uses Neon Postgres for job/chunk state.
  app.post('/api/cc-stream', async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { prompt, userPrompt, inputText = '', provider = 'openai' } = req.body;
    const actualPrompt = userPrompt || prompt;

    if (!actualPrompt) {
      res.status(400).json({ error: 'Missing prompt or userPrompt' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');

    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

    try {
      for await (const event of runCCPipeline(userId, actualPrompt, inputText, provider)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', data: err.message })}\n\n`);
    } finally {
      clearInterval(heartbeat);
    }

    res.end();
  });

  // Test endpoint: Generate skeleton only (no chunk generation)
  app.post('/api/test-skeleton', async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { userPrompt, inputText = '', targetChunks = 8 } = req.body;

    if (!userPrompt) {
      res.status(400).json({ error: 'Missing userPrompt' });
      return;
    }

    try {
      const skeleton = await coherenceService.generateSkeletonOnly(userPrompt, inputText);
      res.json({ success: true, skeleton });
    } catch (error: any) {
      console.error('[test-skeleton] Error:', error);
      res.status(500).json({ error: error.message || 'Failed to generate skeleton' });
    }
  });

  // Get coherent session status
  app.get('/api/coherent-session/:sessionId', async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const sessionId = parseInt(req.params.sessionId);
    if (isNaN(sessionId)) {
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    }

    const status = await coherenceService.getSessionStatus(sessionId);
    if (!status) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json(status);
  });

  // Get all chunk outputs combined
  app.get('/api/coherent-session/:sessionId/output', async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const sessionId = parseInt(req.params.sessionId);
    if (isNaN(sessionId)) {
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    }

    const output = await coherenceService.getAllChunkOutputs(sessionId);
    res.json({ output });
  });

  // Resume an interrupted coherent session
  app.get('/api/coherent-session/:sessionId/resume', async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const sessionId = parseInt(req.params.sessionId);
    if (isNaN(sessionId)) {
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
      for await (const event of coherenceService.resumeSession(sessionId)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    }

    res.end();
  });

  // Production diagnostics route (no secrets leaked)
  app.get("/__diag/payments", async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: "Stripe not configured" });
    }
    try {
      const liveKey = (process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live_");
      const whSet   = !!process.env.STRIPE_WEBHOOK_SECRET;
      const priceId = process.env.PRICE_ID_30K || process.env.PRICE_ID || "";
      let priceInfo = null;
      if (priceId) {
        priceInfo = await stripe.prices.retrieve(priceId);
      }
      res.json({
        liveKey, 
        webhookSecretSet: whSet,
        priceConfigured: !!priceId,
        priceActive: !!(priceInfo && priceInfo.active),
        priceLiveMode: !!(priceInfo && priceInfo.livemode)
      });
    } catch (e) {
      res.status(500).json({ diagError: e.message || String(e) });
    }
  });

  // Auth routes
  app.post('/api/register', async (req, res) => {
    try {
      const userData = registerSchema.parse(req.body);
      const { sessionId } = userData;
      
      // SPECIAL CASE: jmkuczynski gets unlimited access
      if (userData.username === 'jmkuczynski') {
        let user = await storage.getUserByUsername('jmkuczynski');
        if (!user) {
          user = await storage.createUser({
            username: 'jmkuczynski',
            password: 'dummy', // Password doesn't matter for this user
            tokenBalance: 99999999 // Unlimited tokens
          });
        }
        
        // Store user in session
        req.session.userId = user.id;
        
        // Migrate anonymous assignments if sessionId provided
        if (sessionId) {
          await storage.migrateAnonymousAssignments(sessionId, user.id);
        }
        
        res.json({
          success: true,
          user: {
            id: user.id,
            username: user.username,
            tokenBalance: 99999999
          }
        });
        return;
      }
      
      const user = await authService.register(userData);
      
      // Store user in session
      req.session.userId = user.id;
      
      // Migrate anonymous assignments if sessionId provided
      if (sessionId) {
        await storage.migrateAnonymousAssignments(sessionId, user.id);
      }
      
      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          tokenBalance: user.tokenBalance || 0
        }
      });
    } catch (error) {
      console.error('Registration error:', error);
      res.status(400).json({ 
        error: error instanceof Error ? error.message : 'Registration failed' 
      });
    }
  });

  app.post('/api/login', async (req, res) => {
    try {
      // Special handling for jmkuczynski and randyjohnson - allow login without password
      let loginData;
      const username = req.body.username?.toLowerCase()?.trim();
      
      if (username === 'jmkuczynski' || username === 'jmk' || username === 'randyjohnson') {
        loginData = { username: req.body.username, password: undefined, sessionId: req.body.sessionId };
      } else {
        loginData = loginSchema.parse(req.body);
      }
      
      const { sessionId } = loginData;
      
      // SPECIAL CASE: jmkuczynski and randyjohnson get unlimited access with NO PASSWORD required
      const loginUsername = loginData.username?.toLowerCase()?.trim();
      if (loginUsername === 'jmkuczynski' || loginUsername === 'jmk' || loginUsername === 'randyjohnson') {
        // No password validation needed for special users
        // Create or update user with unlimited tokens
        let user = await storage.getUserByUsername(loginData.username);
        if (!user) {
          // Create with dummy hashed password - just use a simple hash
          const hashedPassword = `dummy_hash_for_${loginData.username}`;
          user = await storage.createUser({
            username: loginData.username,
            password: hashedPassword,
            tokenBalance: 99999999 // Unlimited tokens
          });
        } else {
          // Ensure unlimited tokens
          await storage.updateUserTokenBalance(user.id, 99999999);
          user.tokenBalance = 99999999;
        }
        
        // Store user in session
        req.session.userId = user.id;
        
        // Migrate anonymous assignments if sessionId provided
        if (sessionId) {
          await storage.migrateAnonymousAssignments(sessionId, user.id);
        }
        
        res.json({
          success: true,
          user: {
            id: user.id,
            username: user.username,
            tokenBalance: 99999999
          }
        });
        return;
      }
      
      // Validate password is provided for users who aren't special accounts
      if (!loginData.password) {
        return res.status(400).json({ error: 'Password required' });
      }
      
      const user = await authService.login(loginData);
      
      // Store user in session
      req.session.userId = user.id;
      
      // Migrate anonymous assignments if sessionId provided
      if (sessionId) {
        await storage.migrateAnonymousAssignments(sessionId, user.id);
      }
      
      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          tokenBalance: user.tokenBalance
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(400).json({ 
        error: error instanceof Error ? error.message : 'Login failed' 
      });
    }
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        console.error('Logout error:', err);
        return res.status(500).json({ error: 'Logout failed' });
      }
      res.json({ success: true });
    });
  });

  app.get('/api/me', async (req, res) => {
    try {
      // Requires a signed-in Clerk session (mapped to a DB user by the clerk-sync middleware)
      if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      
      const user = await authService.getUserById(req.session.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      // TESTING MODE: all users have unlimited tokens
      res.json({
        id: user.id,
        username: user.username,
        tokenBalance: 99999999
      });
    } catch (error) {
      console.error('Get user error:', error);
      res.status(500).json({ error: 'Failed to get user' });
    }
  });

  // Token check endpoint
  app.post('/api/check-tokens', async (req, res) => {
    try {
      const { inputText, sessionId } = tokenCheckSchema.parse(req.body);
      
      const inputTokens = countTokens(inputText);
      const estimatedOutputTokens = estimateOutputTokens(inputText);
      const totalTokens = inputTokens + estimatedOutputTokens;
      
      // Check if user is authenticated
      if (req.session.userId) {
        const user = await authService.getUserById(req.session.userId);
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }
        
        // SPECIAL CASE: jmkuczynski and randyjohnson have unlimited access
        if (user.username === 'jmkuczynski' || user.username === 'randyjohnson') {
          res.json({
            canProcess: true,
            inputTokens,
            estimatedOutputTokens,
            remainingBalance: 99999999,
            message: undefined
          });
          return;
        }
        
        const canProcess = (user.tokenBalance || 0) >= totalTokens;
        
        res.json({
          canProcess,
          inputTokens,
          estimatedOutputTokens,
          remainingBalance: user.tokenBalance || 0,
          message: canProcess ? undefined : '🔒 You\'ve used all your credits. [Buy More Credits]'
        });
      } else {
        // Free user logic
        const today = getTodayDate();
        const dailyUsage = await storage.getDailyUsage(sessionId || generateSessionId(), today);
        const currentDailyUsage = dailyUsage?.totalTokens || 0;
        
        let canProcess = true;
        let message: string | undefined;
        
        // Check input token limit
        if (inputTokens > TOKEN_LIMITS.FREE_INPUT_LIMIT) {
          canProcess = false;
          message = '🔒 Full results available with upgrade. [Register & Unlock Full Access]';
        }
        // Check output token limit
        else if (estimatedOutputTokens > TOKEN_LIMITS.FREE_OUTPUT_LIMIT) {
          canProcess = false;
          message = '🔒 Full results available with upgrade. [Register & Unlock Full Access]';
        }
        // Check daily limit
        else if (currentDailyUsage + totalTokens > TOKEN_LIMITS.FREE_DAILY_LIMIT) {
          canProcess = false;
          message = '🔒 You\'ve reached the free usage limit for today. [Register & Unlock Full Access]';
        }
        
        res.json({
          canProcess,
          inputTokens,
          estimatedOutputTokens,
          dailyUsage: currentDailyUsage,
          dailyLimit: TOKEN_LIMITS.FREE_DAILY_LIMIT,
          message
        });
      }
    } catch (error) {
      console.error('Token check error:', error);
      res.status(500).json({ error: 'Failed to check tokens' });
    }
  });

  // Stripe payment endpoints
  app.post('/api/create-checkout-session', async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: "Stripe not configured" });
    }
    try {
      // Production-safe user ID validation - ONLY use session, never trust headers
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(400).json({ error: "NO_USER_ID" });
      }
      
      // Production-safe origin determination 
      const origin = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || process.env.FRONTEND_URL || `https://${req.headers.host}`;
      
      const { amount } = purchaseCreditsSchema.parse(req.body);
      const tokens = TOKEN_LIMITS.CREDIT_TIERS[amount];
      
      // Enhanced error logging for production
      console.log(`[STRIPE CHECKOUT] Creating session for user ${userId}, tokens: ${tokens}, amount: $${amount}`);
      
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        client_reference_id: String(userId),
        metadata: { 
          user_id: String(userId), 
          tokens: String(tokens),
          amount: String(amount)
        },
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: `${tokens.toLocaleString()} Homework Pro Tokens`,
                description: 'Credits for AI-powered homework assistance',
              },
              unit_amount: parseInt(amount) * 100, // Convert to cents
            },
            quantity: 1,
          },
        ],
        success_url: `${origin}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/?payment=cancelled&session_id={CHECKOUT_SESSION_ID}`,
      });
      
      // Create payment record in database with better error handling
      try {
        await storage.createStripePayment({
          userId: parseInt(String(userId)),
          stripeSessionId: session.id,
          amount: parseInt(amount),
          tokens: tokens,
          status: 'pending',
          metadata: { 
            amount: amount,
            sessionUrl: session.url,
            origin: origin
          }
        });
        console.log(`[STRIPE CHECKOUT] Created payment record for session ${session.id}`);
      } catch (dbError) {
        console.error('[STRIPE CHECKOUT] Database error creating payment record:', dbError);
        // Continue anyway - webhook can handle crediting if needed
      }
      
      res.json({ 
        sessionId: session.id,
        url: session.url 
      });
    } catch (error) {
      console.error('[STRIPE CHECKOUT] Session creation failed:', error);
      if (error && typeof error === 'object' && 'type' in error) {
        console.error(`[STRIPE CHECKOUT] Stripe error - type: ${error.type}, code: ${error.code}, message: ${error.message}`);
      }
      res.status(500).json({ error: "CREATE_SESSION_FAILED" });
    }
  });

  // Payment status checking endpoint
  app.get('/api/payment-status/:sessionId', async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: "Stripe not configured" });
    }
    try {
      const { sessionId } = req.params;
      console.log(`[STRIPE DEBUG] Checking payment status for session: ${sessionId}`);
      
      // Retrieve the session from Stripe
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log(`[STRIPE DEBUG] Session details:`, {
        id: session.id,
        status: session.status,
        payment_status: session.payment_status,
        payment_intent: session.payment_intent,
        mode: session.mode,
        amount_total: session.amount_total,
        currency: session.currency,
        metadata: session.metadata,
        client_reference_id: session.client_reference_id
      });
      
      if (session.payment_status === 'paid' && session.status === 'complete') {
        console.log(`[STRIPE DEBUG] Payment successful, crediting tokens for session: ${sessionId}`);
        
        // Payment completed - check if tokens already credited
        const existingPayment = await storage.getStripePaymentBySessionId(sessionId);
        console.log(`[STRIPE DEBUG] Existing payment record:`, existingPayment);
        
        if (existingPayment && existingPayment.status !== 'completed') {
          // Credit the tokens from our payment record (more reliable than Stripe metadata)
          const tokens = existingPayment.tokens;
          const userId = existingPayment.userId;
          console.log(`[STRIPE DEBUG] Crediting ${tokens} tokens to user ${userId} from payment record`);
          
          if (tokens > 0 && userId > 0) {
            // Update user's token balance
            const user = await authService.getUserById(userId);
            if (user) {
              const newBalance = (user.tokenBalance || 0) + tokens;
              await storage.updateUserTokenBalance(userId, newBalance);
              await storage.updateStripePaymentStatus(sessionId, 'completed');
              console.log(`[STRIPE DEBUG] Updated user ${userId} balance to ${newBalance} tokens`);
            } else {
              console.error(`[STRIPE DEBUG] User ${userId} not found when crediting tokens`);
            }
          } else {
            console.error(`[STRIPE DEBUG] Invalid token credit parameters: tokens=${tokens}, userId=${userId}`);
          }
        } else {
          console.log(`[STRIPE DEBUG] Tokens already credited for session: ${sessionId}`);
        }
        
        res.json({ status: 'completed' });
      } else if (session.status === 'expired') {
        console.log(`[STRIPE DEBUG] Session expired: ${sessionId}`);
        res.json({ status: 'failed' });
      } else if (session.status === 'open' && session.payment_status === 'unpaid') {
        console.log(`[STRIPE DEBUG] Session still open and unpaid: ${sessionId}`);
        res.json({ status: 'pending' });
      } else {
        console.log(`[STRIPE DEBUG] Session in unexpected state - status: ${session.status}, payment_status: ${session.payment_status}`);
        // Check if payment failed
        if (session.payment_status === 'no_payment_required' || session.payment_status === 'unpaid') {
          console.log(`[STRIPE DEBUG] Payment not completed or failed for session: ${sessionId}`);
          res.json({ status: 'failed' });
        } else {
          res.json({ status: 'pending' });
        }
      }
    } catch (error) {
      console.error(`[STRIPE DEBUG] Payment status check error for session ${req.params.sessionId}:`, error);
      // Check if it's a Stripe API error
      if (error && typeof error === 'object' && 'type' in error) {
        console.error(`[STRIPE DEBUG] Stripe error type: ${error.type}, code: ${error.code}, message: ${error.message}`);
      }
      res.status(500).json({ error: 'Failed to check payment status' });
    }
  });

  // PayPal payment endpoints
  app.get("/api/paypal/setup", async (req, res) => {
    await loadPaypalDefault(req, res);
  });

  app.post("/api/paypal/order", async (req, res) => {
    // Request body should contain: { intent, amount, currency }
    await createPaypalOrder(req, res);
  });

  app.post("/api/paypal/order/:orderID/capture", async (req, res) => {
    try {
      // Capture the PayPal payment
      await capturePaypalOrder(req, res);
      
      // TODO: Add token balance update logic here after successful capture
      // This would involve:
      // 1. Getting order details to determine token amount
      // 2. Getting user from session 
      // 3. Adding tokens to user account
      
    } catch (error) {
      console.error('PayPal capture error:', error);
      res.status(500).json({ error: 'Failed to capture payment' });
    }
  });

  // Azure Speech configuration endpoint
  app.get('/api/azure-speech-config', (req, res) => {
    const endpoint = process.env.AZURE_SPEECH_ENDPOINT;
    const subscriptionKey = process.env.AZURE_SPEECH_KEY;
    
    if (!subscriptionKey) {
      return res.status(500).json({ error: 'Azure Speech key not configured' });
    }
    
    // Extract region from endpoint URL if available, otherwise default to eastus
    let region = 'eastus';
    if (endpoint) {
      const match = endpoint.match(/https:\/\/([^.]+)\.cognitiveservices\.azure\.com/);
      if (match) {
        region = match[1];
      }
    }
    
    res.json({ subscriptionKey, region });
  });

  // Refine solution endpoint
  app.post('/api/refine-solution', async (req, res) => {
    try {
      const { originalProblem, currentSolution, feedback, provider } = req.body;
      
      if (!originalProblem || !currentSolution || !feedback || !provider) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const startTime = Date.now();
      
      // Detect content type to determine appropriate formatting
      const contentType = detectContentType(originalProblem);
      
      let refinementPrompt = `You are an expert academic assistant. The user wants you to improve their existing solution based on feedback.

ORIGINAL PROBLEM:
${originalProblem}

CURRENT SOLUTION:
${currentSolution}

USER FEEDBACK:
${feedback}

IMPORTANT: You must respond with ONLY the improved solution. Do NOT provide analysis, commentary, or explanations about what you changed. Simply provide the refined solution text directly.

Requirements:
- Keep good parts that weren't criticized
- Address all feedback points`;

      if (contentType === 'math') {
        refinementPrompt += `
- Use proper LaTeX notation ($ for inline, $$ for display math)`;
      } else {
        refinementPrompt += `
- Write in clear, natural language appropriate for the question
- Only use mathematical notation if the problem specifically requires it`;
      }

      refinementPrompt += `
- Maintain logical flow and structure

Respond with the refined solution only:`;

      let refinedResult: {response: string, graphData?: GraphRequest[]};
      
      try {
        switch (provider) {
          case 'deepseek':
            // Don't run content detection again - use the already-prepared prompt directly
            refinedResult = await processDirectWithDeepSeek(refinementPrompt);
            break;
          case 'anthropic':
            refinedResult = await processWithAnthropic(refinementPrompt);
            break;
          case 'openai':
            refinedResult = await processWithOpenAI(refinementPrompt);
            break;
          case 'grok':
            refinedResult = await processWithGrok(refinementPrompt);
            break;
          case 'venice':
            refinedResult = await processWithVenice(refinementPrompt);
            break;
          case 'perplexity':
            refinedResult = await processWithPerplexity(refinementPrompt);
            break;
          default:
            throw new Error('Invalid provider');
        }
      } catch (error) {
        console.error(`Error with ${provider}:`, error);
        throw error;
      }

      const processingTime = Date.now() - startTime;

      res.json({
        success: true,
        refinedSolution: cleanResponse(refinedResult.response),
        processingTime,
        provider
      });

    } catch (error) {
      console.error('Refine solution error:', error);
      res.status(500).json({ 
        error: 'Failed to refine solution',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  // File upload endpoint
  app.post("/api/upload", upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const { llmProvider } = req.body;
      if (!llmProvider || !['anthropic', 'openai', 'perplexity', 'azure', 'deepseek', 'venice'].includes(llmProvider)) {
        return res.status(400).json({ error: "Invalid LLM provider" });
      }

      const startTime = Date.now();
      
      // Extract text from uploaded file
      let extractedText = '';
      const fileName = req.file.originalname;
      const fileType = req.file.mimetype;

      if (fileType.startsWith('image/')) {
        extractedText = await performOCR(req.file.buffer, fileName);
      } else if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
                 fileType === 'application/msword' ||
                 fileName.toLowerCase().endsWith('.docx') ||
                 fileName.toLowerCase().endsWith('.doc')) {
        extractedText = await extractTextFromWord(req.file.buffer);
      } else if (fileType === 'application/pdf') {
        extractedText = await extractTextFromPDF(req.file.buffer);
      } else {
        return res.status(400).json({ error: "File type not supported yet. Please use images or Word documents." });
      }

      if (!extractedText.trim()) {
        return res.status(400).json({ error: "No text could be extracted from the file" });
      }

      // Process with selected LLM
      let llmResult: {response: string, graphData?: GraphRequest[]};
      switch (llmProvider) {
        case 'anthropic':
          llmResult = await processWithAnthropic(extractedText);
          break;
        case 'openai':
          llmResult = await processWithOpenAI(extractedText);
          break;
        case 'grok':
          llmResult = await processWithGrok(extractedText);
          break;
        case 'venice':
          llmResult = await processWithVenice(extractedText);
          break;
        case 'perplexity':
          llmResult = await processWithPerplexity(extractedText);
          break;
        case 'deepseek':
          llmResult = await processWithDeepSeekFixed(extractedText);
          break;
        default:
          throw new Error(`Unsupported LLM provider: ${llmProvider}`);
      }

      const processingTime = Date.now() - startTime;

      // Generate graphs if required
      let graphImages: string[] | undefined;
      let graphDataJsons: string[] | undefined;
      
      if (llmResult.graphData && llmResult.graphData.length > 0) {
        try {
          graphImages = [];
          graphDataJsons = [];
          
          for (const graphData of llmResult.graphData) {
            const graphImage = await generateGraph(graphData);
            graphImages.push(graphImage);
            graphDataJsons.push(JSON.stringify(graphData));
          }
        } catch (error) {
          console.error('Graph generation error:', error);
          // Continue without graphs if generation fails
        }
      }

      // Don't auto-save assignment

      const response: ProcessAssignmentResponse = {
        id: Date.now(), // Generate a temporary ID for the response
        extractedText,
        llmResponse: llmResult.response,
        graphData: graphDataJsons,
        graphImages: graphImages,
        processingTime,
        success: true,
      };

      res.json(response);
    } catch (error) {
      console.error('Upload processing error:', error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : "Failed to process upload" 
      });
    }
  });

  // Save assignment endpoint - saves the PROMPT only (not the solution)
  app.post("/api/save-assignment", async (req, res) => {
    try {
      const { inputText, title } = req.body;
      
      if (!inputText) {
        return res.status(400).json({ error: "Prompt text is required" });
      }

      const userId = req.session?.userId;
      const sessionId = req.session?.id || req.body.sessionId;
      
      const assignmentTitle = title || inputText.substring(0, 100);

      const assignment = await storage.createAssignment({
        userId: userId || null,
        sessionId: sessionId || null,
        title: assignmentTitle,
        inputText: inputText,
        inputType: 'text',
        fileName: assignmentTitle,
        extractedText: null,
        llmProvider: 'saved',
        llmResponse: null,
        grade: null,
        graphData: null,
        graphImages: null,
        processingTime: null,
      });

      console.log(`[SAVE] Assignment prompt ${assignment.id} saved: "${assignmentTitle}"`);

      res.json({ 
        success: true, 
        id: assignment.id,
        title: assignmentTitle,
        message: "Assignment prompt saved"
      });
    } catch (error) {
      console.error('Save assignment error:', error);
      res.status(500).json({ error: "Failed to save assignment" });
    }
  });

  // Save grade to an assignment
  app.post("/api/grades", async (req, res) => {
    try {
      const { assignmentId, gradeText, gradeScore, llmProvider } = req.body;
      
      if (!assignmentId || !gradeText) {
        return res.status(400).json({ error: "Assignment ID and grade text are required" });
      }

      const userId = req.session?.userId || null;
      const sessionId = req.session?.id || req.body.sessionId || null;

      const grade = await storage.createGrade({
        assignmentId,
        userId,
        sessionId,
        gradeText,
        gradeScore: gradeScore || null,
        llmProvider: llmProvider || null,
      });

      console.log(`[SAVE] Grade ${grade.id} saved for assignment ${assignmentId}`);
      res.json({ success: true, id: grade.id });
    } catch (error) {
      console.error('Save grade error:', error);
      res.status(500).json({ error: "Failed to save grade" });
    }
  });

  // Get grades for an assignment
  app.get("/api/grades/:assignmentId", async (req, res) => {
    try {
      const assignmentId = parseInt(req.params.assignmentId);
      const grades = await storage.getGradesByAssignment(assignmentId);
      res.json(grades);
    } catch (error) {
      console.error('Get grades error:', error);
      res.status(500).json({ error: "Failed to get grades" });
    }
  });

  // Save rewrite to an assignment
  app.post("/api/rewrites", async (req, res) => {
    try {
      const { assignmentId, rewriteText, basedOnGradeId, llmProvider } = req.body;
      
      if (!assignmentId || !rewriteText) {
        return res.status(400).json({ error: "Assignment ID and rewrite text are required" });
      }

      const userId = req.session?.userId || null;
      const sessionId = req.session?.id || req.body.sessionId || null;

      const rewrite = await storage.createRewrite({
        assignmentId,
        userId,
        sessionId,
        rewriteText,
        basedOnGradeId: basedOnGradeId || null,
        llmProvider: llmProvider || null,
      });

      console.log(`[SAVE] Rewrite ${rewrite.id} saved for assignment ${assignmentId}`);
      res.json({ success: true, id: rewrite.id });
    } catch (error) {
      console.error('Save rewrite error:', error);
      res.status(500).json({ error: "Failed to save rewrite" });
    }
  });

  // Get rewrites for an assignment
  app.get("/api/rewrites/:assignmentId", async (req, res) => {
    try {
      const assignmentId = parseInt(req.params.assignmentId);
      const rewrites = await storage.getRewritesByAssignment(assignmentId);
      res.json(rewrites);
    } catch (error) {
      console.error('Get rewrites error:', error);
      res.status(500).json({ error: "Failed to get rewrites" });
    }
  });

  // Auto-Grader API Endpoint
  app.post('/api/grade', async (req, res) => {
    try {
      const { assignment, solution, detail_level = 'standard', focus_areas = ['all'] } = req.body;
      
      if (!assignment || !solution) {
        return res.status(400).json({ error: 'Assignment and solution text are required' });
      }

      // Build grading prompt
      const gradingPrompt = `You are an expert academic grader evaluating a student assignment.

ASSIGNMENT REQUIREMENTS:
${assignment}

STUDENT SOLUTION:
${solution}

GRADING RUBRIC:

## COMPLETENESS (30 points)
Does the solution address ALL required components?
- Identify required components from assignment
- Check if each component is present and adequately addressed
- Deduct points for missing or incomplete components

## RIGOR (25 points)
Are claims supported with evidence?
- Mathematical derivations: Complete with all steps? (Y/N)
- Empirical evidence: Specific studies with N, results, effect sizes? (Y/N)
- Theory: Formal models stated and distinguished? (Y/N)
- Are assertions backed by specific evidence or just claims?

## DEPTH (25 points)
Does it engage with difficult parts or evade them?
- Are hard questions addressed or glossed over?
- Are counterarguments steel-manned or straw-manned?
- Is there original synthesis or just source summary?
- Does it tackle the intellectually demanding aspects?

## DISCIPLINE (20 points)
Does it stay on topic?
- Count actual vs required words (if specified)
- Identify any padding: repetitive content, tangential sections, generic filler
- Check for off-topic content (e.g., unrelated applications, "future directions" not requested)
- Evaluate focus and relevance throughout

## MECHANICS (10 points)
- Formatting correct? (Y/N)
- Citations present and proper? (Y/N)
- Grammar/spelling acceptable? (Y/N)

---

DETAIL LEVEL: ${detail_level.toUpperCase()}

${detail_level === 'brief' ? `
OUTPUT REQUIRED (Brief format):
Provide a concise JSON response with:
- Overall score and grade
- 3-5 key strengths (bullet points only)
- Top 3-4 weaknesses (category + brief description)
- Quick fix suggestions
` : detail_level === 'comprehensive' ? `
OUTPUT REQUIRED (Comprehensive format):
Provide a detailed JSON response with:
- Full component breakdown with justifications
- All strengths with quotes from solution
- All weaknesses ranked by severity with evidence
- Paragraph-by-paragraph critique for major issues
- Detailed rewrite plan with example corrections
` : `
OUTPUT REQUIRED (Standard format):
Provide a balanced JSON response with:
- Component scores with justifications
- 3-5 strengths with specific evidence
- Top 4-6 weaknesses with evidence and specific fixes
- Clear rewrite instructions
`}

CRITICAL: You MUST respond with ONLY valid JSON in exactly this format (no markdown, no code blocks, no additional text):

{
  "overall_score": [0-100],
  "grade_letter": "[A+ through F]",
  "component_scores": {
    "completeness": {"score": X, "max": 30, "justification": "..."},
    "rigor": {"score": X, "max": 25, "justification": "..."},
    "depth": {"score": X, "max": 25, "justification": "..."},
    "discipline": {"score": X, "max": 20, "justification": "..."},
    "mechanics": {"score": X, "max": 10, "justification": "..."}
  },
  "strengths": [
    "Specific strength with evidence from solution"
  ],
  "weaknesses": [
    {
      "category": "DESCRIPTIVE_NAME",
      "severity": "Major|Minor",
      "points_lost": X,
      "evidence": "Quote or description from solution",
      "fix": "Specific, actionable instruction"
    }
  ],
  "estimated_score_after_fix": [0-100],
  "rewrite_instructions": "Numbered list of all fixes needed:\\n1. Fix X by doing Y\\n2. Add Z to section A\\n3. Remove padding from pages B-C"
}

IMPORTANT: Return ONLY the JSON object. Do not include any markdown formatting, code blocks, or explanatory text.`;

      // Call OpenAI for grading
      if (!openai) {
        throw new Error('OpenAI not configured');
      }

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are an expert academic grader. You MUST respond with valid JSON only.' },
          { role: 'user', content: gradingPrompt }
        ],
        temperature: 0.3,
        response_format: { type: "json_object" }
      });

      const gradingResultText = completion.choices[0]?.message?.content;
      
      if (!gradingResultText) {
        throw new Error('No grading result from OpenAI');
      }

      // Parse JSON response
      const gradingResult = JSON.parse(gradingResultText);

      // Return grading report
      res.json(gradingResult);

    } catch (error) {
      console.error('Grading error:', error);
      res.status(500).json({ 
        error: 'Failed to grade assignment',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Generate Perfect Assignment API Endpoint
  app.post('/api/generate-perfect', async (req, res) => {
    try {
      const { assignment, originalSolution, gradingReport } = req.body;
      
      if (!assignment || !originalSolution || !gradingReport) {
        return res.status(400).json({ error: 'Assignment, original solution, and grading report are required' });
      }

      // Build perfection prompt using the grading report
      const perfectionPrompt = `You are an expert academic writer tasked with creating a PERFECT version of a student assignment based on detailed grading feedback.

ORIGINAL ASSIGNMENT PROMPT:
${assignment}

STUDENT'S ORIGINAL SUBMISSION:
${originalSolution}

GRADING REPORT:
- Overall Score: ${gradingReport.overall_score}/100 (${gradingReport.grade_letter})
- Component Scores:
${Object.entries(gradingReport.component_scores || {}).map(([key, value]: [string, any]) => 
  `  * ${key}: ${value.score}/${value.max} - ${value.justification}`
).join('\n')}

IDENTIFIED WEAKNESSES:
${(gradingReport.weaknesses || []).map((w: any, i: number) => 
  `${i + 1}. [${w.severity}] ${w.category} (-${w.points_lost} pts)
   Problem: ${w.evidence}
   Fix Required: ${w.fix}`
).join('\n\n')}

REWRITE INSTRUCTIONS:
${gradingReport.rewrite_instructions}

---

YOUR TASK:
Generate a PERFECT version of this assignment that would score 95-100/100. This perfected version must:

1. **Address ALL identified weaknesses** - Implement every fix from the grading report
2. **Preserve all strengths** - Keep what worked well in the original
3. **Meet ALL assignment requirements** - Ensure complete coverage of the prompt
4. **Achieve academic excellence** - Demonstrate A+ level rigor, depth, and discipline
5. **Maintain proper mechanics** - Perfect formatting, citations, grammar

CRITICAL QUALITY STANDARDS:
- **Rigor**: Support ALL claims with specific evidence (studies with N, results, effect sizes for empirical claims; complete derivations for math)
- **Depth**: Engage directly with difficult questions, steel-man counterarguments, provide original synthesis
- **Discipline**: Stay strictly on topic, meet exact word/page count if specified, eliminate all padding
- **Completeness**: Address every single component of the assignment requirements
- **Mechanics**: Perfect formatting, proper citations, flawless grammar

OUTPUT FORMAT:
Return ONLY the perfected assignment text. Do not include:
- Meta-commentary about changes made
- Explanations of improvements
- Grading analysis
- Section headers like "Perfected Version:"

Just provide the final, polished, A+ quality assignment that a student could submit directly.`;

      // Call OpenAI for perfection generation
      if (!openai) {
        throw new Error('OpenAI not configured');
      }

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { 
            role: 'system', 
            content: 'You are an expert academic writer. Generate only the final perfected assignment text without any meta-commentary.' 
          },
          { role: 'user', content: perfectionPrompt }
        ],
        temperature: 0.7,
      });

      const perfectSolution = completion.choices[0]?.message?.content;
      
      if (!perfectSolution) {
        throw new Error('No perfected solution from OpenAI');
      }

      // Return the perfected assignment
      res.json({ 
        perfectSolution,
        message: 'Perfect assignment generated successfully'
      });

    } catch (error) {
      console.error('Generate perfect error:', error);
      res.status(500).json({ 
        error: 'Failed to generate perfect assignment',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Simplified fast perfect assignment generation (from grading assistant)
  app.post('/api/generate-perfect-fast', async (req, res) => {
    try {
      const { assignmentPrompt, studentSubmission, gradeFeedback, grade } = req.body;
      
      if (!assignmentPrompt || !studentSubmission || !gradeFeedback) {
        return res.status(400).json({ error: 'Assignment prompt, submission, and grade feedback are required' });
      }

      const perfectionPrompt = `You are an expert academic writer. Create a PERFECT version of this student submission based on the grading feedback.

ASSIGNMENT REQUIREMENTS:
${assignmentPrompt}

STUDENT'S ORIGINAL SUBMISSION:
${studentSubmission}

GRADE RECEIVED: ${grade}

GRADING FEEDBACK:
${gradeFeedback}

YOUR TASK:
Rewrite and improve this submission to fix ALL weaknesses identified in the feedback. Create an A+ grade version that:
1. Addresses every criticism from the feedback
2. Maintains the original format and approximate length
3. Demonstrates academic excellence with proper evidence and rigor
4. Has perfect mechanics (grammar, structure, citations if applicable)

OUTPUT: Provide ONLY the perfected assignment text. No meta-commentary or explanations.`;

      if (!openai) {
        throw new Error('OpenAI not configured');
      }

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are an expert academic writer. Generate only the final perfected assignment text without any meta-commentary.' },
          { role: 'user', content: perfectionPrompt }
        ],
        temperature: 0.3,
      });

      const improvedAssignment = completion.choices[0]?.message?.content;
      
      if (!improvedAssignment) {
        throw new Error('No response from OpenAI');
      }

      res.json({ improvedAssignment });

    } catch (error) {
      console.error('Generate perfect fast error:', error);
      res.status(500).json({ 
        error: 'Failed to generate perfect assignment',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Text processing endpoint with token management
  app.post("/api/process-text", async (req, res) => {
    try {
      const { inputText, llmProvider, sessionId, referenceDocumentIds = [], forcePhilosopher = false } = processAssignmentSchema.parse(req.body);

      if (!inputText) {
        return res.status(400).json({ error: "Input text is required" });
      }

      const startTime = Date.now();
      
      // WHOLE-DOC MODE: When reference documents are provided, combine them with user input
      let combinedText = inputText;
      const userId = req.session.userId;
      let actualSessionId = req.headers['x-session-id'] as string || sessionId;
      
      if (referenceDocumentIds.length > 0) {
        console.log(`[WHOLE-DOC MODE] Processing with ${referenceDocumentIds.length} reference documents`);
        
        // Fetch reference documents content
        const referenceTexts: string[] = [];
        for (const docId of referenceDocumentIds) {
          const document = await storage.getReferenceDocument(docId, userId, actualSessionId);
          if (document) {
            referenceTexts.push(`=== REFERENCE DOCUMENT: ${document.fileName} ===\n${document.extractedText}\n\n`);
          } else {
            console.warn(`[WHOLE-DOC MODE] Reference document ${docId} not found or access denied`);
          }
        }
        
        if (referenceTexts.length > 0) {
          // Combine reference documents with user prompt - process as complete wholes
          combinedText = `${referenceTexts.join('')}=== USER REQUEST ===\n${inputText}\n\nPlease analyze the above reference documents as complete wholes and respond to the user request based on the full context provided.`;
          console.log(`[WHOLE-DOC MODE] Combined text length: ${combinedText.length} chars`);
        }
      }
      
      // PHILOSOPHER API: Enrich with philosophical content (forced or auto-detected)
      if (forcePhilosopher) {
        console.log('[PHILOSOPHER API] Force mode enabled - querying database');
      }
      combinedText = await enrichWithPhilosophicalContentIfNeeded(combinedText, forcePhilosopher);
      
      // Count tokens based on combined text (inputText + reference documents + philosophical enrichment)
      const inputTokens = countTokens(combinedText);
      const estimatedOutputTokens = estimateOutputTokens(combinedText);
      const totalTokens = inputTokens + estimatedOutputTokens;
      
      console.log(`[TOKEN DEBUG] User: ${userId}, Input: ${inputTokens}, Estimated Output: ${estimatedOutputTokens}, Total: ${totalTokens}`);
      
      // Check token limits and process accordingly
      if (userId) {
        // Registered user - check token balance
        const user = await authService.getUserById(userId);
        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }
        
        console.log(`[TOKEN DEBUG] User ${user.username} has ${user.tokenBalance} tokens, needs ${totalTokens}`);
        
        // TESTING MODE: Token checks disabled - all users have unlimited access
        // Keeping the code here for when paywall is re-enabled
        /*
        if (user.username !== 'jmkuczynski' && user.username !== 'randyjohnson' && (user.tokenBalance || 0) < totalTokens) {
          return res.status(402).json({ 
            error: "🔒 You've used all your credits. [Buy More Credits]",
            needsUpgrade: true 
          });
        }
        */
        
        // Process with full response
        let llmResult: {response: string, graphData?: GraphRequest[]};
        switch (llmProvider) {
          case 'anthropic':
            llmResult = await processWithAnthropic(combinedText);
            break;
          case 'openai':
            llmResult = await processWithOpenAI(combinedText);
            break;
          case 'grok':
            llmResult = await processWithGrok(combinedText);
            break;
          case 'venice':
            llmResult = await processWithVenice(combinedText);
            break;
          case 'perplexity':
            llmResult = await processWithPerplexity(combinedText);
            break;
          case 'deepseek':
            llmResult = await processWithDeepSeekFixed(combinedText);
            break;
          default:
            throw new Error(`Unsupported LLM provider: ${llmProvider}`);
        }

        const actualOutputTokens = countTokens(llmResult.response);
        const actualTotalTokens = inputTokens + actualOutputTokens;
        
        console.log(`[TOKEN DEDUCTION] User ${user.username}: actual input=${inputTokens}, actual output=${actualOutputTokens}, actual total=${actualTotalTokens}`);
        
        // TESTING MODE: Token deduction disabled - all users have unlimited access
        // Log usage for analytics but don't deduct tokens
        console.log(`[TESTING MODE] NOT deducting ${actualTotalTokens} tokens (paywall disabled)`);
        
        // Keeping the deduction code here for when paywall is re-enabled
        /*
        if (user.username !== 'jmkuczynski' && user.username !== 'randyjohnson') {
          console.log(`[TOKEN DEDUCTION] Deducting ${actualTotalTokens} tokens from user ${user.username} (balance: ${user.tokenBalance})`);
          const newBalance = Math.max(0, (user.tokenBalance || 0) - actualTotalTokens);
          await storage.updateUserTokenBalance(userId, newBalance);
          console.log(`[TOKEN DEDUCTION] New balance: ${newBalance} (prevented negative: ${(user.tokenBalance || 0) - actualTotalTokens})`);
          
          await storage.createTokenUsage({
            userId,
            sessionId: null,
            inputTokens,
            outputTokens: actualOutputTokens,
            remainingBalance: (user.tokenBalance || 0) - actualTotalTokens
          });
        }
        */
        
        const processingTime = Date.now() - startTime;

        // Generate graphs if required
        let graphImages: string[] | undefined;
        let graphDataJsons: string[] | undefined;
        
        if (llmResult.graphData && llmResult.graphData.length > 0) {
          try {
            graphImages = [];
            graphDataJsons = [];
            
            for (const graphData of llmResult.graphData) {
              const graphImage = await generateGraph(graphData);
              graphImages.push(graphImage);
              graphDataJsons.push(JSON.stringify(graphData));
            }
          } catch (error) {
            console.error('Graph generation error:', error);
          }
        }

        // Auto-generate filename from input text
        const autoFileName = inputText.split(' ').slice(0, 6).join(' ').substring(0, 50) + '...';
        
        // Store assignment
        const assignment = await storage.createAssignment({
          userId,
          sessionId: null,
          inputText,
          inputType: 'text',
          fileName: autoFileName,
          extractedText: null,
          llmProvider,
          llmResponse: llmResult.response,
          referenceDocumentIds, // Include reference documents used
          graphData: graphDataJsons,
          graphImages: graphImages,
          processingTime,
          inputTokens,
          outputTokens: actualOutputTokens,
        });

        const response: ProcessAssignmentResponse = {
          id: assignment.id,
          extractedText: inputText,
          llmResponse: llmResult.response,
          graphData: graphDataJsons,
          graphImages: graphImages,
          processingTime,
          success: true,
        };

        res.json(response);
      } else {
        // Free user - FREEMIUM MODEL: Process full answer but show only preview
        if (!actualSessionId) {
          actualSessionId = generateSessionId();
        }
        
        // Process with LLM to get complete answer
        let llmResult: {response: string, graphData?: GraphRequest[]};
        switch (llmProvider) {
          case 'anthropic':
            llmResult = await processWithAnthropic(combinedText);
            break;
          case 'openai':
            llmResult = await processWithOpenAI(combinedText);
            break;
          case 'grok':
            llmResult = await processWithGrok(combinedText);
            break;
          case 'venice':
            llmResult = await processWithVenice(combinedText);
            break;
          case 'perplexity':
            llmResult = await processWithPerplexity(combinedText);
            break;
          case 'deepseek':
            llmResult = await processWithDeepSeekFixed(combinedText);
            break;
          default:
            throw new Error(`Unsupported LLM provider: ${llmProvider}`);
        }

        // Generate preview for free users
        const previewResponse = generatePreview(llmResult.response);
        const finalOutputTokens = countTokens(previewResponse);
        const finalTotalTokens = inputTokens + finalOutputTokens;
        
        const processingTime = Date.now() - startTime;

        // No graphs for free users - premium feature
        const graphImages: string[] | undefined = undefined;
        const graphDataJsons: string[] | undefined = undefined;

        // Auto-generate filename from input text  
        const autoFileName = inputText.split(' ').slice(0, 6).join(' ').substring(0, 50) + '...';
        
        // Store assignment with preview only
        const assignment = await storage.createAssignment({
          userId: null,
          sessionId: actualSessionId,
          inputText,
          inputType: 'text',
          fileName: autoFileName,
          extractedText: null,
          llmProvider,
          llmResponse: previewResponse, // Store preview, not full answer
          referenceDocumentIds, // Include reference documents used
          graphData: graphDataJsons,
          graphImages: graphImages,
          processingTime,
          inputTokens,
          outputTokens: finalOutputTokens,
        });

        const response: ProcessAssignmentResponse = {
          id: assignment.id,
          extractedText: inputText,
          llmResponse: previewResponse, // Return preview to frontend
          graphData: graphDataJsons,
          graphImages: graphImages,
          processingTime,
          success: true,
          isPreview: true, // Flag to indicate this is a preview
        };

        res.json(response);
      }
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ error: "Invalid request data", details: error.errors });
      }
      
      console.error('Text processing error:', error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : "Failed to process text" 
      });
    }
  });

  // Upgrade assignment from preview to full answer
  app.post("/api/assignments/:id/upgrade", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const userId = req.session.userId;
      
      if (!userId) {
        return res.status(401).json({ error: "Authentication required to upgrade assignments" });
      }
      
      // Get the assignment
      const assignment = await storage.getAssignment(id, userId);
      if (!assignment) {
        return res.status(404).json({ error: "Assignment not found" });
      }
      
      // Check if user has tokens  
      const user = await authService.getUserById(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Count tokens needed for regeneration
      const inputTokens = countTokens(assignment.inputText || '');
      const estimatedOutputTokens = estimateOutputTokens(assignment.inputText || '');
      const totalTokens = inputTokens + estimatedOutputTokens;
      
      console.log(`[UPGRADE DEBUG] User ${user.username} has ${user.tokenBalance} tokens, needs ${totalTokens} for upgrade`);
      
      // Check token balance (special case for unlimited users)
      if (user.username !== 'jmkuczynski' && user.username !== 'randyjohnson' && (user.tokenBalance || 0) < totalTokens) {
        return res.status(402).json({ 
          error: "🔒 Insufficient credits to upgrade this assignment. [Buy More Credits]",
          needsUpgrade: true 
        });
      }
      
      const startTime = Date.now();
      
      // Regenerate full answer with LLM
      let llmResult: {response: string, graphData?: GraphRequest[]};
      switch (assignment.llmProvider) {
        case 'anthropic':
          llmResult = await processWithAnthropic(assignment.inputText || '');
          break;
        case 'openai':
          llmResult = await processWithOpenAI(assignment.inputText || '');
          break;
        case 'grok':
          llmResult = await processWithGrok(assignment.inputText || '');
          break;
        case 'venice':
          llmResult = await processWithVenice(assignment.inputText || '');
          break;
        case 'perplexity':
          llmResult = await processWithPerplexity(assignment.inputText || '');
          break;
        case 'deepseek':
          llmResult = await processWithDeepSeekFixed(assignment.inputText || '');
          break;
        default:
          return res.status(400).json({ error: `Unsupported LLM provider: ${assignment.llmProvider}` });
      }
      
      const actualOutputTokens = countTokens(llmResult.response);
      const actualTotalTokens = inputTokens + actualOutputTokens;
      const processingTime = Date.now() - startTime;
      
      // Deduct tokens (except for unlimited users)
      if (user.username !== 'jmkuczynski' && user.username !== 'randyjohnson') {
        console.log(`[UPGRADE DEDUCTION] Deducting ${actualTotalTokens} tokens from user ${user.username}`);
        const newBalance = Math.max(0, (user.tokenBalance || 0) - actualTotalTokens);
        await storage.updateUserTokenBalance(userId, newBalance);
        
        // Log token usage
        await storage.createTokenUsage({
          userId,
          sessionId: null,
          inputTokens,
          outputTokens: actualOutputTokens,
          remainingBalance: newBalance
        });
      }
      
      // Generate graphs if required
      let graphImages: string[] | undefined;
      let graphDataJsons: string[] | undefined;
      
      if (llmResult.graphData && llmResult.graphData.length > 0) {
        try {
          graphImages = [];
          graphDataJsons = [];
          
          for (const graphData of llmResult.graphData) {
            const graphImage = await generateGraph(graphData);
            graphImages.push(graphImage);
            graphDataJsons.push(JSON.stringify(graphData));
          }
        } catch (error) {
          console.error('Graph generation error:', error);
        }
      }
      
      // Update assignment with full response
      const updatedAssignment = await storage.updateAssignment(id, {
        llmResponse: llmResult.response,
        graphData: graphDataJsons,
        graphImages: graphImages,
        processingTime: assignment.processingTime + processingTime, // Add upgrade time
        outputTokens: actualOutputTokens,
      }, userId);
      
      const response: ProcessAssignmentResponse = {
        id: assignment.id,
        extractedText: assignment.inputText || '',
        llmResponse: llmResult.response,
        graphData: graphDataJsons,
        graphImages: graphImages,
        processingTime: processingTime,
        success: true,
      };
      
      console.log(`[UPGRADE SUCCESS] Assignment ${id} upgraded for user ${user.username}`);
      res.json(response);
      
    } catch (error) {
      console.error('Assignment upgrade error:', error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : "Failed to upgrade assignment" 
      });
    }
  });

  // Get all assignments with user isolation
  app.get("/api/assignments", async (req, res) => {
    try {
      // SECURITY: Get user ID from session for isolation
      const userId = req.session.userId;
      const sessionId = req.query.sessionId as string;
      
      // Get assignments scoped to user (or anonymous if no user)
      const assignments = await storage.getAllAssignments(userId, sessionId);
      const assignmentList: AssignmentListItem[] = assignments.map(assignment => ({
        id: assignment.id,
        extractedText: assignment.extractedText,
        llmProvider: assignment.llmProvider,
        processingTime: assignment.processingTime || 0,
        createdAt: assignment.createdAt?.toISOString() || new Date().toISOString(),
        fileName: assignment.fileName,
        inputText: assignment.inputText,
      }));
      
      res.json(assignmentList);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch assignments" });
    }
  });

  // Get assignment by ID with user isolation
  app.get("/api/assignments/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      // SECURITY: Get user ID from session for isolation
      const userId = req.session.userId;
      
      const assignment = await storage.getAssignment(id, userId);
      
      if (!assignment) {
        return res.status(404).json({ error: "Assignment not found" });
      }
      
      res.json(assignment);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch assignment" });
    }
  });

  // Update assignment by ID with user isolation
  app.patch("/api/assignments/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const userId = req.session?.userId || null;
      const sessionId = req.session?.id || req.body.sessionId || null;
      const updates = req.body;

      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid assignment ID" });
      }

      const updatedAssignment = await storage.updateAssignment(id, updates, userId, sessionId);
      
      if (!updatedAssignment) {
        return res.status(404).json({ error: "Assignment not found or access denied" });
      }

      console.log(`[UPDATE] Assignment ${id} updated`);
      res.json({ success: true, assignment: updatedAssignment });
    } catch (error) {
      console.error('Update assignment error:', error);
      res.status(500).json({ error: "Failed to update assignment" });
    }
  });

  // Delete assignment by ID with user isolation
  app.delete("/api/assignments/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const userId = req.session.userId;
      const sessionId = req.headers['x-session-id'] as string;
      
      // Validate ID parameter
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid assignment ID" });
      }
      
      // SECURITY: For anonymous users, sessionId is required
      if (!userId && !sessionId) {
        return res.status(400).json({ error: "Session ID is required for anonymous users" });
      }
      
      await storage.deleteAssignment(id, userId, sessionId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete assignment" });
    }
  });

  // Clean up assignments without file names
  app.post("/api/assignments/cleanup", async (req, res) => {
    try {
      await storage.cleanupEmptyAssignments();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to cleanup assignments" });
    }
  });

  // Bulk delete ALL user assignments with user isolation
  app.delete("/api/assignments", async (req, res) => {
    try {
      // SECURITY: Get user ID from session for isolation
      const userId = req.session.userId;
      const sessionId = req.headers['x-session-id'] as string;
      
      // SECURITY: For anonymous users, sessionId is required
      if (!userId && !sessionId) {
        return res.status(400).json({ error: "Session ID is required for anonymous users" });
      }
      
      await storage.deleteAllAssignments(userId, sessionId);
      res.json({ success: true });
    } catch (error) {
      console.error('Bulk delete assignments error:', error);
      res.status(500).json({ error: "Failed to delete all assignments" });
    }
  });

  // Upload reference document (whole file, not chunked)
  app.post("/api/documents", upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const userId = req.session.userId;
      const sessionId = req.headers['x-session-id'] as string;
      
      // SECURITY: For anonymous users, sessionId is required
      if (!userId && !sessionId) {
        return res.status(400).json({ error: "Session ID is required for anonymous users" });
      }
      
      const fileName = req.file.originalname;
      const mimeType = req.file.mimetype;
      const fileSize = req.file.size;
      
      // Extract text from uploaded file
      let extractedText = '';
      
      if (mimeType.startsWith('image/')) {
        extractedText = await performOCR(req.file.buffer, fileName);
      } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
                 mimeType === 'application/msword' ||
                 fileName.toLowerCase().endsWith('.docx') ||
                 fileName.toLowerCase().endsWith('.doc')) {
        extractedText = await extractTextFromWord(req.file.buffer);
      } else if (mimeType === 'application/pdf') {
        extractedText = await extractTextFromPDF(req.file.buffer);
      } else {
        return res.status(400).json({ error: "File type not supported. Please use images, Word documents, or PDFs." });
      }

      if (!extractedText.trim()) {
        return res.status(400).json({ error: "No text could be extracted from the file" });
      }

      // Create reference document record
      const document = await storage.createReferenceDocument({
        userId: userId || null,
        sessionId: sessionId || null,
        fileName,
        mimeType,
        fileSize,
        extractedText
      });

      res.json({ 
        success: true, 
        document: {
          id: document.id,
          fileName: document.fileName,
          fileSize: document.fileSize,
          extractedTextLength: extractedText.length,
          createdAt: document.createdAt
        }
      });
    } catch (error) {
      console.error('Reference document upload error:', error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : "Failed to upload reference document" 
      });
    }
  });

  // Get all reference documents for user
  app.get("/api/documents", async (req, res) => {
    try {
      const userId = req.session.userId;
      const sessionId = req.headers['x-session-id'] as string;
      
      // SECURITY: For anonymous users, sessionId is required
      if (!userId && !sessionId) {
        return res.status(400).json({ error: "Session ID is required for anonymous users" });
      }
      
      const documents = await storage.getAllReferenceDocuments(userId, sessionId);
      
      res.json(documents.map(doc => ({
        id: doc.id,
        fileName: doc.fileName,
        fileSize: doc.fileSize,
        extractedTextLength: doc.extractedText?.length || 0,
        createdAt: doc.createdAt
      })));
    } catch (error) {
      console.error('Get reference documents error:', error);
      res.status(500).json({ error: "Failed to fetch reference documents" });
    }
  });

  // Delete reference document by ID
  app.delete("/api/documents/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const userId = req.session.userId;
      const sessionId = req.headers['x-session-id'] as string;
      
      // Validate ID parameter
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid document ID" });
      }
      
      // SECURITY: For anonymous users, sessionId is required
      if (!userId && !sessionId) {
        return res.status(400).json({ error: "Session ID is required for anonymous users" });
      }
      
      await storage.deleteReferenceDocument(id, userId, sessionId);
      res.json({ success: true });
    } catch (error) {
      console.error('Delete reference document error:', error);
      res.status(500).json({ error: "Failed to delete reference document" });
    }
  });

  // Extract text from file endpoint (no LLM processing)
  app.post("/api/extract-text", upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      
      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      let extractedText = "";
      const fileName = file.originalname.toLowerCase();
      
      if (fileName.endsWith('.pdf')) {
        extractedText = await extractTextFromPDF(file.buffer);
      } else if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
        extractedText = await extractTextFromWord(file.buffer);
      } else if (fileName.match(/\.(png|jpg|jpeg)$/)) {
        extractedText = await performOCR(file.buffer, fileName);
      } else {
        return res.status(400).json({ error: "Unsupported file type. Please upload PDF, Word document, or image file." });
      }

      if (!extractedText || extractedText.trim().length === 0) {
        return res.status(400).json({ error: "No text could be extracted from the file" });
      }

      res.json({ 
        extractedText: extractedText.trim(),
        fileName: file.originalname 
      });
    } catch (error: any) {
      console.error('Text extraction error:', error);
      res.status(500).json({ error: error.message || 'Failed to extract text from file' });
    }
  });

  // Email solution endpoint
  app.post("/api/email-solution", async (req, res) => {
    try {
      const { toEmail, fromEmail, content, title } = req.body;

      if (!toEmail || !fromEmail || !content) {
        return res.status(400).json({ error: "To email, from email, and content are required" });
      }

      if (!process.env.SENDGRID_API_KEY) {
        return res.status(500).json({ error: "SendGrid not configured. Please provide SENDGRID_API_KEY." });
      }

      const { default: sgMail } = await import('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);

      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>${title || 'Homework Solution'}</title>
          <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
          <script>
            window.MathJax = {
              tex: {
                inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
                displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']],
                processEscapes: true
              }
            };
          </script>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
            h1, h2 { color: #2563eb; }
            .solution-section { margin-top: 20px; }
            .math-content { white-space: pre-wrap; word-wrap: break-word; }
            .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 14px; }
          </style>
        </head>
        <body>
          <h1>${title || 'Homework Solution'}</h1>
          
          <div class="solution-section">
            <div class="math-content">${content}</div>
          </div>
          
          <div class="footer">
            <p>This solution was generated by the AI Homework Assistant.</p>
          </div>
        </body>
        </html>
      `;

      const msg = {
        to: toEmail,
        from: process.env.SENDGRID_VERIFIED_SENDER || fromEmail,
        subject: title || 'Your Homework Solution',
        html: htmlContent,
      };

      await sgMail.send(msg);
      
      res.json({ success: true, message: 'Solution sent successfully!' });
    } catch (error: any) {
      console.error('Email sending error:', error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : "Failed to send email" 
      });
    }
  });

  // Grading endpoint - STRICT adherence to user's grading instructions
  app.post("/api/grade-submission", async (req, res) => {
    try {
      const { assignmentPrompt, gradingInstructions, studentSubmission } = req.body;
      
      if (!assignmentPrompt || !gradingInstructions || !studentSubmission) {
        return res.status(400).json({ error: "All fields are required" });
      }

      // Build prompt that treats grading instructions as ABSOLUTE LAW
      const gradingPrompt = `
YOU ARE A GRADING ASSISTANT. YOUR ONLY JOB IS TO FOLLOW THE INSTRUCTOR'S GRADING INSTRUCTIONS EXACTLY AS WRITTEN.

=== ABSOLUTE LAW - GRADING INSTRUCTIONS (FOLLOW THESE EXACTLY) ===
${gradingInstructions}
=== END OF GRADING INSTRUCTIONS ===

CRITICAL RULES:
1. The grading instructions above are ABSOLUTE LAW - you MUST follow them EXACTLY
2. DO NOT apply any generic grading criteria
3. DO NOT use your own judgment about quality unless the instructions ask for it
4. Use the EXACT grading format specified in the instructions (letter grades, numeric, pass/fail, etc.)
5. If the instructions say "A IF PERFECT" then give it an A if it's perfect - NOT 95/100
6. If the instructions say "B IF PERFECT BUT DOES NOT INCLUDE QUOTES" then check for quotes and give a B if appropriate
7. Follow the instructor's rubric PRECISELY - no deviations, no conversions, no interpretations
8. Your grade must be in the EXACT format the instructions specify

ASSIGNMENT:
${assignmentPrompt}

STUDENT SUBMISSION:
${studentSubmission}

Now grade this submission following the GRADING INSTRUCTIONS EXACTLY. Provide:
1. A grade in EXACTLY the format specified by the grading instructions
2. Brief comments explaining how the submission matches the grading criteria

Format your response EXACTLY like this:
GRADE: [grade in the format specified by the rubric]
COMMENTS: [your comments here]
`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ 
          role: "user", 
          content: gradingPrompt
        }],
        max_tokens: 2000,
      });

      const responseText = response.choices[0]?.message?.content || '';
      
      // Parse the response - handle any grade format
      const gradeMatch = responseText.match(/GRADE:\s*(.+?)(?=\n|$)/i);
      const commentsMatch = responseText.match(/COMMENTS:\s*([\s\S]+)/i);
      
      const gradeText = gradeMatch ? gradeMatch[1].trim() : 'No grade';
      const comments = commentsMatch ? commentsMatch[1].trim() : responseText;

      // Try to convert to numeric for display, but preserve original
      let numericGrade = 0;
      const numericMatch = gradeText.match(/(\d+)(?:\/100)?/);
      if (numericMatch) {
        numericGrade = parseInt(numericMatch[1]);
      } else if (gradeText.match(/\bA\+?\b/i)) {
        numericGrade = 98;
      } else if (gradeText.match(/\bA-?\b/i)) {
        numericGrade = 92;
      } else if (gradeText.match(/\bB\+?\b/i)) {
        numericGrade = 88;
      } else if (gradeText.match(/\bB-?\b/i)) {
        numericGrade = 82;
      } else if (gradeText.match(/\bC\+?\b/i)) {
        numericGrade = 78;
      } else if (gradeText.match(/\bC-?\b/i)) {
        numericGrade = 72;
      } else if (gradeText.match(/\bD\b/i)) {
        numericGrade = 65;
      } else if (gradeText.match(/\bF\b/i)) {
        numericGrade = 50;
      } else if (gradeText.match(/pass/i)) {
        numericGrade = 85;
      } else if (gradeText.match(/fail/i)) {
        numericGrade = 40;
      }

      res.json({
        grade: numericGrade,
        gradeText: gradeText, // Original grade as specified by rubric
        comments,
        feedback: gradingInstructions
      });
    } catch (error: any) {
      console.error('Grading error:', error);
      res.status(500).json({ error: error.message || 'Grading failed' });
    }
  });

  // Grade adjustment endpoint
  app.post("/api/adjust-grade", async (req, res) => {
    try {
      const { 
        assignmentPrompt, 
        gradingInstructions, 
        studentSubmission,
        currentGrade,
        currentComments,
        adjustmentType,
        studentName 
      } = req.body;
      
      if (!assignmentPrompt || !gradingInstructions || !studentSubmission || !adjustmentType) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      let adjustmentPrompt = '';
      
      if (adjustmentType === 'reevaluate') {
        adjustmentPrompt = `Re-evaluate this submission completely from scratch, following the grading instructions exactly.`;
      } else if (adjustmentType === 'higher') {
        adjustmentPrompt = `The current grade of ${currentGrade}/100 is too low. Re-evaluate and give a higher grade that better reflects the submission's quality according to the grading instructions.`;
      } else if (adjustmentType === 'lower') {
        adjustmentPrompt = `The current grade of ${currentGrade}/100 is too high. Re-evaluate and give a lower grade that better reflects the submission's issues according to the grading instructions.`;
      } else {
        adjustmentPrompt = `The grade of ${currentGrade}/100 is appropriate. Provide the same grade with refined comments.`;
      }

      const gradingPrompt = `
YOU ARE A GRADING ASSISTANT. YOUR ONLY JOB IS TO FOLLOW THE INSTRUCTOR'S GRADING INSTRUCTIONS EXACTLY AS WRITTEN.

=== ABSOLUTE LAW - GRADING INSTRUCTIONS (FOLLOW THESE EXACTLY) ===
${gradingInstructions}
=== END OF GRADING INSTRUCTIONS ===

ADJUSTMENT REQUEST: ${adjustmentPrompt}

CRITICAL RULES:
1. The grading instructions above are ABSOLUTE LAW - you MUST follow them EXACTLY
2. Use the EXACT grading format specified in the instructions (letter grades, numeric, pass/fail, etc.)
3. Follow the instructor's rubric PRECISELY - no deviations, no conversions

ASSIGNMENT:
${assignmentPrompt}

STUDENT SUBMISSION:
${studentSubmission}

PREVIOUS GRADE: ${currentGrade}
PREVIOUS COMMENTS: ${currentComments}

Now grade this submission following the GRADING INSTRUCTIONS EXACTLY and the adjustment request. Provide:
1. A grade in EXACTLY the format specified by the grading instructions
2. Brief comments explaining how the submission matches the grading criteria

Format your response EXACTLY like this:
GRADE: [grade in the format specified by the rubric]
COMMENTS: [your comments here]
`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ 
          role: "user", 
          content: gradingPrompt
        }],
        max_tokens: 2000,
      });

      const responseText = response.choices[0]?.message?.content || '';
      
      // Parse the response - handle any grade format
      const gradeMatch = responseText.match(/GRADE:\s*(.+?)(?=\n|$)/i);
      const commentsMatch = responseText.match(/COMMENTS:\s*([\s\S]+)/i);
      
      const gradeText = gradeMatch ? gradeMatch[1].trim() : 'No grade';
      const comments = commentsMatch ? commentsMatch[1].trim() : responseText;

      // Try to convert to numeric for display, but preserve original
      let numericGrade = currentGrade || 0;
      const numericMatch = gradeText.match(/(\d+)(?:\/100)?/);
      if (numericMatch) {
        numericGrade = parseInt(numericMatch[1]);
      } else if (gradeText.match(/\bA\+?\b/i)) {
        numericGrade = 98;
      } else if (gradeText.match(/\bA-?\b/i)) {
        numericGrade = 92;
      } else if (gradeText.match(/\bB\+?\b/i)) {
        numericGrade = 88;
      } else if (gradeText.match(/\bB-?\b/i)) {
        numericGrade = 82;
      } else if (gradeText.match(/\bC\+?\b/i)) {
        numericGrade = 78;
      } else if (gradeText.match(/\bC-?\b/i)) {
        numericGrade = 72;
      } else if (gradeText.match(/\bD\b/i)) {
        numericGrade = 65;
      } else if (gradeText.match(/\bF\b/i)) {
        numericGrade = 50;
      }

      res.json({
        grade: numericGrade,
        gradeText: gradeText, // Original grade as specified by rubric
        comments,
        feedback: gradingInstructions
      });
    } catch (error: any) {
      console.error('Grade adjustment error:', error);
      res.status(500).json({ error: error.message || 'Grade adjustment failed' });
    }
  });

  // AI detection endpoint
  app.post("/api/ai-detection", async (req, res) => {
    try {
      const { text } = req.body;
      
      if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: "Text is required" });
      }

      const result = await checkAIDetection(text);
      res.json(result);
    } catch (error: any) {
      console.error('AI detection error:', error);
      res.status(500).json({ error: error.message || 'AI detection failed' });
    }
  });

  // HTML to PDF conversion endpoint
  app.post("/api/html-to-pdf", async (req, res) => {
    try {
      const { htmlContent, title, graphImage } = req.body;
      
      if (!htmlContent || typeof htmlContent !== 'string') {
        return res.status(400).json({ error: "HTML content is required" });
      }

      const pdfBuffer = await convertHtmlToPdf(htmlContent, title, graphImage);
      
      // Set headers for PDF download
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${title || 'assignment'}.pdf"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      
      res.send(pdfBuffer);
    } catch (error: any) {
      console.error('HTML to PDF conversion error:', error);
      res.status(500).json({ error: error.message || 'Failed to convert HTML to PDF' });
    }
  });

  // PDF generation endpoint (LaTeX fallback)
  app.post("/api/generate-pdf", async (req, res) => {
    try {
      const { content, title, extractedText, graphImage } = req.body;
      
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: "Content is required" });
      }

      const pdfBuffer = await generatePDF(content, title, extractedText, graphImage);
      
      // Set headers for PDF download
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${title || 'assignment'}.pdf"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      
      res.send(pdfBuffer);
    } catch (error: any) {
      console.error('PDF generation error:', error);
      res.status(500).json({ error: error.message || 'Failed to generate PDF' });
    }
  });

  // Graph PDF generation endpoint
  app.post("/api/generate-graph-pdf", async (req, res) => {
    try {
      const { graphImage, title } = req.body;
      
      if (!graphImage || typeof graphImage !== 'string') {
        return res.status(400).json({ error: "Graph image is required" });
      }

      const graphHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${title || 'Generated Graph'}</title>
    <style>
        body {
            font-family: 'Times New Roman', serif;
            margin: 0;
            padding: 40px;
            background: white;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
        }
        h1 {
            color: #000;
            margin-bottom: 30px;
            font-size: 24pt;
            text-align: center;
        }
        .graph-container {
            width: 100%;
            display: flex;
            justify-content: center;
            margin-bottom: 20px;
        }
        .graph-image {
            max-width: 100%;
            height: auto;
            border: 1px solid #ddd;
            border-radius: 4px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        @page {
            margin: 0.75in;
            size: letter;
        }
        @media print {
            body { margin: 0; }
        }
    </style>
</head>
<body>
    <h1>${title || 'Generated Graph'}</h1>
    <div class="graph-container">
        <img src="data:image/png;base64,${graphImage}" alt="Generated Graph" class="graph-image" />
    </div>
</body>
</html>`;

      const pdfBuffer = await convertHtmlToPdf(graphHtml, title || 'Generated Graph');
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${(title || 'graph').replace(/[^a-zA-Z0-9]/g, '_')}_graph.pdf"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      
      res.send(pdfBuffer);
    } catch (error: any) {
      console.error('Graph PDF generation error:', error);
      res.status(500).json({ error: error.message || 'Failed to generate graph PDF' });
    }
  });

  // Email solution endpoint using SendGrid
  app.post("/api/email-solution", async (req, res) => {
    try {
      const { email, solution, assignmentTitle } = req.body;
      
      if (!email || !solution) {
        return res.status(400).json({ error: "Email and solution are required" });
      }

      if (!process.env.SENDGRID_API_KEY) {
        return res.status(500).json({ error: "SendGrid API key not configured" });
      }

      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);

      const msg = {
        to: email,
        from: process.env.SENDGRID_VERIFIED_SENDER || 'noreply@example.com',
        subject: assignmentTitle || 'Homework Solution',
        text: solution,
        html: `<pre>${solution}</pre>`
      };

      await sgMail.send(msg);
      
      res.json({ 
        success: true, 
        message: "Email sent successfully" 
      });
    } catch (error: any) {
      console.error('SendGrid email error:', error);
      res.status(500).json({ error: error.message || "Failed to send email" });
    }
  });

  // Chat endpoint
  app.post("/api/chat", async (req, res) => {
    try {
      const { message, provider, context, conversationHistory = [] } = req.body;
      
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: "Message is required" });
      }

      // Build conversation context
      let fullPrompt = message;
      
      if (context) {
        fullPrompt = `Context: I'm working on this problem: "${context.problem}" and got this solution: "${context.solution}"\n\n`;
      }
      
      if (conversationHistory.length > 0) {
        const historyText = conversationHistory
          .map((msg: any) => `${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.content}`)
          .join('\n\n');
        fullPrompt = `Previous conversation:\n${historyText}\n\nCurrent question: ${message}`;
      }

      let result: {response: string, graphData?: any};
      switch (provider) {
        case 'anthropic':
          result = await processWithAnthropic(fullPrompt);
          break;
        case 'openai':
          result = await processWithOpenAI(fullPrompt);
          break;
        case 'venice':
          result = await processWithVenice(fullPrompt);
          break;
        case 'perplexity':
          result = await processWithPerplexity(fullPrompt);
          break;
        case 'deepseek':
          result = await processWithDeepSeekFixed(fullPrompt);
          break;
        default:
          return res.status(400).json({ error: "Invalid provider" });
      }

      res.json({ response: result.response });
    } catch (error: any) {
      console.error('Chat error:', error);
      res.status(500).json({ error: error.message || 'Chat failed' });
    }
  });

  // Enhanced Math PDF generation endpoint
  app.post("/api/generate-math-pdf", async (req, res) => {
    try {
      const { content, title, extractedText, renderedHtml } = req.body;
      
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: "Content is required" });
      }

      // Use pre-rendered HTML if available, otherwise process math content
      const mathContent = renderedHtml || content;
      
      const pdfBuffer = await generateMathPDF(mathContent, title, extractedText);
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${(title || 'math-solution').replace(/[^a-zA-Z0-9]/g, '_')}.pdf"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      
      res.send(pdfBuffer);
    } catch (error: any) {
      console.error('Math PDF generation error:', error);
      res.status(500).json({ error: error.message || 'Failed to generate math PDF' });
    }
  });

  // Chat file upload endpoint
  app.post("/api/chat-upload", upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      const { provider, message, conversationHistory = [] } = req.body;

      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      let extractedText = "";
      const fileName = file.originalname.toLowerCase();
      
      if (fileName.endsWith('.pdf')) {
        extractedText = await extractTextFromPDF(file.buffer);
      } else if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
        extractedText = await extractTextFromWord(file.buffer);
      } else if (fileName.match(/\.(png|jpg|jpeg)$/)) {
        extractedText = await performOCR(file.buffer, fileName);
      } else {
        return res.status(400).json({ error: "Unsupported file type. Please upload PDF, Word document, or image file." });
      }

      let chatPrompt = message ? `${message}\n\nFile content:\n${extractedText}` : `Please analyze this file content:\n\n${extractedText}`;
      
      // Add conversation history context
      if (conversationHistory && conversationHistory.length > 0) {
        const historyText = conversationHistory
          .map((msg: any) => `${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.content}`)
          .join('\n\n');
        chatPrompt = `Previous conversation:\n${historyText}\n\n${chatPrompt}`;
      }

      let result: {response: string, graphData?: any};
      switch (provider) {
        case 'anthropic':
          result = await processWithAnthropic(chatPrompt);
          break;
        case 'openai':
          result = await processWithOpenAI(chatPrompt);
          break;
        case 'venice':
          result = await processWithVenice(chatPrompt);
          break;
        case 'perplexity':
          result = await processWithPerplexity(chatPrompt);
          break;
        default:
          return res.status(400).json({ error: "Invalid provider" });
      }

      res.json({ response: result.response, extractedText, fileName: file.originalname });
    } catch (error: any) {
      console.error('Chat upload error:', error);
      res.status(500).json({ error: error.message || 'Chat upload failed' });
    }
  });

  // Rewrite endpoint
  app.post("/api/rewrite", async (req, res) => {
    try {
      const { originalSolution, critique, provider, problem } = req.body;
      
      if (!originalSolution || !critique || !provider) {
        return res.status(400).json({ error: "Original solution, critique, and provider are required" });
      }

      const rewritePrompt = `I need you to rewrite this solution based on the critique provided.

Original Problem: ${problem}

Original Solution:
${originalSolution}

Critique/Feedback:
${critique}

Please provide an improved solution that addresses the feedback. Maintain proper mathematical notation and formatting.`;

      let result: {response: string, graphData?: GraphRequest[]};
      switch (provider) {
        case 'anthropic':
          result = await processWithAnthropic(rewritePrompt);
          break;
        case 'openai':
          result = await processWithOpenAI(rewritePrompt);
          break;
        case 'venice':
          result = await processWithVenice(rewritePrompt);
          break;
        case 'perplexity':
          result = await processWithPerplexity(rewritePrompt);
          break;
        default:
          return res.status(400).json({ error: "Invalid provider" });
      }

      res.json({ rewrittenSolution: result.response });
    } catch (error: any) {
      console.error('Rewrite error:', error);
      res.status(500).json({ error: error.message || 'Rewrite failed' });
    }
  });

  // Multi-graph PDF generation endpoint
  app.post("/api/generate-multi-graph-pdf", async (req, res) => {
    try {
      const { graphImages, graphData, title } = req.body;
      
      if (!graphImages || !Array.isArray(graphImages) || graphImages.length === 0) {
        return res.status(400).json({ error: "Graph images are required" });
      }

      const pdfBuffers: Buffer[] = [];
      
      // Generate individual graph PDFs
      for (let i = 0; i < graphImages.length; i++) {
        const graphImage = graphImages[i];
        const graphInfo = graphData && graphData[i] ? JSON.parse(graphData[i]) : {};
        const graphTitle = graphInfo.title || `Graph ${i + 1}`;
        
        const graphHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${graphTitle}</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
        }
        .graph-container {
            text-align: center;
            max-width: 100%;
        }
        .graph-title {
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
            color: #333;
        }
        .graph-image {
            max-width: 100%;
            height: auto;
            border: 1px solid #ddd;
            border-radius: 8px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.1);
        }
        .graph-description {
            margin-top: 20px;
            font-size: 14px;
            color: #666;
            max-width: 600px;
            line-height: 1.4;
        }
    </style>
</head>
<body>
    <div class="graph-container">
        <h1 class="graph-title">${graphTitle}</h1>
        <img src="data:image/png;base64,${graphImage}" alt="${graphTitle}" class="graph-image" />
        ${graphInfo.description ? `<p class="graph-description">${graphInfo.description}</p>` : ''}
    </div>
</body>
</html>`;

        const graphPdfBuffer = await convertHtmlToPdf(graphHtml, graphTitle);
        pdfBuffers.push(graphPdfBuffer);
      }

      // Combine all PDFs
      const combinedPdf = await combinePDFs(pdfBuffers);
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${title || 'graphs'}_combined.pdf"`);
      res.setHeader('Content-Length', combinedPdf.length);
      
      res.send(combinedPdf);
    } catch (error: any) {
      console.error('Multi-graph PDF generation error:', error);
      res.status(500).json({ error: error.message || 'Failed to generate multi-graph PDF' });
    }
  });

  // Combined solution + graphs PDF endpoint
  app.post("/api/generate-combined-pdf", async (req, res) => {
    try {
      const { content, title, extractedText, graphImages, graphData } = req.body;
      
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: "Content is required" });
      }

      const pdfBuffers: Buffer[] = [];

      // Generate individual graph PDFs first
      if (graphImages && Array.isArray(graphImages) && graphImages.length > 0) {
        for (let i = 0; i < graphImages.length; i++) {
          const graphImage = graphImages[i];
          const graphInfo = graphData && graphData[i] ? JSON.parse(graphData[i]) : {};
          const graphTitle = graphInfo.title || `Graph ${i + 1}`;
          
          const graphHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${graphTitle}</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
        }
        .graph-container {
            text-align: center;
            max-width: 100%;
        }
        .graph-title {
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
            color: #333;
        }
        .graph-image {
            max-width: 100%;
            height: auto;
            border: 1px solid #ddd;
            border-radius: 8px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.1);
        }
        .graph-description {
            margin-top: 20px;
            font-size: 14px;
            color: #666;
            max-width: 600px;
            line-height: 1.4;
        }
    </style>
</head>
<body>
    <div class="graph-container">
        <h1 class="graph-title">${graphTitle}</h1>
        <img src="data:image/png;base64,${graphImage}" alt="${graphTitle}" class="graph-image" />
        ${graphInfo.description ? `<p class="graph-description">${graphInfo.description}</p>` : ''}
    </div>
</body>
</html>`;

          const graphPdfBuffer = await convertHtmlToPdf(graphHtml, graphTitle);
          pdfBuffers.push(graphPdfBuffer);
        }
      }

      // Generate main solution PDF
      let solutionHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${title || 'Assignment Solution'}</title>
    <style>
        body {
            font-family: 'Times New Roman', serif;
            line-height: 1.6;
            max-width: 800px;
            margin: 20px auto;
            padding: 20px;
            color: #000;
            background: white;
            font-size: 14pt;
        }
        h1, h2, h3 {
            color: #333;
            margin-top: 1.5em;
            margin-bottom: 0.5em;
            page-break-after: avoid;
        }
        .problem-section {
            background: #f9f9f9;
            padding: 15px;
            border-left: 4px solid #3b82f6;
            margin-bottom: 20px;
        }
        .solution-section {
            margin-top: 20px;
        }
        @media print {
            body { margin: 0; }
            .problem-section { 
                background: #f5f5f5 !important; 
                -webkit-print-color-adjust: exact;
            }
        }
    </style>
</head>
<body>
    <h1>${(title || 'Assignment Solution').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h1>
    
    ${extractedText ? `
    <div class="problem-section">
        <h2>Problem Statement</h2>
        <p>${extractedText.replace(/\n/g, '<br>').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
    </div>
    ` : ''}
    
    <div class="solution-section">
        <h2>Solution</h2>
        <div class="math-content">${content}</div>
    </div>
</body>
</html>`;

      const solutionPdfBuffer = await convertHtmlToPdf(solutionHtml, title || 'Assignment Solution');
      pdfBuffers.push(solutionPdfBuffer);

      // Combine all PDFs
      const combinedPdf = await combinePDFs(pdfBuffers);
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${title || 'assignment'}_complete.pdf"`);
      res.setHeader('Content-Length', combinedPdf.length);
      
      res.send(combinedPdf);
    } catch (error: any) {
      console.error('Combined PDF generation error:', error);
      res.status(500).json({ error: error.message || 'Failed to generate combined PDF' });
    }
  });

  // GPT BYPASS / Humanizer routes
  
  // Coherent rewrite with SSE streaming for large documents (>1000 words)
  app.post('/api/humanize/coherent-rewrite', async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { inputText, styleText, contentMixText, customInstructions, selectedPresets, mixingMode } = req.body;

    if (!inputText) {
      res.status(400).json({ error: 'Input text is required' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');

    // Heartbeat every 15s to prevent proxy timeouts
    const heartbeatInterval = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 15000);

    try {
      for await (const event of coherenceService.processLargeRewrite(userId, {
        inputText,
        styleText,
        contentMixText,
        customInstructions,
        selectedPresets,
        mixingMode
      })) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    } finally {
      clearInterval(heartbeatInterval);
    }

    res.end();
  });

  app.post('/api/humanize/rewrite', async (req, res) => {
    try {
      const { inputText, styleText, contentMixText, customInstructions, selectedPresets, provider, selectedChunkIds, mixingMode } = req.body;

      if (!inputText || !provider) {
        return res.status(400).json({ error: 'Input text and provider are required' });
      }

      // Get initial AI score
      const initialScore = await gptZeroService.analyzeText(inputText);
      
      // Create chunks if needed
      const chunks = selectedChunkIds && selectedChunkIds.length > 0 ? 
        textChunkerService.chunkText(inputText) : [{ id: 'full', content: inputText, startWord: 0, endWord: inputText.split(' ').length }];
      
      // Reconstruct text from selected chunks or use full text
      const textToRewrite = selectedChunkIds && selectedChunkIds.length > 0 ?
        chunks.filter(chunk => selectedChunkIds.includes(chunk.id)).map(chunk => chunk.content).join(' ') : inputText;
      
      // Rewrite text using AI provider service
      const rewrittenText = await aiProviderService.rewrite(provider, {
        inputText: textToRewrite,
        styleText,
        contentMixText,
        customInstructions,
        selectedPresets,
        mixingMode
      });
      
      // Get final AI score
      const finalScore = await gptZeroService.analyzeText(rewrittenText);
      
      // Store in database
      const jobId = `rewrite_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await storage.createRewriteJob({
        id: jobId,
        inputText,
        styleText,
        contentMixText,
        customInstructions,
        selectedPresets,
        provider,
        chunks: JSON.stringify(chunks),
        selectedChunkIds: JSON.stringify(selectedChunkIds || []),
        mixingMode,
        outputText: rewrittenText,
        inputAiScore: initialScore.aiScore,
        outputAiScore: finalScore.aiScore,
        status: 'completed'
      });
      
      res.json({
        rewrittenText,
        inputAiScore: initialScore.aiScore,
        outputAiScore: finalScore.aiScore,
        jobId
      });
    } catch (error) {
      console.error('Rewrite error:', error);
      res.status(500).json({ error: error.message || 'Failed to rewrite text' });
    }
  });

  app.post('/api/humanize/analyze', async (req, res) => {
    try {
      const { text } = req.body;
      
      if (!text) {
        return res.status(400).json({ error: 'Text is required' });
      }

      const result = await gptZeroService.analyzeText(text);
      
      res.json(result);
    } catch (error) {
      console.error('Analysis error:', error);
      res.status(500).json({ error: error.message || 'Failed to analyze text' });
    }
  });

  app.post('/api/humanize/chunk', async (req, res) => {
    try {
      const { text } = req.body;
      
      if (!text) {
        return res.status(400).json({ error: 'Text is required' });
      }

      const chunks = textChunkerService.chunkText(text);
      const stats = textChunkerService.getChunkStats(chunks);
      
      res.json({ chunks, stats });
    } catch (error) {
      console.error('Chunking error:', error);
      res.status(500).json({ error: error.message || 'Failed to chunk text' });
    }
  });

  app.post('/api/humanize/upload', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      if (!fileProcessorService.isValidFileType(req.file.originalname)) {
        return res.status(400).json({ error: 'Unsupported file type' });
      }

      if (req.file.size > fileProcessorService.getMaxFileSize()) {
        return res.status(400).json({ error: 'File too large' });
      }

      const processedFile = await fileProcessorService.processFile(req.file.buffer, req.file.originalname);
      
      // Store document in database
      await storage.createDocument({
        id: processedFile.id,
        filename: processedFile.filename,
        content: processedFile.content,
        wordCount: processedFile.wordCount
      });
      
      res.json(processedFile);
    } catch (error) {
      console.error('File upload error:', error);
      res.status(500).json({ error: error.message || 'Failed to process file' });
    }
  });

  app.get('/api/humanize/jobs/:id', async (req, res) => {
    try {
      const job = await storage.getRewriteJob(req.params.id);
      
      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }
      
      res.json(job);
    } catch (error) {
      console.error('Get job error:', error);
      res.status(500).json({ error: error.message || 'Failed to get job' });
    }
  });

  app.get('/api/humanize/jobs', async (req, res) => {
    try {
      const jobs = await storage.getRewriteJobs();
      res.json(jobs);
    } catch (error) {
      console.error('Get jobs error:', error);
      res.status(500).json({ error: error.message || 'Failed to get jobs' });
    }
  });

  // ============================================================================
  // ASSEMBLYAI — Real-time transcription token
  // ============================================================================

  app.post("/api/assemblyai/token", async (req: any, res) => {
    try {
      const apiKey = process.env.ASSEMBLYAI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "AssemblyAI API key not configured" });
      const response = await fetch("https://api.assemblyai.com/v2/realtime/token", {
        method: "POST",
        headers: { "Authorization": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ expires_in: 3600 }),
      });
      if (!response.ok) {
        const err = await response.text();
        return res.status(500).json({ error: `AssemblyAI token error: ${err}` });
      }
      const data = await response.json() as { token: string };
      res.json({ token: data.token });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================================
  // PROJECTS SYSTEM — Tractatus Tree memory + Long-term workspaces
  // ============================================================================

  // Import tractatus helpers inline (avoid circular imports in large routes file)
  const { compactTreeString, tryParseTractatusJSON, buildTractatusSystemPrompt, loadTieredMemory, updateTractatusTree, generateLargeDocument } = await import('./services/tractatusService');

  // GET /api/projects — list all projects for the logged-in user
  app.get("/api/projects", async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const allProjects = await storage.getAllProjects(userId);
      res.json(allProjects);
    } catch (err: any) {
      console.error("GET /api/projects error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects — create a project
  app.post("/api/projects", async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { name, description } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "Project name is required" });
      const project = await storage.createProject({ userId, name: name.trim(), description: description?.trim() || null, tractatusTree: {}, tractatusTier: 1, compressionCount: 0 });
      res.json(project);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/projects/:id — rename / update project
  app.patch("/api/projects/:id", async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const { name, description } = req.body;
      const updated = await storage.updateProject(id, { name, description }, userId);
      if (!updated) return res.status(404).json({ error: "Project not found" });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/projects/:id
  app.delete("/api/projects/:id", async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      await storage.deleteProject(parseInt(req.params.id), userId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/:id/tractatus — raw tree
  app.get("/api/projects/:id/tractatus", async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const project = await storage.getProject(parseInt(req.params.id), userId);
      if (!project) return res.status(404).json({ error: "Project not found" });
      res.json({ tree: project.tractatusTree || {}, nodeCount: Object.keys(project.tractatusTree || {}).length, lastTreeUpdate: project.lastTreeUpdate, compressionCount: project.compressionCount });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/:id/memory-hierarchy — all tiers
  app.get("/api/projects/:id/memory-hierarchy", async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const project = await storage.getProject(parseInt(req.params.id), userId);
      if (!project) return res.status(404).json({ error: "Project not found" });
      const tieredMemory = await loadTieredMemory(project.id);
      const archives = await storage.getTractatusArchives(project.id);
      res.json({ tiers: tieredMemory.tiers, archives: archives.map(a => ({ tier: a.tier, nodeCount: a.nodeCount, createdAt: a.createdAt })), totalChars: tieredMemory.totalChars });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Project Sessions ----

  // GET /api/projects/:id/sessions
  app.get("/api/projects/:id/sessions", async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const project = await storage.getProject(parseInt(req.params.id), userId);
      if (!project) return res.status(404).json({ error: "Project not found" });
      const sessions = await storage.getAllProjectSessions(project.id);
      // Return sessions without full transcript for listing
      res.json(sessions.map(s => ({ id: s.id, projectId: s.projectId, title: s.title, messageCount: Array.isArray(s.transcript) ? s.transcript.length : 0, createdAt: s.createdAt })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/:id/sessions — create new session
  app.post("/api/projects/:id/sessions", async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const project = await storage.getProject(parseInt(req.params.id), userId);
      if (!project) return res.status(404).json({ error: "Project not found" });
      const { title } = req.body;
      const session = await storage.createProjectSession({ projectId: project.id, title: title || "New Session", transcript: [] });
      res.json(session);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/project-sessions/:id — get session with full transcript
  app.get("/api/project-sessions/:id", async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const session = await storage.getProjectSession(parseInt(req.params.id));
      if (!session) return res.status(404).json({ error: "Session not found" });
      // Verify project ownership
      const project = await storage.getProject(session.projectId!, userId);
      if (!project) return res.status(403).json({ error: "Access denied" });
      res.json(session);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/project-sessions/:id — rename
  app.patch("/api/project-sessions/:id", async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const session = await storage.getProjectSession(parseInt(req.params.id));
      if (!session) return res.status(404).json({ error: "Session not found" });
      const project = await storage.getProject(session.projectId!, userId);
      if (!project) return res.status(403).json({ error: "Access denied" });
      const updated = await storage.updateProjectSession(session.id, { title: req.body.title });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/project-sessions/:id
  app.delete("/api/project-sessions/:id", async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const session = await storage.getProjectSession(parseInt(req.params.id));
      if (!session) return res.status(404).json({ error: "Session not found" });
      const project = await storage.getProject(session.projectId!, userId);
      if (!project) return res.status(403).json({ error: "Access denied" });
      await storage.deleteProjectSession(session.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Project Chat (SSE with Tractatus memory) ----

  app.post("/api/project-sessions/:id/chat", async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const session = await storage.getProjectSession(parseInt(req.params.id));
      if (!session) return res.status(404).json({ error: "Session not found" });
      const project = await storage.getProject(session.projectId!, userId);
      if (!project) return res.status(403).json({ error: "Access denied" });

      const { message, provider = "anthropic" } = req.body;
      if (!message?.trim()) return res.status(400).json({ error: "Message is required" });

      // SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const send = (data: any) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
      };

      // Load tiered memory
      const tieredMemory = await loadTieredMemory(project.id);

      // Build system prompt with Tractatus tree
      const systemPrompt = buildTractatusSystemPrompt(tieredMemory, project.name);

      // Build message history from session transcript (last 16 messages)
      const transcript = (session.transcript as Array<{ role: string; content: string; ts: string }>) || [];
      const recentMessages = transcript.slice(-16).map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

      // Add the new user message
      recentMessages.push({ role: "user", content: message });

      // Stream LLM response
      let assistantResponse = "";

      try {
        if (provider === "anthropic") {
          const stream = await anthropic.messages.stream({
            model: "claude-opus-4-5",
            max_tokens: 4096,
            system: systemPrompt,
            messages: recentMessages,
          });
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              assistantResponse += event.delta.text;
              send({ type: "delta", delta: event.delta.text });
            }
          }
        } else {
          const stream = await openai.chat.completions.create({
            model: "gpt-4o",
            max_tokens: 4096,
            stream: true,
            messages: [{ role: "system", content: systemPrompt }, ...recentMessages],
          });
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content || "";
            if (delta) {
              assistantResponse += delta;
              send({ type: "delta", delta });
            }
          }
        }
      } catch (llmErr: any) {
        send({ type: "error", message: llmErr.message });
        res.end();
        return;
      }

      send({ type: "response_complete", content: assistantResponse });

      // Persist updated transcript
      const newTranscript = [
        ...transcript,
        { role: "user", content: message, ts: new Date().toISOString() },
        { role: "assistant", content: assistantResponse, ts: new Date().toISOString() },
      ];

      // Auto-generate session title from first message if still default
      let sessionTitle = session.title;
      if (!sessionTitle || sessionTitle === "New Session") {
        try {
          const titleResp = await anthropic.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 60,
            system: "Generate a short 4-8 word title for this conversation. Output ONLY the title, no quotes.",
            messages: [{ role: "user", content: message.substring(0, 500) }],
          });
          sessionTitle = titleResp.content[0].type === "text" ? titleResp.content[0].text.trim() : sessionTitle;
        } catch {}
      }

      await storage.updateProjectSession(session.id, { transcript: newTranscript, title: sessionTitle });

      // Background Tractatus tree update
      send({ type: "tractatus_updating" });
      const currentTree = (project.tractatusTree as Record<string, string>) || {};
      await updateTractatusTree(project.id, currentTree, message, assistantResponse, (data) => {
        if (!res.writableEnded) send(JSON.parse(data));
      });

      send({ type: "done" });
      res.end();
    } catch (err: any) {
      console.error("Project chat error:", err);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
        res.end();
      }
    }
  });

  // ---- Long Document Generator (SSE, up to 50K words) ----

  app.post("/api/long-document/generate", async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const { prompt, targetWords = 5000, provider = "anthropic", projectId } = req.body;
      if (!prompt?.trim()) return res.status(400).json({ error: "Prompt is required" });

      const parsedTarget = Math.min(Math.max(parseInt(targetWords) || 5000, 500), 100000);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const send = (data: any) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const gen = generateLargeDocument(prompt, parsedTarget, provider as "anthropic" | "openai");

      for await (const event of gen) {
        send(event);
        if (event.type === "complete" || event.type === "error") break;
      }

      // If this was linked to a project, save the generated document as a context note
      if (projectId) {
        try {
          const project = await storage.getProject(parseInt(projectId), userId);
          if (project) {
            const currentTree = (project.tractatusTree as Record<string, string>) || {};
            const keys = Object.keys(currentTree);
            const nextKey = keys.length === 0 ? "1.0" : (() => {
              const top = Math.max(...keys.map(k => parseInt(k.split(".")[0])), 0);
              return `${top + 1}.0`;
            })();
            const updatedTree = { ...currentTree, [nextKey]: `DOCUMENT: Long-form document generated — "${prompt.substring(0, 120)}" (~${parsedTarget.toLocaleString()} words target)` };
            await storage.updateProject(project.id, { tractatusTree: updatedTree, lastTreeUpdate: new Date() }, userId);
          }
        } catch {}
      }

      if (!res.writableEnded) res.end();
    } catch (err: any) {
      console.error("Long document generation error:", err);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
        res.end();
      }
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
