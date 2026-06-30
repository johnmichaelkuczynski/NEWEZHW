---
name: Deployment healthcheck & drizzle db:push quirks (EZHW)
description: Two recurring traps — autoscale healthcheck 500s during startup are normal, and db:push hangs on the connect-pg-simple session table.
---

## Autoscale healthcheck 500 / connection-refused during startup is NORMAL
The deployment proxy forwards external 80 → local 5000 (logged as a mapped port like 1104). Before the app calls `server.listen`, healthchecks on `/` log "connection refused" then "returned status 500" — that is the proxy responding while no backend is bound, NOT an app error.
**Why:** the app does ~5-8s of startup work (DB migrations, ensureCCTables) before binding. Once "serving on port 5000" appears and `/api/*` requests log 200, the deploy is healthy.
**How to apply:** Do NOT keep re-editing `.replit` in response to startup-window 500s. Confirm health by fetching deployment logs AFTER "serving on port" and looking for successful 200 responses + absence of repeated "starting up user application" restarts. Rollout transitions briefly show 500s while the old instance is terminated and the new one boots.

## drizzle-kit push hangs on the connect-pg-simple `session` table
The app stores sessions via `connect-pg-simple` with `tableName: 'session'`, `createTableIfMissing: true` (server/routes.ts). That table is created at runtime, NOT in the Drizzle schema, so `drizzle-kit push` sees it as extraneous and interactively prompts to drop it ("delete session table with N items"). With stdin closed (post-merge), it hangs → timeout.
**Why:** runtime-created tables not present in `shared/schema.ts` look like drift to drizzle-kit.
**How to apply:** Keep the `session` table declared in `shared/schema.ts` (sid varchar PK, sess json, expire timestamp(6), index IDX_session_expire on expire) so push never wants to drop it. Post-merge script uses `npm run db:push -- --force` for non-interactive runs. Any future runtime-created table must likewise be declared in schema or push will prompt.
