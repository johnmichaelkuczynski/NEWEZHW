import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useSession } from '@/hooks/use-session';
import { Upload, Sparkles, Trash2, Loader2, Zap, ChevronDown, ChevronRight, CheckCircle, Circle, Play, Copy, Download, Send } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import { MathRenderer } from '@/components/ui/math-renderer';

export default function GradingAssistant() {
  const { toast } = useToast();
  const sessionId = useSession();
  const [assignmentPrompt, setAssignmentPrompt] = useState('');
  const [gradingInstructions, setGradingInstructions] = useState('');
  const [studentSubmission, setStudentSubmission] = useState('');
  const [studentName, setStudentName] = useState('');
  const [gradingResult, setGradingResult] = useState<{
    grade: number;
    gradeText?: string;
    comments: string;
    feedback: string;
  } | null>(null);
  const [adjustmentType, setAdjustmentType] = useState<string>('');
  
  // Coherence mode state
  const [useCoherenceMode, setUseCoherenceMode] = useState(true);
  const [isCoherenceGrading, setIsCoherenceGrading] = useState(false);
  const [coherenceStatus, setCoherenceStatus] = useState('');
  const [coherenceSkeleton, setCoherenceSkeleton] = useState<any>(null);
  const [skeletonExpanded, setSkeletonExpanded] = useState(true);
  const [chunkProgress, setChunkProgress] = useState({ current: 0, total: 0 });
  const [accumulatedFeedback, setAccumulatedFeedback] = useState('');
  
  // Perfect assignment generation state
  const [isGeneratingPerfect, setIsGeneratingPerfect] = useState(false);
  const [perfectStatus, setCoherencePerfectStatus] = useState('');
  const [perfectSkeleton, setPerfectSkeleton] = useState<any>(null);
  const [perfectProgress, setPerfectProgress] = useState({ current: 0, total: 0 });
  const [perfectOutput, setPerfectOutput] = useState('');
  const [perfectExpanded, setPerfectExpanded] = useState(true);
  const [savedAssignmentId, setSavedAssignmentId] = useState<number | null>(null);

  const autoSaveGrade = async (gradeText: string, gradeScore: string) => {
    try {
      let assignmentId = savedAssignmentId;
      if (!assignmentId) {
        const title = (assignmentPrompt || 'Grading Task').substring(0, 80) + (assignmentPrompt.length > 80 ? '...' : '');
        const res = await fetch('/api/save-assignment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputText: assignmentPrompt,
            title: title,
            sessionId: sessionId
          }),
        });
        if (res.ok) {
          const data = await res.json();
          assignmentId = data.id;
          setSavedAssignmentId(data.id);
        }
      }
      
      if (assignmentId) {
        await fetch('/api/grades', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assignmentId,
            gradeText,
            gradeScore,
            llmProvider: 'openai',
            sessionId: sessionId
          }),
        });
        console.log(`[AUTO-SAVE] Grade saved for assignment ${assignmentId}`);
      }
    } catch (error) {
      console.error('Auto-save grade failed:', error);
    }
  };

  const autoSaveRewrite = async (rewriteText: string) => {
    try {
      if (savedAssignmentId) {
        await fetch('/api/rewrites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assignmentId: savedAssignmentId,
            rewriteText,
            llmProvider: 'openai',
            sessionId: sessionId
          }),
        });
        console.log(`[AUTO-SAVE] Rewrite saved for assignment ${savedAssignmentId}`);
      }
    } catch (error) {
      console.error('Auto-save rewrite failed:', error);
    }
  };

  // Copy grading result to clipboard (grade + comments + fix instructions)
  const copyGradingResult = async () => {
    if (!gradingResult) return;
    
    let textToCopy = `GRADE: ${gradingResult.gradeText || `${gradingResult.grade}/100`}\n\n`;
    textToCopy += `DETAILED COMMENTS:\n${gradingResult.comments}\n`;
    if (gradingResult.feedback) {
      textToCopy += `\nFIX INSTRUCTIONS:\n${gradingResult.feedback}`;
    }
    
    try {
      await navigator.clipboard.writeText(textToCopy);
      toast({
        title: "Copied to clipboard",
        description: "Grade, comments, and fix instructions copied.",
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Copy failed",
        description: "Could not copy to clipboard.",
      });
    }
  };

  // Download grading result as text file
  const downloadGradingResult = () => {
    if (!gradingResult) return;
    
    const studentLabel = studentName ? `_${studentName.replace(/\s+/g, '_')}` : '';
    const filename = `grading_feedback${studentLabel}_${new Date().toISOString().split('T')[0]}.txt`;
    
    let content = `GRADING FEEDBACK
================
${studentName ? `Student: ${studentName}\n` : ''}Date: ${new Date().toLocaleDateString()}

GRADE: ${gradingResult.gradeText || `${gradingResult.grade}/100`}

DETAILED COMMENTS:
${gradingResult.comments}
`;
    if (gradingResult.feedback) {
      content += `\nFIX INSTRUCTIONS:\n${gradingResult.feedback}\n`;
    }
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    toast({
      title: "Downloaded",
      description: `Saved as ${filename}`,
    });
  };

  // Check if submission is long enough to warrant coherence mode
  const isLongSubmission = (): boolean => {
    const wordCount = studentSubmission.trim().split(/\s+/).length;
    return wordCount > 2000;
  };

  // Determine if coherence will be used
  const willUseCoherence = (): boolean => {
    return useCoherenceMode && isLongSubmission();
  };

  const gradeMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/grade-submission', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assignmentPrompt,
          gradingInstructions,
          studentSubmission
        })
      });
      
      if (!response.ok) {
        throw new Error('Grading failed');
      }
      
      return response.json() as Promise<{grade: number; gradeText?: string; comments: string; feedback: string}>;
    },
    onSuccess: (data) => {
      setGradingResult(data);
      autoSaveGrade(data.comments, data.gradeText || `${data.grade}/100`);
      toast({
        title: "Submission Graded",
        description: `Grade: ${data.grade}/100`,
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Grading Failed",
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

  // Coherence grading with SSE streaming
  const gradeWithCoherence = async () => {
    setIsCoherenceGrading(true);
    setAccumulatedFeedback('');
    setCoherenceStatus('Starting detailed evaluation...');
    setCoherenceSkeleton(null);
    setChunkProgress({ current: 0, total: 0 });
    setGradingResult(null);

    try {
      const userPrompt = `Provide a detailed, structured evaluation and grade for this student submission based on the assignment requirements and grading criteria. 

Your evaluation must include:
1. Overall assessment and final grade (following the exact grading format specified in the rubric)
2. Section-by-section analysis of the submission
3. Specific strengths with evidence from the text
4. Specific weaknesses with evidence from the text
5. Accuracy and completeness evaluation
6. Structure and organization analysis
7. Detailed improvement suggestions

Be rigorous, fair, and follow the grading rubric exactly as specified.`;

      const inputText = `ASSIGNMENT REQUIREMENTS:
${assignmentPrompt}

GRADING RUBRIC/INSTRUCTIONS:
${gradingInstructions}

STUDENT SUBMISSION TO GRADE:
${studentSubmission}`;

      const response = await fetch('/api/coherent-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userPrompt,
          inputText,
          sessionType: 'grading'
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to start coherence grading');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              switch (event.type) {
                case "skeleton":
                  setCoherenceSkeleton(event.data);
                  setCoherenceStatus("Evaluation outline ready, generating sections...");
                  if (event.data?.sections) {
                    setChunkProgress({ current: 0, total: event.data.sections.length });
                  }
                  break;
                case "status":
                  setCoherenceStatus(event.data);
                  break;
                case "chunk":
                  fullContent += event.data.content + "\n\n";
                  setAccumulatedFeedback(fullContent);
                  setChunkProgress(prev => ({ ...prev, current: (event.data.sectionIndex ?? event.data.chunkIndex ?? prev.current) + 1 }));
                  break;
                case "pause":
                  setCoherenceStatus(typeof event.data === 'string' ? event.data : `Pausing before next section...`);
                  break;
                case "complete":
                  const finalOutput = event.data.content || event.data.output || fullContent;
                  setAccumulatedFeedback(finalOutput);
                  setCoherenceStatus("");
                  // Extract grade from the output - handles letter grades (A, B+, etc) and numeric (85/100, 92, etc)
                  let extractedGrade = 0;
                  let extractedGradeText: string | undefined;
                  
                  // Try to find letter grade first (A+, A, A-, B+, etc)
                  const letterMatch = finalOutput.match(/(?:Final\s+)?(?:Grade|Score|Rating|Overall)[:\s]*([A-F][+-]?)/i);
                  if (letterMatch) {
                    const gradeKey = letterMatch[1].toUpperCase();
                    extractedGradeText = gradeKey;
                    // Convert letter to numeric equivalent
                    const letterToNum: Record<string, number> = {
                      'A+': 98, 'A': 95, 'A-': 92,
                      'B+': 88, 'B': 85, 'B-': 82,
                      'C+': 78, 'C': 75, 'C-': 72,
                      'D+': 68, 'D': 65, 'D-': 62,
                      'F': 50
                    };
                    extractedGrade = letterToNum[gradeKey] || 75;
                  } else {
                    // Try numeric grade (85/100, 92%, 88 out of 100, etc)
                    const numericMatch = finalOutput.match(/(?:Final\s+)?(?:Grade|Score|Rating|Overall)[:\s]*(\d+)(?:\s*(?:\/|out of|%|\s*points?)?\s*(?:100)?)?/i);
                    if (numericMatch) {
                      extractedGrade = Math.min(100, parseInt(numericMatch[1]));
                      extractedGradeText = `${extractedGrade}/100`;
                    } else {
                      // Check for pass/fail
                      const passMatch = finalOutput.match(/(?:Grade|Result)[:\s]*(Pass|Fail|Satisfactory|Unsatisfactory)/i);
                      if (passMatch) {
                        extractedGradeText = passMatch[1];
                        extractedGrade = passMatch[1].toLowerCase().includes('pass') || passMatch[1].toLowerCase().includes('satisfactory') ? 75 : 50;
                      }
                    }
                  }
                  
                  setGradingResult({
                    grade: extractedGrade || 75,
                    gradeText: extractedGradeText,
                    comments: finalOutput,
                    feedback: ''
                  });
                  autoSaveGrade(finalOutput, extractedGradeText || `${extractedGrade || 75}/100`);
                  toast({
                    title: "Evaluation Complete",
                    description: `${event.data.totalWords || 'Full'} words of detailed feedback`,
                  });
                  break;
                case "error":
                  throw new Error(event.message || event.data || 'Unknown error');
              }
            } catch (parseErr) {
              console.error("SSE parse error:", parseErr);
            }
          }
        }
      }
    } catch (err: any) {
      toast({
        title: "Coherence grading failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setIsCoherenceGrading(false);
      setCoherenceStatus("");
    }
  };

  // Generate Perfect Assignment using coherence mode
  const generatePerfectAssignment = async () => {
    if (!gradingResult) return;
    
    setIsGeneratingPerfect(true);
    setPerfectOutput('');
    setCoherencePerfectStatus('Starting assignment improvement...');
    setPerfectSkeleton(null);
    setPerfectProgress({ current: 0, total: 0 });

    try {
      const userPrompt = `${assignmentPrompt}

PREVIOUS SOLUTION:
${studentSubmission}

GRADE RECEIVED: ${gradingResult.gradeText || `${gradingResult.grade}/100`}

GRADING FEEDBACK:
${gradingResult.comments}

TASK: Rewrite and improve this solution to fix ALL weaknesses identified in the feedback. Improve the work to achieve an A grade while maintaining the same general format and length requirements. Address every criticism point from the feedback.`;

      const response = await fetch('/api/coherent-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userPrompt,
          inputText: '',
          sessionType: 'improvement'
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to start improvement generation');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              switch (event.type) {
                case "skeleton":
                  setPerfectSkeleton(event.data);
                  setCoherencePerfectStatus("Improvement outline ready, generating sections...");
                  if (event.data?.sections) {
                    setPerfectProgress({ current: 0, total: event.data.sections.length });
                  }
                  break;
                case "status":
                  setCoherencePerfectStatus(event.data);
                  break;
                case "chunk":
                  fullContent += event.data.content + "\n\n";
                  setPerfectOutput(fullContent);
                  setPerfectProgress(prev => ({ ...prev, current: (event.data.sectionIndex ?? event.data.chunkIndex ?? prev.current) + 1 }));
                  break;
                case "pause":
                  setCoherencePerfectStatus(typeof event.data === 'string' ? event.data : `Pausing before next section...`);
                  break;
                case "complete":
                  const finalOutput = event.data.content || event.data.output || fullContent;
                  setPerfectOutput(finalOutput);
                  setCoherencePerfectStatus("");
                  autoSaveRewrite(finalOutput);
                  toast({
                    title: "Perfect Assignment Generated",
                    description: `${event.data.totalWords || 'Full'} words of improved content`,
                  });
                  break;
                case "error":
                  throw new Error(event.message || event.data || 'Unknown error');
              }
            } catch (parseErr) {
              console.error("SSE parse error:", parseErr);
            }
          }
        }
      }
    } catch (err: any) {
      toast({
        title: "Perfect assignment generation failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setIsGeneratingPerfect(false);
      setCoherencePerfectStatus("");
    }
  };

  // Fast perfect assignment generation (non-coherence mode)
  const generatePerfectFast = async () => {
    if (!gradingResult) return;
    
    setIsGeneratingPerfect(true);
    setPerfectOutput('');
    
    try {
      const response = await fetch('/api/generate-perfect-fast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignmentPrompt,
          studentSubmission,
          gradeFeedback: gradingResult.comments,
          grade: gradingResult.gradeText || `${gradingResult.grade}/100`
        }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to generate perfect assignment');
      }
      
      const data = await response.json();
      setPerfectOutput(data.improvedAssignment);
      autoSaveRewrite(data.improvedAssignment);
      toast({
        title: "Perfect Assignment Generated",
        description: "Improved version is ready",
      });
    } catch (err: any) {
      toast({
        title: "Generation failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setIsGeneratingPerfect(false);
    }
  };

  const handleGeneratePerfect = () => {
    if (!gradingResult) {
      toast({
        variant: "destructive",
        title: "No Grading Results",
        description: "Please grade the assignment first.",
      });
      return;
    }

    if (useCoherenceMode) {
      generatePerfectAssignment();
    } else {
      generatePerfectFast();
    }
  };

  // Copy perfect output to clipboard
  const copyPerfectOutput = async () => {
    if (!perfectOutput) return;
    try {
      await navigator.clipboard.writeText(perfectOutput);
      toast({ title: "Copied to clipboard" });
    } catch (err) {
      toast({ variant: "destructive", title: "Copy failed" });
    }
  };

  // Download perfect output
  const downloadPerfectOutput = () => {
    if (!perfectOutput) return;
    const filename = `perfect_assignment_${new Date().toISOString().split('T')[0]}.txt`;
    const blob = new Blob([perfectOutput], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast({ title: "Downloaded", description: `Saved as ${filename}` });
  };

  // Send perfect output to the student submission input for re-grading
  const sendPerfectToGrader = () => {
    if (!perfectOutput) return;
    setStudentSubmission(perfectOutput);
    setGradingResult(null);
    setPerfectOutput('');
    setAccumulatedFeedback('');
    toast({
      title: "Sent to Grader",
      description: "Perfect assignment loaded into Student Submission. Click Grade to evaluate.",
    });
    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const adjustGradeMutation = useMutation({
    mutationFn: async () => {
      if (!gradingResult) return null;
      
      const response = await fetch('/api/adjust-grade', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assignmentPrompt,
          gradingInstructions,
          studentSubmission,
          currentGrade: gradingResult.grade,
          currentComments: gradingResult.comments,
          adjustmentType,
          studentName
        })
      });
      
      if (!response.ok) {
        throw new Error('Grade adjustment failed');
      }
      
      return response.json() as Promise<{grade: number; gradeText?: string; comments: string; feedback: string}>;
    },
    onSuccess: (data) => {
      if (data) {
        setGradingResult(data);
        toast({
          title: "Grade Adjusted",
          description: `New Grade: ${data.grade}/100`,
        });
      }
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Adjustment Failed",
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

  const handleGrade = () => {
    if (!assignmentPrompt || !gradingInstructions || !studentSubmission) {
      toast({
        variant: "destructive",
        title: "Missing Information",
        description: "Please fill in all three sections before grading.",
      });
      return;
    }

    if (willUseCoherence()) {
      gradeWithCoherence();
    } else {
      gradeMutation.mutate();
    }
  };

  const handleAdjustGrade = () => {
    if (!adjustmentType) {
      toast({
        variant: "destructive",
        title: "No Adjustment Selected",
        description: "Please select an adjustment option.",
      });
      return;
    }
    adjustGradeMutation.mutate();
  };

  const isProcessing = gradeMutation.isPending || isCoherenceGrading || isGeneratingPerfect;
  const submissionWordCount = studentSubmission.trim().split(/\s+/).filter(w => w).length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-4xl font-bold text-center mb-2 text-gray-800">
          <Sparkles className="inline-block w-8 h-8 mr-2 text-yellow-500" />
          Grading Assistant
        </h1>
        <p className="text-center text-gray-600 mb-8">AI-powered grading that follows YOUR rubric exactly</p>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          {/* Assignment Prompt */}
          <Card className="p-6 bg-blue-50 border-blue-200">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-blue-900">Assignment Prompt</h2>
              <Button 
                variant="ghost" 
                size="sm"
                onClick={() => setAssignmentPrompt('')}
                data-testid="button-clear-prompt"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-sm text-gray-600 mb-3">Upload or enter the assignment instructions</p>
            <Textarea
              value={assignmentPrompt}
              onChange={(e) => setAssignmentPrompt(e.target.value)}
              placeholder="WRITE A 500 WORD ESSAY COMPARING FREUD AND MARX"
              className="min-h-[300px] bg-white"
              data-testid="textarea-assignment-prompt"
            />
          </Card>

          {/* Grading Instructions */}
          <Card className="p-6 bg-yellow-50 border-yellow-200">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-yellow-900">Grading Instructions</h2>
              <Button 
                variant="ghost" 
                size="sm"
                onClick={() => setGradingInstructions('')}
                data-testid="button-clear-instructions"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-sm text-gray-600 mb-3">Upload or enter the grading criteria and rubric</p>
            <Textarea
              value={gradingInstructions}
              onChange={(e) => setGradingInstructions(e.target.value)}
              placeholder="A IF PERFECT; B IF PERFECT BUT DOES NOT INCLUDE QUOTES; C IF IMPERFECT; ETC"
              className="min-h-[300px] bg-white"
              data-testid="textarea-grading-instructions"
            />
          </Card>

          {/* Student Submission */}
          <Card className="p-6 bg-purple-50 border-purple-200">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-purple-900">Student Submission</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-purple-600">{submissionWordCount} words</span>
                <Button 
                  variant="ghost" 
                  size="sm"
                  onClick={() => setStudentSubmission('')}
                  data-testid="button-clear-submission"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <p className="text-sm text-gray-600 mb-3">Upload or enter the student's work</p>
            <Textarea
              value={studentSubmission}
              onChange={(e) => setStudentSubmission(e.target.value)}
              placeholder="Sigmund Freud and Karl Marx, two towering intellectual figures of the 19th and early 20th centuries..."
              className="min-h-[300px] bg-white"
              data-testid="textarea-student-submission"
            />
          </Card>
        </div>

        {/* Coherence Mode Toggle */}
        <div className="flex items-center justify-center mb-4">
          <div className="flex items-center justify-between p-3 bg-white rounded-lg border shadow-sm max-w-md w-full">
            <div className="flex items-center space-x-2">
              <Switch
                id="coherence-toggle-grading"
                checked={useCoherenceMode}
                onCheckedChange={setUseCoherenceMode}
                data-testid="switch-coherence-grading"
              />
              <Label htmlFor="coherence-toggle-grading" className="text-sm font-medium text-slate-700 cursor-pointer">
                Use Coherence Mode (for long assignments)
              </Label>
            </div>
            <span className="text-xs text-slate-500">
              {willUseCoherence() ? "Section-by-section" : "Fast mode"}
            </span>
          </div>
        </div>

        <div className="text-center mb-6">
          <Button
            onClick={handleGrade}
            disabled={isProcessing}
            className={`text-lg px-12 py-6 ${willUseCoherence() ? 'bg-blue-600 hover:bg-blue-700' : 'bg-cyan-500 hover:bg-cyan-600'} text-white`}
            data-testid="button-grade-submission"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                {isCoherenceGrading ? 'Evaluating...' : 'Grading...'}
              </>
            ) : willUseCoherence() ? (
              <>
                <Zap className="w-5 h-5 mr-2" />
                GRADE LONG ASSIGNMENT
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5 mr-2" />
                GRADE SUBMISSION
              </>
            )}
          </Button>
          <p className="text-xs text-gray-500 mt-2">
            {willUseCoherence() 
              ? "Detailed section-by-section evaluation with structured feedback"
              : "Quick evaluation for shorter submissions"
            }
          </p>
        </div>

        {/* Coherence Processing Progress */}
        {isCoherenceGrading && (
          <Card className="p-6 mb-6 bg-blue-50 border-blue-200">
            <div className="flex items-center gap-2 mb-4">
              <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
              <span className="font-medium text-blue-900">{coherenceStatus}</span>
            </div>

            {chunkProgress.total > 0 && (
              <div className="mb-4">
                <div className="flex justify-between text-sm text-blue-700 mb-1">
                  <span>Section {chunkProgress.current} of {chunkProgress.total}</span>
                  <span>{Math.round((chunkProgress.current / chunkProgress.total) * 100)}%</span>
                </div>
                <Progress value={(chunkProgress.current / chunkProgress.total) * 100} className="h-2" />
              </div>
            )}

            {/* Evaluation Outline */}
            {coherenceSkeleton && (
              <div className="bg-white rounded-lg p-4">
                <button
                  onClick={() => setSkeletonExpanded(!skeletonExpanded)}
                  className="flex items-center gap-2 text-sm font-medium text-blue-800 mb-2 hover:text-blue-600"
                >
                  {skeletonExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  Evaluation Outline
                </button>
                {skeletonExpanded && coherenceSkeleton.sections && (
                  <div className="space-y-1 text-sm">
                    {coherenceSkeleton.sections.map((section: any, idx: number) => (
                      <div key={idx} className="flex items-center gap-2">
                        {idx < chunkProgress.current ? (
                          <CheckCircle className="w-4 h-4 text-green-500" />
                        ) : idx === chunkProgress.current ? (
                          <Play className="w-4 h-4 text-blue-500 animate-pulse" />
                        ) : (
                          <Circle className="w-4 h-4 text-gray-300" />
                        )}
                        <span className={idx < chunkProgress.current ? "text-green-700" : idx === chunkProgress.current ? "text-blue-700 font-medium" : "text-gray-500"}>
                          {section.title || section.heading || `Section ${idx + 1}`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        )}

        {/* Streaming Feedback Display */}
        {accumulatedFeedback && !gradingResult && (
          <Card className="p-6 mb-6 bg-green-50 border-green-200">
            <h2 className="text-xl font-semibold text-green-900 mb-4">Evaluation Progress</h2>
            <div className="bg-white rounded-lg p-4 max-h-[500px] overflow-y-auto">
              <MathRenderer content={accumulatedFeedback} className="prose prose-sm max-w-none" />
            </div>
          </Card>
        )}

        {/* Grading Results */}
        {gradingResult && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Grading Results Panel */}
            <Card className="p-6 bg-green-50 border-green-200 lg:col-span-2">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-green-900">Grading Results</h2>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={copyGradingResult}
                    data-testid="button-copy-grading"
                  >
                    <Copy className="w-4 h-4 mr-1" />
                    Copy
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={downloadGradingResult}
                    data-testid="button-download-grading"
                  >
                    <Download className="w-4 h-4 mr-1" />
                    Download
                  </Button>
                </div>
              </div>
              <p className="text-sm text-gray-600 mb-4">Edit feedback directly in the textbox below</p>
              
              <div className="mb-4">
                <Label htmlFor="student-name">Student Name</Label>
                <Input
                  id="student-name"
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  placeholder="Enter student name"
                  className="mt-1"
                  data-testid="input-student-name"
                />
              </div>

              <div className="bg-white rounded-lg p-6 text-center mb-4">
                <div className="text-5xl font-bold text-green-600 mb-2" data-testid="text-grade-value">
                  {gradingResult.gradeText || `${gradingResult.grade}/100`}
                </div>
                {gradingResult.gradeText && (
                  <div className="text-sm text-gray-500">({gradingResult.grade}/100 equivalent)</div>
                )}
              </div>

              {accumulatedFeedback ? (
                <div className="bg-white rounded-lg p-4 max-h-[500px] overflow-y-auto mb-4">
                  <MathRenderer content={gradingResult.comments} className="prose prose-sm max-w-none" />
                </div>
              ) : (
                <Textarea
                  value={gradingResult.comments}
                  onChange={(e) => setGradingResult({...gradingResult, comments: e.target.value})}
                  className="min-h-[200px] bg-white mb-4"
                  data-testid="textarea-grade-comments"
                />
              )}

              <Button
                variant="outline"
                className="w-full"
                data-testid="button-override-grade"
              >
                OVERRIDE GRADE
              </Button>
            </Card>

            {/* Professor Feedback & Grading Adjustment */}
            <Card className="p-6 bg-orange-50 border-orange-200">
              <h2 className="text-xl font-semibold text-orange-900 mb-2">Professor Feedback & Grading Adjustment</h2>
              <p className="text-sm text-gray-600 mb-4">Your feedback will generate new comments and a revised grade</p>

              <div className="mb-4">
                <Label className="text-sm font-semibold mb-2 block">Grade Adjustment</Label>
                <RadioGroup value={adjustmentType} onValueChange={setAdjustmentType}>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="reevaluate" id="reevaluate" data-testid="radio-reevaluate" />
                    <Label htmlFor="reevaluate" className="cursor-pointer">Re-evaluate completely</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="higher" id="higher" data-testid="radio-higher" />
                    <Label htmlFor="higher" className="cursor-pointer">Grade should be higher</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="lower" id="lower" data-testid="radio-lower" />
                    <Label htmlFor="lower" className="cursor-pointer">Grade should be lower</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="appropriate" id="appropriate" data-testid="radio-appropriate" />
                    <Label htmlFor="appropriate" className="cursor-pointer">Grade is appropriate</Label>
                  </div>
                </RadioGroup>
                <p className="text-xs text-gray-500 mt-2">Current grade: {gradingResult.grade}/100</p>
              </div>

              <div className="mb-4">
                <Label htmlFor="instructor-feedback">Instructor Feedback</Label>
                <Textarea
                  id="instructor-feedback"
                  value={gradingResult.feedback}
                  onChange={(e) => setGradingResult({...gradingResult, feedback: e.target.value})}
                  placeholder="IF THE STUDENT DOES EVERYTHING RIGHT AND DOES NOT MAKE ANY CLEAR MISTAKES, HE SHOULD GET A 100/100. DO NOT DEDUCT POINTS EXCEPT WHEN THEY ABSOLUTELY HAVE TO BE DEDUCTED."
                  className="min-h-[150px] bg-white"
                  data-testid="textarea-instructor-feedback"
                />
              </div>

              <Button
                onClick={handleAdjustGrade}
                disabled={adjustGradeMutation.isPending}
                className="w-full"
                data-testid="button-adjust-grade"
              >
                {adjustGradeMutation.isPending ? 'Adjusting...' : 'Apply Adjustment'}
              </Button>
            </Card>
          </div>
        )}

        {/* Generate Perfect Assignment Section */}
        {gradingResult && (
          <div className="mt-6">
            <div className="text-center mb-4">
              <Button
                onClick={handleGeneratePerfect}
                disabled={isGeneratingPerfect}
                className={`text-lg px-8 py-5 ${useCoherenceMode ? 'bg-purple-600 hover:bg-purple-700' : 'bg-indigo-500 hover:bg-indigo-600'} text-white`}
                data-testid="button-generate-perfect"
              >
                {isGeneratingPerfect ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Generating Perfect Version...
                  </>
                ) : useCoherenceMode ? (
                  <>
                    <Zap className="w-5 h-5 mr-2" />
                    GENERATE PERFECT LONG ASSIGNMENT
                  </>
                ) : (
                  <>
                    <Sparkles className="w-5 h-5 mr-2" />
                    GENERATE PERFECT ASSIGNMENT
                  </>
                )}
              </Button>
              <p className="text-xs text-gray-500 mt-2">
                {useCoherenceMode 
                  ? "Uses coherence mode to generate a comprehensive improved version" 
                  : "Quick generation for shorter assignments"
                }
              </p>
            </div>

            {/* Perfect Assignment Generation Progress */}
            {isGeneratingPerfect && useCoherenceMode && (
              <Card className="p-6 mb-6 bg-purple-50 border-purple-200">
                <div className="flex items-center gap-2 mb-4">
                  <Loader2 className="w-5 h-5 animate-spin text-purple-600" />
                  <span className="font-medium text-purple-900">{perfectStatus}</span>
                </div>

                {perfectProgress.total > 0 && (
                  <div className="mb-4">
                    <div className="flex justify-between text-sm text-purple-700 mb-1">
                      <span>Section {perfectProgress.current} of {perfectProgress.total}</span>
                      <span>{Math.round((perfectProgress.current / perfectProgress.total) * 100)}%</span>
                    </div>
                    <Progress value={(perfectProgress.current / perfectProgress.total) * 100} className="h-2" />
                  </div>
                )}

                {/* Improvement Outline */}
                {perfectSkeleton && (
                  <div className="bg-white rounded-lg p-4">
                    <button
                      onClick={() => setPerfectExpanded(!perfectExpanded)}
                      className="flex items-center gap-2 text-sm font-medium text-purple-800 mb-2 hover:text-purple-600"
                    >
                      {perfectExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      Improvement Outline
                    </button>
                    {perfectExpanded && perfectSkeleton.sections && (
                      <div className="space-y-1 text-sm">
                        {perfectSkeleton.sections.map((section: any, idx: number) => (
                          <div key={idx} className="flex items-center gap-2">
                            {idx < perfectProgress.current ? (
                              <CheckCircle className="w-4 h-4 text-green-500" />
                            ) : idx === perfectProgress.current ? (
                              <Play className="w-4 h-4 text-purple-500 animate-pulse" />
                            ) : (
                              <Circle className="w-4 h-4 text-gray-300" />
                            )}
                            <span className={idx < perfectProgress.current ? "text-green-700" : idx === perfectProgress.current ? "text-purple-700 font-medium" : "text-gray-500"}>
                              {section.title || section.heading || `Section ${idx + 1}`}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            )}

            {/* Streaming Perfect Output */}
            {perfectOutput && isGeneratingPerfect && (
              <Card className="p-6 mb-6 bg-purple-50 border-purple-200">
                <h2 className="text-xl font-semibold text-purple-900 mb-4">Generating Improved Assignment...</h2>
                <div className="bg-white rounded-lg p-4 max-h-[500px] overflow-y-auto">
                  <MathRenderer content={perfectOutput} className="prose prose-sm max-w-none" />
                </div>
              </Card>
            )}

            {/* Perfect Assignment Output (completed) */}
            {perfectOutput && !isGeneratingPerfect && (
              <Card className="p-6 bg-purple-50 border-purple-200">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold text-purple-900">Perfect Assignment</h2>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={copyPerfectOutput}
                      data-testid="button-copy-perfect"
                    >
                      <Copy className="w-4 h-4 mr-1" />
                      Copy
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={downloadPerfectOutput}
                      data-testid="button-download-perfect"
                    >
                      <Download className="w-4 h-4 mr-1" />
                      Download
                    </Button>
                    <Button
                      size="sm"
                      onClick={sendPerfectToGrader}
                      className="bg-green-600 hover:bg-green-700 text-white"
                      data-testid="button-send-to-grader"
                    >
                      <Send className="w-4 h-4 mr-1" />
                      Send to Grader
                    </Button>
                  </div>
                </div>
                <div className="bg-white rounded-lg p-4 max-h-[600px] overflow-y-auto">
                  <MathRenderer content={perfectOutput} className="prose prose-sm max-w-none" />
                </div>
                <p className="text-sm text-gray-600 mt-4 text-center">
                  Word count: ~{perfectOutput.trim().split(/\s+/).length} words
                </p>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
