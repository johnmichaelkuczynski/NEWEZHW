import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Plus, Trash2, ArrowLeft, Send, Brain, Copy, Download, FileText, ChevronRight, ChevronDown, MessageSquare, Zap, X, BookOpen, BarChart2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { MathRenderer } from "@/components/ui/math-renderer";
import { VoiceInput } from "@/components/ui/voice-input";

interface Project {
  id: number;
  name: string;
  description: string | null;
  tractatusTree: Record<string, string> | null;
  compressionCount: number;
  lastTreeUpdate: string | null;
  createdAt: string;
}

interface Session {
  id: number;
  projectId: number;
  title: string;
  messageCount: number;
  createdAt: string;
}

interface FullSession {
  id: number;
  projectId: number;
  title: string;
  transcript: Array<{ role: string; content: string; ts: string }>;
  createdAt: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  ts: string;
}

type ActiveTab = "chat" | "long-doc" | "memory";

export default function ProjectWorkspace() {
  const params = useParams<{ id: string }>();
  const projectId = parseInt(params.id || "0");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatting, setIsChatting] = useState(false);
  const [provider, setProvider] = useState("anthropic");
  const [activeTab, setActiveTab] = useState<ActiveTab>("chat");

  // Tractatus popup state
  const [tractatusPopupOpen, setTractatusPopupOpen] = useState(false);
  const [tractatusStream, setTractatusStream] = useState("");
  const [tractatusStatus, setTractatusStatus] = useState("");
  const [popupPos, setPopupPos] = useState({ x: 20, y: 80 });
  const isDragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  // Memory viewer state
  const [memoryExpanded, setMemoryExpanded] = useState(true);

  // Long document generator state
  const [docPrompt, setDocPrompt] = useState("");
  const [docTargetWords, setDocTargetWords] = useState("5000");
  const [isGeneratingDoc, setIsGeneratingDoc] = useState(false);
  const [docOutput, setDocOutput] = useState("");
  const [docStatus, setDocStatus] = useState("");
  const [docSections, setDocSections] = useState<Array<{ title: string; wordCount?: number }>>([]);
  const [docFinalWords, setDocFinalWords] = useState(0);

  const chatBottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Queries
  const projectQuery = useQuery<Project>({
    queryKey: ["/api/projects", projectId],
    queryFn: () => fetch(`/api/projects/${projectId}`).then((r) => {
      if (!r.ok) throw new Error("Project not found");
      return r.json();
    }).then((projects: Project[]) => {
      // The GET /api/projects returns all projects; find ours
      return projects.find((p) => p.id === projectId) as Project;
    }).catch(() => fetch(`/api/projects/${projectId}`).then(r => r.json())),
    retry: 1,
    enabled: !!projectId,
  });

  // Simpler project fetch
  const [project, setProject] = useState<Project | null>(null);
  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data: Project[]) => {
        const found = data.find((p) => p.id === projectId);
        if (found) setProject(found);
      })
      .catch(console.error);
  }, [projectId]);

  const sessionsQuery = useQuery<Session[]>({
    queryKey: ["/api/projects", projectId, "sessions"],
    queryFn: () => fetch(`/api/projects/${projectId}/sessions`).then((r) => r.json()),
    enabled: !!projectId,
  });

  const memoryQuery = useQuery({
    queryKey: ["/api/projects", projectId, "memory"],
    queryFn: () => fetch(`/api/projects/${projectId}/memory-hierarchy`).then((r) => r.json()),
    enabled: !!projectId && activeTab === "memory",
  });

  const createSessionMutation = useMutation({
    mutationFn: (title?: string) =>
      apiRequest("POST", `/api/projects/${projectId}/sessions`, { title }).then((r) => r.json()),
    onSuccess: (session: FullSession) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "sessions"] });
      loadSession(session.id);
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/project-sessions/${id}`).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "sessions"] });
      if (activeSessionId) {
        setActiveSessionId(null);
        setMessages([]);
      }
    },
  });

  const loadSession = useCallback(async (id: number) => {
    setActiveSessionId(id);
    try {
      const data: FullSession = await fetch(`/api/project-sessions/${id}`).then((r) => r.json());
      setMessages(data.transcript || []);
    } catch (err) {
      toast({ title: "Failed to load session", variant: "destructive" });
    }
  }, [toast]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isChatting]);

  // ---- CHAT ----
  const sendMessage = async () => {
    if (!chatInput.trim() || isChatting || !activeSessionId) return;

    const userMsg: ChatMessage = { role: "user", content: chatInput.trim(), ts: new Date().toISOString() };
    setMessages((prev) => [...prev, userMsg]);
    const msgText = chatInput.trim();
    setChatInput("");
    setIsChatting(true);
    setTractatusStream("");
    setTractatusStatus("Sending...");

    abortRef.current = new AbortController();

    try {
      const resp = await fetch(`/api/project-sessions/${activeSessionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msgText, provider }),
        signal: abortRef.current.signal,
      });

      if (!resp.ok || !resp.body) throw new Error("Stream failed");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";
      let assistantMsgAdded = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);
        const lines = text.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));

            if (event.type === "delta") {
              assistantContent += event.delta;
              if (!assistantMsgAdded) {
                setMessages((prev) => [...prev, { role: "assistant", content: assistantContent, ts: new Date().toISOString() }]);
                assistantMsgAdded = true;
              } else {
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = { ...updated[updated.length - 1], content: assistantContent };
                  return updated;
                });
              }
            } else if (event.type === "tractatus_updating") {
              setTractatusStatus("Updating memory tree...");
              setTractatusPopupOpen(true);
            } else if (event.type === "tractatus_delta") {
              setTractatusStream((prev) => prev + event.delta);
            } else if (event.type === "tractatus_complete") {
              setTractatusStatus(`Memory updated — ${event.nodeCount} nodes`);
              // Refresh project to show updated node count
              fetch("/api/projects").then(r => r.json()).then((data: Project[]) => {
                const found = data.find((p) => p.id === projectId);
                if (found) setProject(found);
              });
            } else if (event.type === "compression_start") {
              setTractatusStatus(`Compressing memory tree (${event.nodeCount} nodes)...`);
            } else if (event.type === "compression_complete") {
              setTractatusStatus(`Compressed: ${event.originalNodes} → ${event.summaryNodes} nodes (Tier ${event.tier})`);
            } else if (event.type === "response_complete") {
              queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "sessions"] });
            }
          } catch {}
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        toast({ title: "Chat error", description: err.message, variant: "destructive" });
      }
    } finally {
      setIsChatting(false);
    }
  };

  // ---- LONG DOCUMENT GENERATOR ----
  const generateDocument = async () => {
    if (!docPrompt.trim() || isGeneratingDoc) return;
    setIsGeneratingDoc(true);
    setDocOutput("");
    setDocStatus("Starting...");
    setDocSections([]);
    setDocFinalWords(0);

    try {
      const resp = await fetch("/api/long-document/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: docPrompt,
          targetWords: parseInt(docTargetWords) || 5000,
          provider,
          projectId: project?.id,
        }),
      });

      if (!resp.ok || !resp.body) throw new Error("Stream failed");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);
        const lines = text.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));

            if (event.type === "status") {
              setDocStatus(event.data);
            } else if (event.type === "outline_complete") {
              setDocStatus(`Outline ready — ${event.data.sections.length} sections`);
              setDocSections(event.data.sections.map((s: any) => ({ title: s.title, targetWords: s.targetWords })));
            } else if (event.type === "section_start") {
              setDocStatus(`Writing section ${event.data.index + 1}/${event.data.totalSections}: "${event.data.title}"...`);
            } else if (event.type === "section_delta") {
              setDocOutput((prev) => prev + event.data.delta);
            } else if (event.type === "section_complete") {
              setDocSections((prev) => {
                const updated = [...prev];
                if (updated[event.data.index]) {
                  updated[event.data.index] = { ...updated[event.data.index], wordCount: event.data.wordCount };
                }
                return updated;
              });
              setDocStatus(`Sections complete: ${event.data.totalSoFar.toLocaleString()} words so far`);
            } else if (event.type === "stitch_delta") {
              // Stitch repairs are applied to the full output
              setDocStatus("Applying coherence repairs...");
            } else if (event.type === "complete") {
              setDocOutput(event.data.content);
              setDocFinalWords(event.data.totalWords);
              setDocStatus(`Complete: ${event.data.totalWords.toLocaleString()} words`);
              if (project) {
                fetch("/api/projects").then(r => r.json()).then((data: Project[]) => {
                  const found = data.find((p) => p.id === projectId);
                  if (found) setProject(found);
                });
              }
            } else if (event.type === "error") {
              throw new Error(event.data);
            }
          } catch {}
        }
      }
    } catch (err: any) {
      toast({ title: "Generation failed", description: err.message, variant: "destructive" });
      setDocStatus("Failed — " + err.message);
    } finally {
      setIsGeneratingDoc(false);
    }
  };

  // ---- DRAGGABLE POPUP ----
  const startDrag = (e: React.MouseEvent) => {
    isDragging.current = true;
    dragOffset.current = { x: e.clientX - popupPos.x, y: e.clientY - popupPos.y };
    const onMove = (ev: MouseEvent) => {
      if (isDragging.current) setPopupPos({ x: ev.clientX - dragOffset.current.x, y: ev.clientY - dragOffset.current.y });
    };
    const onUp = () => { isDragging.current = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const sessions = sessionsQuery.data || [];

  const getTagColor = (value: string) => {
    if (value.startsWith("ASSERTS")) return "text-green-700 bg-green-50 border-green-200";
    if (value.startsWith("REJECTS")) return "text-red-700 bg-red-50 border-red-200";
    if (value.startsWith("OPEN")) return "text-purple-700 bg-purple-50 border-purple-200";
    if (value.startsWith("RESOLVED")) return "text-blue-700 bg-blue-50 border-blue-200";
    if (value.startsWith("ASSUMES")) return "text-amber-700 bg-amber-50 border-amber-200";
    if (value.startsWith("DOCUMENT")) return "text-indigo-700 bg-indigo-50 border-indigo-200";
    if (value.startsWith("QUESTION")) return "text-pink-700 bg-pink-50 border-pink-200";
    return "text-slate-700 bg-slate-50 border-slate-200";
  };

  const nodeCount = project ? Object.keys(project.tractatusTree || {}).length : 0;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 shadow-sm flex-shrink-0">
        <div className="max-w-full px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/projects">
              <Button variant="ghost" size="sm" className="text-slate-600">
                <ArrowLeft className="w-4 h-4 mr-1" />
                Projects
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <Brain className="w-5 h-5 text-indigo-600" />
              <div>
                <h1 className="text-lg font-bold text-slate-900">{project?.name || "Loading..."}</h1>
                {project?.description && (
                  <p className="text-xs text-slate-500 truncate max-w-xs">{project.description}</p>
                )}
              </div>
              {nodeCount > 0 && (
                <Badge className="bg-indigo-100 text-indigo-700 text-xs ml-1">
                  🧠 {nodeCount} nodes
                </Badge>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Tab nav */}
            <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
              <Button size="sm" variant={activeTab === "chat" ? "default" : "ghost"} onClick={() => setActiveTab("chat")} className="text-xs h-7">
                <MessageSquare className="w-3.5 h-3.5 mr-1" /> Chat
              </Button>
              <Button size="sm" variant={activeTab === "long-doc" ? "default" : "ghost"} onClick={() => setActiveTab("long-doc")} className="text-xs h-7">
                <FileText className="w-3.5 h-3.5 mr-1" /> Long Doc
              </Button>
              <Button size="sm" variant={activeTab === "memory" ? "default" : "ghost"} onClick={() => setActiveTab("memory")} className="text-xs h-7">
                <Brain className="w-3.5 h-3.5 mr-1" /> Memory
              </Button>
            </div>

            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger className="w-32 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anthropic">ZHI 1 (Claude)</SelectItem>
                <SelectItem value="openai">ZHI 2 (GPT-4o)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>

      {/* Main layout */}
      <div className="flex flex-1 overflow-hidden">

        {/* ---- CHAT TAB ---- */}
        {activeTab === "chat" && (
          <>
            {/* Session list sidebar */}
            <div className="w-56 flex-shrink-0 bg-white border-r border-slate-200 flex flex-col">
              <div className="p-3 border-b border-slate-100 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Sessions</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-slate-400 hover:text-indigo-600"
                  onClick={() => createSessionMutation.mutate()}
                  disabled={createSessionMutation.isPending}
                >
                  {createSessionMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                </Button>
              </div>

              <div className="flex-1 overflow-y-auto">
                {sessions.length === 0 ? (
                  <div className="p-4 text-center">
                    <p className="text-xs text-slate-400 mb-2">No sessions yet</p>
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => createSessionMutation.mutate()}>
                      <Plus className="w-3 h-3 mr-1" /> Start chatting
                    </Button>
                  </div>
                ) : (
                  sessions.map((session) => (
                    <div
                      key={session.id}
                      className={`group px-3 py-2.5 cursor-pointer border-b border-slate-50 hover:bg-slate-50 flex items-start justify-between ${activeSessionId === session.id ? "bg-indigo-50 border-l-2 border-l-indigo-500" : ""}`}
                      onClick={() => loadSession(session.id)}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-slate-800 truncate">{session.title}</p>
                        <p className="text-xs text-slate-400">{session.messageCount} msgs</p>
                      </div>
                      <button
                        className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-red-500 flex-shrink-0 ml-1"
                        onClick={(e) => { e.stopPropagation(); deleteSessionMutation.mutate(session.id); }}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Chat area */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {!activeSessionId ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    <MessageSquare className="w-12 h-12 text-slate-200 mx-auto mb-3" />
                    <h3 className="text-base font-semibold text-slate-500">Select or create a session</h3>
                    <p className="text-sm text-slate-400 mt-1 mb-4 max-w-xs">Each session adds to the project's shared memory tree.</p>
                    <Button onClick={() => createSessionMutation.mutate()} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                      <Plus className="w-4 h-4 mr-2" /> New Session
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Messages */}
                  <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {messages.length === 0 && (
                      <div className="text-center py-8">
                        <Brain className="w-10 h-10 text-indigo-200 mx-auto mb-3" />
                        <p className="text-sm text-slate-400">The AI has full memory of this project. Ask anything.</p>
                        {nodeCount > 0 && (
                          <p className="text-xs text-indigo-400 mt-1">🧠 {nodeCount} memory nodes available</p>
                        )}
                      </div>
                    )}
                    {messages.map((msg, i) => (
                      <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-2xl rounded-lg px-4 py-3 text-sm ${msg.role === "user" ? "bg-indigo-600 text-white" : "bg-white border border-slate-200 text-slate-800 shadow-sm"}`}>
                          {msg.role === "assistant" ? (
                            <MathRenderer content={msg.content} />
                          ) : (
                            <p className="whitespace-pre-wrap">{msg.content}</p>
                          )}
                          {msg.role === "assistant" && (
                            <div className="mt-2 flex gap-2 justify-end">
                              <Button size="sm" variant="ghost" className="h-6 text-xs text-slate-400 hover:text-slate-700 px-2"
                                onClick={() => { navigator.clipboard.writeText(msg.content); toast({ title: "Copied" }); }}>
                                <Copy className="w-3 h-3 mr-1" /> Copy
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {isChatting && messages[messages.length - 1]?.role !== "assistant" && (
                      <div className="flex justify-start">
                        <div className="bg-white border border-slate-200 rounded-lg px-4 py-3 shadow-sm">
                          <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                        </div>
                      </div>
                    )}
                    <div ref={chatBottomRef} />
                  </div>

                  {/* Input */}
                  <div className="flex-shrink-0 p-3 border-t border-slate-200 bg-white">
                    {tractatusStatus && (
                      <div className="mb-2 text-xs text-indigo-600 flex items-center gap-1.5">
                        <Brain className="w-3 h-3" />
                        {tractatusStatus}
                      </div>
                    )}
                    <div className="flex gap-2 items-end">
                      <div className="flex-1 relative">
                        <Textarea
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                              e.preventDefault();
                              sendMessage();
                            }
                          }}
                          placeholder="Message this project... (Ctrl+Enter to send)"
                          className="min-h-[70px] resize-none text-sm pr-10"
                          disabled={isChatting}
                        />
                        <div className="absolute right-2 top-2">
                          <VoiceInput
                            size="sm"
                            onTranscript={(text) => setChatInput(prev => prev ? prev + ' ' + text : text)}
                            onInterim={(interim) => {
                              if (interim) setChatInput(prev => prev + (prev ? ' ' : '') + interim);
                            }}
                          />
                        </div>
                      </div>
                      <Button
                        onClick={sendMessage}
                        disabled={isChatting || !chatInput.trim()}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white"
                      >
                        {isChatting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* ---- LONG DOC TAB ---- */}
        {activeTab === "long-doc" && (
          <div className="flex-1 flex overflow-hidden">
            {/* Controls */}
            <div className="w-72 flex-shrink-0 bg-white border-r border-slate-200 p-4 overflow-y-auto">
              <h2 className="font-semibold text-slate-800 mb-1">Long Document Generator</h2>
              <p className="text-xs text-slate-500 mb-4">Generate coherent documents up to 50,000 words using a 3-pass architecture: Outline → Section writing → Global stitch.</p>

              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-slate-700 mb-1 block">Task / Prompt *</label>
                  <Textarea
                    value={docPrompt}
                    onChange={(e) => setDocPrompt(e.target.value)}
                    placeholder="E.g. Write a comprehensive 10,000-word analysis of Kant's Critique of Pure Reason focusing on the Transcendental Aesthetic..."
                    className="min-h-[120px] resize-none text-sm"
                    disabled={isGeneratingDoc}
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-slate-700 mb-1 block">Target Word Count</label>
                  <Select value={docTargetWords} onValueChange={setDocTargetWords} disabled={isGeneratingDoc}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="2000">2,000 words</SelectItem>
                      <SelectItem value="5000">5,000 words</SelectItem>
                      <SelectItem value="10000">10,000 words</SelectItem>
                      <SelectItem value="15000">15,000 words</SelectItem>
                      <SelectItem value="20000">20,000 words</SelectItem>
                      <SelectItem value="30000">30,000 words</SelectItem>
                      <SelectItem value="50000">50,000 words</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-400 mt-1">Larger targets = more time. 50K words takes ~15-20 min.</p>
                </div>

                <div>
                  <label className="text-xs font-medium text-slate-700 mb-1 block">AI Model</label>
                  <Select value={provider} onValueChange={setProvider} disabled={isGeneratingDoc}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="anthropic">ZHI 1 (Claude — recommended)</SelectItem>
                      <SelectItem value="openai">ZHI 2 (GPT-4o)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Button
                  onClick={generateDocument}
                  disabled={isGeneratingDoc || !docPrompt.trim()}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
                >
                  {isGeneratingDoc ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating...</>
                  ) : (
                    <><Zap className="w-4 h-4 mr-2" /> Generate Document</>
                  )}
                </Button>

                {docStatus && (
                  <div className="p-2 bg-indigo-50 border border-indigo-200 rounded text-xs text-indigo-700">
                    {docStatus}
                  </div>
                )}

                {/* Section progress */}
                {docSections.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-slate-600 mb-2">Sections</p>
                    <div className="space-y-1">
                      {docSections.map((s, i) => (
                        <div key={i} className="flex items-center justify-between text-xs p-1.5 bg-slate-50 rounded">
                          <span className="text-slate-700 truncate flex-1">{s.title}</span>
                          {s.wordCount && (
                            <span className="text-green-600 font-medium ml-2 flex-shrink-0">{s.wordCount.toLocaleString()}w</span>
                          )}
                        </div>
                      ))}
                    </div>
                    {docFinalWords > 0 && (
                      <div className="mt-2 text-xs font-semibold text-indigo-700">
                        Total: {docFinalWords.toLocaleString()} words
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Document output */}
            <div className="flex-1 flex flex-col overflow-hidden bg-white">
              {docOutput ? (
                <>
                  <div className="flex-shrink-0 p-3 border-b border-slate-200 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-indigo-600" />
                      <span className="text-sm font-semibold text-slate-800">Generated Document</span>
                      {docFinalWords > 0 && (
                        <Badge className="bg-green-100 text-green-700 text-xs">{docFinalWords.toLocaleString()} words</Badge>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className="text-xs h-7"
                        onClick={() => { navigator.clipboard.writeText(docOutput); toast({ title: "Copied to clipboard" }); }}>
                        <Copy className="w-3 h-3 mr-1" /> Copy All
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs h-7"
                        onClick={() => {
                          const blob = new Blob([docOutput], { type: "text/plain" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `document-${Date.now()}.txt`;
                          a.click();
                        }}>
                        <Download className="w-3 h-3 mr-1" /> Download
                      </Button>
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto p-6">
                    <MathRenderer content={docOutput} />
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center max-w-sm">
                    <FileText className="w-12 h-12 text-slate-200 mx-auto mb-3" />
                    <h3 className="text-base font-semibold text-slate-500">Your document appears here</h3>
                    <p className="text-sm text-slate-400 mt-1">
                      Content streams section-by-section as it's generated. The outline appears first, then each section, then a final coherence repair pass.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ---- MEMORY TAB ---- */}
        {activeTab === "memory" && (
          <div className="flex-1 overflow-y-auto p-6 max-w-4xl mx-auto w-full">
            <div className="mb-6">
              <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <Brain className="w-5 h-5 text-indigo-600" />
                Tractatus Tree Memory Hierarchy
              </h2>
              <p className="text-sm text-slate-500 mt-1">
                Every chat exchange is automatically summarised into this tree. Tier 1 is high-resolution recent memory. Higher tiers are compressed archives of older sessions. The AI reads this entire structure on every response.
              </p>
            </div>

            {memoryQuery.isLoading ? (
              <div className="flex items-center gap-2 text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading memory hierarchy...
              </div>
            ) : memoryQuery.data ? (
              <div className="space-y-6">
                {memoryQuery.data.tiers?.map((tier: any) => (
                  <Card key={tier.tier} className="p-5">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-semibold text-slate-800">
                        Tier {tier.tier} — {tier.label}
                      </h3>
                      <Badge variant="outline" className="text-xs">{tier.nodeCount} nodes</Badge>
                    </div>
                    <div className="space-y-1.5">
                      {tier.compactString.split("\n").map((line: string, i: number) => {
                        const colonIdx = line.indexOf(": ");
                        if (colonIdx === -1) return <p key={i} className="text-xs text-slate-500">{line}</p>;
                        const key = line.substring(0, colonIdx);
                        const value = line.substring(colonIdx + 2);
                        return (
                          <div key={i} className="flex items-start gap-2">
                            <span className="text-xs font-mono text-slate-400 flex-shrink-0 mt-0.5 w-10">{key}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded border flex-1 ${getTagColor(value)}`}>{value}</span>
                          </div>
                        );
                      })}
                    </div>
                  </Card>
                ))}

                {memoryQuery.data.tiers?.length === 0 && (
                  <div className="text-center py-10">
                    <Brain className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                    <p className="text-slate-400">No memory nodes yet. Chat to start building the tree.</p>
                  </div>
                )}

                {memoryQuery.data.archives?.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-slate-700 mb-2 flex items-center gap-2">
                      <BookOpen className="w-4 h-4" /> Compression Archives
                    </h3>
                    <div className="space-y-1">
                      {memoryQuery.data.archives.map((a: any, i: number) => (
                        <div key={i} className="flex items-center justify-between text-xs p-2 bg-slate-50 rounded border border-slate-200">
                          <span className="text-slate-600">Tier {a.tier} snapshot</span>
                          <span className="text-slate-400">{a.nodeCount} nodes — {new Date(a.createdAt).toLocaleDateString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-slate-400 text-sm">No memory data available.</p>
            )}
          </div>
        )}
      </div>

      {/* Tractatus Update Popup (draggable) */}
      {tractatusPopupOpen && (
        <div
          style={{ position: "fixed", left: popupPos.x, top: popupPos.y, zIndex: 9999, width: 340, maxHeight: 320 }}
          className="bg-green-900 text-green-100 rounded-xl shadow-2xl border border-green-700 overflow-hidden"
        >
          <div
            className="flex items-center justify-between px-3 py-2 bg-green-800 cursor-move select-none"
            onMouseDown={startDrag}
          >
            <div className="flex items-center gap-2 text-xs font-semibold">
              <Brain className="w-3.5 h-3.5" />
              Memory Tree Updating...
            </div>
            <button onClick={() => setTractatusPopupOpen(false)} className="text-green-300 hover:text-white">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="p-3 overflow-y-auto" style={{ maxHeight: 260 }}>
            {tractatusStatus && <p className="text-xs text-green-300 mb-2">{tractatusStatus}</p>}
            {tractatusStream && (
              <pre className="text-xs font-mono whitespace-pre-wrap text-green-100">{tractatusStream}</pre>
            )}
            {!tractatusStream && <p className="text-xs text-green-400">Waiting for LLM...</p>}
          </div>
        </div>
      )}
    </div>
  );
}
