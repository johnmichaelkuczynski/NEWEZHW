// Token counting and management utilities

export function countTokens(text: string): number {
  // Simple token counting - approximately 4 characters per token
  // This is a rough estimate, but works for our purposes
  return Math.ceil(text.length / 4);
}

export function truncateResponse(response: string, maxTokens: number): string {
  // DISABLED - RETURN FULL RESPONSE ALWAYS, NO TRUNCATION
  return response;
}

export function generateSessionId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}