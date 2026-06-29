import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { registerAdminRoutes } from "./adminRoutes";
import { setupVite, serveStatic, log } from "./vite";

// Clerk's backend SDK looks for CLERK_PUBLISHABLE_KEY; mirror the VITE-prefixed value used by the frontend.
if (!process.env.CLERK_PUBLISHABLE_KEY && process.env.VITE_CLERK_PUBLISHABLE_KEY) {
  process.env.CLERK_PUBLISHABLE_KEY = process.env.VITE_CLERK_PUBLISHABLE_KEY;
}

const app = express();

// Add reachability probes for Render diagnostics
app.get("/__ping", (_req, res) => res.send("ok"));

// Now safe to add JSON parsing for other routes
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

// Immediately log startup for Render diagnostics
console.log('[STARTUP] EZHW server starting...');
console.log(`[STARTUP] NODE_ENV=${process.env.NODE_ENV}, PORT=${process.env.PORT || 5000}`);

(async () => {
  try {
    // Startup migration: Create reference_documents table and add reference_document_ids column idempotently
    try {
      const { pool } = await import('./db');
      
      // Create reference_documents table (safe to rerun)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS reference_documents (
          id serial PRIMARY KEY,
          user_id integer REFERENCES users(id) ON DELETE CASCADE,
          session_id text,
          file_name text NOT NULL,
          mime_type text NOT NULL,
          file_size integer,
          extracted_text text NOT NULL,
          created_at timestamp DEFAULT now()
        )
      `);
      
      // Add reference_document_ids column to assignments (safe to rerun)
      await pool.query(`
        ALTER TABLE assignments
        ADD COLUMN IF NOT EXISTS reference_document_ids integer[] DEFAULT '{}'::integer[]
      `);
      
      console.log('[MIGRATION] Reference documents schema updated successfully');
    } catch (error) {
      console.error('[MIGRATION] Error updating schema:', error);
      // Continue startup even if migration fails - the app should still work
    }

    // Initialize CC pipeline tables (cross-chunk coherence system)
    try {
      const { ensureCCTables } = await import('./services/ccService');
      await ensureCCTables();
    } catch (ccErr: any) {
      console.error('[CC] Table init failed (non-fatal):', ccErr.message);
    }
    
    const server = await registerRoutes(app);

    // Admin routes registered separately — guaranteed to run after registerRoutes
    // and before Vite's catch-all, so /api/admin/* is never intercepted by the SPA
    registerAdminRoutes(app);

    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";

      res.status(status).json({ message });
      throw err;
    });

    // importantly only setup vite in development and after
    // setting up all the other routes so the catch-all route
    // doesn't interfere with the other routes
    if (app.get("env") === "development") {
      await setupVite(app, server);
    } else {
      serveStatic(app);
    }

    // serve on port 5000 in development, or PORT environment variable in production
    // this serves both the API and the client.
    const port = process.env.PORT ? parseInt(process.env.PORT) : 5000;
    server.listen(port, "0.0.0.0", () => {
      log(`serving on port ${port}`);
      console.log(`[STARTUP] Server successfully bound to port ${port}`);
    });
  } catch (error) {
    console.error('[STARTUP] Fatal error during server startup:', error);
    process.exit(1);
  }
})();
