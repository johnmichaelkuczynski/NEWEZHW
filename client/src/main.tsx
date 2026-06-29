import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App";
import { clerkEnabled, CLERK_PUBLISHABLE_KEY } from "./lib/clerk";
import "./index.css";

const root = createRoot(document.getElementById("root")!);

if (clerkEnabled) {
  root.render(
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY!} afterSignOutUrl="/">
      <App />
    </ClerkProvider>
  );
} else {
  // No valid Clerk key configured - fall back to the app without Clerk gating.
  root.render(<App />);
}
