import { pgTable, text, serial, integer, boolean, timestamp, varchar, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

// Users table for authentication (with proper user isolation)
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 255 }).unique().notNull(),
  password: text("password").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Reference documents table with proper user isolation
export const referenceDocuments = pgTable("reference_documents", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  sessionId: text("session_id"), // for anonymous users
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSize: integer("file_size"),
  extractedText: text("extracted_text").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Assignments table with proper user isolation (CASCADE DELETE for security)
export const assignments = pgTable("assignments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  sessionId: text("session_id"), // for anonymous users
  title: text("title"), // Short title for display in saved assignments list
  inputText: text("input_text"),
  inputType: text("input_type").notNull(), // 'text', 'image', 'pdf', 'doc'
  fileName: text("file_name"),
  extractedText: text("extracted_text"),
  llmProvider: text("llm_provider").notNull(), // 'anthropic', 'openai', 'perplexity'
  llmResponse: text("llm_response"),
  grade: text("grade"), // Grade feedback from grading assistant
  graphData: text("graph_data").array(), // JSON strings containing graph configuration and data
  graphImages: text("graph_images").array(), // base64 encoded graph images
  referenceDocumentIds: integer("reference_document_ids").array().default([]), // references to reference_documents
  processingTime: integer("processing_time"), // in milliseconds
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Grades table - stores grading history for assignments
export const grades = pgTable("grades", {
  id: serial("id").primaryKey(),
  assignmentId: integer("assignment_id").references(() => assignments.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  sessionId: text("session_id"),
  gradeText: text("grade_text").notNull(),
  gradeScore: text("grade_score"),
  llmProvider: text("llm_provider"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Rewrites table - stores rewrite/perfector history for assignments
export const rewrites = pgTable("rewrites", {
  id: serial("id").primaryKey(),
  assignmentId: integer("assignment_id").references(() => assignments.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  sessionId: text("session_id"),
  rewriteText: text("rewrite_text").notNull(),
  basedOnGradeId: integer("based_on_grade_id").references(() => grades.id, { onDelete: "set null" }),
  llmProvider: text("llm_provider"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertReferenceDocumentSchema = createInsertSchema(referenceDocuments).omit({
  id: true,
  createdAt: true,
});

export const insertAssignmentSchema = createInsertSchema(assignments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertGradeSchema = createInsertSchema(grades).omit({
  id: true,
  createdAt: true,
});

export const insertRewriteSchema = createInsertSchema(rewrites).omit({
  id: true,
  createdAt: true,
});

export type InsertReferenceDocument = z.infer<typeof insertReferenceDocumentSchema>;
export type ReferenceDocument = typeof referenceDocuments.$inferSelect;
export type InsertAssignment = z.infer<typeof insertAssignmentSchema>;
export type Assignment = typeof assignments.$inferSelect;
export type InsertGrade = z.infer<typeof insertGradeSchema>;
export type Grade = typeof grades.$inferSelect;
export type InsertRewrite = z.infer<typeof insertRewriteSchema>;
export type Rewrite = typeof rewrites.$inferSelect;

// API request/response types
export const processAssignmentSchema = z.object({
  inputText: z.string().optional(),
  inputType: z.enum(['text', 'image', 'pdf', 'doc']),
  fileName: z.string().optional(),
  llmProvider: z.enum(['anthropic', 'openai', 'azure', 'perplexity', 'deepseek', 'grok']),
  fileData: z.string().optional(), // base64 encoded file data
  sessionId: z.string().optional(), // for anonymous users
  referenceDocumentIds: z.array(z.number()).default([]), // for whole-document processing
  forcePhilosopher: z.boolean().optional().default(false), // force philosopher API enrichment
});

export type ProcessAssignmentRequest = z.infer<typeof processAssignmentSchema>;

export const processAssignmentResponseSchema = z.object({
  id: z.number(),
  extractedText: z.string().optional(),
  llmResponse: z.string(),
  graphData: z.array(z.string()).optional(),
  graphImages: z.array(z.string()).optional(),
  processingTime: z.number(),
  success: z.boolean(),
  isPreview: z.boolean().optional(), // Flag for freemium preview mode
});

export type ProcessAssignmentResponse = z.infer<typeof processAssignmentResponseSchema>;

export const emailSolutionSchema = z.object({
  email: z.string().email(),
  extractedText: z.string().optional(),
  llmResponse: z.string().optional(),
  provider: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
});

export type EmailSolutionRequest = z.infer<typeof emailSolutionSchema>;

export const assignmentListSchema = z.object({
  id: z.number(),
  extractedText: z.string().nullable(),
  llmProvider: z.string(),
  processingTime: z.number(),
  createdAt: z.string(),
  fileName: z.string().nullable(),
});

export type AssignmentListItem = z.infer<typeof assignmentListSchema>;

// User authentication schemas
export const registerSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
  sessionId: z.string().optional(), // for migrating anonymous assignments
});

export const loginSchema = z.object({
  username: z.string(),
  password: z.string().optional(),
  sessionId: z.string().optional(), // for migrating anonymous assignments
});

export const userResponseSchema = z.object({
  id: z.number(),
  username: z.string(),
  tokenBalance: z.number(),
});

export type RegisterRequest = z.infer<typeof registerSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
export type UserResponse = z.infer<typeof userResponseSchema>;

// GPT BYPASS / Humanization schemas
export const documents = pgTable("documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  filename: text("filename").notNull(),
  content: text("content").notNull(),
  wordCount: integer("word_count").notNull(),
  aiScore: integer("ai_score"),
  createdAt: timestamp("created_at").default(sql`now()`),
});

export const rewriteJobs = pgTable("rewrite_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  inputText: text("input_text").notNull(),
  styleText: text("style_text"),
  contentMixText: text("content_mix_text"),
  customInstructions: text("custom_instructions"),
  selectedPresets: jsonb("selected_presets").$type<string[]>(),
  provider: text("provider").notNull(),
  chunks: jsonb("chunks").$type<TextChunk[]>(),
  selectedChunkIds: jsonb("selected_chunk_ids").$type<string[]>(),
  mixingMode: text("mixing_mode").$type<'style' | 'content' | 'both'>(),
  outputText: text("output_text"),
  inputAiScore: integer("input_ai_score"),
  outputAiScore: integer("output_ai_score"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").default(sql`now()`),
});

export const insertDocumentSchema = createInsertSchema(documents).omit({
  id: true,
  createdAt: true,
});

export const insertRewriteJobSchema = createInsertSchema(rewriteJobs).omit({
  id: true,
  createdAt: true,
});

export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documents.$inferSelect;
export type InsertRewriteJob = z.infer<typeof insertRewriteJobSchema>;
export type RewriteJob = typeof rewriteJobs.$inferSelect;

// GPT BYPASS API request/response types
export const rewriteRequestSchema = z.object({
  inputText: z.string(),
  styleText: z.string().optional(),
  contentMixText: z.string().optional(),
  customInstructions: z.string().optional(),
  selectedPresets: z.array(z.string()).optional(),
  provider: z.enum(['openai', 'anthropic', 'deepseek', 'perplexity']),
  selectedChunkIds: z.array(z.string()).optional(),
  mixingMode: z.enum(['style_only', 'content_mix', 'hybrid']).optional(),
});

export const rewriteResponseSchema = z.object({
  rewrittenText: z.string(),
  inputAiScore: z.number(),
  outputAiScore: z.number(),
  jobId: z.string(),
});

export type RewriteRequest = z.infer<typeof rewriteRequestSchema>;
export type RewriteResponse = z.infer<typeof rewriteResponseSchema>;

// Stripe payments table
export const stripePayments = pgTable("stripe_payments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  stripeSessionId: text("stripe_session_id").notNull().unique(),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  amount: integer("amount").notNull(),
  tokens: integer("tokens").notNull(),
  status: text("status").notNull().default("pending"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
  completedAt: timestamp("completed_at"),
});

// Stripe events table for idempotency tracking
export const stripeEvents = pgTable("stripe_events", {
  eventId: text("event_id").primaryKey(), // Stripe event ID
  eventType: text("event_type").notNull(),
  processed: boolean("processed").notNull().default(false),
  sessionId: text("session_id"), // Optional reference to session
  paymentIntentId: text("payment_intent_id"), // Optional reference to payment intent
  createdAt: timestamp("created_at").default(sql`now()`),
});

export const insertStripePaymentSchema = createInsertSchema(stripePayments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertStripeEventSchema = createInsertSchema(stripeEvents).omit({
  createdAt: true,
});

export type StripePayment = typeof stripePayments.$inferSelect;
export type InsertStripePayment = z.infer<typeof insertStripePaymentSchema>;
export type StripeEvent = typeof stripeEvents.$inferSelect;
export type InsertStripeEvent = z.infer<typeof insertStripeEventSchema>;

// Payment schemas
export const purchaseCreditsSchema = z.object({
  amount: z.enum(['1', '10', '100', '1000']),
});

export type PurchaseCreditsRequest = z.infer<typeof purchaseCreditsSchema>;

// Token usage tracking
export const tokenCheckSchema = z.object({
  inputText: z.string(),
  sessionId: z.string().optional(),
});

export const tokenUsageResponseSchema = z.object({
  canProcess: z.boolean(),
  inputTokens: z.number(),
  estimatedOutputTokens: z.number(),
  remainingBalance: z.number().optional(),
  dailyUsage: z.number().optional(),
  dailyLimit: z.number().optional(),
  message: z.string().optional(),
});

export type TokenCheckRequest = z.infer<typeof tokenCheckSchema>;
export type TokenUsageResponse = z.infer<typeof tokenUsageResponseSchema>;

// Insert schemas for new tables
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export const insertTokenUsageSchema = createInsertSchema(tokenUsage).omit({
  id: true,
  createdAt: true,
});

export const insertDailyUsageSchema = createInsertSchema(dailyUsage).omit({
  id: true,
  createdAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertTokenUsage = z.infer<typeof insertTokenUsageSchema>;
export type InsertDailyUsage = z.infer<typeof insertDailyUsageSchema>;
export type User = typeof users.$inferSelect;
export type TokenUsage = typeof tokenUsage.$inferSelect;
export type DailyUsage = typeof dailyUsage.$inferSelect;

// GPT BYPASS interfaces
export interface TextChunk {
  id: string;
  content: string;
  startWord: number;
  endWord: number;
  aiScore?: number;
}

export interface InstructionPreset {
  id: string;
  name: string;
  description: string;
  category: string;
  instruction: string;
}

export interface WritingSample {
  id: string;
  name: string;
  preview: string;
  content: string;
  category: string;
}

export interface AIProviderConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'perplexity';
  model?: string;
}

export interface RewriteRequest {
  inputText: string;
  styleText?: string;
  contentMixText?: string;
  customInstructions?: string;
  selectedPresets?: string[];
  provider: string;
  selectedChunkIds?: string[];
  mixingMode?: 'style' | 'content' | 'both';
}

export interface RewriteResponse {
  rewrittenText: string;
  inputAiScore: number;
  outputAiScore: number;
  jobId: string;
}

// ============================================================================
// PROJECTS SYSTEM - Long-term project workspaces with Tractatus Tree memory
// ============================================================================

// Projects table — holds the Tractatus tree for per-project persistent memory
export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  tractatusTree: jsonb("tractatus_tree").$type<Record<string, string>>().default({}),
  tractatusTier: integer("tractatus_tier").default(1),
  parentProjectId: integer("parent_project_id"), // for compressed summary tiers (tier 2+)
  lastTreeUpdate: timestamp("last_tree_update"),
  compressionCount: integer("compression_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

// Project sessions — individual chat sessions within a project, transcript stored inline
export const projectSessions = pgTable("project_sessions", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").default("New Session"),
  transcript: jsonb("transcript").$type<Array<{ role: string; content: string; ts: string }>>().default([]),
  createdAt: timestamp("created_at").defaultNow(),
});

// Tractatus archive — pre-compression snapshots for recovery and audit
export const tractatusArchive = pgTable("tractatus_archive", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
  tier: integer("tier").notNull(),
  tree: jsonb("tree").$type<Record<string, string>>().notNull(),
  nodeCount: integer("node_count"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Insert schemas for project tables
export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  createdAt: true,
});

export const insertProjectSessionSchema = createInsertSchema(projectSessions).omit({
  id: true,
  createdAt: true,
});

export const insertTractatusArchiveSchema = createInsertSchema(tractatusArchive).omit({
  id: true,
  createdAt: true,
});

export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projects.$inferSelect;
export type InsertProjectSession = z.infer<typeof insertProjectSessionSchema>;
export type ProjectSession = typeof projectSessions.$inferSelect;
export type InsertTractatusArchive = z.infer<typeof insertTractatusArchiveSchema>;
export type TractatusArchive = typeof tractatusArchive.$inferSelect;

// Tractatus tag vocabulary for type safety
export type TractatusTag = "ASSERTS" | "REJECTS" | "ASSUMES" | "OPEN" | "RESOLVED" | "DOCUMENT" | "QUESTION";

// ============================================================================
// COHERENCE SYSTEM TABLES - For large document processing with global coherence
// ============================================================================

// Coherent sessions - tracks the overall processing session
export const coherentSessions = pgTable("coherent_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  sessionType: varchar("session_type", { length: 50 }).notNull(), // 'research', 'homework', 'rewrite', 'analysis'
  userPrompt: text("user_prompt").notNull(),
  globalSkeleton: jsonb("global_skeleton"), // populated after skeleton pass
  taskInvariants: jsonb("task_invariants"), // HARD constraints that must not be violated
  status: varchar("status", { length: 20 }).default("pending"), // 'pending', 'skeleton_complete', 'chunking', 'stitching', 'complete', 'failed'
  totalChunks: integer("total_chunks").default(0),
  processedChunks: integer("processed_chunks").default(0),
  taskComplete: boolean("task_complete").default(false), // true when all task clauses are instantiated
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Coherent chunks - individual chunks with their outputs and deltas
export const coherentChunks = pgTable("coherent_chunks", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").references(() => coherentSessions.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  chunkType: varchar("chunk_type", { length: 10 }).notNull(), // 'input' or 'output'
  chunkText: text("chunk_text").notNull(),
  chunkOutput: text("chunk_output"), // generated content for this chunk
  chunkDelta: jsonb("chunk_delta"), // what changed: new claims, removed claims, conflicts, terms introduced
  processedAt: timestamp("processed_at"),
});

// Stitch results - cross-chunk coherence validation
export const stitchResults = pgTable("stitch_results", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").references(() => coherentSessions.id, { onDelete: "cascade" }),
  conflicts: jsonb("conflicts"), // cross-chunk contradictions detected
  repairs: jsonb("repairs"), // proposed fixes
  finalValidation: jsonb("final_validation"), // completeness check
  coherenceScore: varchar("coherence_score", { length: 20 }), // 'pass' or 'needs_repair'
  createdAt: timestamp("created_at").defaultNow(),
});

// Insert schemas for coherence tables
export const insertCoherentSessionSchema = createInsertSchema(coherentSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertCoherentChunkSchema = createInsertSchema(coherentChunks).omit({
  id: true,
});

export const insertStitchResultSchema = createInsertSchema(stitchResults).omit({
  id: true,
  createdAt: true,
});

// Types for coherence system
export type InsertCoherentSession = z.infer<typeof insertCoherentSessionSchema>;
export type CoherentSession = typeof coherentSessions.$inferSelect;
export type InsertCoherentChunk = z.infer<typeof insertCoherentChunkSchema>;
export type CoherentChunk = typeof coherentChunks.$inferSelect;
export type InsertStitchResult = z.infer<typeof insertStitchResultSchema>;
export type StitchResult = typeof stitchResults.$inferSelect;

// Skeleton structure type
export interface GlobalSkeleton {
  thesis: string;
  outline: string[];
  keyTerms: Record<string, string>;
  commitments: string[];
  entities: string[];
  methodology: string;
  targetConclusion: string;
}

// Task invariants - HARD constraints that trigger veto if violated
export interface TaskInvariants {
  invariants: string[]; // Boolean rules, not themes (e.g., "Output must concern ONLY neurosis vs psychosis")
  forbiddenTopics: string[]; // Topics that trigger immediate veto (e.g., "AI", "policy", "ethics")
  requiredElements: string[]; // Elements that MUST appear (e.g., each contention to address)
  antiElaboration: string; // Explicit instruction against adding new topics
}

// Chunk delta type
export interface ChunkDelta {
  claimsAdded: string[];
  claimsRemoved: string[];
  termsIntroduced: Record<string, string>;
  conflictsDetected: string[];
  continuityNotes: string;
}

// Stitch result type
export interface StitchValidation {
  crossChunkConflicts: string[];
  termDrift: string[];
  missingPremises: string[];
  repairPlan: Array<{ chunkIndex: number; issue: string; fix: string }>;
  coherenceScore: "pass" | "needs_repair";
}
