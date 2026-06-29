import { assignments, users, documents, rewriteJobs, referenceDocuments, grades, rewrites, projects, projectSessions, tractatusArchive, type Assignment, type InsertAssignment, type User, type InsertUser, type Document, type InsertDocument, type RewriteJob, type InsertRewriteJob, type ReferenceDocument, type InsertReferenceDocument, type Grade, type InsertGrade, type Rewrite, type InsertRewrite, type Project, type InsertProject, type ProjectSession, type InsertProjectSession, type TractatusArchive, type InsertTractatusArchive } from "@shared/schema";
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
  
  // Anonymous to authenticated user migration
  migrateAnonymousAssignments(sessionId: string, userId: number): Promise<Assignment[]>;
  
  // GPT BYPASS / Humanization methods
  createDocument(document: InsertDocument): Promise<Document>;
  getDocument(id: string): Promise<Document | undefined>;
  createRewriteJob(job: InsertRewriteJob): Promise<RewriteJob>;
  getRewriteJob(id: string): Promise<RewriteJob | undefined>;
  updateRewriteJob(id: string, updates: Partial<RewriteJob>): Promise<void>;
  getRewriteJobs(limit?: number): Promise<RewriteJob[]>;

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

  // Stub implementations for user methods (MemStorage doesn't support users)
  async createUser(): Promise<User> { throw new Error("MemStorage does not support users"); }
  async getUserByUsername(): Promise<User | undefined> { return undefined; }
  async getUserById(): Promise<User | undefined> { return undefined; }
  
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
