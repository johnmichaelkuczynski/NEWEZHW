import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Loader2, ChevronDown, ChevronRight, Upload, FileText, RotateCcw, Copy, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface OutlineSection {
  id: string;
  title: string;
  description: string;
  estimatedWords: number;
  mandatoryElements: string[];
  format?: string;
}

interface StrictOutline {
  taskSummary: string;
  totalEstimatedWords: number;
  sections: OutlineSection[];
  globalConstraints?: {
    outputFormat?: string;
    speakerNames?: string[];
    requiresBalance?: boolean;
    mustReferenceEarlier?: boolean;
    forbiddenPatterns?: string[];
    keyTerms?: Record<string, string>;
  };
}

interface SkeletonData {
  strictOutline?: StrictOutline;
  sourceClaims?: Array<{ id: string; claim: string; category: string }>;
  allowedTopics?: string[];
  forbiddenTopics?: string[];
  totalTargetWords?: number;
}

export default function FullDocumentGenerator() {
  const [userPrompt, setUserPrompt] = useState("Precisely restructure and summarize the provided text into a concise, faithful prose document of approximately 8000 words. Preserve all key arguments, definitions, examples, critiques, and logical flow exactly as in the original. Do not add, expand, speculate, or omit any substantive content. Maintain rigorous academic tone and pure prose format.");
  const [inputText, setInputText] = useState("");
  const [showOutline, setShowOutline] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDraggingPrompt, setIsDraggingPrompt] = useState(false);
  const [isDraggingInput, setIsDraggingInput] = useState(false);
  const [skeleton, setSkeleton] = useState<SkeletonData | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [generatedOutput, setGeneratedOutput] = useState("");
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const toggleSection = (id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const readFileAsText = (file: File, target: "prompt" | "input") => {
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      if (target === "prompt") {
        setUserPrompt(text);
      } else {
        setInputText(text);
      }
      toast({ title: "File loaded", description: `${file.name} (${text.length} chars)` });
    };
    reader.onerror = () => {
      toast({ title: "Failed to read file", variant: "destructive" });
    };
    reader.readAsText(file);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) readFileAsText(file, "input");
  };

  const handlePromptDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingPrompt(true);
  };

  const handlePromptDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingPrompt(false);
  };

  const handlePromptDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingPrompt(false);
    const file = e.dataTransfer.files?.[0];
    if (file) readFileAsText(file, "prompt");
  };

  const handleInputDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingInput(true);
  };

  const handleInputDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingInput(false);
  };

  const handleInputDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingInput(false);
    const file = e.dataTransfer.files?.[0];
    if (file) readFileAsText(file, "input");
  };


  const handleClearAll = () => {
    setUserPrompt("");
    setInputText("");
    setSkeleton(null);
    setStatusMessage("");
    setGeneratedOutput("");
    setExpandedSections(new Set());
  };

  const handleCopyOutput = async () => {
    try {
      await navigator.clipboard.writeText(generatedOutput);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ title: "Failed to copy", variant: "destructive" });
    }
  };

  const handleGenerate = async () => {
    if (!userPrompt.trim()) {
      toast({ title: "Enter a prompt", variant: "destructive" });
      return;
    }

    setIsGenerating(true);
    setSkeleton(null);
    setStatusMessage("Starting document generation...");
    setGeneratedOutput("");
    setExpandedSections(new Set());

    try {
      const response = await fetch("/api/coherent-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: userPrompt,
          inputText: inputText || " ",
          sessionType: "homework",
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Request failed");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6));

              switch (event.type) {
                case "skeleton":
                  if (showOutline && event.data) {
                    setSkeleton(event.data);
                  }
                  setStatusMessage("Outline generated. Beginning section generation...");
                  break;

                case "status":
                  setStatusMessage(event.data || "Processing...");
                  break;

                case "chunk":
                  if (event.data?.content) {
                    setGeneratedOutput((prev) => prev + event.data.content + "\n\n");
                  }
                  break;

                case "complete":
                  if (event.data?.content) {
                    setGeneratedOutput(event.data.content);
                  }
                  setStatusMessage("Generation complete!");
                  break;

                case "error":
                  throw new Error(event.message || event.data || "Generation error");
              }
            } catch (parseErr) {
              // Ignore heartbeat comments or malformed lines
            }
          }
        }
      }
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      setStatusMessage(`Error: ${error.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const outline = skeleton?.strictOutline;

  return (
    <div className="mt-10 border-t-4 border-blue-600 pt-8">
      <Card className="bg-blue-50 border-blue-200">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-blue-800">
              <FileText className="h-5 w-5" />
              Full Document Generator
              <Badge variant="outline" className="ml-2 text-xs">Pipeline Test</Badge>
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={handleClearAll}
              data-testid="button-clear-full-doc"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              Clear All
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium text-blue-900 block mb-2">
              User Prompt / Task (drag & drop text file here)
            </label>
            <div
              onDragOver={handlePromptDragOver}
              onDragLeave={handlePromptDragLeave}
              onDrop={handlePromptDrop}
              className={`relative rounded-md transition-all ${isDraggingPrompt ? "ring-2 ring-blue-500 ring-offset-2" : ""}`}
            >
              {isDraggingPrompt && (
                <div className="absolute inset-0 bg-blue-100/80 rounded-md flex items-center justify-center z-10 pointer-events-none">
                  <div className="text-blue-700 font-medium flex items-center gap-2">
                    <Upload className="h-5 w-5" />
                    Drop file here
                  </div>
                </div>
              )}
              <Textarea
                value={userPrompt}
                onChange={(e) => setUserPrompt(e.target.value)}
                placeholder="e.g., 'Write a 4000-word dialogue on free will vs determinism with 3 biochemical examples' or 'Rewrite this text as a 50,000-word treatise'"
                className="min-h-[100px] bg-white"
                data-testid="textarea-fulldoc-prompt"
              />
            </div>
            {userPrompt && (
              <p className="text-xs text-blue-700 mt-1">
                {userPrompt.length} characters
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-blue-900">
                Input Text (for rewrites, summaries, etc. — optional)
              </label>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-upload-fulldoc-source"
              >
                <Upload className="h-3 w-3 mr-1" />
                Upload source text
              </Button>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                accept=".txt,.md,.html"
                className="hidden"
              />
            </div>
            <div
              onDragOver={handleInputDragOver}
              onDragLeave={handleInputDragLeave}
              onDrop={handleInputDrop}
              className={`relative rounded-md transition-all ${isDraggingInput ? "ring-2 ring-blue-500 ring-offset-2" : ""}`}
            >
              {isDraggingInput && (
                <div className="absolute inset-0 bg-blue-100/80 rounded-md flex items-center justify-center z-10 pointer-events-none">
                  <div className="text-blue-700 font-medium flex items-center gap-2">
                    <Upload className="h-5 w-5" />
                    Drop file here
                  </div>
                </div>
              )}
              <Textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Paste source text here..."
                className="min-h-[80px] bg-white text-sm"
                data-testid="textarea-fulldoc-input"
              />
            </div>
            {inputText && (
              <p className="text-xs text-blue-700 mt-1">
                {inputText.length} characters loaded
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="show-outline"
              checked={showOutline}
              onCheckedChange={(checked) => setShowOutline(checked === true)}
              data-testid="checkbox-show-outline"
            />
            <label htmlFor="show-outline" className="text-sm text-blue-800 cursor-pointer">
              Show outline before generation?
            </label>
          </div>

          <Button
            onClick={handleGenerate}
            disabled={isGenerating || !userPrompt.trim()}
            className="w-full bg-blue-600 hover:bg-blue-700"
            data-testid="button-generate-full-doc"
          >
            {isGenerating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <FileText className="h-4 w-4 mr-2" />
                Generate Full Document
              </>
            )}
          </Button>

          {statusMessage && (
            <div className="text-sm text-blue-700 bg-blue-100 px-3 py-2 rounded-md">
              {statusMessage}
            </div>
          )}

          {outline && showOutline && (
            <Collapsible defaultOpen>
              <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium text-blue-800 hover:underline">
                <ChevronDown className="h-4 w-4" />
                Generated Outline ({outline.sections.length} sections, ~{outline.totalEstimatedWords} words)
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-3 p-4 bg-white rounded-md border border-blue-200 space-y-3">
                  <div>
                    <span className="text-xs font-semibold text-blue-600 uppercase">Task Summary</span>
                    <p className="text-sm text-gray-800">{outline.taskSummary}</p>
                  </div>

                  {outline.globalConstraints && (
                    <div>
                      <span className="text-xs font-semibold text-blue-600 uppercase">Global Constraints</span>
                      <div className="text-sm text-gray-700 mt-1 space-y-1">
                        {outline.globalConstraints.outputFormat && (
                          <p><strong>Format:</strong> {outline.globalConstraints.outputFormat}</p>
                        )}
                        {outline.globalConstraints.speakerNames && outline.globalConstraints.speakerNames.length > 0 && (
                          <p><strong>Speakers:</strong> {outline.globalConstraints.speakerNames.join(", ")}</p>
                        )}
                        {outline.globalConstraints.forbiddenPatterns && outline.globalConstraints.forbiddenPatterns.length > 0 && (
                          <p><strong>Forbidden:</strong> {outline.globalConstraints.forbiddenPatterns.join(", ")}</p>
                        )}
                      </div>
                    </div>
                  )}

                  <div>
                    <span className="text-xs font-semibold text-blue-600 uppercase">Sections</span>
                    <div className="mt-2 space-y-2">
                      {outline.sections.map((section) => (
                        <div key={section.id} className="border border-gray-200 rounded-md overflow-hidden">
                          <button
                            onClick={() => toggleSection(section.id)}
                            className="w-full flex items-center justify-between p-2 bg-gray-50 hover:bg-gray-100 text-left"
                          >
                            <span className="text-sm font-medium text-gray-800">
                              {section.title} <span className="text-gray-500">(~{section.estimatedWords} words)</span>
                            </span>
                            {expandedSections.has(section.id) ? (
                              <ChevronDown className="h-4 w-4 text-gray-500" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-gray-500" />
                            )}
                          </button>
                          {expandedSections.has(section.id) && (
                            <div className="p-2 text-sm space-y-1 bg-white">
                              <p className="text-gray-600">{section.description}</p>
                              {section.mandatoryElements.length > 0 && (
                                <div>
                                  <span className="text-xs font-semibold text-gray-500">Must include:</span>
                                  <ul className="list-disc list-inside text-gray-700 text-xs">
                                    {section.mandatoryElements.map((el, i) => (
                                      <li key={i}>{el}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {generatedOutput && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-blue-800">Generated Output</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={handleCopyOutput}
                  data-testid="button-copy-output"
                >
                  {copied ? (
                    <>
                      <Check className="h-3 w-3 mr-1" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3 mr-1" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
              <div className="bg-white border border-blue-200 rounded-md p-4 max-h-[600px] overflow-y-auto">
                <div className="prose prose-sm max-w-none whitespace-pre-wrap text-gray-800">
                  {generatedOutput}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
