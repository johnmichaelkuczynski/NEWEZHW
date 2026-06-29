import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Loader2, ChevronDown, ChevronRight, Upload, FlaskConical, RotateCcw } from "lucide-react";
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

interface SkeletonResponse {
  success: boolean;
  skeleton: {
    strictOutline?: StrictOutline;
    sourceClaims?: any[];
    forbiddenTopics?: string[];
    keyTerms?: Record<string, string>;
    outputFormat?: string;
    totalTargetWords?: number;
    logicalSections?: string[];
    speakerNames?: string[];
  };
  error?: string;
}

export function StrictOutlineTester() {
  const [userPrompt, setUserPrompt] = useState("");
  const [inputText, setInputText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [skeletonResult, setSkeletonResult] = useState<SkeletonResponse | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    readFileAsText(file);
  };

  const readFileAsText = (file: File) => {
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      setInputText(text);
      toast({ title: "File loaded", description: `${file.name} (${text.length} chars)` });
    };
    reader.onerror = () => {
      toast({ title: "Failed to read file", variant: "destructive" });
    };
    reader.readAsText(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (file) {
      readFileAsText(file);
    }
  };

  const handleGenerate = async () => {
    if (!userPrompt.trim()) {
      toast({ title: "Enter a prompt", variant: "destructive" });
      return;
    }

    setIsLoading(true);
    setSkeletonResult(null);

    try {
      const response = await fetch("/api/test-skeleton", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userPrompt: userPrompt.trim(),
          inputText: inputText.trim(),
          targetChunks: 8,
        }),
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || "Failed to generate skeleton");
      }

      setSkeletonResult(data);
      setExpandedSections(new Set());
      toast({ title: "Outline generated", description: "See results below" });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const toggleSection = (id: string) => {
    const newSet = new Set(expandedSections);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setExpandedSections(newSet);
  };

  const strictOutline = skeletonResult?.skeleton?.strictOutline;

  return (
    <div className="mt-16 border-t-4 border-amber-600 pt-8">
      <Card className="bg-amber-50 border-amber-200">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-amber-800">
              <FlaskConical className="h-5 w-5" />
              Test Strict Outline Generator
              <Badge variant="outline" className="ml-2 text-xs">Debug Tool</Badge>
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => {
                setUserPrompt("");
                setInputText("");
                setSkeletonResult(null);
                setExpandedSections(new Set());
              }}
              data-testid="button-clear-outline-test"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              Clear All
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium text-amber-900 block mb-2">
              User Prompt / Task
            </label>
            <Textarea
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
              placeholder="Paste your user prompt / task here..."
              className="min-h-[120px] bg-white"
              data-testid="textarea-test-prompt"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-amber-900">
                Input Text (for rewrites, summaries, etc. — optional)
              </label>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-upload-source"
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
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`relative rounded-md transition-all ${isDragging ? 'ring-2 ring-amber-500 ring-offset-2' : ''}`}
            >
              {isDragging && (
                <div className="absolute inset-0 bg-amber-100/80 rounded-md flex items-center justify-center z-10 pointer-events-none">
                  <div className="text-amber-700 font-medium flex items-center gap-2">
                    <Upload className="h-5 w-5" />
                    Drop file here
                  </div>
                </div>
              )}
              <Textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Optional: paste, drag & drop, or upload source text..."
                className="min-h-[80px] bg-white text-sm"
                data-testid="textarea-test-input"
              />
            </div>
            {inputText && (
              <p className="text-xs text-amber-700 mt-1">
                {inputText.length} characters loaded
              </p>
            )}
          </div>

          <Button
            onClick={handleGenerate}
            disabled={isLoading || !userPrompt.trim()}
            className="w-full bg-amber-600 hover:bg-amber-700"
            data-testid="button-generate-outline"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generating Strict Outline...
              </>
            ) : (
              <>
                <FlaskConical className="h-4 w-4 mr-2" />
                Generate Strict Outline
              </>
            )}
          </Button>

          {skeletonResult && strictOutline && (
            <div className="mt-6 space-y-4 bg-white rounded-lg p-4 border border-amber-200">
              <div className="border-b pb-3">
                <h3 className="font-semibold text-lg text-amber-900">Task Summary</h3>
                <p className="text-sm text-slate-700 mt-1">{strictOutline.taskSummary}</p>
                <Badge variant="secondary" className="mt-2">
                  Total: {strictOutline.totalEstimatedWords.toLocaleString()} words
                </Badge>
              </div>

              {strictOutline.globalConstraints && (
                <div className="border-b pb-3">
                  <h4 className="font-medium text-amber-800 mb-2">Global Constraints</h4>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {strictOutline.globalConstraints.outputFormat && (
                      <div>
                        <span className="text-slate-500">Format:</span>{" "}
                        <span className="font-mono text-xs bg-slate-100 px-1 rounded">
                          {strictOutline.globalConstraints.outputFormat}
                        </span>
                      </div>
                    )}
                    {strictOutline.globalConstraints.speakerNames && strictOutline.globalConstraints.speakerNames.length > 0 && (
                      <div>
                        <span className="text-slate-500">Speakers:</span>{" "}
                        {strictOutline.globalConstraints.speakerNames.map((s, i) => (
                          <Badge key={i} variant="outline" className="ml-1 text-xs">{s}</Badge>
                        ))}
                      </div>
                    )}
                    {strictOutline.globalConstraints.requiresBalance && (
                      <Badge variant="secondary" className="text-xs">Balance Required</Badge>
                    )}
                    {strictOutline.globalConstraints.mustReferenceEarlier && (
                      <Badge variant="secondary" className="text-xs">Must Reference Earlier</Badge>
                    )}
                  </div>
                  {strictOutline.globalConstraints.forbiddenPatterns && strictOutline.globalConstraints.forbiddenPatterns.length > 0 && (
                    <div className="mt-2">
                      <span className="text-xs text-slate-500">Forbidden:</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {strictOutline.globalConstraints.forbiddenPatterns.map((p, i) => (
                          <Badge key={i} variant="destructive" className="text-xs">{p}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {strictOutline.globalConstraints.keyTerms && Object.keys(strictOutline.globalConstraints.keyTerms).length > 0 && (
                    <div className="mt-2">
                      <span className="text-xs text-slate-500">Key Terms:</span>
                      <div className="mt-1 text-xs space-y-1">
                        {Object.entries(strictOutline.globalConstraints.keyTerms).map(([term, def]) => (
                          <div key={term}>
                            <strong>{term}:</strong> {def}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div>
                <h4 className="font-medium text-amber-800 mb-3">
                  Sections ({strictOutline.sections.length})
                </h4>
                <div className="space-y-2">
                  {strictOutline.sections.map((section) => (
                    <Collapsible key={section.id} open={expandedSections.has(section.id)}>
                      <CollapsibleTrigger
                        onClick={() => toggleSection(section.id)}
                        className="w-full text-left p-3 bg-slate-50 hover:bg-slate-100 rounded-lg border transition-colors"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {expandedSections.has(section.id) ? (
                              <ChevronDown className="h-4 w-4 text-slate-400" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-slate-400" />
                            )}
                            <span className="font-medium text-sm">{section.title}</span>
                            <Badge variant="outline" className="text-xs ml-2">{section.id}</Badge>
                          </div>
                          <div className="flex items-center gap-2">
                            {section.format && (
                              <Badge variant="secondary" className="text-xs">{section.format}</Badge>
                            )}
                            <Badge className="text-xs">{section.estimatedWords} words</Badge>
                          </div>
                        </div>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="px-3 py-2 border-x border-b rounded-b-lg bg-white">
                        <p className="text-sm text-slate-600 mb-2">{section.description}</p>
                        {section.mandatoryElements.length > 0 && (
                          <div>
                            <span className="text-xs text-slate-500">Mandatory Elements:</span>
                            <ul className="mt-1 space-y-1">
                              {section.mandatoryElements.map((el, i) => (
                                <li key={i} className="text-xs flex items-start gap-1">
                                  <span className="text-green-600">✓</span>
                                  <span>{el}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </CollapsibleContent>
                    </Collapsible>
                  ))}
                </div>
              </div>

              <Collapsible>
                <CollapsibleTrigger className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1">
                  <ChevronRight className="h-3 w-3" />
                  Show raw JSON
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-2 p-3 bg-slate-900 text-green-400 text-xs rounded-lg overflow-x-auto max-h-96 overflow-y-auto">
                    {JSON.stringify(skeletonResult.skeleton, null, 2)}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}

          {skeletonResult && !strictOutline && (
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-700">No strictOutline in response. Raw skeleton:</p>
              <pre className="mt-2 text-xs overflow-x-auto">
                {JSON.stringify(skeletonResult.skeleton, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
