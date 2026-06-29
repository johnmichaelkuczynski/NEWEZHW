# EZHW — COMPLETE APPLICATION BLUEPRINT

---

## PART 1: APPLICATION OVERVIEW

**EZHW** is a full-stack AI-powered academic assistance platform. Its core purpose is to solve, grade, rewrite, and discuss homework and research assignments using multiple LLM providers. It is a single-tenant application — one pre-authenticated user (JMK, userId=1) is auto-logged in at server startup; no login screen is shown.

### Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript + Vite |
| Routing | Wouter |
| State / Data | TanStack Query v5 |
| UI Library | Shadcn/ui (Radix UI) + Tailwind CSS |
| Math Rendering | MathJax (CDN) |
| Backend | Node.js + Express.js (TypeScript) |
| Database | PostgreSQL (Neon) via Drizzle ORM |
| File Parsing | Multer + Tesseract.js (OCR) + pdf2json |
| Graph Generation | Chart.js + ChartJSNodeCanvas (server-side) |
| PDF Generation | Puppeteer + pdf-lib |
| Voice Input | AssemblyAI real-time WebSocket streaming |
| Payments | Stripe + PayPal (both fully integrated) |
| AI Providers | Anthropic Claude, OpenAI GPT-4o, DeepSeek, Perplexity, xAI Grok |

---

## PART 2: CORE FUNCTIONS (8 Systems)

### 1. HOMEWORK ASSISTANT (Main Solver)
- **Location:** `/` (homepage) — `client/src/pages/homework-assistant.tsx`
- **Purpose:** Accepts homework questions via text, image, PDF, or document upload and generates full AI solutions.
- **Input Types:** Plain text, drag-and-drop image, PDF, Word document
- **Output:** Streaming solution with LaTeX math rendering, embedded graphs, copy/download options
- **Key Features:**
  - Multi-provider selection: ZHI 1 (Claude), ZHI 2 (GPT-4o), ZHI 3 (DeepSeek), ZHI 4 (Perplexity), ZHI 5 (Grok, default)
  - Coherence Mode: 3-pass architecture (skeleton → chunks → stitch) for long documents
  - Philosopher DB toggle: automatically enriches responses with authenticated philosophical content
  - Voice dictation on all input fields (AssemblyAI)
  - Special Instructions field for formatting constraints
  - Save/Load assignments (title + prompt saved, never the solution)
  - Reference document upload (PDF/DOCX stored per-user, attached to prompts)
  - Automatic word/page count detection and iterative continuation
  - Anti-Puffery system: reduced temperature, direct writing style by default
  - Hard Constraint Enforcement: extracts invariants from prompt, vetoes non-compliant chunks
  - Post-generation chat refinement (ask follow-up questions about the solution)
  - Chat file upload (attach context to follow-up messages)
  - Graph auto-detection and server-side Chart.js generation, embedded inline
  - PDF export (MathJax-rendered, with embedded graphs)
  - Email solution
  - AI detection (GPTZero integration)
  - Rewrite/Humanize function
- **Primary Endpoints:** `POST /api/process-text`, `POST /api/coherent-stream`, `POST /api/chat`, `POST /api/upload`

---

### 2. GRADING ASSISTANT
- **Location:** `/grading` — `client/src/pages/grading-assistant.tsx`
- **Purpose:** Grade student submissions against a rubric provided by the instructor.
- **Inputs:** Assignment prompt, grading rubric (any format), student submission text (typed or file upload)
- **Output:** Grade (in rubric's exact format — letter, numeric, pass/fail), comments, feedback
- **Key Features:**
  - Coherence Mode for long submissions (SSE streaming with real-time progress)
  - Grade adjustment buttons: Reevaluate / Grade Higher / Grade Lower
  - "Generate Perfect Assignment" — produces ideal submission using DeepSeek R1 or GPT-4o
  - Rubric is ABSOLUTE LAW — the AI is forced to follow it exactly, no deviations
  - Student name support
  - Voice input on all fields
- **Primary Endpoints:** `POST /api/grade-submission`, `POST /api/adjust-grade`, `POST /api/generate-perfect`, `POST /api/generate-perfect-fast`

---

### 3. LONG-TERM PROJECTS (Tractatus Tree System)
- **Location:** `/projects` → `/projects/:id` — `client/src/pages/projects.tsx`, `client/src/pages/project-workspace.tsx`
- **Purpose:** Maintain persistent cross-session memory for multi-week research, writing, or study goals using a Wittgenstein-style decimal-notated memory tree.
- **How It Works:**
  - Each project stores a **Tractatus Tree** — a structured JSON object where keys are Wittgenstein decimal numbers ("1.0", "1.1.2") and values are tagged summary strings
  - Tag vocabulary: `ASSERTS`, `REJECTS`, `ASSUMES`, `OPEN`, `RESOLVED`, `DOCUMENT`, `QUESTION`
  - After every AI exchange, a background Claude call generates 1–8 new tree nodes capturing what was genuinely new
  - When the tree exceeds 200 nodes, an automatic **compression** pass condenses older nodes into a Tier 2 archive; this repeats (Tier 2 → Tier 3, etc.)
  - The full tiered hierarchy is injected as a system prompt prefix on every new message, giving the AI persistent knowledge beyond its context window
- **Three-Tab Workspace:**
  - **Chat tab:** Session sidebar + chat interface with the full Tractatus Tree in context. A draggable green popup shows the tree update streaming live after each exchange.
  - **Long Doc tab:** 50,000-word document generator (see System 4 below)
  - **Memory tab:** Visual browser of all tree tiers, color-coded by tag type
- **Primary Endpoints:** `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id`, `GET /api/projects/:id/tractatus`, `GET /api/projects/:id/memory-hierarchy`, `GET/POST /api/projects/:id/sessions`, `GET/PATCH/DELETE /api/project-sessions/:id`, `POST /api/project-sessions/:id/chat`

---

### 4. LARGE DOCUMENT GENERATOR (NeuroText)
- **Location:** Long Doc tab inside `/projects/:id`
- **Purpose:** Generate coherent documents up to 50,000 words using a 3-pass architecture.
- **Three-Pass Architecture:**
  - **Pass 1 — Outline:** LLM generates a structured section list with per-section target word counts
  - **Pass 2 — Section Writing:** Each section is written sequentially with awareness of prior sections; content streams in real-time
  - **Pass 3 — Global Stitch:** A coherence repair pass identifies cross-section contradictions, term drift, and missing premises, then applies targeted fixes
- **Output:** Full streamed document with section-by-section progress tracking, word count per section, copy-all, and plain-text download
- **Target sizes:** 2K / 5K / 10K / 15K / 20K / 30K / 50K words
- **Providers:** ZHI 1 (Claude, recommended) or ZHI 2 (GPT-4o)
- **Project integration:** Completed documents add a DOCUMENT node to the project's Tractatus Tree
- **Primary Endpoint:** `POST /api/long-document/generate`

---

### 5. COHERENCE MODE (Large Assignment Solver)
- **Location:** Toggle in Homework Assistant header
- **Purpose:** Solve assignments too long for a single LLM call by breaking them into coherent chunks with a shared skeleton.
- **Three-Pass Architecture:**
  - **Pass 1 — Global Skeleton:** LLM produces thesis, outline, key terms, commitments, entities, methodology, and target conclusion
  - **Pass 2 — Chunk Processing:** Each ~300-word input chunk is solved, validated against the skeleton, and a "delta" (claims added/removed, terms introduced, conflicts) is tracked
  - **Pass 3 — Stitch/Repair:** Cross-chunk conflicts, term drift, and missing premises are identified; a repair plan is applied
- **Hard Constraint Enforcement:** Before chunking, invariants are extracted from the prompt (non-negotiable rules). Each chunk's output is validated; if a constraint is violated, the chunk is regenerated.
- **SSE Streaming:** Progress events streamed to client: `skeleton_complete`, `chunk_start`, `chunk_delta`, `chunk_complete`, `stitch_start`, `stitch_delta`, `stitch_complete`
- **Primary Endpoints:** `POST /api/coherent-stream`, `GET /api/coherent-stream`, `GET /api/coherent-session/:id`, `GET /api/coherent-session/:id/output`, `GET /api/coherent-session/:id/resume`

---

### 6. PAYMENT SYSTEM (Dual Gateway)
- **Stripe:** Full checkout session flow with webhook verification. Session ID polling on the frontend. Credits credited on `payment_intent.succeeded` webhook event. Idempotent — duplicate events are detected and ignored.
- **PayPal:** Server-side order creation and capture. Client-side PayPal button renders from SDK. Credits applied on capture confirmation.
- **Token Economy (CURRENTLY DISABLED FOR TESTING):** All new users receive 99,999,999 tokens. Token balance checks and deductions are bypassed. Special users (jmkuczynski, randyjohnson) always have unlimited access. Paywall can be re-enabled by restoring balance checks in routes.
- **Primary Endpoints:** `POST /api/create-checkout-session`, `GET /api/payment-status/:sessionId`, `POST /api/stripe-webhook`, `GET /api/paypal/setup`, `POST /api/paypal/order`, `POST /api/paypal/order/:orderID/capture`

---

### 7. VOICE DICTATION (AssemblyAI Real-Time)
- **Scope:** Every text input in the app — homework textarea, special instructions, grading fields, project chat, long-doc prompt, and all form inputs — has a mic button.
- **Architecture:**
  - Frontend requests a temporary token from backend (`POST /api/assemblyai/token`)
  - WebSocket opened to `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000&token=TOKEN`
  - Browser captures mic via `getUserMedia`, resamples to 16kHz via `AudioContext`, converts Float32 → Int16 PCM, sends as base64 JSON chunks
  - Partial transcripts display in italics in the field as the user speaks
  - Final transcripts are appended to the field value
- **Key Files:** `client/src/components/ui/voice-input.tsx` (core WebSocket component), `textarea-with-voice.tsx`, `input-with-voice.tsx` (wrappers)
- **Primary Endpoint:** `POST /api/assemblyai/token`

---

### 8. PHILOSOPHER DATABASE INTEGRATION (Ask-a-Philosopher)
- **Toggle:** "Philosopher DB" button in Homework Assistant header
- **Purpose:** Automatically enriches homework responses with authentic philosophical content — real quotes, passages, and argumentative context from `https://analyticphilosophy.net/`
- **KILL SWITCH:** If the external API fails to return authentic content, the LLM is explicitly instructed NOT to fabricate quotes. Fabrication is a hard error.
- **Detection:** The service inspects the prompt for philosophical topics before firing
- **Key File:** `server/services/philosopherApi.ts`

---

## PART 3: COMPLETE FILE TREE

```
/
├── EZHW_COMPLETE_APP_BLUEPRINT.md      # This document
├── replit.md                           # Project overview and user preferences
├── package.json                        # Dependencies and scripts
├── tsconfig.json                       # TypeScript configuration
├── vite.config.ts                      # Vite bundler configuration (DO NOT MODIFY)
├── drizzle.config.ts                   # Drizzle ORM config (DO NOT MODIFY)
├── tailwind.config.ts                  # Tailwind CSS configuration
│
├── /client/                            # FRONTEND (React + TypeScript + Vite)
│   └── /src/
│       ├── App.tsx                     # Router, providers (QueryClient, Tooltip, Toaster)
│       ├── main.tsx                    # React entry point (mounts App to #root)
│       ├── index.css                   # Global styles, Tailwind directives, prose config
│       │
│       ├── /pages/                     # Route-level pages
│       │   ├── homework-assistant.tsx  # PRIMARY PAGE: full AI homework solver (~3400 lines)
│       │   ├── homework-assistant-simple.tsx  # Simplified solver (text-only, minimal UI)
│       │   ├── grading-assistant.tsx   # AI grading tool with rubric enforcement
│       │   ├── projects.tsx            # Project list dashboard (Tractatus Tree)
│       │   ├── project-workspace.tsx   # Project workspace: chat / long-doc / memory tabs
│       │   ├── test-page.tsx           # React environment smoke test
│       │   └── not-found.tsx           # 404 page
│       │
│       ├── /components/
│       │   ├── FullDocumentGenerator.tsx   # Coherence-mode document generator UI
│       │   ├── StrictOutlineTester.tsx     # Debug tool for outline generation testing
│       │   ├── PayPalButton.tsx            # PayPal payment button integration
│       │   ├── StripeButton.tsx            # Stripe checkout with polling confirmation
│       │   │
│       │   └── /ui/                    # Shadcn UI primitives + custom components
│       │       ├── voice-input.tsx     # AssemblyAI real-time WebSocket mic button (CORE)
│       │       ├── textarea-with-voice.tsx  # Textarea + mic button + interim display
│       │       ├── input-with-voice.tsx     # Input + mic button + interim display
│       │       ├── math-renderer.tsx   # MathJax LaTeX rendering for AI output
│       │       ├── math-textarea.tsx   # Textarea with LaTeX preview
│       │       ├── token-status.tsx    # Token balance / Unlimited Access display
│       │       ├── auth-dialog.tsx     # Login/register modal (special bypass for JMK)
│       │       ├── payment-dialog.tsx  # Payment method selection modal
│       │       ├── file-upload.tsx     # Drag-and-drop file upload zone
│       │       ├── speech-input.tsx    # Legacy browser Web Speech API (superseded)
│       │       ├── azure-speech-input.tsx   # Azure Cognitive Services integration
│       │       ├── button.tsx          # Shadcn Button
│       │       ├── card.tsx            # Shadcn Card
│       │       ├── dialog.tsx          # Shadcn Dialog
│       │       ├── input.tsx           # Shadcn Input
│       │       ├── textarea.tsx        # Shadcn Textarea
│       │       ├── select.tsx          # Shadcn Select
│       │       ├── badge.tsx           # Shadcn Badge
│       │       ├── toast.tsx / toaster.tsx  # Notification system
│       │       └── ... (35+ additional Shadcn primitives)
│       │
│       ├── /hooks/
│       │   ├── use-auth.ts             # Auth state via /api/me
│       │   ├── use-coherent-stream.ts  # SSE state machine for coherence mode
│       │   ├── use-llm.ts              # Mutations for file processing / text solving
│       │   ├── use-session.ts          # Persistent anonymous session ID (localStorage)
│       │   ├── use-speech-recognition.ts  # Browser Web Speech API hook (legacy)
│       │   ├── use-toast.ts            # Toast notification state
│       │   └── use-mobile.tsx          # Mobile breakpoint detection
│       │
│       └── /lib/
│           ├── api.ts                  # Frontend API service layer (file uploads, text processing)
│           ├── queryClient.ts          # TanStack Query setup + apiRequest utility
│           └── utils.ts               # cn() Tailwind class merger
│
├── /server/                            # BACKEND (Express + TypeScript)
│   ├── index.ts                        # Server entry point, auto-login for JMK at startup
│   ├── routes.ts                       # ALL ~70 API endpoints (~5800 lines)
│   ├── storage.ts                      # Database CRUD: full IStorage interface + DatabaseStorage + MemStorage stubs
│   ├── db.ts                           # Drizzle ORM → Neon PostgreSQL connection
│   ├── auth.ts                         # Session-based authentication, bcrypt, authService
│   ├── paypal.ts                       # PayPal SDK: createPaypalOrder, capturePaypalOrder
│   ├── tokenUtils.ts                   # countTokens, estimateOutputTokens, truncateResponse, generateSessionId
│   ├── types.ts                        # Express session type extensions
│   ├── vite.ts                         # Vite dev server integration (DO NOT MODIFY)
│   │
│   ├── /services/
│   │   ├── aiProviders.ts              # LLM abstraction: rewrite(), generateOutline() across providers
│   │   ├── coherenceService.ts         # 3-pass large document engine: skeleton → chunks → stitch
│   │   ├── outlineService.ts           # Strict outline generation for coherence mode
│   │   ├── tractatusService.ts         # Tractatus Tree: update, compress, load tiers, generateLargeDocument
│   │   ├── philosopherApi.ts           # Ask-a-Philosopher API: HMAC auth, quote injection, kill switch
│   │   ├── fileProcessor.ts            # File ingestion: .txt, .docx (mammoth); PDF temporarily disabled
│   │   ├── textChunker.ts              # Split text into 300-word overlapping chunks; reconstruct by ID
│   │   └── gptZero.ts                  # GPTZero AI detection integration with fallback heuristics
│   │
│   └── /utils/
│       └── openai.ts                   # OpenAI client helper
│
└── /shared/                            # SHARED (frontend + backend)
    └── schema.ts                       # Drizzle schema, insert schemas, TypeScript types (~564 lines)
```

---

## PART 4: DATABASE SCHEMA

All tables use Drizzle ORM with Neon PostgreSQL. Schema is in `shared/schema.ts`. Changes are applied with `npm run db:push` (never hand-write SQL).

### Core Tables

| Table | Key Columns | Purpose |
|---|---|---|
| `users` | id, username, password, token_balance, created_at | Authentication + token economy |
| `token_usage` | id, user_id, session_id, input_tokens, output_tokens, remaining_balance | Per-request token tracking |
| `daily_usage` | id, session_id, date, total_tokens | Anonymous user daily caps |
| `assignments` | id, user_id, session_id, title, input_text, input_type, file_name, extracted_text, llm_provider, llm_response, grade, graph_data[], graph_images[], reference_document_ids[], processing_time, input_tokens, output_tokens | Core assignment records (prompt only — solutions not saved by default) |
| `reference_documents` | id, user_id, session_id, file_name, mime_type, file_size, extracted_text | Uploaded reference PDFs/DOCXs |
| `grades` | id, assignment_id, user_id, session_id, grade_text, grade_score, llm_provider | Grading history |
| `rewrites` | id, assignment_id, user_id, session_id, rewrite_text, based_on_grade_id, llm_provider | Rewrite/humanize history |

### Payment Tables

| Table | Key Columns | Purpose |
|---|---|---|
| `stripe_payments` | id, session_id, user_id, amount, tokens, status, metadata | Stripe checkout sessions |
| `stripe_events` | id, event_id, event_type, processed_at | Idempotent webhook event log |

### Coherence System Tables

| Table | Key Columns | Purpose |
|---|---|---|
| `coherent_sessions` | id, user_id, session_type, user_prompt, global_skeleton (JSONB), task_invariants (JSONB), status, total_chunks, processed_chunks, task_complete | Coherence mode session state |
| `coherent_chunks` | id, session_id, chunk_index, chunk_type, chunk_text, chunk_output, chunk_delta (JSONB), processed_at | Per-chunk input/output records |
| `stitch_results` | id, session_id, conflicts (JSONB), repairs (JSONB), final_validation (JSONB), coherence_score | Cross-chunk coherence validation results |

### Projects / Tractatus Tables

| Table | Key Columns | Purpose |
|---|---|---|
| `projects` | id, user_id, name, description, tractatus_tree (JSONB), tractatus_tier, parent_project_id, last_tree_update, compression_count | Long-term research projects |
| `project_sessions` | id, project_id, title, transcript (JSONB array), created_at | Chat sessions within a project |
| `tractatus_archive` | id, project_id, tier, tree (JSONB), node_count | Pre-compression snapshots for audit/recovery |

### Session Table

| Table | Key Columns | Purpose |
|---|---|---|
| `session` | sid, sess, expire | Express session persistence (connect-pg-simple) |

---

## PART 5: COMPLETE API ENDPOINT REFERENCE

### Authentication
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/register` | Register new user, auto-grant 99,999,999 test tokens |
| POST | `/api/login` | Authenticate, create session |
| POST | `/api/logout` | Destroy session |
| GET | `/api/me` | Current user info + token balance |

### Token / Payment
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/check-tokens` | Verify session has enough tokens (currently disabled) |
| POST | `/api/create-checkout-session` | Initialize Stripe checkout |
| GET | `/api/payment-status/:sessionId` | Poll Stripe payment completion |
| POST | `/api/stripe-webhook` | Stripe webhook (verified via `STRIPE_WEBHOOK_SECRET`) |
| GET | `/api/paypal/setup` | Return PayPal client ID |
| POST | `/api/paypal/order` | Create PayPal order |
| POST | `/api/paypal/order/:orderID/capture` | Capture PayPal payment, credit tokens |
| GET | `/__diag/payments` | Internal diagnostic: recent payments |

### File Processing
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/upload` | Upload file (image/PDF/DOCX), extract text, process assignment |
| POST | `/api/extract-text` | File → plain text (no assignment processing) |
| POST | `/api/documents` | Upload reference document, store extracted text |
| GET | `/api/documents` | List user's reference documents |
| DELETE | `/api/documents/:id` | Delete reference document |

### Core Homework Solving
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/process-text` | Main solver: text prompt → streaming AI solution |
| POST | `/api/refine-solution` | Iterative refinement of existing solution |
| POST | `/api/chat` | Follow-up chat about a solution |
| POST | `/api/chat-upload` | Upload file into chat context |
| POST | `/api/rewrite` | Rewrite text in a different style |

### Coherence Mode (Large Documents)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/coherent-stream` | Start coherence session, stream skeleton + chunks |
| GET | `/api/coherent-stream` | Join existing coherence SSE stream |
| POST | `/api/test-skeleton` | Generate skeleton only (debug/preview) |
| GET | `/api/coherent-session/:id` | Get session metadata and status |
| GET | `/api/coherent-session/:id/output` | Get accumulated output text |
| GET | `/api/coherent-session/:id/resume` | Resume interrupted session |

### Grading
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/grade-submission` | Grade student submission against rubric |
| POST | `/api/adjust-grade` | Reevaluate / push grade higher or lower |
| POST | `/api/generate-perfect` | Generate ideal assignment (DeepSeek R1 / GPT-4o) |
| POST | `/api/generate-perfect-fast` | Fast high-quality generation path |
| POST | `/api/grades` | Save grade record |
| GET | `/api/grades/:assignmentId` | Get grades for assignment |

### Assignments
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/assignments` | List user assignments (user-scoped, session-scoped for anon) |
| GET | `/api/assignments/:id` | Get single assignment |
| POST | `/api/save-assignment` | Save/update assignment (prompt only, never solution) |
| PATCH | `/api/assignments/:id` | Update assignment fields |
| DELETE | `/api/assignments/:id` | Delete assignment |
| DELETE | `/api/assignments` | Bulk delete all user assignments |
| POST | `/api/assignments/cleanup` | Remove empty/orphaned records |
| POST | `/api/assignments/:id/upgrade` | Upgrade assignment to pro quality |
| POST | `/api/rewrites` | Save rewrite record |
| GET | `/api/rewrites/:assignmentId` | Get rewrites for assignment |

### PDF / Graph Generation
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/html-to-pdf` | Convert HTML → PDF (Puppeteer) |
| POST | `/api/generate-pdf` | Generate PDF from plain text |
| POST | `/api/generate-math-pdf` | LaTeX-formatted math PDF |
| POST | `/api/generate-graph-pdf` | PDF with single Chart.js graph |
| POST | `/api/generate-multi-graph-pdf` | PDF with multiple charts |
| POST | `/api/generate-combined-pdf` | PDF merging text + graphs |

### Humanize / AI Detection
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/humanize/rewrite` | Rewrite to reduce AI detection score |
| POST | `/api/humanize/coherent-rewrite` | Long-form humanization using coherence service |
| POST | `/api/humanize/analyze` | Analyze text for AI detection risk |
| POST | `/api/humanize/chunk` | Split text for batch humanization |
| POST | `/api/humanize/upload` | Upload document for humanization |
| GET | `/api/humanize/jobs/:id` | Humanization job status |
| GET | `/api/humanize/jobs` | List recent humanization jobs |
| POST | `/api/ai-detection` | GPTZero AI content detection |

### Voice / Speech
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/assemblyai/token` | Generate ephemeral AssemblyAI real-time token (1hr) |
| GET | `/api/azure-speech-config` | Azure Speech service credentials (legacy, still live) |

### Projects (Tractatus Tree)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects` | List all Tier-1 projects for user |
| POST | `/api/projects` | Create new project |
| PATCH | `/api/projects/:id` | Rename / update project metadata |
| DELETE | `/api/projects/:id` | Delete project + all sessions + archive |
| GET | `/api/projects/:id/tractatus` | Raw tree JSON + node count + last update |
| GET | `/api/projects/:id/memory-hierarchy` | All tiers (compact string + node counts) + archives |
| GET | `/api/projects/:id/sessions` | List sessions (no full transcripts) |
| POST | `/api/projects/:id/sessions` | Create new session |
| GET | `/api/project-sessions/:id` | Get session + full transcript |
| PATCH | `/api/project-sessions/:id` | Rename session |
| DELETE | `/api/project-sessions/:id` | Delete session |
| POST | `/api/project-sessions/:id/chat` | Project chat with full Tractatus context (SSE) |

### Long Document Generator
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/long-document/generate` | 3-pass 50K-word generator (SSE) |

### Email
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/email-solution` | Email solution to user-provided address |

---

## PART 6: SERVICE LAYER — DETAILED DESCRIPTIONS

### `server/services/aiProviders.ts`
Abstraction layer over all LLM providers. Normalizes rewrite and outline calls across Anthropic, OpenAI, and DeepSeek. All generation routes route through this service when they need provider-agnostic calls.
- `rewrite(provider, params)` — rewrites text with Kuczynski-style quality rules (compressed, direct, high-density, no puffery)
- `generateOutline(userPrompt, requirements)` — GPT-4o strict JSON outline for coherence mode

### `server/services/coherenceService.ts`
The 3-pass coherent document engine. Used by Coherence Mode in homework assistant and humanizer.
- `processLargeDocument(userId, type, prompt, input)` — `AsyncGenerator` yielding SSE events: `skeleton_complete`, `chunk_start`, `chunk_delta`, `chunk_complete`, `stitch_start`, `stitch_complete`
- `buildGlobalSkeleton(prompt)` — mandatory first pass: thesis, outline, key terms, commitments, entities, methodology, target conclusion
- `validateChunk(chunk, skeleton)` — checks each chunk against invariants; regenerates if violated
- `compareAndModifyChunk(prev, curr)` — ensures continuity between consecutive chunks
- Persists state to `coherent_sessions`, `coherent_chunks`, `stitch_results` tables

### `server/services/outlineService.ts`
Companion to coherenceService. Handles strict outline format parsing and section target-word assignment.

### `server/services/tractatusService.ts`
The Tractatus Tree long-term memory system. (~775 lines)
- `compactTreeString(tree)` — render tree as `key: value\n` lines (30–40% smaller than JSON)
- `tryParseTractatusJSON(text)` — tolerant parser: strips fences, handles truncated JSON, retries
- `loadTieredMemory(projectId)` — loads Tier 1 (live) + all archive tiers, returns compact strings + char totals
- `buildTractatusSystemPrompt(tieredMemory, projectName)` — constructs the system prompt injected before every project chat
- `updateTractatusTree(projectId, existingTree, userMsg, assistantMsg, sendFn)` — streams new node generation via Claude, merges nodes, triggers compression if ≥200 nodes, saves to DB
- `compressTractatusTier(projectId, tree, tier)` — compresses tree to summary tier, archives original, returns trimmed live tree (30 most recent nodes)
- `getStalenessSeverity(lastUpdate)` — staleness label for memory UI
- `generateLargeDocument(prompt, targetWords, provider)` — `AsyncGenerator` for 50K-word docs: outline → section streaming → global stitch

### `server/services/philosopherApi.ts`
Interface to `https://analyticphilosophy.net/` philosophical content database.
- `fetchPhilosopherContent(query, author)` — HMAC-signed authenticated API call
- `enrichTextWithPhilosopherContent(prompt, content)` — injects quotes with "KILL SWITCH" fabrication prevention
- `enrichWithPhilosophicalContentIfNeeded(text, forceQuery)` — auto-detects philosophical topics before querying

### `server/services/fileProcessor.ts`
Handles file ingestion and text extraction.
- `processFile(buffer, filename)` — supports `.txt`, `.docx` (via mammoth). PDF disabled (pdf2json used directly in routes instead).
- `countWords(text)` — utility for tracking document size
- Max file size: 50MB. Valid types: txt, docx (via this service), plus PDF/image handled in routes.

### `server/services/textChunker.ts`
Text chunking utility for documents exceeding single-call limits.
- `chunkText(text)` — splits into ~300-word chunks with 50-word overlap
- `getReconstructedText(chunks, selectedIds)` — reassembles chunks, merging overlaps intelligently
- `getChunkStats(chunks)` — word count summary across chunks

### `server/services/gptZero.ts`
GPTZero API integration for AI content detection.
- `analyzeText(text)` — returns `{ aiScore, confidence, isAI }`. Falls back to local heuristic if API key missing.
- `analyzeBatch(texts)` — batch analysis

---

## PART 7: KEY DESIGN RULES AND INVARIANTS

These rules must be understood before modifying any part of the codebase:

### Authentication / User Model
- **Single-user mode**: JMK (userId=1, username="jmkuczynski") is auto-logged in at server startup in `server/index.ts`. No login screen is ever shown.
- **Special users**: jmkuczynski and randyjohnson have `tokenBalance = 99,999,999` and are never gated.
- **Session isolation**: Authenticated users are isolated by `userId`. Anonymous users are isolated by `sessionId` stored in localStorage. Cross-session access is always prevented.

### Assignment Saving Rule (CRITICAL)
- **"Save Assignment" saves the PROMPT ONLY**, never the solution/response. `llmResponse` is never persisted in assignment records. This is intentional and must not be changed.

### Token / Paywall (Currently Disabled for Testing)
- All new users receive 99,999,999 tokens at registration
- Token balance checks (`/api/check-tokens`) are effectively bypassed
- Token deductions after AI calls are disabled
- Payment gateways (Stripe, PayPal) remain functional but are not required
- To re-enable: restore balance checks in `process-text`, `upload`, and `coherent-stream` routes

### LLM Provider Mapping
| User-Facing Name | Internal ID | Actual Model |
|---|---|---|
| ZHI 1 | `anthropic` | claude-opus-4-5 (Tractatus), claude-haiku-4-5 (titles) |
| ZHI 2 | `openai` | gpt-4o |
| ZHI 3 | `deepseek` | deepseek-reasoner (for "perfect" generation), deepseek-chat |
| ZHI 4 | `perplexity` | llama-3.1-sonar-large-128k-online |
| ZHI 5 (Default) | `grok` | grok-2-1212 |

### Anti-Puffery Writing System
- All prompts include instructions for direct, compressed, non-performative writing
- LLM temperature is reduced by default
- "Bad-Writing Mode" can be conditionally enabled by explicit user request — relaxes all constraints

### Graph Generation
- The main solver automatically detects graph/chart/data visualization requests
- Server-side Chart.js renders graphs via `ChartJSNodeCanvas`
- Graph images are base64-encoded and embedded inline in the response
- Graph data + images are stored in `graphData[]` and `graphImages[]` arrays on the assignment record

### Tractatus Tree Rules
- Nodes use Wittgenstein decimal notation: "1.0", "1.1", "1.1.2", "2.0", etc.
- Each value MUST begin with a tag: `ASSERTS`, `REJECTS`, `ASSUMES`, `OPEN`, `RESOLVED`, `DOCUMENT`, `QUESTION`
- 1–8 new nodes generated per chat exchange (never restate existing nodes)
- Compression at ≥200 nodes; live tree trimmed to 30 most recent after compression
- Only Tier-1 (live) projects appear in `/api/projects` listing

### File Upload Limits
- Max image: 10MB (Tesseract.js OCR)
- Max PDF: 50MB (pdf2json)
- Max DOCX: 50MB (mammoth)
- Max reference document: 10MB

### Streaming (SSE) Architecture
All long-running operations use Server-Sent Events:
- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`
- Events are JSON: `data: {"type": "delta", "delta": "..."}\n\n`
- Frontend reads via `ReadableStream` with `getReader()` / `TextDecoder`

---

## PART 8: ROUTING (Frontend)

Routes are defined in `client/src/App.tsx` using Wouter:

| Path | Component | Description |
|---|---|---|
| `/` | `HomeworkAssistant` | Main AI homework solver |
| `/grading` | `GradingAssistant` | AI grading tool |
| `/projects` | `ProjectsPage` | Long-term projects dashboard |
| `/projects/:id` | `ProjectWorkspace` | Project chat / long-doc / memory tabs |
| `*` | `NotFound` | 404 fallback |

Navigation links in the Homework Assistant header:
- `🧠 Projects` → `/projects`
- `New Assignment` → clears input/output (no navigation)
- `Coherence: ON/OFF` → toggle Coherence Mode
- `Philosopher DB: ON/OFF` → toggle philosopher enrichment
- Provider selector → ZHI 1–5

---

## PART 9: ENVIRONMENT SECRETS

All secrets are stored in the Replit Secrets panel. Never hardcode values.

| Secret Name | Used By |
|---|---|
| `ANTHROPIC_API_KEY` | Claude (main solver, Tractatus updates, compression, title generation) |
| `OPENAI_API_KEY` | GPT-4o (ZHI 2), outline generation, perfect assignment |
| `DEEPSEEK_API_KEY` | DeepSeek ZHI 3, deepseek-reasoner for "perfect" mode |
| `GOOGLE_API_KEY` | (Available, not currently wired) |
| `XAI_API_KEY` | Grok ZHI 5 (default provider) |
| `ASSEMBLYAI_API_KEY` | Real-time voice transcription tokens |
| `GPTZER0_API_KEY` | GPTZero AI detection |
| `AZURE_OPENAI_ENDPOINT` | Azure speech config endpoint |
| `STRIPE_SECRET_KEY` | Stripe server-side payment operations |
| `STRIPE_PUBLISHABLE_KEY` | Stripe frontend checkout |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verification |
| `PAYPAL_CLIENT_ID` | PayPal order creation |
| `PAYPAL_CLIENT_SECRET` | PayPal order capture |
| `SESSION_SECRET` | Express session signing |
| `DATABASE_URL` | Neon PostgreSQL connection string |

---

## PART 10: DEVELOPMENT RULES

### Forbidden Changes
- **NEVER modify** `server/vite.ts` or `vite.config.ts` — Vite integration is locked
- **NEVER edit** `package.json` directly — use package install tools
- **NEVER edit** `drizzle.config.ts`
- **NEVER write raw SQL** — use `npm run db:push` after editing `shared/schema.ts`

### Schema Changes
1. Add tables/columns to `shared/schema.ts`
2. Add insert schema with `createInsertSchema(...).omit({ id: true, createdAt: true })`
3. Export TypeScript types with `z.infer<>` and `$inferSelect`
4. Run `npm run db:push` (if interactive prompt appears about renaming, use direct `psql "$DATABASE_URL"` SQL instead)
5. Add CRUD methods to `IStorage` interface in `storage.ts`
6. Implement in `DatabaseStorage` class
7. Add stubs to `MemStorage` class (throw errors or return empty)

### Adding a New Route
- Append before `const httpServer = createServer(app);` at the bottom of `server/routes.ts`
- Use `req.session?.userId` for user identification
- Return `401` if not authenticated (though JMK is always auto-logged in)

### Adding a Frontend Page
1. Create in `client/src/pages/`
2. Register in `client/src/App.tsx` with a `<Route path="..." component={...} />`
3. Add navigation link if needed (in homework-assistant.tsx header controls row)

### Using Voice in a New Input
```tsx
import { VoiceInput } from "@/components/ui/voice-input";
// Or use pre-built wrappers:
import { TextareaWithVoice } from "@/components/ui/textarea-with-voice";
import { InputWithVoice } from "@/components/ui/input-with-voice";
```

### Streaming SSE Pattern (Backend)
```ts
res.setHeader("Content-Type", "text/event-stream");
res.setHeader("Cache-Control", "no-cache");
res.setHeader("Connection", "keep-alive");
res.setHeader("X-Accel-Buffering", "no");
res.flushHeaders?.();
const send = (data: any) => {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
};
```

### Streaming SSE Pattern (Frontend)
```ts
const resp = await fetch("/api/endpoint", { method: "POST", body: ... });
const reader = resp.body!.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  for (const line of decoder.decode(value).split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6));
    // handle event.type
  }
}
```

---

## PART 11: KNOWN ISSUES / THINGS TO NOTE FOR FINE-TUNING

1. **`homework-assistant.tsx` is ~3,400 lines** — the largest file. It contains all the main homework solver logic including streaming, coherence mode integration, file upload, chat, graph embedding, PDF export, and assignment management.

2. **routes.ts is ~5,800 lines** — all API endpoints are in a single file. New routes should be appended at the bottom before `createServer(app)`.

3. **Tractatus project workspace fetch** — `projects.tsx` fetches project list from `/api/projects` and filters client-side. The workspace page does an independent fetch on mount to get the specific project. The workspace does not use TanStack Query for the project object (uses `useState` + `useEffect` with raw `fetch`).

4. **Voice interim text** — when AssemblyAI emits a `PartialTranscript`, `textarea-with-voice.tsx` displays it in italics by appending to the display value. The real `value` prop is not mutated until a `FinalTranscript` arrives. This is intentional so the input field stays clean.

5. **Coherence Mode vs. Long Doc Generator** — these are two separate systems:
   - Coherence Mode (in homework assistant): processes an INPUT document/assignment into coherent OUTPUT, section-by-section.
   - Long Doc Generator (in project workspace): generates a new large document from a PROMPT, using outline → sections → stitch.

6. **db:push interactive prompt** — if you add a new table and `npm run db:push` shows a rename prompt (because it detects a similarly-named existing table), use direct psql instead: `psql "$DATABASE_URL" -c "CREATE TABLE IF NOT EXISTS ..."`

7. **`session` table in DB** — there is an existing `session` table (Express session store). Do NOT rename it or create anything named `sessions` (conflicts with Drizzle detection).

8. **Philosopher DB kill switch** — if `philosopherApi.ts` cannot retrieve authenticated quotes, the LLM receives explicit instructions forbidding fabricated quotes. This is non-negotiable safety behavior.

9. **PDF generation uses both Puppeteer and pdf-lib** — Puppeteer handles HTML-to-PDF; pdf-lib handles programmatic PDF creation. Both are server-side only.

10. **Graph images** are stored as base64 strings in the `graphImages` array column on assignments. They are also embedded directly in streaming responses as markdown image tags (`![graph](data:image/png;base64,...)`).
