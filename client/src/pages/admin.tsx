import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle, XCircle, AlertCircle, RefreshCw, Play, Square,
  FileText, Image, ChevronLeft, ExternalLink, Terminal, Activity,
  Database, Cpu
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────
interface DiagCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}
interface R1Run {
  name: string;
  hasReport: boolean;
  hasFailures: boolean;
  hasTranscript: boolean;
  screenshotCount: number;
  interactions: number;
  passed: number;
  failed: number;
  partial: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function StatusIcon({ status }: { status: string }) {
  if (status === "ok") return <CheckCircle className="w-4 h-4 text-green-600 shrink-0" />;
  if (status === "warn") return <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />;
  return <XCircle className="w-4 h-4 text-red-600 shrink-0" />;
}

function statusColor(status: string) {
  if (status === "ok") return "bg-green-50 border-green-200";
  if (status === "warn") return "bg-amber-50 border-amber-200";
  return "bg-red-50 border-red-200";
}

function formatRunName(name: string) {
  // "20260516_143022" → "2026-05-16  14:30:22"
  const m = name.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
  if (!m) return name;
  return `${m[1]}-${m[2]}-${m[3]}  ${m[4]}:${m[5]}:${m[6]}`;
}

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN PAGE
// ════════════════════════════════════════════════════════════════════════════
export default function AdminPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // ── Diagnostics state ───────────────────────────────────────────────
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagChecks, setDiagChecks] = useState<DiagCheck[]>([]);
  const [diagTimestamp, setDiagTimestamp] = useState("");

  // ── R1 state ────────────────────────────────────────────────────────
  const [r1Running, setR1Running] = useState(false);
  const [r1ExitCode, setR1ExitCode] = useState<number | null>(null);
  const [r1Lines, setR1Lines] = useState<string[]>([]);
  const [r1Skip, setR1Skip] = useState("");
  const [r1Words, setR1Words] = useState("2000");
  const [streamActive, setStreamActive] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // ── Runs state ──────────────────────────────────────────────────────
  const [runs, setRuns] = useState<R1Run[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  // ── Auto-scroll console ─────────────────────────────────────────────
  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [r1Lines]);

  // ── Poll R1 status on mount ──────────────────────────────────────────
  useEffect(() => {
    checkR1Status();
    loadRuns();
  }, []);

  // ── Diagnostics ──────────────────────────────────────────────────────
  async function runDiagnostics() {
    setDiagLoading(true);
    setDiagChecks([]);
    try {
      const resp = await fetch("/api/admin/diagnostics");
      const data = await resp.json();
      setDiagChecks(data.checks || []);
      setDiagTimestamp(data.timestamp || "");
    } catch (e) {
      toast({ title: "Diagnostics failed", description: String(e), variant: "destructive" });
    } finally {
      setDiagLoading(false);
    }
  }

  // ── R1 controls ──────────────────────────────────────────────────────
  async function checkR1Status() {
    try {
      const resp = await fetch("/api/admin/r1/status");
      const data = await resp.json();
      setR1Running(data.running);
      setR1ExitCode(data.exitCode);
      if (data.recentLines?.length) setR1Lines(data.recentLines);
      if (data.running) startStream();
    } catch {}
  }

  function startStream() {
    if (eventSourceRef.current) eventSourceRef.current.close();
    setStreamActive(true);
    const es = new EventSource("/api/admin/r1/stream");
    eventSourceRef.current = es;
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.lines?.length) {
        setR1Lines(prev => [...prev, ...data.lines].slice(-500));
      }
      setR1Running(data.running);
      setR1ExitCode(data.exitCode ?? null);
      if (!data.running) {
        es.close();
        setStreamActive(false);
        loadRuns();
      }
    };
    es.onerror = () => {
      es.close();
      setStreamActive(false);
    };
  }

  async function startR1() {
    setR1Lines([]);
    setR1ExitCode(null);
    try {
      const resp = await fetch("/api/admin/r1/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skip: r1Skip, words: parseInt(r1Words) }),
      });
      const data = await resp.json();
      if (data.error) {
        toast({ title: "Cannot start R1", description: data.error, variant: "destructive" });
        return;
      }
      setR1Running(true);
      toast({ title: "R1 started", description: `PID ${data.pid} — browser running headlessly` });
      startStream();
    } catch (e) {
      toast({ title: "Failed to start R1", description: String(e), variant: "destructive" });
    }
  }

  async function stopR1() {
    await fetch("/api/admin/r1/stop", { method: "POST" });
    setR1Running(false);
    if (eventSourceRef.current) eventSourceRef.current.close();
    toast({ title: "R1 stop signal sent" });
  }

  // ── Runs ─────────────────────────────────────────────────────────────
  async function loadRuns() {
    setRunsLoading(true);
    try {
      const resp = await fetch("/api/admin/r1/runs");
      setRuns(await resp.json());
    } catch {}
    setRunsLoading(false);
  }

  // ── Render ────────────────────────────────────────────────────────────
  const okCount = diagChecks.filter(c => c.status === "ok").length;
  const failCount = diagChecks.filter(c => c.status === "fail").length;
  const warnCount = diagChecks.filter(c => c.status === "warn").length;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-4">
        <button
          onClick={() => setLocation("/")}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" /> Back
        </button>
        <div className="h-5 w-px bg-gray-200" />
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <Cpu className="w-5 h-5 text-slate-600" />
          Admin Dashboard
        </h1>
        {r1Running && (
          <Badge className="bg-green-100 text-green-800 animate-pulse ml-auto">
            ● R1 running
          </Badge>
        )}
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <Tabs defaultValue="diagnostics">
          <TabsList className="mb-6">
            <TabsTrigger value="diagnostics" className="flex items-center gap-2">
              <Activity className="w-4 h-4" /> Diagnostics
            </TabsTrigger>
            <TabsTrigger value="r1" className="flex items-center gap-2">
              <Terminal className="w-4 h-4" /> Synthetic User (R1)
            </TabsTrigger>
            <TabsTrigger value="runs" className="flex items-center gap-2">
              <FileText className="w-4 h-4" /> Past Runs
              {runs.length > 0 && (
                <Badge variant="secondary" className="ml-1">{runs.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {/* ═══ DIAGNOSTICS TAB ═══════════════════════════════════════ */}
          <TabsContent value="diagnostics">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-4">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Database className="w-5 h-5" /> System Health Check
                  </CardTitle>
                  {diagTimestamp && (
                    <p className="text-xs text-gray-500 mt-1">
                      Last run: {new Date(diagTimestamp).toLocaleTimeString()}
                    </p>
                  )}
                </div>
                <Button onClick={runDiagnostics} disabled={diagLoading} className="gap-2">
                  <RefreshCw className={`w-4 h-4 ${diagLoading ? "animate-spin" : ""}`} />
                  {diagLoading ? "Checking…" : "Run Diagnostics"}
                </Button>
              </CardHeader>
              <CardContent>
                {diagChecks.length === 0 && !diagLoading && (
                  <div className="text-center py-12 text-gray-400">
                    <Activity className="w-10 h-10 mx-auto mb-3 opacity-40" />
                    <p>Click "Run Diagnostics" to check all systems.</p>
                  </div>
                )}
                {diagChecks.length > 0 && (
                  <>
                    <div className="flex gap-4 mb-5 text-sm font-medium">
                      <span className="text-green-700">✓ {okCount} OK</span>
                      {warnCount > 0 && <span className="text-amber-600">⚠ {warnCount} warnings</span>}
                      {failCount > 0 && <span className="text-red-700">✗ {failCount} failed</span>}
                    </div>
                    <div className="space-y-2">
                      {diagChecks.map((c, i) => (
                        <div key={i} className={`flex items-start gap-3 px-4 py-3 rounded-lg border ${statusColor(c.status)}`}>
                          <StatusIcon status={c.status} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800">{c.name}</p>
                            <p className="text-xs text-gray-500 mt-0.5 truncate">{c.detail}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ═══ R1 TAB ════════════════════════════════════════════════ */}
          <TabsContent value="r1">
            <div className="space-y-4">
              {/* Controls card */}
              <Card>
                <CardHeader className="pb-4">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Terminal className="w-5 h-5" /> R1 Synthetic User
                  </CardTitle>
                  <p className="text-sm text-gray-500 mt-1">
                    Runs a headless browser that exercises all 8 EZHW systems, then produces a report, a failure log, and screenshots.
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-4 items-end mb-5">
                    {/* Skip systems */}
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Skip systems</label>
                      <Select value={r1Skip || "none"} onValueChange={v => setR1Skip(v === "none" ? "" : v)} disabled={r1Running}>
                        <SelectTrigger className="w-48">
                          <SelectValue placeholder="None (run all)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None — run all 8</SelectItem>
                          <SelectItem value="6,7">Skip 6+7 (payment, voice)</SelectItem>
                          <SelectItem value="4,5,6,7">Skip 4-7 (fast mode)</SelectItem>
                          <SelectItem value="6">Skip 6 (payment only)</SelectItem>
                          <SelectItem value="7">Skip 7 (voice only)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Word count */}
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Long-doc target words</label>
                      <Select value={r1Words} onValueChange={setR1Words} disabled={r1Running}>
                        <SelectTrigger className="w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="2000">2,000 (fast)</SelectItem>
                          <SelectItem value="5000">5,000</SelectItem>
                          <SelectItem value="10000">10,000</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Start / Stop */}
                    <div className="flex gap-2 ml-auto">
                      {!r1Running ? (
                        <Button onClick={startR1} className="gap-2 bg-green-600 hover:bg-green-700 text-white px-6">
                          <Play className="w-4 h-4" /> Start R1
                        </Button>
                      ) : (
                        <Button onClick={stopR1} variant="destructive" className="gap-2 px-6">
                          <Square className="w-4 h-4" /> Stop R1
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Status bar */}
                  {(r1Running || r1ExitCode !== null || r1Lines.length > 0) && (
                    <div className="flex items-center gap-3 mb-3 text-sm">
                      {r1Running ? (
                        <Badge className="bg-green-100 text-green-800 gap-1">
                          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse inline-block" />
                          Running — {r1Lines.length} lines captured
                        </Badge>
                      ) : r1ExitCode !== null ? (
                        <Badge className={r1ExitCode === 0 ? "bg-blue-100 text-blue-800" : "bg-red-100 text-red-800"}>
                          {r1ExitCode === 0 ? "✓ Completed" : `✗ Exited with code ${r1ExitCode}`}
                        </Badge>
                      ) : null}
                      {!streamActive && r1Lines.length > 0 && (
                        <button onClick={checkR1Status} className="text-xs text-gray-400 hover:text-gray-600">
                          refresh
                        </button>
                      )}
                    </div>
                  )}

                  {/* Console output */}
                  {r1Lines.length > 0 && (
                    <div
                      ref={consoleRef}
                      className="bg-gray-950 text-green-400 font-mono text-xs rounded-lg p-4 h-80 overflow-y-auto leading-relaxed"
                    >
                      {r1Lines.map((line, i) => {
                        let color = "text-green-400";
                        if (line.includes("FAIL") || line.includes("ERROR") || line.includes("✗"))
                          color = "text-red-400";
                        else if (line.includes("PASS") || line.includes("✓"))
                          color = "text-emerald-300";
                        else if (line.includes("Judge:") || line.includes("approach:"))
                          color = "text-blue-300";
                        else if (line.includes("PARTIAL") || line.includes("~"))
                          color = "text-yellow-400";
                        else if (line.startsWith("[") && line.includes("]"))
                          color = "text-gray-400";
                        return (
                          <div key={i} className={color}>
                            {line}
                          </div>
                        );
                      })}
                      {r1Running && (
                        <div className="text-gray-500 animate-pulse">█</div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* What R1 tests */}
              <Card className="border-dashed">
                <CardContent className="pt-5">
                  <p className="text-sm font-medium text-gray-700 mb-3">What R1 tests in one run:</p>
                  <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
                    {[
                      ["1", "Homework Assistant", "All 5 providers, coherence, file upload, chat, save, PDF, AI detect"],
                      ["2", "Grading Assistant", "Full grade cycle, adjustments, Generate Perfect"],
                      ["3", "Long-Term Projects", "Create, 3 chats, memory tab, rename, second session"],
                      ["4", "Long Doc Generator", "Outline → sections → stitch, word count check"],
                      ["5", "Coherence Mode", "SSE event verification (skeleton/chunk/stitch events)"],
                      ["6", "Payment System", "Dialog UI check — no real charges"],
                      ["7", "Voice Dictation", "Mic button, AssemblyAI token request verification"],
                      ["8", "Philosopher DB", "Kill-switch: non-philosophy prompt should not get quotes"],
                    ].map(([num, name, desc]) => (
                      <div key={num} className="flex gap-2">
                        <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">{num}</span>
                        <div>
                          <span className="font-medium text-gray-700">{name}</span>
                          <br />{desc}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ═══ PAST RUNS TAB ═════════════════════════════════════════ */}
          <TabsContent value="runs">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-4">
                <CardTitle className="text-lg">Past R1 Runs</CardTitle>
                <Button variant="outline" size="sm" onClick={loadRuns} disabled={runsLoading} className="gap-2">
                  <RefreshCw className={`w-3.5 h-3.5 ${runsLoading ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              </CardHeader>
              <CardContent>
                {runs.length === 0 && !runsLoading && (
                  <div className="text-center py-12 text-gray-400">
                    <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
                    <p>No runs yet. Start R1 to generate your first report.</p>
                  </div>
                )}
                {runs.length > 0 && (
                  <div className="space-y-3">
                    {runs.map((run) => (
                      <div key={run.name} className="border border-gray-200 rounded-xl p-4 hover:border-gray-300 transition-colors">
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <p className="font-mono text-sm font-semibold text-gray-800">{formatRunName(run.name)}</p>
                            <p className="text-xs text-gray-500 mt-0.5">
                              {run.interactions} interactions · {run.screenshotCount} screenshots
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            {run.interactions > 0 && (
                              <>
                                <Badge className="bg-green-100 text-green-800 text-xs">✓ {run.passed}</Badge>
                                {run.partial > 0 && <Badge className="bg-amber-100 text-amber-800 text-xs">~ {run.partial}</Badge>}
                                {run.failed > 0 && <Badge className="bg-red-100 text-red-800 text-xs">✗ {run.failed}</Badge>}
                              </>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {run.hasReport && (
                            <a
                              href={`/r1-runs/${run.name}/report.html`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors font-medium"
                            >
                              <ExternalLink className="w-3 h-3" /> Full Report
                            </a>
                          )}
                          {run.hasFailures && (
                            <a
                              href={`/api/admin/r1/runs/${run.name}/failures`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 transition-colors font-medium"
                            >
                              <XCircle className="w-3 h-3" /> Failures
                            </a>
                          )}
                          {run.hasTranscript && (
                            <a
                              href={`/r1-runs/${run.name}/transcript.jsonl`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                            >
                              <FileText className="w-3 h-3" /> Transcript
                            </a>
                          )}
                          {run.screenshotCount > 0 && (
                            <a
                              href={`/r1-runs/${run.name}/screenshots/`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                            >
                              <Image className="w-3 h-3" /> {run.screenshotCount} screenshots
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
