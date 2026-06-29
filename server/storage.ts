import { assignments, users, tokenUsage, dailyUsage, documents, rewriteJobs, stripePayments, stripeEvents, referenceDocuments, grades, rewrites, projects, projectSessions, tractatusArchive, type Assignment, type InsertAssignment, type User, type InsertUser, type TokenUsage, type InsertTokenUsage, type DailyUsage, type InsertDailyUsage, type Document, type InsertDocument, type RewriteJob, type InsertRewriteJob, type StripePayment, type InsertStripePayment, type StripeEvent, type InsertStripeEvent, type ReferenceDocument, type InsertReferenceDocument, type Grade, type InsertGrade, type Rewrite, type InsertRewrite, type Project, type InsertProject, type ProjectSession, type InsertProjectSession, type TractatusArchive, type InsertTractatusArchive } from "@shared/schema";
import { db } from "./db";
import { eq, isNull, and, sum, desc } from "drizzle-orm";

export interface IStorage {
  // Assignment methods with user isolation
  createAssignment(assignment: InsertAssignment): Promise<Assignment>;
  getAssignment(id: number, userId?: number, sessionId?: string): Promise<Assignment | undefined>;
  getAllAssignments(userId?: number, sessionId?: string): Promise<Assignment[]>;
  updateAssignment(id: number, updates: Partial<InsertAssignment>, userId?: number, sessionId?: string): Promise<Assignment | undefined>;
  deleteAssignment(id: number, userId?: number, sessionId?: string): Promise<void>;
  deleteAllAssignments(userId?: number, sessionId?: string): Promise<void>;
  cleanupEmptyAssignments(): Promise<void>;
  
  // User management methods
  createUser(user: InsertUser): Promise<User>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserById(id: number): Promise<User | undefined>;
  updateUserTokenBalance(userId: number, balance: number): Promise<void>;
  
  // Token usage methods
  createTokenUsage(usage: InsertTokenUsage): Promise<TokenUsage>;
  getDailyUsage(sessionId: string, date: string): Promise<DailyUsage | undefined>;
  createOrUpdateDailyUsage(sessionId: string, date: string, tokens: number): Promise<void>;
  getUserTokenBalance(userId: number): Promise<number>;
  
  // Anonymous to authenticated user migration
  migrateAnonymousAssignments(sessionId: string, userId: number): Promise<Assignment[]>;
  
  // GPT BYPASS / Humanization methods
  createDocument(document: InsertDocument): Promise<Document>;
  getDocument(id: string): Promise<Document | undefined>;
  createRewriteJob(job: InsertRewriteJob): Promise<RewriteJob>;
  getRewriteJob(id: string): Promise<RewriteJob | undefined>;
  updateRewriteJob(id: string, updates: Partial<RewriteJob>): Promise<void>;
  getRewriteJobs(limit?: number): Promise<RewriteJob[]>;
  
  // Stripe payment methods
  createStripePayment(payment: InsertStripePayment): Promise<StripePayment>;
  getStripePaymentBySessionId(sessionId: string): Promise<StripePayment | undefined>;
  getAllStripePayments?(): Promise<StripePayment[]>;
  updateStripePaymentStatus(sessionId: string, status: string): Promise<void>;
  updateStripePaymentMetadata?(sessionId: string, metadata: any): Promise<void>;
  completeStripePaymentAndCredit(sessionId: string, userId: number, tokens: number): Promise<{ alreadyCompleted: boolean; newBalance?: number }>;
  
  // Stripe event idempotency methods
  createStripeEvent(event: InsertStripeEvent): Promise<StripeEvent>;
  isEventProcessed(eventId: string): Promise<boolean>;

  // Reference document methods
  createReferenceDocument(document: InsertReferenceDocument): Promise<ReferenceDocument>;
  getReferenceDocument(id: number, userId?: number, sessionId?: string): Promise<ReferenceDocument | undefined>;
  getAllReferenceDocuments(userId?: number, sessionId?: string): Promise<ReferenceDocument[]>;
  deleteReferenceDocument(id: number, userId?: number, sessionId?: string): Promise<void>;

  // Grade methods
  createGrade(grade: InsertGrade): Promise<Grade>;
  getGradesByAssignment(assignmentId: number): Promise<Grade[]>;
  getAllGrades(userId?: number, sessionId?: string): Promise<Grade[]>;

  // Rewrite methods  
  createRewrite(rewrite: InsertRewrite): Promise<Rewrite>;
  getRewritesByAssignment(assignmentId: number): Promise<Rewrite[]>;
  getAllRewrites(userId?: number, sessionId?: string): Promise<Rewrite[]>;

  // Project methods (Tractatus Tree long-term workspace)
  createProject(project: InsertProject): Promise<Project>;
  getProject(id: number, userId?: number): Promise<Project | undefined>;
  getAllProjects(userId?: number): Promise<Project[]>;
  updateProject(id: number, updates: Partial<InsertProject>, userId?: number): Promise<Project | undefined>;
  deleteProject(id: number, userId?: number): Promise<void>;

  // Project session methods
  createProjectSession(session: InsertProjectSession): Promise<ProjectSession>;
  getProjectSession(id: number): Promise<ProjectSession | undefined>;
  getAllProjectSessions(projectId: number): Promise<ProjectSession[]>;
  updateProjectSession(id: number, updates: Partial<InsertProjectSession>): Promise<ProjectSession | undefined>;
  deleteProjectSession(id: number): Promise<void>;

  // Tractatus archive
  createTractatusArchive(archive: InsertTractatusArchive): Promise<TractatusArchive>;
  getTractatusArchives(projectId: number): Promise<TractatusArchive[]>;
}

export class DatabaseStorage implements IStorage {
  async createAssignment(insertAssignment: InsertAssignment): Promise<Assignment> {
    const [assignment] = await db
      .insert(assignments)
      .values(insertAssignment)
      .returning();
    return assignment;
  }

  async getAssignment(id: number, userId?: number, sessionId?: string): Promise<Assignment | undefined> {
    const conditions = [eq(assignments.id, id)];
    
    // SECURITY: Always enforce user isolation for authenticated users
    if (userId) {
      conditions.push(eq(assignments.userId, userId));
    } else {
      // For anonymous users, enforce sessionId isolation to prevent cross-session access
      conditions.push(isNull(assignments.userId));
      if (sessionId) {
        conditions.push(eq(assignments.sessionId, sessionId));
      } else {
        // No sessionId for anonymous user - return undefined for security
        return undefined;
      }
    }
    
    const [assignment] = await db.select().from(assignments).where(and(...conditions));
    return assignment || undefined;
  }

  async getAllAssignments(userId?: number, sessionId?: string): Promise<Assignment[]> {
    const conditions = [];
    
    // SECURITY: Always enforce user isolation for authenticated users
    if (userId) {
      conditions.push(eq(assignments.userId, userId));
    } else {
      // For anonymous users, only show assignments without a userId AND matching sessionId
      conditions.push(isNull(assignments.userId));
      // CRITICAL SECURITY: Must filter by sessionId to prevent cross-session data leakage
      if (sessionId) {
        conditions.push(eq(assignments.sessionId, sessionId));
      } else {
        // If no sessionId provided for anonymous user, return empty array for security
        return [];
      }
    }
    
    return await db.select().from(assignments).where(and(...conditions)).orderBy(assignments.createdAt);
  }

  async updateAssignment(id: number, updates: Partial<InsertAssignment>, userId?: number, sessionId?: string): Promise<Assignment | undefined> {
    const conditions = [eq(assignments.id, id)];
    
    // SECURITY: Always enforce user isolation for authenticated users
    if (userId) {
      conditions.push(eq(assignments.userId, userId));
    } else {
      // For anonymous users, enforce sessionId isolation to prevent cross-session updates
      conditions.push(isNull(assignments.userId));
      if (sessionId) {
        conditions.push(eq(assignments.sessionId, sessionId));
      } else {
        // No sessionId for anonymous user - don't update anything for security
        return undefined;
      }
    }
    
    const [updatedAssignment] = await db
      .update(assignments)
      .set(updates)
      .where(and(...conditions))
      .returning();
    
    return updatedAssignment || undefined;
  }

  async deleteAssignment(id: number, userId?: number, sessionId?: string): Promise<void> {
    const conditions = [eq(assignments.id, id)];
    
    // SECURITY: Always enforce user isolation for authenticated users
    if (userId) {
      conditions.push(eq(assignments.userId, userId));
    } else {
      // For anonymous users, enforce sessionId isolation to prevent cross-session deletion
      conditions.push(isNull(assignments.userId));
      if (sessionId) {
        conditions.push(eq(assignments.sessionId, sessionId));
      } else {
        // No sessionId for anonymous user - don't delete anything for security
        return;
      }
    }
    
    await db.delete(assignments).where(and(...conditions));
  }

  async cleanupEmptyAssignments(): Promise<void> {
    // Empty assignments already cleaned via SQL
    return;
  }

  // User management methods
  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async getUserById(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async updateUserTokenBalance(userId: number, balance: number): Promise<void> {
    await db
      .update(users)
      .set({ tokenBalance: balance })
      .where(eq(users.id, userId));
  }

  // Token usage methods
  async createTokenUsage(insertUsage: InsertTokenUsage): Promise<TokenUsage> {
    const [usage] = await db
      .insert(tokenUsage)
      .values(insertUsage)
      .returning();
    return usage;
  }

  async getDailyUsage(sessionId: string, date: string): Promise<DailyUsage | undefined> {
    const [usage] = await db
      .select()
      .from(dailyUsage)
      .where(and(eq(dailyUsage.sessionId, sessionId), eq(dailyUsage.date, date)));
    return usage || undefined;
  }

  async createOrUpdateDailyUsage(sessionId: string, date: string, tokens: number): Promise<void> {
    const existing = await this.getDailyUsage(sessionId, date);
    
    if (existing) {
      await db
        .update(dailyUsage)
        .set({ totalTokens: (existing.totalTokens || 0) + tokens })
        .where(eq(dailyUsage.id, existing.id));
    } else {
      await db
        .insert(dailyUsage)
        .values({ sessionId, date, totalTokens: tokens });
    }
  }

  async getUserTokenBalance(userId: number): Promise<number> {
    const user = await this.getUserById(userId);
    return user?.tokenBalance || 0;
  }

  // Anonymous to authenticated user migration
  async migrateAnonymousAssignments(sessionId: string, userId: number): Promise<Assignment[]> {
    // Find all assignments for the anonymous session that don't have a userId
    const anonymousAssignments = await db
      .select()
      .from(assignments)
      .where(and(
        eq(assignments.sessionId, sessionId),
        isNull(assignments.userId)
      ));

    if (anonymousAssignments.length === 0) {
      return [];
    }

    // Update all anonymous assignments to be owned by the authenticated user
    const updatedAssignments = await db
      .update(assignments)
      .set({ userId })
      .where(and(
        eq(assignments.sessionId, sessionId),
        isNull(assignments.userId)
      ))
      .returning();

    console.log(`Migrated ${updatedAssignments.length} anonymous assignments to user ${userId}`);
    return updatedAssignments;
  }

  // GPT BYPASS / Humanization methods
  async createDocument(insertDocument: InsertDocument): Promise<Document> {
    const [document] = await db
      .insert(documents)
      .values(insertDocument)
      .returning();
    return document;
  }

  async getDocument(id: number): Promise<Document | undefined> {
    const [document] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, id));
    return document || undefined;
  }

  async createRewriteJob(insertJob: InsertRewriteJob): Promise<RewriteJob> {
    const [job] = await db
      .insert(rewriteJobs)
      .values(insertJob)
      .returning();
    return job;
  }

  async getRewriteJob(id: string): Promise<RewriteJob | undefined> {
    const [job] = await db
      .select()
      .from(rewriteJobs)
      .where(eq(rewriteJobs.id, id));
    return job || undefined;
  }

  async updateRewriteJob(id: string, updates: Partial<RewriteJob>): Promise<void> {
    await db
      .update(rewriteJobs)
      .set(updates)
      .where(eq(rewriteJobs.id, id));
  }

  async getRewriteJobs(limit: number = 20): Promise<RewriteJob[]> {
    return await db
      .select()
      .from(rewriteJobs)
      .orderBy(rewriteJobs.createdAt)
      .limit(limit);
  }
  
  // Stripe payment methods
  async createStripePayment(insertPayment: InsertStripePayment): Promise<StripePayment> {
    const [payment] = await db
      .insert(stripePayments)
      .values(insertPayment)
      .returning();
    return payment;
  }

  async getStripePaymentBySessionId(sessionId: string): Promise<StripePayment | undefined> {
    const [payment] = await db
      .select()
      .from(stripePayments)
      .where(eq(stripePayments.stripeSessionId, sessionId));
    return payment || undefined;
  }

  async updateStripePaymentStatus(sessionId: string, status: string): Promise<void> {
    await db
      .update(stripePayments)
      .set({ 
        status,
        updatedAt: new Date(),
        completedAt: status === 'completed' ? new Date() : undefined
      })
      .where(eq(stripePayments.stripeSessionId, sessionId));
  }
  
  async completeStripePaymentAndCredit(sessionId: string, userId: number, tokens: number): Promise<{ alreadyCompleted: boolean; newBalance?: number }> {
    // Use a transaction with proper concurrency control
    return await db.transaction(async (tx) => {
      let paymentId: number | null = null;
      let updatedRows = 0;
      
      // First, try to atomically claim the payment by updating status from non-completed to completed
      const existingPayments = await tx
        .select()
        .from(stripePayments)
        .where(eq(stripePayments.stripeSessionId, sessionId));
      
      if (existingPayments.length > 0) {
        const existingPayment = existingPayments[0];
        
        if (existingPayment.status === 'completed') {
          // Already completed - safe to return early
          return { alreadyCompleted: true };
        }
        
        // Conditionally update to completed ONLY if current status is not completed
        const result = await tx
          .update(stripePayments)
          .set({ 
            status: 'completed',
            updatedAt: new Date(),
            completedAt: new Date()
          })
          .where(and(
            eq(stripePayments.stripeSessionId, sessionId),
            eq(stripePayments.status, existingPayment.status) // Only update if status hasn't changed
          ))
          .returning({ id: stripePayments.id });
        
        updatedRows = result.length;
        if (updatedRows > 0) {
          paymentId = result[0].id;
        }
      } else {
        // No existing payment - try to insert as completed with conflict handling
        try {
          const result = await tx
            .insert(stripePayments)
            .values({
              userId,
              stripeSessionId: sessionId,
              amount: 30, // Default amount
              tokens,
              status: 'completed',
              completedAt: new Date(),
              metadata: { webhookCreated: true }
            })
            .returning({ id: stripePayments.id });
          
          paymentId = result[0].id;
          updatedRows = 1;
        } catch (error) {
          // If unique constraint violation, another webhook won the race
          if (error.message?.includes('unique') || error.code === '23505') {
            return { alreadyCompleted: true };
          }
          throw error;
        }
      }
      
      // Only credit tokens if we successfully claimed the payment (updated or inserted)
      if (updatedRows === 0) {
        return { alreadyCompleted: true };
      }
      
      // Get current user balance and credit tokens
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, userId));
      
      if (!user) {
        throw new Error(`User ${userId} not found`);
      }
      
      const newBalance = (user.tokenBalance || 0) + tokens;
      
      await tx
        .update(users)
        .set({ tokenBalance: newBalance })
        .where(eq(users.id, userId));
      
      return { alreadyCompleted: false, newBalance };
    });
  }
  
  async createStripeEvent(insertEvent: InsertStripeEvent): Promise<StripeEvent> {
    const [event] = await db
      .insert(stripeEvents)
      .values(insertEvent)
      .returning();
    return event;
  }
  
  async getAllStripePayments(): Promise<StripePayment[]> {
    return await db
      .select()
      .from(stripePayments)
      .orderBy(stripePayments.createdAt);
  }
  
  async updateStripePaymentMetadata(sessionId: string, metadata: any): Promise<void> {
    await db
      .update(stripePayments)
      .set({ 
        metadata,
        updatedAt: new Date()
      })
      .where(eq(stripePayments.stripeSessionId, sessionId));
  }
  
  async isEventProcessed(eventId: string): Promise<boolean> {
    const [event] = await db
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.eventId, eventId));
    return !!event;
  }

  // Bulk delete assignments for user cleanup
  async deleteAllAssignments(userId?: number, sessionId?: string): Promise<void> {
    const conditions = [];
    
    // SECURITY: Always enforce user isolation for authenticated users
    if (userId) {
      conditions.push(eq(assignments.userId, userId));
    } else {
      // For anonymous users, enforce sessionId isolation to prevent cross-session access
      conditions.push(isNull(assignments.userId));
      if (sessionId) {
        conditions.push(eq(assignments.sessionId, sessionId));
      } else {
        // No sessionId for anonymous user - don't delete anything for security
        return;
      }
    }

    await db.delete(assignments).where(and(...conditions));
  }

  // Reference document CRUD operations with user isolation
  async createReferenceDocument(insertDocument: InsertReferenceDocument): Promise<ReferenceDocument> {
    const [document] = await db
      .insert(referenceDocuments)
      .values(insertDocument)
      .returning();
    return document;
  }

  async getReferenceDocument(id: number, userId?: number, sessionId?: string): Promise<ReferenceDocument | undefined> {
    const conditions = [eq(referenceDocuments.id, id)];
    
    // SECURITY: Always enforce user isolation for authenticated users
    if (userId) {
      conditions.push(eq(referenceDocuments.userId, userId));
    } else {
      // For anonymous users, enforce sessionId isolation to prevent cross-session access
      conditions.push(isNull(referenceDocuments.userId));
      if (sessionId) {
        conditions.push(eq(referenceDocuments.sessionId, sessionId));
      } else {
        // No sessionId for anonymous user - return undefined for security
        return undefined;
      }
    }
    
    const [document] = await db
      .select()
      .from(referenceDocuments)
      .where(and(...conditions));
    return document;
  }

  async getAllReferenceDocuments(userId?: number, sessionId?: string): Promise<ReferenceDocument[]> {
    const conditions = [];
    
    // SECURITY: Always enforce user isolation for authenticated users
    if (userId) {
      conditions.push(eq(referenceDocuments.userId, userId));
    } else {
      // For anonymous users, enforce sessionId isolation to prevent cross-session access
      conditions.push(isNull(referenceDocuments.userId));
      if (sessionId) {
        conditions.push(eq(referenceDocuments.sessionId, sessionId));
      } else {
        // No sessionId for anonymous user - return empty array for security
        return [];
      }
    }
    
    return await db
      .select()
      .from(referenceDocuments)
      .where(and(...conditions))
      .orderBy(referenceDocuments.createdAt);
  }

  async deleteReferenceDocument(id: number, userId?: number, sessionId?: string): Promise<void> {
    const conditions = [eq(referenceDocuments.id, id)];
    
    // SECURITY: Always enforce user isolation for authenticated users
    if (userId) {
      conditions.push(eq(referenceDocuments.userId, userId));
    } else {
      // For anonymous users, enforce sessionId isolation to prevent cross-session access
      conditions.push(isNull(referenceDocuments.userId));
      if (sessionId) {
        conditions.push(eq(referenceDocuments.sessionId, sessionId));
      } else {
        // No sessionId for anonymous user - don't delete anything for security
        return;
      }
    }
    
    await db.delete(referenceDocuments).where(and(...conditions));
  }

  // Grade methods
  async createGrade(insertGrade: InsertGrade): Promise<Grade> {
    const [grade] = await db
      .insert(grades)
      .values(insertGrade)
      .returning();
    return grade;
  }

  async getGradesByAssignment(assignmentId: number): Promise<Grade[]> {
    return await db.select().from(grades).where(eq(grades.assignmentId, assignmentId));
  }

  async getAllGrades(userId?: number, sessionId?: string): Promise<Grade[]> {
    const conditions = [];
    if (userId) {
      conditions.push(eq(grades.userId, userId));
    } else if (sessionId) {
      conditions.push(isNull(grades.userId));
      conditions.push(eq(grades.sessionId, sessionId));
    } else {
      return [];
    }
    return await db.select().from(grades).where(and(...conditions));
  }

  // Rewrite methods
  async createRewrite(insertRewrite: InsertRewrite): Promise<Rewrite> {
    const [rewrite] = await db
      .insert(rewrites)
      .values(insertRewrite)
      .returning();
    return rewrite;
  }

  async getRewritesByAssignment(assignmentId: number): Promise<Rewrite[]> {
    return await db.select().from(rewrites).where(eq(rewrites.assignmentId, assignmentId));
  }

  async getAllRewrites(userId?: number, sessionId?: string): Promise<Rewrite[]> {
    const conditions = [];
    if (userId) {
      conditions.push(eq(rewrites.userId, userId));
    } else if (sessionId) {
      conditions.push(isNull(rewrites.userId));
      conditions.push(eq(rewrites.sessionId, sessionId));
    } else {
      return [];
    }
    return await db.select().from(rewrites).where(and(...conditions));
  }

  // ============================================================================
  // Project methods (Tractatus Tree long-term workspace)
  // ============================================================================

  async createProject(insertProject: InsertProject): Promise<Project> {
    const [project] = await db.insert(projects).values(insertProject).returning();
    return project;
  }

  async getProject(id: number, userId?: number): Promise<Project | undefined> {
    const conditions = [eq(projects.id, id)];
    if (userId) conditions.push(eq(projects.userId, userId));
    const [project] = await db.select().from(projects).where(and(...conditions));
    return project;
  }

  async getAllProjects(userId?: number): Promise<Project[]> {
    const conditions = [];
    if (userId) conditions.push(eq(projects.userId, userId));
    // Only return Tier 1 (live) projects — summary tiers are hidden
    conditions.push(eq(projects.tractatusTier, 1));
    return await db.select().from(projects).where(and(...conditions)).orderBy(desc(projects.createdAt));
  }

  async updateProject(id: number, updates: Partial<InsertProject>, userId?: number): Promise<Project | undefined> {
    const conditions = [eq(projects.id, id)];
    if (userId) conditions.push(eq(projects.userId, userId));
    const [updated] = await db.update(projects).set(updates).where(and(...conditions)).returning();
    return updated;
  }

  async deleteProject(id: number, userId?: number): Promise<void> {
    const conditions = [eq(projects.id, id)];
    if (userId) conditions.push(eq(projects.userId, userId));
    await db.delete(projects).where(and(...conditions));
  }

  // ============================================================================
  // Project session methods
  // ============================================================================

  async createProjectSession(insertSession: InsertProjectSession): Promise<ProjectSession> {
    const [session] = await db.insert(projectSessions).values(insertSession).returning();
    return session;
  }

  async getProjectSession(id: number): Promise<ProjectSession | undefined> {
    const [session] = await db.select().from(projectSessions).where(eq(projectSessions.id, id));
    return session;
  }

  async getAllProjectSessions(projectId: number): Promise<ProjectSession[]> {
    return await db
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.projectId, projectId))
      .orderBy(desc(projectSessions.createdAt));
  }

  async updateProjectSession(id: number, updates: Partial<InsertProjectSession>): Promise<ProjectSession | undefined> {
    const [updated] = await db
      .update(projectSessions)
      .set(updates)
      .where(eq(projectSessions.id, id))
      .returning();
    return updated;
  }

  async deleteProjectSession(id: number): Promise<void> {
    await db.delete(projectSessions).where(eq(projectSessions.id, id));
  }

  // ============================================================================
  // Tractatus archive
  // ============================================================================

  async createTractatusArchive(insertArchive: InsertTractatusArchive): Promise<TractatusArchive> {
    const [archive] = await db.insert(tractatusArchive).values(insertArchive).returning();
    return archive;
  }

  async getTractatusArchives(projectId: number): Promise<TractatusArchive[]> {
    return await db
      .select()
      .from(tractatusArchive)
      .where(eq(tractatusArchive.projectId, projectId))
      .orderBy(desc(tractatusArchive.createdAt));
  }
}

export class MemStorage implements IStorage {
  private assignments: Map<number, Assignment>;
  private currentId: number;
  private storageFile: string;

  constructor() {
    this.storageFile = './assignments.json';
    this.assignments = new Map();
    this.currentId = 1;
    this.loadFromFile();
  }

  private loadFromFile() {
    try {
      const fs = require('fs');
      if (fs.existsSync(this.storageFile)) {
        const data = JSON.parse(fs.readFileSync(this.storageFile, 'utf8'));
        this.currentId = data.currentId || 1;
        if (data.assignments) {
          for (const [id, assignment] of Object.entries(data.assignments)) {
            this.assignments.set(Number(id), {
              ...assignment as Assignment,
              createdAt: new Date((assignment as any).createdAt)
            });
          }
        }
      }
    } catch (error) {
      console.log('No existing assignments file found, starting fresh');
    }
  }

  private saveToFile() {
    try {
      import('fs').then(fs => {
        const data = {
          currentId: this.currentId,
          assignments: Object.fromEntries(this.assignments)
        };
        fs.writeFileSync(this.storageFile, JSON.stringify(data, null, 2));
      });
    } catch (error) {
      console.error('Failed to save assignments:', error);
    }
  }

  async createAssignment(insertAssignment: InsertAssignment): Promise<Assignment> {
    const id = this.currentId++;
    const assignment: Assignment = {
      id,
      userId: insertAssignment.userId || null,
      sessionId: insertAssignment.sessionId || null,
      inputText: insertAssignment.inputText || null,
      inputType: insertAssignment.inputType,
      fileName: insertAssignment.fileName || null,
      extractedText: insertAssignment.extractedText || null,
      llmProvider: insertAssignment.llmProvider,
      llmResponse: insertAssignment.llmResponse || null,
      graphData: insertAssignment.graphData || null,
      graphImages: insertAssignment.graphImages || null,
      processingTime: insertAssignment.processingTime || null,
      inputTokens: insertAssignment.inputTokens || null,
      outputTokens: insertAssignment.outputTokens || null,
      createdAt: new Date(),
    };
    this.assignments.set(id, assignment);
    this.saveToFile(); // Save immediately after creating
    console.log(`Saved assignment ${id} to storage. Total assignments: ${this.assignments.size}`);
    return assignment;
  }

  async getAssignment(id: number, userId?: number, sessionId?: string): Promise<Assignment | undefined> {
    const assignment = this.assignments.get(id);
    if (!assignment) return undefined;
    
    // SECURITY: Enforce user/session isolation
    if (userId) {
      return assignment.userId === userId ? assignment : undefined;
    } else {
      // For anonymous users, check sessionId isolation
      return assignment.userId === null && assignment.sessionId === sessionId ? assignment : undefined;
    }
  }

  async getAllAssignments(userId?: number, sessionId?: string): Promise<Assignment[]> {
    const allAssignments = Array.from(this.assignments.values());
    
    // SECURITY: Filter by userId for authenticated users, sessionId for anonymous
    const filteredAssignments = allAssignments.filter(assignment => {
      if (userId) {
        return assignment.userId === userId;
      } else {
        // For anonymous users, only return assignments without userId AND matching sessionId
        return assignment.userId === null && assignment.sessionId === sessionId;
      }
    });
    
    // If no sessionId provided for anonymous user, return empty array for security
    if (!userId && !sessionId) {
      return [];
    }
    
    return filteredAssignments.sort((a, b) => 
      (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0)
    );
  }

  async updateAssignment(id: number, updates: Partial<InsertAssignment>, userId?: number, sessionId?: string): Promise<Assignment | undefined> {
    const assignment = this.assignments.get(id);
    if (!assignment) return undefined;
    
    // SECURITY: Only update if user/session owns the assignment
    let canUpdate = false;
    if (userId) {
      canUpdate = assignment.userId === userId;
    } else {
      canUpdate = assignment.userId === null && assignment.sessionId === sessionId;
    }
    
    if (!canUpdate) return undefined;
    
    // Update assignment properties
    const updatedAssignment = {
      ...assignment,
      ...updates,
      id: assignment.id, // Preserve the original ID
      createdAt: assignment.createdAt, // Preserve creation time
    };
    
    this.assignments.set(id, updatedAssignment);
    this.saveToFile();
    
    return updatedAssignment;
  }

  async deleteAssignment(id: number, userId?: number, sessionId?: string): Promise<void> {
    const assignment = this.assignments.get(id);
    if (!assignment) return;
    
    // SECURITY: Only delete if user/session owns the assignment
    let canDelete = false;
    if (userId) {
      canDelete = assignment.userId === userId;
    } else {
      canDelete = assignment.userId === null && assignment.sessionId === sessionId;
    }
    
    if (canDelete) {
      this.assignments.delete(id);
      this.saveToFile();
    }
  }

  async cleanupEmptyAssignments(): Promise<void> {
    const toDelete: number[] = [];
    this.assignments.forEach((assignment, id) => {
      if (!assignment.fileName) {
        toDelete.push(id);
      }
    });
    toDelete.forEach(id => this.assignments.delete(id));
    this.saveToFile();
  }

  // Stub implementations for user/token methods (MemStorage doesn't support users)
  async createUser(): Promise<User> { throw new Error("MemStorage does not support users"); }
  async getUserByUsername(): Promise<User | undefined> { return undefined; }
  async getUserById(): Promise<User | undefined> { return undefined; }
  async updateUserTokenBalance(): Promise<void> { throw new Error("MemStorage does not support users"); }
  async createTokenUsage(): Promise<TokenUsage> { throw new Error("MemStorage does not support tokens"); }
  async getDailyUsage(): Promise<DailyUsage | undefined> { return undefined; }
  async createOrUpdateDailyUsage(): Promise<void> { throw new Error("MemStorage does not support daily usage"); }
  async getUserTokenBalance(): Promise<number> { return 0; }
  
  // Anonymous to authenticated user migration (not supported in MemStorage)
  async migrateAnonymousAssignments(): Promise<Assignment[]> { 
    return []; // MemStorage doesn't support user authentication
  }
  
  // Stub implementations for GPT BYPASS methods (MemStorage doesn't support these)
  async createDocument(): Promise<Document> { throw new Error("MemStorage does not support documents"); }
  async getDocument(): Promise<Document | undefined> { return undefined; }
  async createRewriteJob(): Promise<RewriteJob> { throw new Error("MemStorage does not support rewrite jobs"); }
  async getRewriteJob(): Promise<RewriteJob | undefined> { return undefined; }
  async updateRewriteJob(): Promise<void> { throw new Error("MemStorage does not support rewrite jobs"); }
  async getRewriteJobs(): Promise<RewriteJob[]> { return []; }
  
  // Stripe payment methods (not implemented for MemStorage)
  async createStripePayment(payment: InsertStripePayment): Promise<StripePayment> {
    throw new Error("Stripe payments not supported in MemStorage");
  }

  async getStripePaymentBySessionId(sessionId: string): Promise<StripePayment | undefined> {
    return undefined;
  }

  async updateStripePaymentStatus(sessionId: string, status: string): Promise<void> {
    // No-op for MemStorage
  }
  
  async completeStripePaymentAndCredit(sessionId: string, userId: number, tokens: number): Promise<{ alreadyCompleted: boolean; newBalance?: number }> {
    throw new Error("Stripe payments not supported in MemStorage");
  }
  
  async createStripeEvent(event: InsertStripeEvent): Promise<StripeEvent> {
    throw new Error("Stripe events not supported in MemStorage");
  }
  
  async getAllStripePayments(): Promise<StripePayment[]> {
    return [];
  }
  
  async updateStripePaymentMetadata(sessionId: string, metadata: any): Promise<void> {
    // No-op for MemStorage
  }
  
  async isEventProcessed(eventId: string): Promise<boolean> {
    return false;
  }

  // Grade methods (not supported in MemStorage)
  async createGrade(): Promise<Grade> { throw new Error("MemStorage does not support grades"); }
  async getGradesByAssignment(): Promise<Grade[]> { return []; }
  async getAllGrades(): Promise<Grade[]> { return []; }

  // Rewrite methods (not supported in MemStorage)
  async createRewrite(): Promise<Rewrite> { throw new Error("MemStorage does not support rewrites"); }
  async getRewritesByAssignment(): Promise<Rewrite[]> { return []; }
  async getAllRewrites(): Promise<Rewrite[]> { return []; }

  // Project methods (not supported in MemStorage)
  async createProject(): Promise<Project> { throw new Error("MemStorage does not support projects"); }
  async getProject(): Promise<Project | undefined> { return undefined; }
  async getAllProjects(): Promise<Project[]> { return []; }
  async updateProject(): Promise<Project | undefined> { return undefined; }
  async deleteProject(): Promise<void> {}

  // Project session methods (not supported in MemStorage)
  async createProjectSession(): Promise<ProjectSession> { throw new Error("MemStorage does not support project sessions"); }
  async getProjectSession(): Promise<ProjectSession | undefined> { return undefined; }
  async getAllProjectSessions(): Promise<ProjectSession[]> { return []; }
  async updateProjectSession(): Promise<ProjectSession | undefined> { return undefined; }
  async deleteProjectSession(): Promise<void> {}

  // Tractatus archive (not supported in MemStorage)
  async createTractatusArchive(): Promise<TractatusArchive> { throw new Error("MemStorage does not support tractatus archive"); }
  async getTractatusArchives(): Promise<TractatusArchive[]> { return []; }
}

export const storage = new DatabaseStorage();
