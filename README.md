# 🎓 EZHW

**AI-Powered Homework Assistant — Multi-Model, Multi-Format, No Padding, No Puffery**

---

## 🧩 Overview

EZHW is a full-stack academic assistance platform built on a strict operating principle: every output is exactly what was asked for. If you ask for 25 numbered answers plus a 1,000-word synthesis, that is what you get — not 18 answers and a vague closing paragraph. If you specify 6,000 words, the system iterates until the count is met. Instructions are not suggestions; they are enforced.

The platform routes tasks across five leading AI providers (OpenAI, Anthropic, Azure OpenAI, DeepSeek, Perplexity) and applies a coherent chunking architecture for long documents — skeleton generation, chunk processing, global stitch pass — so large outputs are not just long, but structurally sound. A hard constraint enforcement layer extracts non-negotiable rules from your prompt and vetoes any chunk that violates them before it reaches the final output.

Default writing style is direct, compressed, and free of hedging language. No preamble, no filler, no editorializing.

---

## 👥 Who It's For

- **Students at any level** -- need complete, accurate answers to homework problems across every subject and format
- **Graduate students and researchers** -- need rigorous, citation-worthy responses that meet academic standards and specific word counts
- **Philosophers and humanities scholars** -- benefit from automatic enrichment via the Ask-a-Philosopher integration, which pulls authentic quotes and passages from a curated philosophical database
- **STEM students** -- get LaTeX-rendered mathematical notation, automatic graph generation, and structured multi-part problem solving
- **Anyone with a document to grade** -- the Grading Assistant evaluates student submissions against any rubric format with an explicit score and line-by-line justification
- **Anyone who needs a rewrite** -- the Perfector tool improves any text without inflating it, preserving structure while eliminating weak language

---

## ⚙️ Core Capabilities

- **Multi-Model LLM Routing** -- select from OpenAI, Anthropic, Azure OpenAI, DeepSeek, or Perplexity for each task; the system applies the model best suited to the request type

- **Coherent Chunking System** -- for outputs over 1,000 words, a three-pass architecture guarantees global coherence: first a skeleton, then chunk generation, then a global stitch pass that unifies tone, argument, and structure across the full document

- **Hard Constraint Enforcement** -- extracts invariants (non-negotiable rules) from the user prompt and validates every generated chunk against them; any chunk that violates a constraint is vetoed and regenerated automatically

- **Automatic Word Count Enforcement** -- detects specified word or page requirements and iterates until the count is met; multi-question assignments check completion of every numbered item before finalizing output

- **Ask-a-Philosopher Integration** -- detects philosophical topics in any prompt and automatically fetches authentic quotes, passages, and context from https://analyticphilosophy.net/; includes a kill switch that blocks fabricated content if the database cannot supply authentic material

- **Grading Assistant** -- evaluates student submissions against rubrics provided in any format (text, PDF, image, document); outputs an explicit score with line-by-line justification; Coherence Mode handles long assignments with real-time progress via SSE streaming

- **Perfector / Rewrite Tool** -- improves any text for clarity, precision, and academic rigor without padding or structural inflation; all rewrite iterations are saved and accessible from the assignment history

- **Graph Generation** -- automatically detects when a response calls for a visual and generates charts server-side using Chart.js; graphs are embedded directly into the solution output

- **Mathematical Notation** -- full LaTeX support via MathJax; intelligent content detection applies LaTeX formatting only where appropriate; optimized rendering for PDF export

- **File Input Pipeline** -- accepts text, images, PDFs, and documents via drag-and-drop or upload; OCR via Tesseract.js for images; pdf2json for structured text extraction from PDFs

- **Voice Input** -- real-time transcription via Browser Web Speech API with Azure Cognitive Services fallback

- **Persistent Assignment Storage** -- every prompt, generated solution, grade, and rewrite is saved to a PostgreSQL database; full history is accessible and expandable from the Saved Assignments panel

- **PDF Export** -- download any solution as a formatted PDF with proper mathematical notation rendering

---

## 🚀 What Makes It Different

- **It follows instructions** -- the system's job is to do exactly what you said. Word counts, numbered lists, specific structures — all enforced, not approximated

- **It enforces its own constraints** -- hard constraint extraction means the system catches its own violations before they reach you; it does not rely on you to catch errors

- **It produces coherent long documents** -- the three-pass chunking architecture means a 6,000-word output is a unified document, not six 1,000-word fragments stapled together

- **It does not fabricate philosophy** -- the Ask-a-Philosopher integration includes a kill switch; if authentic content is unavailable, the system omits the section rather than inventing quotes

- **Default output is compressed, not padded** -- the Anti-Puffery system eliminates hedging, filler phrases, and unnecessary qualifications from all output by default; a Bad-Writing Mode is available if explicitly requested

- **Five LLMs, one interface** -- pick the model for the task, or let the system route intelligently; automatic fallback handles rate limits and outages without interrupting your workflow

- **Full grading pipeline** -- rubric parsing, submission evaluation, scoring, and justification in one step; Coherence Mode handles assignments too long for a single context window

- **Everything is saved** -- prompts, solutions, grades, and rewrites are all persisted with full history; nothing is lost between sessions
