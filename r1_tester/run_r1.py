#!/usr/bin/env python3
"""
R1 — Synthetic User Agent for EZHW End-to-End Beta Testing
============================================================
R1 exercises all 8 core systems of EZHW using Playwright browser automation.
Claude (claude-opus-4-7) serves as R1's brain (approach selection) and as a
separate judge model (qualitative critique after each interaction).

Usage:
    python run_r1.py [--skip 6,7] [--headless] [--words 2000]

Output per run (timestamped folder):
    transcript.jsonl   — one JSON object per interaction
    report.html        — rendered HTML report with screenshots
    failures.md        — filtered list of flagged interactions
    console.log        — full console output
    network.log        — captured API/SSE traffic
    screenshots/       — one PNG per interaction
"""

import asyncio
import base64
import json
import os
import re
import sys
import time
import traceback
from dataclasses import dataclass, asdict, field
from datetime import datetime
from pathlib import Path
from typing import Optional

import anthropic
from playwright.async_api import async_playwright, Page, BrowserContext, Route, Request

# ─────────────────────────────────────────────
# CONFIGURATION — edit these before running
# ─────────────────────────────────────────────
APP_URL             = "http://localhost:5000"
OUTPUT_DIR          = f"./runs/{datetime.now().strftime('%Y%m%d_%H%M%S')}/"
HEADLESS            = False          # Set True to run without visible browser
SKIP_SYSTEMS        = []            # e.g. [6, 7] to skip payment and voice tests
LONG_DOC_TARGET_WORDS = 2000        # Keep small (2000) for smoke tests
COHERENCE_PROMPT_PATH = "./prompts/long_coherence_prompt.txt"
CLAUDE_MODEL        = "claude-opus-4-7"  # R1 brain + judge model
SOLVE_TIMEOUT_MS    = 150_000       # 2.5 min for streaming responses
LONG_OP_TIMEOUT_MS  = 300_000       # 5 min for coherence / long-doc
# ─────────────────────────────────────────────

# ── 7 approaches R1 can pick from ───────────────────────────────────────────
APPROACHES = {
    "intended":     "Use the feature in the most obvious, intended way",
    "minimal":      "Use minimum viable input (short, empty optional fields)",
    "edge_case":    "Use edge-case input (very long, unusual characters, mixed languages)",
    "constraint":   "Probe a known constraint (violate a Special Instruction to test enforcement)",
    "feature_path": "Trigger a specific known feature path (e.g., graph keyword → Chart.js)",
    "wrong_way":    "Use it in a plausibly-wrong way (typos, malformed input) to test error handling",
    "boundary":     "Stress an integration boundary (file upload + special instructions + provider switch)",
}

# ── Data structures ──────────────────────────────────────────────────────────
@dataclass
class Interaction:
    timestamp: str
    system: int
    step_name: str
    description: str
    url: str
    approach_key: str
    approach_description: str
    r1_reasoning: str
    r1_input: str
    app_response: str
    sse_events_observed: list
    network_errors: list
    judge_verdict: str          # PASS / FAIL / PARTIAL
    judge_critique: str
    screenshot_path: str
    duration_seconds: float
    error: Optional[str] = None

# ── Anthropic client ─────────────────────────────────────────────────────────
_anthropic = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))


# ═══════════════════════════════════════════════════════════════════
#  UTILITY HELPERS
# ═══════════════════════════════════════════════════════════════════

def ts() -> str:
    return datetime.now().strftime("%H:%M:%S")

def log(msg: str, file_handle=None):
    line = f"[{ts()}] {msg}"
    print(line)
    if file_handle:
        file_handle.write(line + "\n")
        file_handle.flush()


async def safe_fill(page: Page, selector: str, value: str, timeout=10_000):
    """Fill a field, trying multiple selector strategies."""
    try:
        await page.fill(selector, value, timeout=timeout)
        return True
    except Exception:
        pass
    try:
        el = page.locator(selector).first
        await el.click(timeout=timeout)
        await el.fill(value)
        return True
    except Exception as e:
        return False


async def wait_for_solve_complete(page: Page, timeout_ms=SOLVE_TIMEOUT_MS):
    """Wait until the solve button stops showing processing state."""
    await page.wait_for_function(
        """() => {
            const btn = document.querySelector('[data-testid="button-solve"]');
            if (!btn) return true;
            const t = btn.textContent || '';
            return !t.includes('Processing') && !t.includes('Generating') && !t.includes('Solving');
        }""",
        timeout=timeout_ms
    )


async def get_solution_text(page: Page) -> str:
    """Extract visible text from the solution panel."""
    return await page.evaluate("""() => {
        const proseEls = document.querySelectorAll('[class*="prose"]');
        for (const el of proseEls) {
            const t = el.innerText?.trim();
            if (t && t.length > 50) return t;
        }
        const rightPanels = document.querySelectorAll('.xl\\\\:col-span-3, [class*="solution"]');
        for (const el of rightPanels) {
            const t = el.innerText?.trim();
            if (t && t.length > 50) return t;
        }
        return '';
    }""")


async def select_provider(page: Page, provider_label: str):
    """Select an LLM provider from the ZHI dropdown."""
    try:
        trigger = page.locator('[role="combobox"]').filter(has_text=re.compile(r'ZHI'))
        await trigger.click(timeout=8000)
        await page.wait_for_selector('[role="listbox"]', timeout=5000)
        await page.locator(f'[role="option"]:has-text("{provider_label}")').click(timeout=5000)
        await page.wait_for_timeout(500)
    except Exception as e:
        try:
            await page.get_by_text(re.compile(r'^ZHI')).first.click(timeout=5000)
            await page.wait_for_selector('[role="listbox"]', timeout=5000)
            await page.locator(f'[role="option"]:has-text("{provider_label}")').click(timeout=5000)
        except Exception:
            pass


async def take_screenshot(page: Page, path: str) -> str:
    """Take screenshot, return path."""
    await page.screenshot(path=path, full_page=False)
    return path


async def r1_choose_approach(step_name: str, description: str) -> tuple[str, str]:
    """Ask Claude to pick an approach from the 7 options. Returns (key, reasoning)."""
    options_text = "\n".join(f"  {k}: {v}" for k, v in APPROACHES.items())
    msg = _anthropic.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=300,
        messages=[{
            "role": "user",
            "content": (
                f"You are R1, a synthetic user beta-testing an AI homework app (EZHW).\n"
                f"Test step: {step_name}\n"
                f"Description: {description}\n\n"
                f"Pick ONE approach from this list that will best probe this feature:\n{options_text}\n\n"
                f"Respond with JSON only: {{\"approach\": \"<key>\", \"reasoning\": \"<1-2 sentences why>\"}}"
            )
        }]
    )
    raw = msg.content[0].text.strip()
    try:
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        data = json.loads(m.group(0) if m else raw)
        key = data.get("approach", "intended")
        if key not in APPROACHES:
            key = "intended"
        return key, data.get("reasoning", "")
    except Exception:
        return "intended", "Default: use the feature as intended."


async def judge_interaction(interaction: Interaction) -> tuple[str, str]:
    """Ask Claude to judge the interaction. Returns (verdict, critique)."""
    prompt = (
        f"You are a QA judge evaluating an automated beta test of EZHW, an AI homework app.\n\n"
        f"Test step: {interaction.step_name}\n"
        f"Description: {interaction.description}\n"
        f"R1's approach: {interaction.approach_key} — {interaction.approach_description}\n"
        f"R1's input: {interaction.r1_input[:800]}\n\n"
        f"App response (first 1200 chars): {interaction.app_response[:1200]}\n"
        f"SSE events observed: {interaction.sse_events_observed}\n"
        f"Network errors: {interaction.network_errors}\n"
        f"Duration: {interaction.duration_seconds:.1f}s\n"
        f"Any error: {interaction.error}\n\n"
        f"Evaluate: Did the feature work? Was the output correct, coherent, and appropriate? "
        f"Were any errors thrown? Was it slow (>30s is a flag)? Anything broken or off?\n\n"
        f"Respond with JSON only: {{\"verdict\": \"PASS|FAIL|PARTIAL\", \"critique\": \"<2-4 sentences>\"}}"
    )
    try:
        msg = _anthropic.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}]
        )
        raw = msg.content[0].text.strip()
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        data = json.loads(m.group(0) if m else raw)
        verdict = data.get("verdict", "PARTIAL")
        if verdict not in ("PASS", "FAIL", "PARTIAL"):
            verdict = "PARTIAL"
        return verdict, data.get("critique", raw)
    except Exception as e:
        return "PARTIAL", f"Judge error: {e}"


# ═══════════════════════════════════════════════════════════════════
#  NETWORK MONITOR — injects into the page to collect SSE events
# ═══════════════════════════════════════════════════════════════════

INIT_SCRIPT = """
window._r1_sse = [];
window._r1_net = [];
window._r1_errors = [];

const _origFetch = window.fetch;
window.fetch = async function(...args) {
    const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url) || '';
    const t0 = Date.now();
    let resp;
    try {
        resp = await _origFetch.apply(this, args);
    } catch(e) {
        window._r1_errors.push({url, error: String(e), ts: new Date().toISOString()});
        throw e;
    }
    window._r1_net.push({url, status: resp.status, ms: Date.now()-t0, ts: new Date().toISOString()});
    return resp;
};

window._r1_recordSSE = function(type) {
    window._r1_sse.push({type, ts: new Date().toISOString()});
};
"""

async def get_network_data(page: Page) -> tuple[list, list]:
    """Return (sse_events, errors) captured since page load."""
    try:
        sse = await page.evaluate("window._r1_sse || []")
        errs = await page.evaluate("window._r1_errors || []")
        return sse, errs
    except Exception:
        return [], []


# ═══════════════════════════════════════════════════════════════════
#  TEST RUNNER — the main class wiring everything together
# ═══════════════════════════════════════════════════════════════════

class R1Runner:
    def __init__(self, output_dir: str, console_log):
        self.out = Path(output_dir)
        self.ss_dir = self.out / "screenshots"
        self.ss_dir.mkdir(parents=True, exist_ok=True)
        self.transcript: list[Interaction] = []
        self.console_log = console_log
        self.step_count = 0
        self.net_log_entries: list[dict] = []

    def _log(self, msg: str):
        log(msg, self.console_log)

    async def run_step(
        self,
        page: Page,
        system: int,
        step_name: str,
        description: str,
        r1_input_text: str,
        executor,          # async callable(page) → app_response str
        force_approach: Optional[str] = None,
    ) -> Interaction:
        """Execute one test step, capture everything, call judge."""
        self.step_count += 1
        ss_name = f"{system:02d}_{self.step_count:03d}_{step_name[:30].replace(' ','_')}.png"
        ss_path = str(self.ss_dir / ss_name)

        self._log(f"System {system} — {step_name}")

        # R1 chooses approach
        if force_approach:
            approach_key, r1_reasoning = force_approach, "Pre-determined for this step."
        else:
            approach_key, r1_reasoning = await r1_choose_approach(step_name, description)

        self._log(f"  R1 approach: {approach_key} — {r1_reasoning}")

        # Clear previous network data
        try:
            await page.evaluate("window._r1_sse=[]; window._r1_errors=[];")
        except Exception:
            pass

        t_start = time.time()
        app_response = ""
        error_str = None

        try:
            self._log(f"  Executing...")
            app_response = await executor(page)
        except Exception as e:
            error_str = traceback.format_exc()
            app_response = f"[ERROR] {e}"
            self._log(f"  ERROR: {e}")

        duration = time.time() - t_start

        # Screenshot
        try:
            await take_screenshot(page, ss_path)
        except Exception:
            ss_path = ""

        # Collect network data
        sse_events, net_errors = await get_network_data(page)

        self._log(f"  App responded in {duration:.1f}s — {len(app_response)} chars")
        if sse_events:
            self._log(f"  SSE events: {[e.get('type') for e in sse_events]}")

        # Build interaction record (pre-judge)
        interaction = Interaction(
            timestamp=datetime.now().isoformat(),
            system=system,
            step_name=step_name,
            description=description,
            url=page.url,
            approach_key=approach_key,
            approach_description=APPROACHES.get(approach_key, ""),
            r1_reasoning=r1_reasoning,
            r1_input=r1_input_text,
            app_response=app_response,
            sse_events_observed=sse_events,
            network_errors=net_errors,
            judge_verdict="",
            judge_critique="",
            screenshot_path=ss_name,
            duration_seconds=round(duration, 2),
            error=error_str,
        )

        # Judge
        self._log(f"  Calling judge...")
        verdict, critique = await judge_interaction(interaction)
        interaction.judge_verdict = verdict
        interaction.judge_critique = critique

        icon = {"PASS": "✓", "FAIL": "✗", "PARTIAL": "~"}.get(verdict, "?")
        self._log(f"  Judge: {icon} {verdict} — {critique[:100]}")

        self.transcript.append(interaction)
        self._append_jsonl(interaction)
        return interaction

    def _append_jsonl(self, interaction: Interaction):
        with open(self.out / "transcript.jsonl", "a") as f:
            f.write(json.dumps(asdict(interaction)) + "\n")


# ═══════════════════════════════════════════════════════════════════
#  SYSTEM 1 — HOMEWORK ASSISTANT
# ═══════════════════════════════════════════════════════════════════

async def test_system_1(r: R1Runner, page: Page, context: BrowserContext):
    r._log("\n══ SYSTEM 1 — HOMEWORK ASSISTANT ══")

    await page.goto(APP_URL, wait_until="networkidle")
    await page.wait_for_timeout(2000)

    # ── 1a: ZHI 1 (Claude) — short factual ──────────────────────────────────
    Q_FACTUAL = "What is the Pythagorean theorem? Provide a brief proof."
    await r.run_step(
        page, 1, "ZHI-1 Claude — factual question", "Short factual question using Claude",
        Q_FACTUAL,
        force_approach="intended",
        executor=lambda p: _solve(p, Q_FACTUAL, provider="ZHI 1"),
    )

    # ── 1b: ZHI 2 (GPT-4o) — essay ──────────────────────────────────────────
    await page.goto(APP_URL, wait_until="networkidle")
    Q_ESSAY = "Write a 400-word essay on the causes of the French Revolution, focusing on economic factors."
    await r.run_step(
        page, 1, "ZHI-2 GPT-4o — essay prompt", "Multi-paragraph essay using GPT-4o",
        Q_ESSAY,
        force_approach="intended",
        executor=lambda p: _solve(p, Q_ESSAY, provider="ZHI 2"),
    )

    # ── 1c: ZHI 3 (DeepSeek) — math / LaTeX ────────────────────────────────
    await page.goto(APP_URL, wait_until="networkidle")
    Q_MATH = "Compute the definite integral ∫₀² (3x² + 2x - 1)dx. Show every step using proper mathematical notation."
    await r.run_step(
        page, 1, "ZHI-3 DeepSeek — math/LaTeX", "Math problem that should trigger LaTeX rendering",
        Q_MATH,
        force_approach="feature_path",
        executor=lambda p: _solve(p, Q_MATH, provider="ZHI 3"),
    )

    # ── 1d: ZHI 4 (Perplexity) — graph trigger ──────────────────────────────
    await page.goto(APP_URL, wait_until="networkidle")
    Q_GRAPH = "Plot y = x² - 4 from x = -3 to x = 3. Identify the x-intercepts, y-intercept, and vertex. Include the graph."
    await r.run_step(
        page, 1, "ZHI-4 Perplexity — graph generation", "Prompt containing 'plot' to trigger Chart.js graph auto-detection",
        Q_GRAPH,
        force_approach="feature_path",
        executor=lambda p: _solve(p, Q_GRAPH, provider="ZHI 4"),
    )

    # ── 1e: ZHI 5 (Grok) — special instructions ────────────────────────────
    await page.goto(APP_URL, wait_until="networkidle")
    Q_SPECIAL = "Explain Newton's three laws of motion with real-world examples."
    SPECIAL_INSTR = "Respond in exactly 3 numbered points. Each point must be under 30 words."
    await r.run_step(
        page, 1, "ZHI-5 Grok — special instructions", "Submit with Special Instructions filled in",
        f"Prompt: {Q_SPECIAL} | Instructions: {SPECIAL_INSTR}",
        force_approach="constraint",
        executor=lambda p: _solve_with_special_instructions(p, Q_SPECIAL, SPECIAL_INSTR, provider="ZHI 5"),
    )

    # ── 1f: Coherence Mode ON ───────────────────────────────────────────────
    await page.goto(APP_URL, wait_until="networkidle")
    coherence_prompt = Path(COHERENCE_PROMPT_PATH).read_text() if Path(COHERENCE_PROMPT_PATH).exists() else \
        "Write a 2000-word comprehensive analysis of Kantian ethics, utilitarian ethics, and their application to AI, covering all major concepts and objections."
    await r.run_step(
        page, 1, "Coherence Mode — long multi-part assignment", "Toggle Coherence Mode ON and submit long philosophical essay prompt",
        coherence_prompt[:200] + "...",
        force_approach="intended",
        executor=lambda p: _solve_coherence_mode(p, coherence_prompt),
    )

    # ── 1g: Philosopher DB ON ───────────────────────────────────────────────
    await page.goto(APP_URL, wait_until="networkidle")
    Q_PHIL = "How did Kant reconcile human freedom with causal determinism? What role does the noumenal self play in his moral philosophy?"
    await r.run_step(
        page, 1, "Philosopher DB ON — philosophy question", "Toggle Philosopher DB ON and submit philosophy question",
        Q_PHIL,
        force_approach="feature_path",
        executor=lambda p: _solve_with_philosopher_db(p, Q_PHIL),
    )

    # ── 1h: File upload (.txt) ──────────────────────────────────────────────
    await page.goto(APP_URL, wait_until="networkidle")
    txt_path = r.out / "test_upload.txt"
    txt_path.write_text("The speed of light in a vacuum is approximately 299,792,458 metres per second (m/s). "
                        "This is commonly denoted by the letter c. According to special relativity, c is the "
                        "upper limit for the speed of matter, energy, and information. Einstein's famous equation "
                        "E=mc² shows the equivalence of mass and energy, where c appears as the conversion factor.")
    await r.run_step(
        page, 1, "File upload — .txt input", "Upload a plain text file as homework input",
        f"[File upload]: {txt_path.name}",
        force_approach="intended",
        executor=lambda p: _solve_file_upload(p, str(txt_path)),
    )

    # ── 1i: Chat refinement ─────────────────────────────────────────────────
    await page.goto(APP_URL, wait_until="networkidle")
    Q_CHAT_BASE = "What is photosynthesis? Give a brief overview."
    CHAT_FOLLOWUP = "Can you provide three specific real-world examples of how photosynthesis is used in agriculture?"
    await r.run_step(
        page, 1, "Chat refinement — follow-up question", "Submit prompt, wait for solution, then send follow-up chat message",
        f"Initial: {Q_CHAT_BASE} | Follow-up: {CHAT_FOLLOWUP}",
        force_approach="intended",
        executor=lambda p: _solve_then_chat(p, Q_CHAT_BASE, CHAT_FOLLOWUP),
    )

    # ── 1j: Save assignment ─────────────────────────────────────────────────
    await page.goto(APP_URL, wait_until="networkidle")
    Q_SAVE = "What is the difference between mitosis and meiosis?"
    SAVE_TITLE = "R1 Test Save — Mitosis vs Meiosis"
    await r.run_step(
        page, 1, "Save assignment — persist and reload", "Submit, then save with title, reload page, confirm in dropdown",
        f"Prompt: {Q_SAVE} | Title: {SAVE_TITLE}",
        force_approach="intended",
        executor=lambda p: _solve_and_save(p, Q_SAVE, SAVE_TITLE),
    )

    # ── 1k: PDF Export ─────────────────────────────────────────────────────
    # Reload, load saved assignment, then try PDF
    await page.goto(APP_URL, wait_until="networkidle")
    Q_PDF = "Explain the water cycle in 3 paragraphs."
    await r.run_step(
        page, 1, "PDF export", "Submit prompt and click Print/PDF export",
        Q_PDF,
        force_approach="intended",
        executor=lambda p: _solve_then_pdf(p, Q_PDF),
    )

    # ── 1l: AI Detection ───────────────────────────────────────────────────
    await page.goto(APP_URL, wait_until="networkidle")
    Q_AIDET = "Summarize the theory of natural selection as proposed by Darwin."
    await r.run_step(
        page, 1, "AI detection — read detection score", "Submit and read the AI detection score shown in the solution header",
        Q_AIDET,
        force_approach="intended",
        executor=lambda p: _solve_check_ai_score(p, Q_AIDET),
    )


# ── System 1 executors ──────────────────────────────────────────────────────

async def _solve(page: Page, prompt: str, provider: str = "ZHI 5") -> str:
    await select_provider(page, provider)
    await page.fill('textarea[placeholder*="Type, paste, or speak"]', prompt)
    await page.wait_for_timeout(300)
    await page.click('[data-testid="button-solve"]')
    await wait_for_solve_complete(page)
    return await get_solution_text(page)


async def _solve_with_special_instructions(page: Page, prompt: str, instructions: str, provider: str = "ZHI 5") -> str:
    await select_provider(page, provider)
    await page.fill('textarea[placeholder*="Type, paste, or speak"]', prompt)
    # Expand special instructions
    try:
        summary = page.locator("summary").filter(has_text=re.compile(r"Special Instruction", re.I))
        if await summary.count() > 0:
            await summary.first.click()
            await page.wait_for_timeout(400)
    except Exception:
        pass
    # Fill the instructions field
    try:
        await page.fill('textarea[placeholder*="Add special instructions"]', instructions)
    except Exception:
        pass
    await page.click('[data-testid="button-solve"]')
    await wait_for_solve_complete(page)
    return await get_solution_text(page)


async def _solve_coherence_mode(page: Page, prompt: str) -> str:
    # Toggle coherence mode ON
    try:
        toggle_btn = page.locator('[data-testid="toggle-coherence-mode"]')
        text = await toggle_btn.text_content()
        if "OFF" in (text or ""):
            await toggle_btn.click()
            await page.wait_for_timeout(500)
    except Exception:
        pass
    await page.fill('textarea[placeholder*="Type, paste, or speak"]', prompt[:3000])
    await page.click('[data-testid="button-solve"]')
    # Coherence mode takes longer
    await page.wait_for_function(
        """() => {
            const btn = document.querySelector('[data-testid="button-solve"]');
            if (!btn) return true;
            const t = btn.textContent || '';
            return !t.includes('Processing') && !t.includes('Generating');
        }""",
        timeout=LONG_OP_TIMEOUT_MS
    )
    result = await get_solution_text(page)
    # Also try to get SSE event info from page state
    sse_info = await page.evaluate("""() => window._r1_sse || []""")
    return f"{result}\n\n[SSE events captured: {len(sse_info)}]"


async def _solve_with_philosopher_db(page: Page, prompt: str) -> str:
    # Toggle Philosopher DB ON
    try:
        phil_btn = page.locator('[data-testid="toggle-philosopher-db"]')
        text = await phil_btn.text_content()
        if "OFF" in (text or ""):
            await phil_btn.click()
            await page.wait_for_timeout(500)
    except Exception:
        pass
    return await _solve(page, prompt)


async def _solve_file_upload(page: Page, file_path: str) -> str:
    # Find file input and upload
    try:
        async with page.expect_file_chooser(timeout=8000) as fc:
            await page.locator('label[for*="file"], [class*="upload"], [class*="drop"]').first.click(timeout=5000)
        chooser = await fc.value
        await chooser.set_files(file_path)
    except Exception:
        try:
            await page.set_input_files('input[type="file"]', file_path)
        except Exception:
            pass
    await page.wait_for_timeout(2000)
    # Click solve
    try:
        await page.click('[data-testid="button-solve"]')
        await wait_for_solve_complete(page)
    except Exception:
        pass
    return await get_solution_text(page)


async def _solve_then_chat(page: Page, base_prompt: str, followup: str) -> str:
    # Solve base
    await _solve(page, base_prompt)
    await page.wait_for_timeout(1000)
    # Find chat refinement input
    chat_input = page.locator('input[placeholder*="Type a message or ask a follow-up"]')
    if await chat_input.count() == 0:
        chat_input = page.locator('textarea[placeholder*="Type a message or ask a follow-up"]')
    try:
        await chat_input.fill(followup)
        await page.wait_for_timeout(300)
        send_btn = page.locator('[data-testid="button-chat-send"]')
        await send_btn.click(timeout=8000)
        await page.wait_for_timeout(8000)  # wait for chat response
    except Exception as e:
        return f"Base solution obtained. Chat refinement failed: {e}"
    chat_response = await page.evaluate("""() => {
        const msgs = document.querySelectorAll('[class*="chat"], [class*="message"]');
        return msgs.length > 0 ? msgs[msgs.length-1].innerText : 'no chat messages found';
    }""")
    return f"Base solution present. Chat response: {chat_response[:500]}"


async def _solve_and_save(page: Page, prompt: str, title: str) -> str:
    await _solve(page, prompt)
    await page.wait_for_timeout(1000)
    # Fill title and save
    try:
        await page.fill('input[placeholder*="Enter assignment title"]', title)
        await page.wait_for_timeout(300)
        save_btn = page.locator('button:has-text("Save")').first
        await save_btn.click(timeout=8000)
        await page.wait_for_timeout(1500)
    except Exception as e:
        return f"Solution obtained. Save failed: {e}"
    # Reload and check dropdown
    await page.reload(wait_until="networkidle")
    await page.wait_for_timeout(2000)
    saved_options = await page.evaluate("""() => {
        const opts = document.querySelectorAll('[role="option"]');
        return Array.from(opts).map(o => o.textContent?.trim()).filter(Boolean);
    }""")
    found = any(title[:20].lower() in (o or "").lower() for o in saved_options)
    return f"Saved. After reload, title found in dropdown: {found}. Options: {saved_options[:5]}"


async def _solve_then_pdf(page: Page, prompt: str) -> str:
    await _solve(page, prompt)
    await page.wait_for_timeout(1000)
    # Look for Print/PDF button
    try:
        pdf_btn = page.locator('button:has-text("Print/PDF"), button:has-text("Print"), button[title*="PDF"]').first
        async with page.expect_event("download", timeout=20000) as dl_info:
            await pdf_btn.click(timeout=8000)
        download = await dl_info.value
        filename = download.suggested_filename
        return f"PDF export triggered. Filename: {filename}"
    except Exception as e:
        # Print dialog might open instead
        return f"PDF button clicked (print dialog may have opened). {e}"


async def _solve_check_ai_score(page: Page, prompt: str) -> str:
    await _solve(page, prompt)
    await page.wait_for_timeout(3000)
    score_text = await page.evaluate("""() => {
        const scorers = document.querySelectorAll('[class*="score"], [class*="ai-detect"], [class*="badge"]');
        return Array.from(scorers).map(e => e.textContent?.trim()).filter(Boolean).join(' | ');
    }""")
    return f"Solution generated. AI score indicators: {score_text or 'Not visible in DOM after solving'}"


# ═══════════════════════════════════════════════════════════════════
#  SYSTEM 2 — GRADING ASSISTANT
# ═══════════════════════════════════════════════════════════════════

async def test_system_2(r: R1Runner, page: Page):
    r._log("\n══ SYSTEM 2 — GRADING ASSISTANT ══")

    await page.goto(f"{APP_URL}/grading", wait_until="networkidle")
    await page.wait_for_timeout(2000)

    ASSIGNMENT = "Write a 300-word paragraph explaining the main causes of World War I."
    RUBRIC = ("A = Identifies 4+ specific causes with names/dates; "
              "B = 3 causes with some detail; "
              "C = 2 causes vaguely described; "
              "D = 1 cause or very unclear; "
              "F = Off-topic or blank.")
    SUBMISSION = ("World War I had many causes. The assassination of Archduke Franz Ferdinand "
                  "in 1914 sparked the conflict. There were also some tensions between European "
                  "nations before the war. Different countries had alliance agreements which pulled "
                  "them into fighting. The war ended up lasting for several years with many casualties.")

    # ── 2a: Full grade cycle ─────────────────────────────────────────────────
    await r.run_step(
        page, 2, "Grade submission — full cycle", "Provide assignment + rubric + student submission, capture grade",
        f"Assignment: {ASSIGNMENT[:80]}... | Rubric: {RUBRIC[:60]}... | Submission: {SUBMISSION[:80]}...",
        force_approach="intended",
        executor=lambda p: _grade_submission(p, ASSIGNMENT, RUBRIC, SUBMISSION),
    )

    # ── 2b: Grade adjustments ────────────────────────────────────────────────
    await r.run_step(
        page, 2, "Grade adjustments — Higher / Lower / Reevaluate", "Click each adjustment option and Apply",
        "Grade Higher → Grade Lower → Reevaluate",
        force_approach="intended",
        executor=lambda p: _grade_adjustments(p),
    )

    # ── 2c: Generate Perfect Assignment ─────────────────────────────────────
    await r.run_step(
        page, 2, "Generate Perfect Assignment", "Click 'Generate Perfect Assignment' button, capture output",
        "Generate Perfect Assignment",
        force_approach="intended",
        executor=lambda p: _generate_perfect(p),
    )


async def _grade_submission(page: Page, assignment: str, rubric: str, submission: str) -> str:
    await safe_fill(page, '[data-testid="textarea-assignment-prompt"]', assignment)
    await safe_fill(page, '[data-testid="textarea-grading-instructions"]', rubric)
    await safe_fill(page, '[data-testid="textarea-student-submission"]', submission)
    await page.click('[data-testid="button-grade-submission"]')
    # Wait for grade to appear
    await page.wait_for_function(
        """() => {
            const btn = document.querySelector('[data-testid="button-grade-submission"]');
            if (!btn) return true;
            return !btn.textContent.includes('Grading') && !btn.textContent.includes('Generating');
        }""",
        timeout=SOLVE_TIMEOUT_MS
    )
    grade_text = await page.evaluate("""() => {
        const areas = document.querySelectorAll('[class*="grade"], [class*="result"], [class*="prose"]');
        return Array.from(areas).map(e => e.innerText?.trim()).filter(t => t.length > 20).join('\n---\n');
    }""")
    return grade_text[:1500] or "Grade output not found in DOM"


async def _grade_adjustments(page: Page) -> str:
    results = []
    for radio_id, label in [("radio-higher", "Higher"), ("radio-lower", "Lower"), ("radio-reevaluate", "Reevaluate")]:
        try:
            radio = page.locator(f'[data-testid="{radio_id}"]')
            if await radio.count() > 0:
                await radio.click(timeout=5000)
            else:
                # Try label text
                await page.get_by_text(re.compile(label, re.I)).first.click(timeout=5000)
            await page.wait_for_timeout(500)
            apply_btn = page.locator('[data-testid="button-adjust-grade"]')
            if await apply_btn.count() > 0:
                await apply_btn.click(timeout=5000)
                await page.wait_for_timeout(8000)
            grade_text = await page.evaluate("""() => {
                const areas = document.querySelectorAll('[class*="grade"], [class*="prose"]');
                return Array.from(areas).map(e => e.innerText?.trim()).filter(t => t.length > 10).join(' | ');
            }""")
            results.append(f"{label}: {grade_text[:200]}")
        except Exception as e:
            results.append(f"{label}: ERROR — {e}")
    return "\n".join(results)


async def _generate_perfect(page: Page) -> str:
    try:
        btn = page.locator('[data-testid="button-generate-perfect"]')
        if await btn.count() == 0:
            btn = page.locator('button:has-text("GENERATE PERFECT")').first
        await btn.click(timeout=8000)
        await page.wait_for_function(
            """() => {
                const btn = document.querySelector('[data-testid="button-generate-perfect"]');
                if (!btn) return true;
                return !btn.textContent.includes('Generating') && !btn.textContent.includes('...');
            }""",
            timeout=LONG_OP_TIMEOUT_MS
        )
        perfect_text = await page.evaluate("""() => {
            const areas = document.querySelectorAll('[class*="prose"], [class*="perfect"], [class*="output"]');
            return Array.from(areas).map(e => e.innerText?.trim()).filter(t => t.length > 50).join('\n');
        }""")
        return perfect_text[:1500] or "Perfect assignment output not found"
    except Exception as e:
        return f"Generate Perfect failed: {e}"


# ═══════════════════════════════════════════════════════════════════
#  SYSTEM 3 — LONG-TERM PROJECTS
# ═══════════════════════════════════════════════════════════════════

async def test_system_3(r: R1Runner, page: Page):
    r._log("\n══ SYSTEM 3 — LONG-TERM PROJECTS ══")

    await page.goto(f"{APP_URL}/projects", wait_until="networkidle")
    await page.wait_for_timeout(2000)

    PROJECT_NAME = "R1 Test Project"

    # ── 3a: Create project ───────────────────────────────────────────────────
    project_id = None
    await r.run_step(
        page, 3, "Create new project", "Click New Project, enter name, confirm creation",
        PROJECT_NAME,
        force_approach="intended",
        executor=lambda p: _create_project(p, PROJECT_NAME),
    )

    # Get the project ID from URL after navigation
    current_url = page.url
    if "/projects/" in current_url:
        try:
            project_id = current_url.split("/projects/")[-1].split("?")[0]
        except Exception:
            pass

    if not project_id:
        # Navigate back and find it
        await page.goto(f"{APP_URL}/projects", wait_until="networkidle")
        await page.wait_for_timeout(1500)
        project_id = await page.evaluate(f"""() => {{
            const links = document.querySelectorAll('a[href*="/projects/"]');
            for (const l of links) {{
                if (l.textContent?.includes('{PROJECT_NAME}')) {{
                    const m = l.href.match(/\\/projects\\/(\\d+)/);
                    return m ? m[1] : null;
                }}
            }}
            return null;
        }}""")

    if project_id:
        await page.goto(f"{APP_URL}/projects/{project_id}", wait_until="networkidle")
        await page.wait_for_timeout(2000)

    # ── 3b: Three sequential chat messages ──────────────────────────────────
    msgs = [
        "What is the significance of Wittgenstein's Tractatus Logico-Philosophicus in 20th century philosophy?",
        "How does Wittgenstein's later philosophy in Philosophical Investigations differ from the Tractatus?",
        "Explain the concept of language games. How does it relate to ordinary language philosophy?",
    ]
    for i, msg in enumerate(msgs, 1):
        await r.run_step(
            page, 3, f"Project chat — message {i} of 3", f"Send message to project chat, verify Tractatus tree updates",
            msg,
            force_approach="intended",
            executor=lambda p, m=msg: _project_chat(p, m),
        )

    # ── 3c: Switch to Memory tab ─────────────────────────────────────────────
    await r.run_step(
        page, 3, "Memory tab — view tree", "Click Memory tab, verify tiers and nodes displayed",
        "Memory tab inspection",
        force_approach="intended",
        executor=lambda p: _check_memory_tab(p),
    )

    # ── 3d: Rename project ───────────────────────────────────────────────────
    await r.run_step(
        page, 3, "Rename project", "Rename project via UI",
        f"{PROJECT_NAME} → R1 Test Project (Renamed)",
        force_approach="intended",
        executor=lambda p: _rename_project(p, "R1 Test Project (Renamed)"),
    )

    # ── 3e: Create second session ────────────────────────────────────────────
    await r.run_step(
        page, 3, "Create second session and send message", "Add a second session, send one message",
        "Second session message",
        force_approach="intended",
        executor=lambda p: _create_second_session(p),
    )


async def _create_project(page: Page, name: str) -> str:
    new_btn = page.locator('button:has-text("New Project"), button:has-text("Create your first project")').first
    await new_btn.click(timeout=8000)
    await page.wait_for_timeout(800)
    name_input = page.locator('input[placeholder*="Dissertation"], input[placeholder*="project"]').first
    if await name_input.count() == 0:
        name_input = page.locator('input[type="text"]').first
    await name_input.fill(name)
    await page.wait_for_timeout(300)
    create_btn = page.locator('button:has-text("Create Project"), button:has-text("Create")').last
    await create_btn.click(timeout=8000)
    await page.wait_for_timeout(2000)
    return f"Project '{name}' created. Current URL: {page.url}"


async def _project_chat(page: Page, message: str) -> str:
    chat_input = page.locator('textarea[placeholder*="Message this project"]')
    await chat_input.fill(message)
    await page.wait_for_timeout(300)
    send_btn = page.locator('button:has([class*="send"]), button:has([data-lucide="send"])').first
    if await send_btn.count() == 0:
        send_btn = page.locator('[data-testid="button-chat-send"]').first
    await send_btn.click(timeout=8000)
    # Wait for AI response
    await page.wait_for_timeout(30000)
    # Check for tree update popup
    tree_popup = await page.evaluate("""() => {
        const popups = document.querySelectorAll('[class*="popup"], [class*="tree-update"], [class*="tractatus"]');
        return Array.from(popups).map(e => e.innerText?.trim()).filter(Boolean).join(' | ');
    }""")
    # Get any chat response
    chat_response = await page.evaluate("""() => {
        const msgs = document.querySelectorAll('[class*="message"], [class*="assistant"]');
        const last = msgs[msgs.length - 1];
        return last ? last.innerText?.trim() : '';
    }""")
    return f"Response: {chat_response[:400]} | Tree popup: {tree_popup[:200] or 'not visible'}"


async def _check_memory_tab(page: Page) -> str:
    try:
        memory_tab = page.locator('button:has-text("Memory")').first
        await memory_tab.click(timeout=8000)
        await page.wait_for_timeout(1500)
    except Exception:
        pass
    memory_content = await page.evaluate("""() => {
        const mem = document.querySelectorAll('[class*="memory"], [class*="tier"], [class*="node"], [class*="tractatus"]');
        return Array.from(mem).map(e => e.innerText?.trim()).filter(t => t.length > 5).slice(0, 10).join(' | ');
    }""")
    return f"Memory tab content: {memory_content[:600] or 'Empty or not rendered'}"


async def _rename_project(page: Page, new_name: str) -> str:
    try:
        # Look for a rename/edit button or editable title
        edit_btn = page.locator('button:has-text("Rename"), button[aria-label*="rename"], button[aria-label*="edit"]').first
        if await edit_btn.count() > 0:
            await edit_btn.click(timeout=5000)
            await page.wait_for_timeout(500)
            name_input = page.locator('input[type="text"]').first
            await name_input.triple_click()
            await name_input.fill(new_name)
            await page.keyboard.press("Enter")
            return f"Renamed to: {new_name}"
        else:
            # Try clicking the project title itself
            title = page.locator('h1, h2, [class*="title"]').first
            await title.double_click(timeout=5000)
            await page.wait_for_timeout(500)
            await page.keyboard.press("Control+a")
            await page.keyboard.type(new_name)
            await page.keyboard.press("Enter")
            return f"Attempted rename to: {new_name}"
    except Exception as e:
        return f"Rename attempted: {e}"


async def _create_second_session(page: Page) -> str:
    try:
        new_session_btn = page.locator('button:has-text("New Session"), button:has-text("New Chat"), button:has-text("+")').first
        await new_session_btn.click(timeout=8000)
        await page.wait_for_timeout(1000)
    except Exception:
        pass
    # Send one message in the new session
    try:
        chat_input = page.locator('textarea[placeholder*="Message this project"]')
        await chat_input.fill("What is the hard problem of consciousness?")
        await page.wait_for_timeout(300)
        send_btn = page.locator('[data-testid="button-chat-send"]').first
        await send_btn.click(timeout=8000)
        await page.wait_for_timeout(25000)
        # Go back and check sessions count
        sessions = await page.evaluate("""() => {
            const s = document.querySelectorAll('[class*="session"], [class*="chat-list"] li, [class*="sidebar"] li');
            return s.length;
        }""")
        return f"Second session created and message sent. Session elements visible: {sessions}"
    except Exception as e:
        return f"Second session: {e}"


# ═══════════════════════════════════════════════════════════════════
#  SYSTEM 4 — LONG DOCUMENT GENERATOR
# ═══════════════════════════════════════════════════════════════════

async def test_system_4(r: R1Runner, page: Page):
    r._log("\n══ SYSTEM 4 — LONG DOCUMENT GENERATOR ══")

    # Navigate to first project's workspace
    await page.goto(f"{APP_URL}/projects", wait_until="networkidle")
    await page.wait_for_timeout(1500)

    # Click first project
    project_link = page.locator('a[href*="/projects/"], [class*="card"] a').first
    if await project_link.count() > 0:
        await project_link.click(timeout=8000)
    else:
        # Try any card
        await page.locator('[class*="card"]').first.click(timeout=8000)
    await page.wait_for_timeout(2000)

    DOC_PROMPT = (f"Write a comprehensive overview of the history of artificial intelligence "
                  f"from 1950 to 2024, covering key milestones, influential researchers, and "
                  f"major paradigm shifts. Target: {LONG_DOC_TARGET_WORDS} words.")

    await r.run_step(
        page, 4, "Long Doc — generate document", f"Open Long Doc tab, set {LONG_DOC_TARGET_WORDS} words, generate document",
        DOC_PROMPT,
        force_approach="intended",
        executor=lambda p: _generate_long_doc(p, DOC_PROMPT),
    )


async def _generate_long_doc(page: Page, prompt: str) -> str:
    # Click Long Doc tab
    try:
        long_doc_tab = page.locator('button:has-text("Long Doc")').first
        await long_doc_tab.click(timeout=8000)
        await page.wait_for_timeout(1000)
    except Exception as e:
        return f"Could not find Long Doc tab: {e}"

    # Set word count
    try:
        select = page.locator('select, [role="combobox"]').filter(has_text=re.compile(r'\d,\d{3}'))
        if await select.count() == 0:
            select = page.locator('[class*="word"], select').first
        await select.click(timeout=5000)
        await page.wait_for_selector('[role="listbox"]', timeout=5000)
        target = f"{LONG_DOC_TARGET_WORDS:,}"
        opt = page.locator(f'[role="option"]:has-text("{target}")')
        if await opt.count() > 0:
            await opt.first.click()
        else:
            await page.keyboard.press("Escape")
    except Exception:
        pass

    # Fill prompt
    doc_textarea = page.locator('textarea[placeholder*="Topic"], textarea[placeholder*="document"], textarea').last
    await doc_textarea.fill(prompt)
    await page.wait_for_timeout(300)

    # Click generate
    gen_btn = page.locator('button:has-text("Generate Document"), button:has-text("Generate")').first
    await gen_btn.click(timeout=8000)

    # Wait for completion (long)
    start = time.time()
    while time.time() - start < (LONG_OP_TIMEOUT_MS / 1000):
        btn_text = await gen_btn.text_content()
        if btn_text and "Generating" not in btn_text and "..." not in btn_text:
            break
        await page.wait_for_timeout(5000)

    # Capture output
    output = await page.evaluate("""() => {
        const areas = document.querySelectorAll('[class*="prose"], [class*="output"], [class*="document"]');
        const texts = Array.from(areas).map(e => e.innerText?.trim()).filter(t => t.length > 100);
        return texts.join('\n\n---\n\n');
    }""")

    word_count = len(output.split()) if output else 0
    return f"Document generated. Approx word count: {word_count}. Preview: {output[:800]}"


# ═══════════════════════════════════════════════════════════════════
#  SYSTEM 5 — COHERENCE MODE (SSE event verification)
# ═══════════════════════════════════════════════════════════════════

async def test_system_5(r: R1Runner, page: Page):
    r._log("\n══ SYSTEM 5 — COHERENCE MODE (SSE verification) ══")

    await page.goto(APP_URL, wait_until="networkidle")
    await page.wait_for_timeout(1500)

    SSE_PROMPT = ("Analyze how three philosophical frameworks — existentialism, pragmatism, and "
                  "analytic philosophy — approach the problem of consciousness. "
                  "For each framework: explain its core methodology, its stance on the mind-body problem, "
                  "its strongest argument, and its primary weakness. Then compare all three.")

    await r.run_step(
        page, 5, "Coherence Mode — SSE event log", "Toggle Coherence ON, submit medium prompt, verify SSE event types arrive",
        SSE_PROMPT,
        force_approach="intended",
        executor=lambda p: _coherence_sse_check(p, SSE_PROMPT),
    )


async def _coherence_sse_check(page: Page, prompt: str) -> str:
    # Inject SSE event tracker
    await page.evaluate("""() => {
        window._r1_sse_types = [];
        const origFetch = window.fetch;
        window.fetch = async function(...args) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            const resp = await origFetch.apply(this, args);
            if (url.includes('coherent')) {
                const reader = resp.clone().body.getReader();
                const decoder = new TextDecoder();
                (async () => {
                    try {
                        while(true) {
                            const {done, value} = await reader.read();
                            if (done) break;
                            const chunk = decoder.decode(value);
                            for (const line of chunk.split('\\n')) {
                                if (!line.startsWith('data: ')) continue;
                                try {
                                    const ev = JSON.parse(line.slice(6));
                                    if (ev.type) window._r1_sse_types.push(ev.type);
                                } catch(e) {}
                            }
                        }
                    } catch(e) {}
                })();
            }
            return resp;
        };
    }""")

    # Toggle coherence ON
    toggle_btn = page.locator('[data-testid="toggle-coherence-mode"]')
    try:
        text = await toggle_btn.text_content()
        if "OFF" in (text or ""):
            await toggle_btn.click()
            await page.wait_for_timeout(500)
    except Exception:
        pass

    await page.fill('textarea[placeholder*="Type, paste, or speak"]', prompt)
    await page.click('[data-testid="button-solve"]')

    # Wait for completion
    await page.wait_for_function(
        """() => {
            const btn = document.querySelector('[data-testid="button-solve"]');
            if (!btn) return true;
            return !btn.textContent.includes('Processing') && !btn.textContent.includes('Generating');
        }""",
        timeout=LONG_OP_TIMEOUT_MS
    )

    sse_types = await page.evaluate("window._r1_sse_types || []")
    solution = await get_solution_text(page)
    unique_events = list(dict.fromkeys(sse_types))  # preserve order, dedupe
    return (f"SSE event types observed: {unique_events}\n"
            f"Solution length: {len(solution)} chars\n"
            f"Solution preview: {solution[:400]}")


# ═══════════════════════════════════════════════════════════════════
#  SYSTEM 6 — PAYMENT SYSTEM (UI-only, no real payments)
# ═══════════════════════════════════════════════════════════════════

async def test_system_6(r: R1Runner, page: Page):
    r._log("\n══ SYSTEM 6 — PAYMENT SYSTEM (UI check only) ══")

    await page.goto(APP_URL, wait_until="networkidle")
    await page.wait_for_timeout(2000)

    await r.run_step(
        page, 6, "Payment dialog — verify UI loads", "Trigger payment dialog, confirm Stripe+PayPal render, close without paying",
        "Payment dialog UI check",
        force_approach="intended",
        executor=lambda p: _check_payment_dialog(p),
    )


async def _check_payment_dialog(page: Page) -> str:
    # Try clicking the token balance area or any buy/upgrade button
    triggers = [
        'button:has-text("Buy Tokens")',
        'button:has-text("Purchase")',
        'button:has-text("Upgrade")',
        '[class*="token"]:has-text("token")',
        'button:has-text("100.0M")',
        '[data-testid="token-status"]',
    ]
    opened = False
    for sel in triggers:
        try:
            el = page.locator(sel).first
            if await el.count() > 0:
                await el.click(timeout=3000)
                await page.wait_for_timeout(1500)
                opened = True
                break
        except Exception:
            pass

    if not opened:
        # Try clicking the token count text in the header
        try:
            token_el = page.get_by_text(re.compile(r'100\.0M|tokens|Unlimited', re.I)).first
            await token_el.click(timeout=3000)
            await page.wait_for_timeout(1500)
            opened = True
        except Exception:
            pass

    # Check what's visible in any dialog
    dialog_content = await page.evaluate("""() => {
        const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"]');
        return Array.from(dialogs).map(d => d.innerText?.trim()).filter(Boolean).join(' | ');
    }""")

    stripe_present = "stripe" in dialog_content.lower() or bool(
        await page.locator('[id*="stripe"], [class*="stripe"], iframe[src*="stripe"]').count()
    )
    paypal_present = "paypal" in dialog_content.lower() or bool(
        await page.locator('[id*="paypal"], [class*="paypal"], iframe[src*="paypal"]').count()
    )

    # Close dialog
    try:
        await page.keyboard.press("Escape")
    except Exception:
        pass

    return (f"Dialog opened: {opened}\n"
            f"Stripe element present: {stripe_present}\n"
            f"PayPal element present: {paypal_present}\n"
            f"Dialog content preview: {dialog_content[:400]}")


# ═══════════════════════════════════════════════════════════════════
#  SYSTEM 7 — VOICE DICTATION
# ═══════════════════════════════════════════════════════════════════

async def test_system_7(r: R1Runner, page: Page):
    r._log("\n══ SYSTEM 7 — VOICE DICTATION ══")

    await page.goto(APP_URL, wait_until="networkidle")
    await page.wait_for_timeout(2000)

    await r.run_step(
        page, 7, "Voice dictation — mic button + AssemblyAI token check", "Click mic button, verify active state + AssemblyAI token endpoint hit",
        "Voice input activation",
        force_approach="intended",
        executor=lambda p: _check_voice_input(p),
    )


async def _check_voice_input(page: Page) -> str:
    # Track network requests for AssemblyAI token endpoint
    token_requests = []
    ws_upgrades = []

    def on_request(req: Request):
        if "assemblyai" in req.url.lower() or "token" in req.url.lower():
            token_requests.append(req.url)
        if req.resource_type == "websocket":
            ws_upgrades.append(req.url)

    page.on("request", on_request)

    # Find the mic button (VoiceInput component)
    mic_btn = page.locator('button[aria-label*="mic"], button[title*="mic"], button:has([data-lucide="mic"])').first
    if await mic_btn.count() == 0:
        mic_btn = page.locator('button:has([class*="mic"]), [class*="voice"] button').first

    clicked = False
    if await mic_btn.count() > 0:
        await mic_btn.click(timeout=5000)
        clicked = True
        await page.wait_for_timeout(3000)

    # Check for active/recording state
    active_state = await page.evaluate("""() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
            if (b.className.includes('red') || b.className.includes('recording') ||
                b.className.includes('active') || b.getAttribute('aria-label')?.includes('stop')) {
                return b.outerHTML.slice(0, 200);
            }
        }
        return null;
    }""")

    # Stop recording if started
    if clicked:
        try:
            await mic_btn.click(timeout=3000)
        except Exception:
            pass

    page.remove_listener("request", on_request)

    return (f"Mic button found: {clicked}\n"
            f"Active/recording state element found: {bool(active_state)}\n"
            f"Active state HTML: {active_state or 'None'}\n"
            f"AssemblyAI/token requests: {token_requests}\n"
            f"WebSocket upgrades: {ws_upgrades}")


# ═══════════════════════════════════════════════════════════════════
#  SYSTEM 8 — PHILOSOPHER DB KILL SWITCH
# ═══════════════════════════════════════════════════════════════════

async def test_system_8(r: R1Runner, page: Page):
    r._log("\n══ SYSTEM 8 — PHILOSOPHER DB KILL SWITCH ══")

    await page.goto(APP_URL, wait_until="networkidle")
    await page.wait_for_timeout(2000)

    NON_PHIL_PROMPT = ("Write a Python function that sorts a list of integers using bubble sort. "
                       "Include step-by-step comments explaining each line.")

    await r.run_step(
        page, 8, "Philosopher DB — non-philosophy kill switch", "Philosopher DB ON + non-philosophical prompt — verify no fabricated quotes",
        NON_PHIL_PROMPT,
        force_approach="boundary",
        executor=lambda p: _philosopher_kill_switch(p, NON_PHIL_PROMPT),
    )


async def _philosopher_kill_switch(page: Page, prompt: str) -> str:
    # Toggle Philosopher DB ON
    try:
        phil_btn = page.locator('[data-testid="toggle-philosopher-db"]')
        text = await phil_btn.text_content()
        if "OFF" in (text or ""):
            await phil_btn.click()
            await page.wait_for_timeout(500)
    except Exception:
        pass

    solution = await _solve(page, prompt)

    # Heuristics: check for quote-like patterns
    quote_patterns = [
        r'"[^"]{20,}".*?—\s*\w+',   # "text" — Author
        r'as\s+\w+\s+once said',
        r'in the words of',
        r'according to',
    ]
    found_quotes = []
    for pat in quote_patterns:
        if re.search(pat, solution, re.I):
            found_quotes.append(pat)

    kill_switch_active = len(found_quotes) == 0
    return (f"Philosopher DB was ON. Non-philosophy prompt submitted.\n"
            f"Kill switch appears active (no fabricated quotes): {kill_switch_active}\n"
            f"Quote patterns found: {found_quotes}\n"
            f"Solution preview: {solution[:600]}")


# ═══════════════════════════════════════════════════════════════════
#  REPORT WRITER
# ═══════════════════════════════════════════════════════════════════

SYSTEM_NAMES = {
    1: "Homework Assistant",
    2: "Grading Assistant",
    3: "Long-Term Projects",
    4: "Long Document Generator",
    5: "Coherence Mode",
    6: "Payment System",
    7: "Voice Dictation",
    8: "Philosopher DB",
}

def write_report(transcript: list[Interaction], out_dir: Path):
    total = len(transcript)
    passed = sum(1 for i in transcript if i.judge_verdict == "PASS")
    failed = sum(1 for i in transcript if i.judge_verdict == "FAIL")
    partial = sum(1 for i in transcript if i.judge_verdict == "PARTIAL")

    # ── failures.md ──────────────────────────────────────────────────────────
    failures = [i for i in transcript if i.judge_verdict in ("FAIL", "PARTIAL")]
    with open(out_dir / "failures.md", "w") as f:
        f.write(f"# R1 Failure Report\n\nGenerated: {datetime.now().isoformat()}\n\n")
        f.write(f"**Total interactions:** {total}  **PASS:** {passed}  **FAIL:** {failed}  **PARTIAL:** {partial}\n\n")
        if not failures:
            f.write("No failures or partial results. All interactions passed.\n")
        else:
            for ix, item in enumerate(failures, 1):
                anchor = f"sys{item.system}-{item.step_name[:20].replace(' ','_').lower()}"
                f.write(f"## {ix}. [{item.judge_verdict}] System {item.system} — {item.step_name}\n\n")
                f.write(f"**Approach:** {item.approach_key}  \n")
                f.write(f"**Duration:** {item.duration_seconds}s  \n")
                f.write(f"**Judge:** {item.judge_critique}  \n")
                if item.error:
                    f.write(f"**Error:**\n```\n{item.error[:500]}\n```\n")
                f.write(f"\n[View in report](report.html#{anchor})\n\n---\n\n")

    # ── report.html ──────────────────────────────────────────────────────────
    verdict_colors = {"PASS": "#22c55e", "FAIL": "#ef4444", "PARTIAL": "#f59e0b"}
    systems_html = {}
    for i in transcript:
        systems_html.setdefault(i.system, []).append(i)

    sections = ""
    for sys_num in sorted(systems_html.keys()):
        sys_name = SYSTEM_NAMES.get(sys_num, f"System {sys_num}")
        interactions = systems_html[sys_num]
        sys_pass = sum(1 for x in interactions if x.judge_verdict == "PASS")
        sys_fail = sum(1 for x in interactions if x.judge_verdict == "FAIL")
        sys_part = sum(1 for x in interactions if x.judge_verdict == "PARTIAL")

        cards = ""
        for item in interactions:
            anchor = f"sys{item.system}-{item.step_name[:20].replace(' ','_').lower()}"
            vc = verdict_colors.get(item.judge_verdict, "#94a3b8")
            ss_tag = (f'<img src="screenshots/{item.screenshot_path}" style="max-width:100%;border:1px solid #ddd;border-radius:6px;margin-top:8px;">'
                      if item.screenshot_path else "")
            err_block = (f'<details><summary style="color:#ef4444">Error trace</summary><pre style="font-size:11px">{item.error[:800]}</pre></details>'
                         if item.error else "")
            sse_block = (f'<p><strong>SSE events:</strong> {item.sse_events_observed}</p>' if item.sse_events_observed else "")
            cards += f"""
<div id="{anchor}" style="border:1px solid #e2e8f0;border-left:4px solid {vc};border-radius:8px;padding:16px;margin:16px 0;">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
    <span style="background:{vc};color:#fff;padding:2px 10px;border-radius:12px;font-size:13px;font-weight:700">{item.judge_verdict}</span>
    <strong style="font-size:15px">{item.step_name}</strong>
    <span style="color:#64748b;font-size:13px">{item.duration_seconds}s</span>
  </div>
  <p><strong>Approach:</strong> <code>{item.approach_key}</code> — {item.approach_description}</p>
  <p><strong>R1 reasoning:</strong> {item.r1_reasoning}</p>
  <p><strong>R1 input:</strong> <code style="white-space:pre-wrap;font-size:12px">{item.r1_input[:400]}</code></p>
  <details><summary><strong>App response</strong> ({len(item.app_response)} chars)</summary>
    <pre style="white-space:pre-wrap;font-size:12px;background:#f8fafc;padding:10px;border-radius:4px">{item.app_response[:2000]}</pre>
  </details>
  {sse_block}
  <p><strong>Judge:</strong> {item.judge_critique}</p>
  {err_block}
  {ss_tag}
</div>"""

        sections += f"""
<section style="margin-bottom:48px">
  <h2 style="font-size:22px;border-bottom:2px solid #e2e8f0;padding-bottom:8px">
    System {sys_num} — {sys_name}
    <span style="font-size:14px;font-weight:400;margin-left:16px;color:#64748b">
      ✓ {sys_pass} &nbsp; ✗ {sys_fail} &nbsp; ~ {sys_part}
    </span>
  </h2>
  {cards}
</section>"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>R1 EZHW Beta Test Report — {datetime.now().strftime('%Y-%m-%d %H:%M')}</title>
<style>
  body {{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:1100px;margin:0 auto;padding:24px;color:#1e293b;background:#f8fafc}}
  h1 {{font-size:28px;margin-bottom:4px}} h2 {{font-size:20px}} code {{font-family:monospace}}
  .stat {{display:inline-block;padding:8px 20px;border-radius:8px;margin:4px;font-size:18px;font-weight:700}}
</style>
</head>
<body>
<h1>R1 — EZHW Beta Test Report</h1>
<p style="color:#64748b">{datetime.now().strftime('%A, %B %d %Y at %H:%M:%S')}</p>
<div style="margin:20px 0">
  <span class="stat" style="background:#dcfce7;color:#166534">✓ PASS: {passed}</span>
  <span class="stat" style="background:#fee2e2;color:#991b1b">✗ FAIL: {failed}</span>
  <span class="stat" style="background:#fef3c7;color:#92400e">~ PARTIAL: {partial}</span>
  <span class="stat" style="background:#e2e8f0;color:#334155">TOTAL: {total}</span>
</div>
<p><a href="failures.md">failures.md</a> &nbsp;|&nbsp; <a href="transcript.jsonl">transcript.jsonl</a></p>
<hr>
{sections}
</body>
</html>"""

    with open(out_dir / "report.html", "w") as f:
        f.write(html)


# ═══════════════════════════════════════════════════════════════════
#  MAIN ORCHESTRATOR
# ═══════════════════════════════════════════════════════════════════

async def main():
    # Parse CLI args
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip", type=str, default="", help="Comma-separated system numbers to skip, e.g. 6,7")
    parser.add_argument("--headless", action="store_true", help="Run browser headlessly")
    parser.add_argument("--words", type=int, default=LONG_DOC_TARGET_WORDS, help="Long doc target word count")
    args = parser.parse_args()

    skip = set()
    if args.skip:
        skip = {int(x.strip()) for x in args.skip.split(",") if x.strip().isdigit()}
    skip.update(SKIP_SYSTEMS)

    global LONG_DOC_TARGET_WORDS, HEADLESS
    LONG_DOC_TARGET_WORDS = args.words
    if args.headless:
        HEADLESS = True

    # Setup output directory
    out = Path(OUTPUT_DIR)
    out.mkdir(parents=True, exist_ok=True)
    console_log_file = open(out / "console.log", "w")

    def log_both(msg):
        log(msg, console_log_file)

    log_both("=" * 60)
    log_both(f"R1 EZHW Beta Test — {datetime.now().isoformat()}")
    log_both(f"Target: {APP_URL}")
    log_both(f"Output: {out.resolve()}")
    log_both(f"Skip systems: {skip or 'none'}")
    log_both(f"Headless: {HEADLESS}")
    log_both("=" * 60)

    r = R1Runner(OUTPUT_DIR, console_log_file)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=HEADLESS, args=["--use-fake-ui-for-media-stream"])
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            permissions=["microphone"],
            ignore_https_errors=True,
        )
        await context.add_init_script(INIT_SCRIPT)

        # Network logging
        network_log_entries = []
        def on_request(req):
            if any(x in req.url for x in ["/api/", "assemblyai", "stripe", "paypal"]):
                network_log_entries.append({"type": "request", "url": req.url, "method": req.method, "ts": datetime.now().isoformat()})
        def on_response(resp):
            if any(x in resp.url for x in ["/api/", "assemblyai", "stripe", "paypal"]):
                network_log_entries.append({"type": "response", "url": resp.url, "status": resp.status, "ts": datetime.now().isoformat()})

        page = await context.new_page()
        page.on("request", on_request)
        page.on("response", on_response)
        page.on("pageerror", lambda e: log_both(f"  [PAGE ERROR] {e}"))

        # ── Verify app is up ─────────────────────────────────────────────────
        log_both("Checking app is reachable...")
        try:
            resp = await page.goto(APP_URL, wait_until="networkidle", timeout=30_000)
            if resp and resp.status >= 400:
                log_both(f"WARNING: App returned HTTP {resp.status}")
            else:
                log_both(f"App reachable. Checking for auto-login (JMK)...")
                await page.wait_for_timeout(2000)
                header_text = await page.evaluate("() => document.body.innerText")
                if "JMK" in header_text:
                    log_both("✓ JMK auto-login confirmed.")
                else:
                    log_both("WARNING: JMK not detected in header — auto-login may not have fired.")
        except Exception as e:
            log_both(f"ERROR: Cannot reach app at {APP_URL}: {e}")
            console_log_file.close()
            return

        # ── Run systems ──────────────────────────────────────────────────────
        system_runners = {
            1: lambda: test_system_1(r, page, context),
            2: lambda: test_system_2(r, page),
            3: lambda: test_system_3(r, page),
            4: lambda: test_system_4(r, page),
            5: lambda: test_system_5(r, page),
            6: lambda: test_system_6(r, page),
            7: lambda: test_system_7(r, page),
            8: lambda: test_system_8(r, page),
        }

        for sys_num in range(1, 9):
            if sys_num in skip:
                log_both(f"\nSkipping System {sys_num} — {SYSTEM_NAMES.get(sys_num, '')}")
                continue
            try:
                await system_runners[sys_num]()
            except Exception as e:
                log_both(f"\nFATAL ERROR in System {sys_num}: {e}\n{traceback.format_exc()}")

        await browser.close()

    # ── Write network log ────────────────────────────────────────────────────
    with open(out / "network.log", "w") as f:
        for entry in network_log_entries:
            f.write(json.dumps(entry) + "\n")

    # ── Write report ─────────────────────────────────────────────────────────
    log_both("\nWriting artifacts...")
    write_report(r.transcript, out)

    total   = len(r.transcript)
    passed  = sum(1 for i in r.transcript if i.judge_verdict == "PASS")
    failed  = sum(1 for i in r.transcript if i.judge_verdict == "FAIL")
    partial = sum(1 for i in r.transcript if i.judge_verdict == "PARTIAL")
    skipped = len(skip)

    log_both("\n" + "=" * 60)
    log_both(f"PASSED: {passed} / FAILED: {failed} / PARTIAL: {partial} / SYSTEMS SKIPPED: {skipped}")
    log_both(f"\nreport.html  → {(out / 'report.html').resolve()}")
    log_both(f"failures.md  → {(out / 'failures.md').resolve()}")
    log_both(f"transcript   → {(out / 'transcript.jsonl').resolve()}")
    log_both("=" * 60)

    console_log_file.close()
    print(f"\nfailures.md → {(out / 'failures.md').resolve()}")
    print(f"report.html → {(out / 'report.html').resolve()}")
    print(f"\nPASSED: {passed} / FAILED: {failed} / PARTIAL: {partial} / SKIPPED: {skipped}")


if __name__ == "__main__":
    asyncio.run(main())
