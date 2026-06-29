import axios from 'axios';
import crypto from 'crypto';

const PHILOSOPHER_API_URL = 'https://analyticphilosophy.net/zhi';
const ZHI_PRIVATE_KEY = process.env.ZHI_PRIVATE_KEY;
const ZHI_APP_ID = 'ezhw';

interface CitationInfo {
  author: string;
  work: string;
  chunkIndex: number;
}

interface SearchResult {
  excerpt: string;
  citation: CitationInfo;
  relevance: number;
  tokens: number;
}

interface PhilosopherApiResponse {
  results: SearchResult[];
  quotes: string[];
  meta: {
    resultsReturned: number;
    limitApplied: number;
    queryProcessed: string;
    filters: {
      author: string | null;
      work: string | null;
      keywords: string | null;
    };
    timestamp: number;
  };
}

interface PhilosopherContent {
  quotes?: string[];
  passages?: string[];
  context?: string;
  source?: string;
}

function generateAuthHeaders(requestBody: any): Record<string, string> {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyString = JSON.stringify(requestBody);
  
  const bodyHash = crypto
    .createHash('sha256')
    .update(bodyString)
    .digest('hex');
  
  const method = 'POST';
  const url = '/zhi/query';
  const payload = `${method}\n${url}\n${timestamp}\n${nonce}\n${bodyHash}`;
  
  const signature = crypto
    .createHmac('sha256', ZHI_PRIVATE_KEY!)
    .update(payload)
    .digest('base64');
  
  console.log('\n╔═══════════════════════════════════════════════════════════════');
  console.log('║ AP API - REQUEST DETAILS');
  console.log('╠═══════════════════════════════════════════════════════════════');
  console.log(`║ Endpoint:       ${PHILOSOPHER_API_URL}/query`);
  console.log(`║ App ID:         ${ZHI_APP_ID}`);
  console.log(`║ Timestamp:      ${timestamp}`);
  console.log(`║ Nonce:          ${nonce}`);
  console.log(`║ Private Key:    ${ZHI_PRIVATE_KEY ? `${ZHI_PRIVATE_KEY.substring(0, 8)}...` : 'NOT SET'}`);
  console.log('╠═══════════════════════════════════════════════════════════════');
  console.log('║ REQUEST BODY:');
  console.log(`║ ${bodyString}`);
  console.log('╠═══════════════════════════════════════════════════════════════');
  console.log('║ SIGNATURE CALCULATION (SERVER FORMAT):');
  console.log(`║ Body Hash:      ${bodyHash}`);
  console.log(`║ Payload:        ${payload.replace(/\n/g, '\\n')}`);
  console.log(`║ Signature:      ${signature}`);
  console.log('╠═══════════════════════════════════════════════════════════════');
  console.log('║ HEADERS SENT:');
  console.log(`║ X-ZHI-App-Id:      ${ZHI_APP_ID}`);
  console.log(`║ X-ZHI-Timestamp:   ${timestamp}`);
  console.log(`║ X-ZHI-Nonce:       ${nonce}`);
  console.log(`║ X-ZHI-Signature:   ${signature}`);
  console.log(`║ Content-Type:      application/json`);
  console.log('╚═══════════════════════════════════════════════════════════════\n');
  
  return {
    'X-ZHI-App-Id': ZHI_APP_ID,
    'X-ZHI-Timestamp': timestamp,
    'X-ZHI-Nonce': nonce,
    'X-ZHI-Signature': signature,
    'Content-Type': 'application/json',
  };
}

export async function fetchPhilosopherContent(query: string, author?: string): Promise<PhilosopherContent | null> {
  if (!ZHI_PRIVATE_KEY) {
    console.warn('[AP API] ZHI_PRIVATE_KEY not configured');
    return null;
  }

  try {
    console.log(`[AP API] Sending query: "${query.substring(0, 100)}..."`);
    console.log(`[AP API] Author filter: ${author || 'none'}`);
    
    const requestBody: any = { 
      query,
      limit: 10,
      includeQuotes: true
    };
    
    if (author) {
      requestBody.author = author;
    }
    
    const authHeaders = generateAuthHeaders(requestBody);
    
    const response = await axios.post<PhilosopherApiResponse>(
      `${PHILOSOPHER_API_URL}/query`,
      requestBody,
      {
        headers: authHeaders,
        timeout: 30000,
      }
    );

    console.log('[AP API] ✓ Successfully retrieved content');
    console.log(`[AP API] Results: ${response.data.results.length} excerpts, ${response.data.quotes.length} quotes`);
    
    let filteredResults = response.data.results;
    
    if (author) {
      const authorLower = author.toLowerCase();
      filteredResults = response.data.results.filter(r => {
        const citationAuthor = r.citation.author.toLowerCase();
        return citationAuthor.includes(authorLower) || authorLower.includes(citationAuthor);
      });
      
      const filtered = response.data.results.length - filteredResults.length;
      if (filtered > 0) {
        console.warn(`[AP API] ⚠️  Filtered out ${filtered} results from wrong authors (requested: ${author})`);
        console.warn(`[AP API] ⚠️  Database author filter is not working correctly - applying client-side filtering`);
      }
      
      if (filteredResults.length === 0) {
        console.error(`[AP API] ⛔ CRITICAL: Database returned ZERO ${author} content after filtering`);
        console.error(`[AP API] ⛔ All ${response.data.results.length} results were from wrong authors`);
        console.error(`[AP API] ⛔ KILL SWITCH: Refusing to proceed without authentic database content`);
        return null;
      }
    }
    
    const MAX_PASSAGE_LENGTH = 800;
    const MAX_PASSAGES_PER_AUTHOR = 3;
    
    const limitedResults = filteredResults.slice(0, MAX_PASSAGES_PER_AUTHOR);
    
    const passages = limitedResults.map(r => {
      const truncatedExcerpt = r.excerpt.length > MAX_PASSAGE_LENGTH 
        ? r.excerpt.substring(0, MAX_PASSAGE_LENGTH) + '...'
        : r.excerpt;
      return `PASSAGE:\n${truncatedExcerpt}\n\nSOURCE: ${r.citation.author}, "${r.citation.work}"`;
    });
    
    const MAX_QUOTES = 20;
    const limitedQuotes = response.data.quotes.slice(0, MAX_QUOTES);
    
    console.log(`[AP API] Sample excerpt: ${filteredResults[0]?.excerpt.substring(0, 200)}...`);
    console.log(`[AP API] First citation: ${filteredResults[0]?.citation.author}`);
    console.log(`[AP API] Limiting to ${limitedResults.length} passages (${MAX_PASSAGES_PER_AUTHOR} max) and ${limitedQuotes.length} quotes (${MAX_QUOTES} max)`);
    console.log(`[AP API] ⚠️ RAW QUOTE DATA:`, JSON.stringify(limitedQuotes.slice(0, 2), null, 2));
    
    const content: PhilosopherContent = {
      quotes: limitedQuotes.length > 0 ? limitedQuotes : undefined,
      passages: passages.length > 0 ? passages : undefined,
      context: response.data.meta.queryProcessed 
        ? `Database query: "${response.data.meta.queryProcessed}"\nReturned ${response.data.meta.resultsReturned} results (showing first ${limitedResults.length} passages, ${limitedQuotes.length} quotes).\n\nNOTE: These passages contain the exact text from the database. Extract quotes word-for-word.`
        : undefined,
      source: 'Ask-a-Philosopher Database (50,000+ pages)'
    };
    
    return content;
  } catch (error: any) {
    if (error.response) {
      console.error(`[AP API] ✗ Server error (${error.response.status}):`, error.response.data);
      
      if (error.response.status === 401) {
        console.error('[AP API] ✗ Unauthorized - check ZHI_PRIVATE_KEY');
      }
    } else if (error.request) {
      console.error('[AP API] ✗ No response from server:', error.message);
    } else {
      console.error('[AP API] ✗ Request error:', error.message);
    }
    
    return null;
  }
}

export function enrichTextWithPhilosopherContent(
  originalText: string,
  philosopherContent: PhilosopherContent
): string {
  const enrichmentSections: string[] = [];
  
  if (philosopherContent.quotes && philosopherContent.quotes.length > 0) {
    const formattedQuotes = philosopherContent.quotes.map((quoteObj: any, i) => {
      const quoteText = typeof quoteObj === 'string' 
        ? quoteObj 
        : quoteObj.text || JSON.stringify(quoteObj);
      
      // Clean up excessive whitespace and line breaks
      const cleanedText = quoteText
        .replace(/\r\n/g, ' ')
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      // Get citation if available
      let citation = '';
      if (typeof quoteObj === 'object' && quoteObj.citation) {
        const author = quoteObj.citation.author || 'Unknown Author';
        const work = quoteObj.citation.work || 'Unknown Work';
        citation = `\n   — ${author}, "${work}"`;
      }
      
      return `${i + 1}. "${cleanedText}"${citation}`;
    }).join('\n\n');
    enrichmentSections.push(`\n\n=== AUTHENTIC QUOTES FROM DATABASE (READY TO USE) ===\n${formattedQuotes}`);
  }
  
  if (philosopherContent.passages && philosopherContent.passages.length > 0) {
    enrichmentSections.push(`\n\n=== AUTHENTIC PASSAGES FROM DATABASE ===\n${philosopherContent.passages.join('\n\n')}`);
  }
  
  if (philosopherContent.context) {
    enrichmentSections.push(`\n\n=== DATABASE CONTEXT ===\n${philosopherContent.context}`);
  }
  
  if (philosopherContent.source) {
    enrichmentSections.push(`\n\n=== SOURCE ===\n${philosopherContent.source}`);
  }
  
  const isQuoteRequest = /(?:give me|get me|show me|provide|list|find).*?(?:\d+\s*)?(?:original\s+)?(?:quotes?|quotations?|passages?|excerpts?)/i.test(originalText);
  
  if (enrichmentSections.length > 0) {
    let instructionText = '';
    
    if (isQuoteRequest) {
      instructionText = `\n\n` +
        `========================================\n` +
        `🔴 DATABASE QUOTE EXTRACTION MODE 🔴\n` +
        `========================================\n\n` +
        `The "AUTHENTIC QUOTES FROM DATABASE" section below contains ${philosopherContent.quotes?.length || 0} ready-to-use quotes.\n\n` +
        `⚠️ IMPORTANT: The database returned ONLY ${philosopherContent.quotes?.length || 0} quotes.\n` +
        `If the user requested more quotes than are available, YOU MUST:\n` +
        `1. Present ALL ${philosopherContent.quotes?.length || 0} authentic quotes from the database\n` +
        `2. Acknowledge that only ${philosopherContent.quotes?.length || 0} were available in the database\n` +
        `3. DO NOT fabricate or add quotes beyond what the database provided\n\n` +
        `YOUR TASK:\n` +
        `1. Copy ALL ${philosopherContent.quotes?.length || 0} quotes from the DATABASE QUOTES section\n` +
        `2. Present them with proper formatting and attribution\n` +
        `3. Add brief explanations if requested\n\n` +
        `⛔ ABSOLUTELY FORBIDDEN:\n` +
        `   - Adding quotes beyond the ${philosopherContent.quotes?.length || 0} database quotes\n` +
        `   - Using your training data to add more quotes\n` +
        `   - Fabricating or inventing additional quotes\n\n` +
        `✅ PRESENT ALL ${philosopherContent.quotes?.length || 0} DATABASE QUOTES:\n` +
        `========================================\n`;
    } else {
      instructionText = `========================================\n` +
        `DATABASE REFERENCE MATERIAL:\n` +
        `(Use these authentic passages to support your response)\n` +
        `========================================`;
    }
    
    const enrichedText = `${originalText}\n\n` + instructionText + enrichmentSections.join('') + `\n\n========================================`;
    
    console.log(`[AP API] ✓ Enriched text with ${enrichmentSections.length} sections (Quote request: ${isQuoteRequest})`);
    return enrichedText;
  }
  
  return originalText;
}

function extractAllAuthorsFromQuery(text: string): string[] {
  const authorPatterns: { [key: string]: RegExp } = {
    'kuczynski': /(?:john-?michael\s+)?kuczynski/i,
    'russell': /\brussell\b/i,
    'galileo': /\bgalileo\b/i,
    'nietzsche': /\bnietzsche\b/i,
    'freud': /\bfreud\b/i,
    'james': /(?:william\s+)?james/i,
    'leibniz': /\bleibniz\b/i,
    'aristotle': /\baristotle\b/i,
    'le bon': /le\s+bon/i,
    'plato': /\bplato\b/i,
    'darwin': /\bdarwin\b/i,
    'kant': /\bkant\b/i,
    'schopenhauer': /\bschopenhauer\b/i,
    'jung': /\bjung\b/i,
    'poe': /(?:edgar\s+allan\s+)?poe/i,
    'marx': /\bmarx\b/i,
    'keynes': /\bkeynes\b/i,
    'locke': /\blocke\b/i,
    'newton': /\bnewton\b/i,
    'hume': /\bhume\b/i,
    'machiavelli': /\bmachiavelli\b/i,
    'bierce': /\bbierce\b/i,
    'poincare': /\bpoincare\b/i,
    'bergson': /\bbergson\b/i,
    'london': /jack\s+london/i,
    'adler': /\badler\b/i,
    'engels': /\bengels\b/i,
    'rousseau': /\brousseau\b/i,
    'mises': /(?:von\s+)?mises/i,
    'veblen': /\bveblen\b/i,
    'swett': /\bswett\b/i,
    'berkeley': /\bberkeley\b/i,
    'maimonides': /\bmaimonides\b/i,
    'descartes': /\bdescartes\b/i,
    'wittgenstein': /\bwittgenstein\b/i,
    'smith': /adam\s+smith/i,
    'hobbes': /thomas\s+hobbes|\bhobbes\b/i,
    'chomsky': /\bchomsky\b/i,
  };
  
  const detectedAuthors: string[] = [];
  
  for (const [author, pattern] of Object.entries(authorPatterns)) {
    if (pattern.test(text)) {
      detectedAuthors.push(author);
    }
  }
  
  return detectedAuthors;
}

export async function enrichWithPhilosophicalContentIfNeeded(text: string, forceQuery: boolean = false): Promise<string> {
  if (!forceQuery) {
    return text;
  }
  
  console.log('[AP API] Toggle ON - querying database');
  
  const authors = extractAllAuthorsFromQuery(text);
  console.log(`[AP API] Detected ${authors.length} author(s): ${authors.join(', ') || 'none'}`);
  
  if (authors.length === 0) {
    const content = await fetchPhilosopherContent(text, undefined);
    if (!content) {
      console.error('[AP API] ⛔ KILL SWITCH ACTIVATED - Database query failed');
      throw new Error('KILL SWITCH: AP database query failed. Cannot proceed without authentic database content. Toggle must be OFF to process this request.');
    }
    return enrichTextWithPhilosopherContent(text, content);
  }
  
  const allQuotes: string[] = [];
  const allPassages: string[] = [];
  let combinedSource = 'Ask-a-Philosopher Database (50,000+ pages)';
  
  for (const author of authors) {
    console.log(`[AP API] Querying database for: ${author}`);
    const content = await fetchPhilosopherContent(text, author);
    
    if (!content) {
      console.error(`[AP API] ⛔ KILL SWITCH: No content for ${author}`);
      throw new Error(`KILL SWITCH: AP database query failed for ${author}. Cannot proceed without authentic database content. Toggle must be OFF to process this request.`);
    }
    
    if (content.quotes) {
      allQuotes.push(...content.quotes);
    }
    if (content.passages) {
      allPassages.push(...content.passages);
    }
  }
  
  const combinedContent: PhilosopherContent = {
    quotes: allQuotes.length > 0 ? allQuotes : undefined,
    passages: allPassages.length > 0 ? allPassages : undefined,
    context: `Database queried for ${authors.length} author(s): ${authors.join(', ')}\nTotal content retrieved from ${authors.length} separate queries.`,
    source: combinedSource
  };
  
  return enrichTextWithPhilosopherContent(text, combinedContent);
}
