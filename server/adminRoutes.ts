import type { Express } from "express";
import { execSync } from "child_process";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const r1RunsDir = path.join(process.cwd(), "r1_tester", "runs");

// Ensure runs directory exists
if (!fs.existsSync(r1RunsDir)) fs.mkdirSync(r1RunsDir, { recursive: true });

// R1 process state — module-level so it persists across requests
const r1State = {
  running: false,
  pid: null as number | null,
  startedAt: null as string | null,
  outputLines: [] as string[],
  exitCode: null as number | null,
  lastRunDir: null as string | null,
};

export function registerAdminRoutes(app: Express) {
  // ── Static file serving for r1 run artifacts ──────────────────────
  app.use("/r1-runs", (req: any, res: any, next: any) => {
    const filePath = path.join(r1RunsDir, req.path);
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return res.sendFile(filePath);
      }
    } catch {}
    next();
  });

  // ── GET /api/admin/diagnostics ────────────────────────────────────
  app.get("/api/admin/diagnostics", async (req: any, res: any) => {
    const checks: Array<{ name: string; status: "ok" | "warn" | "fail"; detail: string }> = [];

    // 1. Database
    try {
      const { pool } = await import("./db");
      await pool.query("SELECT 1");
      checks.push({ name: "Database (PostgreSQL)", status: "ok", detail: "Connected — query returned successfully" });
    } catch (e: any) {
      checks.push({ name: "Database (PostgreSQL)", status: "fail", detail: e.message });
    }

    // 2. API keys
    const apiKeys = [
      { label: "Anthropic (Claude)", env: "ANTHROPIC_API_KEY", required: true },
      { label: "OpenAI (GPT-4o)", env: "OPENAI_API_KEY", required: true },
      { label: "DeepSeek", env: "DEEPSEEK_API_KEY", required: false },
      { label: "Grok / xAI", env: "XAI_API_KEY", required: false },
      { label: "Perplexity", env: "PERPLEXITY_API_KEY", required: false },
      { label: "AssemblyAI (Voice)", env: "ASSEMBLYAI_API_KEY", required: true },
      { label: "Venice AI", env: "VENICE_API_KEY", required: false },
      { label: "GPTZero (AI Detection)", env: "GPTZERO_API_KEY", required: false },
      { label: "Session Secret", env: "SESSION_SECRET", required: true },
    ];
    for (const k of apiKeys) {
      const val = process.env[k.env];
      if (val && val.length > 4) {
        checks.push({ name: `API Key: ${k.label}`, status: "ok", detail: `Set (${val.slice(0, 4)}***${val.slice(-3)})` });
      } else {
        checks.push({ name: `API Key: ${k.label}`, status: k.required ? "fail" : "warn", detail: "Not set or empty" });
      }
    }

    // 3. R1 script
    const r1Script = path.join(process.cwd(), "r1_tester", "run_r1.py");
    checks.push({
      name: "R1 Script (run_r1.py)",
      status: fs.existsSync(r1Script) ? "ok" : "fail",
      detail: fs.existsSync(r1Script) ? r1Script : "File not found",
    });

    // 4. Python
    try {
      const ver = execSync("python --version 2>&1", { timeout: 5000 }).toString().trim();
      checks.push({ name: "Python Runtime", status: "ok", detail: ver });
    } catch {
      checks.push({ name: "Python Runtime", status: "fail", detail: "python not found in PATH" });
    }

    // 5. Playwright / Chromium
    try {
      // Check both the home dir and the workspace dir (Replit installs here)
      const homeCacheDir = path.join(process.env.HOME || "/home/runner", ".cache", "ms-playwright");
      const wsCacheDir = path.join(process.cwd(), ".cache", "ms-playwright");
      const cacheDir = fs.existsSync(wsCacheDir) ? wsCacheDir : homeCacheDir;
      const hasChromium = fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).some((d) => d.startsWith("chromium"));
      checks.push({
        name: "Playwright Chromium",
        status: hasChromium ? "ok" : "warn",
        detail: hasChromium ? `Found in ${cacheDir}` : "Not found — run: python -m playwright install chromium",
      });
    } catch {
      checks.push({ name: "Playwright Chromium", status: "warn", detail: "Could not check" });
    }

    // 6. Philosopher API
    try {
      const https = await import("https");
      const { statusCode, detail: pingResult } = await new Promise<{ statusCode: number; detail: string }>((resolve, reject) => {
        const r = https.get("https://analyticphilosophy.net/", { timeout: 5000 }, (resp) =>
          resolve({ statusCode: resp.statusCode ?? 0, detail: `HTTP ${resp.statusCode}` })
        );
        r.on("error", (e) => reject(e));
        r.on("timeout", () => reject(new Error("timeout")));
      });
      const philStatus = statusCode >= 200 && statusCode < 400 ? "ok" : "warn";
      checks.push({ name: "Philosopher API (analyticphilosophy.net)", status: philStatus, detail: pingResult });
    } catch (e: any) {
      checks.push({ name: "Philosopher API (analyticphilosophy.net)", status: "warn", detail: `Unreachable: ${e.message}` });
    }

    // 7. Past runs count
    try {
      const runs = fs.existsSync(r1RunsDir) ? fs.readdirSync(r1RunsDir) : [];
      checks.push({ name: "R1 Past Runs", status: "ok", detail: `${runs.length} run(s) in r1_tester/runs/` });
    } catch {
      checks.push({ name: "R1 Past Runs", status: "warn", detail: "Could not read runs directory" });
    }

    res.json({ checks, timestamp: new Date().toISOString() });
  });

  // ── POST /api/admin/r1/start ──────────────────────────────────────
  app.post("/api/admin/r1/start", (req: any, res: any) => {
    if (r1State.running) {
      return res.status(409).json({ error: "R1 is already running", pid: r1State.pid });
    }

    const skip = (req.body?.skip || "").toString().trim();
    const words = parseInt(req.body?.words || "2000", 10);

    const args = ["r1_tester/run_r1.py", "--headless", "--words", String(words)];
    if (skip) args.push("--skip", skip);

    r1State.running = true;
    r1State.outputLines = [];
    r1State.exitCode = null;
    r1State.lastRunDir = null;
    r1State.startedAt = new Date().toISOString();

    const proc = spawn("python", args, { cwd: process.cwd(), env: { ...process.env } });
    r1State.pid = proc.pid || null;

    const onData = (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) r1State.outputLines.push(line);
      }
      if (r1State.outputLines.length > 500) r1State.outputLines = r1State.outputLines.slice(-500);
    };

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("close", (code) => {
      r1State.running = false;
      r1State.exitCode = code;
      r1State.pid = null;
      const match = r1State.outputLines.join("\n").match(/runs\/([\d_]+)\//);
      if (match) r1State.lastRunDir = match[1];
    });

    res.json({ started: true, pid: r1State.pid, skip, words });
  });

  // ── POST /api/admin/r1/stop ───────────────────────────────────────
  app.post("/api/admin/r1/stop", (req: any, res: any) => {
    if (!r1State.running || !r1State.pid) return res.json({ stopped: false, reason: "Not running" });
    try {
      process.kill(r1State.pid, "SIGTERM");
      r1State.running = false;
      res.json({ stopped: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/r1/status ──────────────────────────────────────
  app.get("/api/admin/r1/status", (req: any, res: any) => {
    res.json({
      running: r1State.running,
      pid: r1State.pid,
      startedAt: r1State.startedAt,
      exitCode: r1State.exitCode,
      lastRunDir: r1State.lastRunDir,
      lineCount: r1State.outputLines.length,
      recentLines: r1State.outputLines.slice(-30),
    });
  });

  // ── GET /api/admin/r1/stream (SSE) ────────────────────────────────
  app.get("/api/admin/r1/stream", (req: any, res: any) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let lastSent = 0;

    const send = () => {
      const newLines = r1State.outputLines.slice(lastSent);
      lastSent = r1State.outputLines.length;
      res.write(`data: ${JSON.stringify({ lines: newLines, running: r1State.running, exitCode: r1State.exitCode })}\n\n`);
    };

    send();
    const interval = setInterval(() => {
      send();
      if (!r1State.running && lastSent >= r1State.outputLines.length) {
        clearInterval(interval);
        res.end();
      }
    }, 800);

    req.on("close", () => clearInterval(interval));
  });

  // ── GET /api/admin/r1/runs ────────────────────────────────────────
  app.get("/api/admin/r1/runs", (req: any, res: any) => {
    try {
      if (!fs.existsSync(r1RunsDir)) return res.json([]);
      const runs = fs
        .readdirSync(r1RunsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const runPath = path.join(r1RunsDir, d.name);
          let files: string[] = [];
          try { files = fs.readdirSync(runPath); } catch {}
          const jsonl = files.find((f) => f.endsWith(".jsonl"));
          const stats = { interactions: 0, passed: 0, failed: 0, partial: 0 };
          if (jsonl) {
            try {
              const lines = fs.readFileSync(path.join(runPath, jsonl), "utf8").trim().split("\n").filter(Boolean);
              stats.interactions = lines.length;
              for (const line of lines) {
                try {
                  const obj = JSON.parse(line);
                  if (obj.judge_verdict === "PASS") stats.passed++;
                  else if (obj.judge_verdict === "FAIL") stats.failed++;
                  else if (obj.judge_verdict === "PARTIAL") stats.partial++;
                } catch {}
              }
            } catch {}
          }
          let screenshots = files.filter((f) => f.endsWith(".png")).length;
          try { screenshots += fs.readdirSync(path.join(runPath, "screenshots")).length; } catch {}
          return {
            name: d.name,
            hasReport: files.includes("report.html"),
            hasFailures: files.includes("failures.md"),
            hasTranscript: files.some((f) => f.endsWith(".jsonl")),
            screenshotCount: screenshots,
            ...stats,
          };
        })
        .sort((a, b) => b.name.localeCompare(a.name));
      res.json(runs);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/r1/runs/:name/failures ─────────────────────────
  app.get("/api/admin/r1/runs/:name/failures", (req: any, res: any) => {
    const filePath = path.join(r1RunsDir, req.params.name, "failures.md");
    if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(fs.readFileSync(filePath, "utf8"));
  });

  console.log("[ADMIN] Admin routes registered: /api/admin/diagnostics, /api/admin/r1/*, /r1-runs/*");
}
