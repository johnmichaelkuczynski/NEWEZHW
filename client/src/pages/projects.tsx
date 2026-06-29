import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Plus, Trash2, FolderOpen, ArrowLeft, BookOpen, Star, Brain } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface Project {
  id: number;
  name: string;
  description: string | null;
  tractatusTree: Record<string, string> | null;
  compressionCount: number;
  lastTreeUpdate: string | null;
  createdAt: string;
}

export default function ProjectsPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDesc, setNewProjectDesc] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  const projectsQuery = useQuery<Project[]>({
    queryKey: ["/api/projects"],
    retry: 1,
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description: string }) =>
      apiRequest("POST", "/api/projects", data).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setShowCreateDialog(false);
      setNewProjectName("");
      setNewProjectDesc("");
      toast({ title: "Project created" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to create project", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/projects/${id}`).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setDeleteConfirm(null);
      toast({ title: "Project deleted" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    },
  });

  const projects = projectsQuery.data || [];

  const getNodeCount = (tree: Record<string, string> | null) => {
    if (!tree) return 0;
    return Object.keys(tree).length;
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "Never";
    return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-indigo-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/">
                <Button variant="ghost" size="sm" className="text-slate-600">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to EZHW
                </Button>
              </Link>
              <div className="flex items-center gap-2 ml-2">
                <Brain className="w-6 h-6 text-indigo-600" />
                <div>
                  <h1 className="text-2xl font-bold text-slate-900">Long-Term Projects</h1>
                  <p className="text-sm text-slate-500">Persistent memory across sessions via Tractatus Tree</p>
                </div>
              </div>
            </div>
            <Button
              onClick={() => setShowCreateDialog(true)}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              <Plus className="w-4 h-4 mr-2" />
              New Project
            </Button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Info banner */}
        <div className="mb-6 p-4 bg-indigo-50 border border-indigo-200 rounded-lg">
          <div className="flex items-start gap-3">
            <Brain className="w-5 h-5 text-indigo-600 mt-0.5 flex-shrink-0" />
            <div className="text-sm text-indigo-800">
              <strong>How this works:</strong> Each project maintains a <em>Tractatus Tree</em> — a structured, compressed memory of everything discussed across all sessions. The AI reads this tree before every response, giving it persistent knowledge of your project's full history even when raw transcripts would overflow its context window. Trees are automatically compressed as they grow, creating a tiered memory hierarchy (Tier 1: recent detail → Tier 2+: compressed archive).
            </div>
          </div>
        </div>

        {/* Projects grid */}
        {projectsQuery.isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-16">
            <Brain className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-slate-600 mb-2">No projects yet</h3>
            <p className="text-slate-400 mb-6">Create a project for any long-term research, writing, or study goal.</p>
            <Button onClick={() => setShowCreateDialog(true)} className="bg-indigo-600 hover:bg-indigo-700 text-white">
              <Plus className="w-4 h-4 mr-2" />
              Create your first project
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map((project) => {
              const nodeCount = getNodeCount(project.tractatusTree);
              return (
                <Card key={project.id} className="p-5 hover:shadow-md transition-shadow cursor-pointer group relative">
                  {/* Delete button */}
                  <button
                    className="absolute top-3 right-3 p-1.5 rounded text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeleteConfirm(project.id); }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>

                  <div onClick={() => setLocation(`/projects/${project.id}`)}>
                    <div className="flex items-start gap-3 mb-3">
                      <div className="p-2 bg-indigo-100 rounded-lg flex-shrink-0">
                        <FolderOpen className="w-5 h-5 text-indigo-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-slate-900 truncate pr-6">{project.name}</h3>
                        {project.description && (
                          <p className="text-sm text-slate-500 mt-0.5 line-clamp-2">{project.description}</p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap mt-3">
                      {nodeCount > 0 ? (
                        <Badge variant="secondary" className="text-xs bg-indigo-100 text-indigo-700">
                          🧠 {nodeCount} memory nodes
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-slate-400">
                          No memory yet
                        </Badge>
                      )}
                      {project.compressionCount > 0 && (
                        <Badge variant="outline" className="text-xs text-amber-600 border-amber-300">
                          Compressed ×{project.compressionCount}
                        </Badge>
                      )}
                    </div>

                    <div className="mt-3 pt-3 border-t border-slate-100">
                      <p className="text-xs text-slate-400">
                        {project.lastTreeUpdate
                          ? `Memory updated ${formatDate(project.lastTreeUpdate)}`
                          : `Created ${formatDate(project.createdAt)}`}
                      </p>
                    </div>

                    <div className="mt-3">
                      <Button size="sm" className="w-full bg-indigo-600 hover:bg-indigo-700 text-white">
                        <BookOpen className="w-3.5 h-3.5 mr-2" />
                        Open Project
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Create Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create New Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Project Name *</label>
              <Input
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="e.g. Dissertation Ch. 3, Bar Exam Prep, Novel Draft..."
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newProjectName.trim()) createMutation.mutate({ name: newProjectName, description: newProjectDesc });
                }}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Description (optional)</label>
              <Textarea
                value={newProjectDesc}
                onChange={(e) => setNewProjectDesc(e.target.value)}
                placeholder="Brief description of this project's goal..."
                className="min-h-[80px] resize-none"
              />
            </div>
            <p className="text-xs text-slate-500">The AI will build a persistent memory of this project as you chat, allowing it to recall everything across sessions.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancel</Button>
            <Button
              onClick={() => createMutation.mutate({ name: newProjectName, description: newProjectDesc })}
              disabled={!newProjectName.trim() || createMutation.isPending}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create Project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <Dialog open={deleteConfirm !== null} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Project?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-600">This will permanently delete the project, all its sessions, and the entire Tractatus memory tree. This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm !== null && deleteMutation.mutate(deleteConfirm)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
