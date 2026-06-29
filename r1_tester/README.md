# R1 — EZHW Synthetic Beta Tester

R1 is an automated end-to-end test agent that exercises all 8 core systems of EZHW using Playwright browser automation. Claude (`claude-opus-4-7`) serves as both R1's decision-making brain and as an independent judge that critiques each interaction.

---

## Quick Start

```bash
cd r1_tester

# Install dependencies (first time only)
pip install -r requirements.txt
python -m playwright install chromium

# Run full test suite (browser visible by default)
python run_r1.py

# Run headlessly, skip payment + voice tests
python run_r1.py --headless --skip 6,7

# Keep long-doc smoke test small
python run_r1.py --words 2000
```

When the run finishes, the script prints the paths to `report.html` and `failures.md`, plus a one-line summary:

```
PASSED: 18 / FAILED: 2 / PARTIAL: 3 / SKIPPED: 0
```

---

## Prerequisites

| Requirement | Details |
|---|---|
| Python | 3.9+ |
| EZHW app running | `npm run dev` in the project root — app must be live at `http://localhost:5000` |
| `ANTHROPIC_API_KEY` | Set in environment — used for R1's brain and judge model |

---

## Configuration

Edit these constants at the top of `run_r1.py`:

| Constant | Default | Description |
|---|---|---|
| `APP_URL` | `http://localhost:5000` | URL of the running EZHW app |
| `OUTPUT_DIR` | `./runs/<timestamp>/` | Where to write all output artifacts |
| `HEADLESS` | `False` | Run browser without a visible window |
| `SKIP_SYSTEMS` | `[]` | System numbers to skip, e.g. `[6, 7]` |
| `LONG_DOC_TARGET_WORDS` | `2000` | Word target for Long Doc smoke test (keep small) |
| `COHERENCE_PROMPT_PATH` | `./prompts/long_coherence_prompt.txt` | Path to the long prompt for Coherence Mode test |
| `CLAUDE_MODEL` | `claude-opus-4-7` | Anthropic model for R1 brain + judge |
| `SOLVE_TIMEOUT_MS` | `150000` | Max wait for standard solve (2.5 min) |
| `LONG_OP_TIMEOUT_MS` | `300000` | Max wait for coherence/long-doc (5 min) |

You can also pass CLI flags:
```bash
python run_r1.py --skip 6,7    # skip systems 6 and 7
python run_r1.py --headless    # no browser window
python run_r1.py --words 5000  # larger long-doc test
```

---

## What R1 Tests (8 Systems)

### System 1 — Homework Assistant (`/`)
- All 5 AI providers (ZHI 1–5): one unique prompt type per provider
  - ZHI 1 Claude: short factual question
  - ZHI 2 GPT-4o: multi-paragraph essay
  - ZHI 3 DeepSeek: math problem with LaTeX
  - ZHI 4 Perplexity: graph generation trigger
  - ZHI 5 Grok: prompt with Special Instructions enforcement
- Coherence Mode: long multi-part philosophical essay
- Philosopher DB: query that should trigger quote enrichment
- File upload: plain text file as assignment input
- Chat refinement: submit, then ask follow-up question
- Save assignment: save with title, reload, confirm in dropdown
- PDF export: click Print/PDF and capture result
- AI detection: read the AI score shown in the solution header

### System 2 — Grading Assistant (`/grading`)
- Full grade cycle: assignment + rubric + mediocre student submission
- Grade adjustments: Higher → Lower → Reevaluate (captures each result)
- Generate Perfect Assignment

### System 3 — Long-Term Projects (`/projects`)
- Create a new project
- Send 3 sequential chat messages (different topics → Tractatus tree growth)
- Verify tree-update popup appears after each message
- Switch to Memory tab, inspect tiers and nodes
- Rename the project
- Create a second session, send one message

### System 4 — Long Document Generator
- Open Long Doc tab in a project
- Generate a document at `LONG_DOC_TARGET_WORDS`
- Capture outline event, section writes, and final stitch
- Verify word count is in range

### System 5 — Coherence Mode (SSE event verification)
- Toggle Coherence Mode ON with a medium-length prompt
- Inject SSE reader that records every event type observed
- Log: `skeleton_complete`, `chunk_start`, `chunk_delta`, `chunk_complete`, `stitch_start`, `stitch_complete`

### System 6 — Payment System (UI only, no real charges)
- Trigger the payment dialog
- Verify Stripe and PayPal elements render
- Close without paying

### System 7 — Voice Dictation
- Click the mic button on the homepage textarea
- Verify the active/recording state is visible
- Monitor network for the AssemblyAI token endpoint (`POST /api/assemblyai/token`)
- Log any WebSocket upgrades to `wss://api.assemblyai.com`

### System 8 — Philosopher DB Kill Switch
- Philosopher DB ON + explicitly non-philosophical prompt (bubble sort in Python)
- Verify the response does NOT contain fabricated quote-like patterns
- Confirms the kill switch prevents hallucinated philosophical quotes

---

## Output Artifacts

Each run writes a timestamped folder at `OUTPUT_DIR` (default: `./runs/<timestamp>/`):

| File | Description |
|---|---|
| `transcript.jsonl` | One JSON object per interaction. Fields: timestamp, system, step_name, approach, reasoning, r1_input, app_response, sse_events_observed, judge_verdict, judge_critique, duration_seconds, error |
| `report.html` | Human-readable HTML report. Grouped by system (1–8). Each interaction: step, approach, input, app response (expandable), judge critique, screenshot. Color-coded PASS/FAIL/PARTIAL. |
| `failures.md` | Filtered list of only FAIL and PARTIAL interactions with judge critique and link back to report.html. |
| `console.log` | Full timestamped console output of the run. |
| `network.log` | All API requests/responses captured during the run (URL, method, status, timestamp). |
| `screenshots/` | One PNG per interaction, named `{system}_{step_count}_{step_name}.png`. |

---

## R1's 7 Approaches

Before each interaction, R1's brain (Claude) picks one of these approaches based on what will best probe that feature:

| Key | Description |
|---|---|
| `intended` | Use the feature in the most obvious, intended way |
| `minimal` | Use minimum viable input (short, empty optional fields) |
| `edge_case` | Edge-case input (very long, unusual characters, mixed languages) |
| `constraint` | Probe a known constraint (violate a Special Instruction to test enforcement) |
| `feature_path` | Trigger a specific known feature path (e.g., "plot" keyword → Chart.js) |
| `wrong_way` | Plausibly-wrong input (typos, malformed) to test error handling |
| `boundary` | Stress an integration boundary (file upload + special instructions + provider switch) |

The chosen approach and R1's reasoning are recorded in the transcript alongside the input.

---

## Extending the Test Plan

To add a new test step to an existing system, add a `run_step()` call inside the relevant `test_system_N()` function:

```python
await r.run_step(
    page,
    system=1,
    step_name="My new test",
    description="What this step is testing",
    r1_input_text="the prompt or action being performed",
    force_approach="intended",        # or None to let Claude choose
    executor=lambda p: my_executor(p),
)
```

The `executor` is an `async` function that takes `page` and returns the app's response as a string.

To add a new system entirely:
1. Add a `test_system_9()` function following the same pattern
2. Add it to `system_runners` dict in `main()`
3. Add its name to `SYSTEM_NAMES`

---

## Notes

- **JMK auto-login**: EZHW auto-logs in JMK (userId=1) at server startup. R1 does not need to handle authentication.
- **Token budget**: With `ANTHROPIC_API_KEY` set and unlimited tokens for JMK, all AI calls will succeed without payment.
- **PDF export**: Some PDF interactions open the browser's native print dialog, which Playwright cannot fully automate. R1 clicks the button and records what happens.
- **Voice input**: R1 grants microphone permission via `context.permissions=["microphone"]`, but cannot speak audio. It verifies the AssemblyAI token request fires on mic button click.
- **Coherence mode**: Can take 2–5 minutes for a full run. The `LONG_OP_TIMEOUT_MS` constant controls the wait. Increase it if your machine is slow.
