import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { SignedIn, SignedOut, SignIn } from "@clerk/clerk-react";
import { clerkEnabled } from "@/lib/clerk";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import HomeworkAssistant from "@/pages/homework-assistant";
import GradingAssistant from "@/pages/grading-assistant";
import ProjectsPage from "@/pages/projects";
import ProjectWorkspace from "@/pages/project-workspace";
import AdminPage from "@/pages/admin";
import NotFound from "@/pages/not-found";
import { Star } from "lucide-react";

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeworkAssistant} />
      <Route path="/grading" component={GradingAssistant} />
      <Route path="/projects" component={ProjectsPage} />
      <Route path="/projects/:id" component={ProjectWorkspace} />
      <Route path="/admin" component={AdminPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function SignInScreen() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 px-4">
      <div className="flex items-center gap-2 mb-8">
        <Star className="w-8 h-8 text-yellow-500 fill-yellow-500" />
        <div>
          <h1 className="text-3xl font-bold text-slate-900">EZHW</h1>
          <p className="text-sm text-slate-600 mt-1">AI-powered assignment solver</p>
        </div>
      </div>
      <SignIn routing="hash" />
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        {clerkEnabled ? (
          <>
            <SignedIn>
              <Router />
            </SignedIn>
            <SignedOut>
              <SignInScreen />
            </SignedOut>
          </>
        ) : (
          <Router />
        )}
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
