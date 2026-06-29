import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  console.error('[DB] DATABASE_URL is not set. Database features will not work.');
}

// Add connection timeout and error handling for Render deployment
export const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL || '',
  connectionTimeoutMillis: 10000, // 10 second timeout
  idleTimeoutMillis: 30000,
  max: 10
});

// Log connection errors instead of crashing
pool.on('error', (err) => {
  console.error('[DB] Pool error:', err.message);
});

export const db = drizzle({ client: pool, schema });