export const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;

// Clerk is only enabled when a real publishable key (pk_test_/pk_live_) is configured.
// Otherwise the app falls back to the legacy auto-login so it's never bricked by a bad key.
export const clerkEnabled =
  typeof CLERK_PUBLISHABLE_KEY === "string" && CLERK_PUBLISHABLE_KEY.startsWith("pk_");
