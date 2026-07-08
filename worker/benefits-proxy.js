/**
 * Benefits of Everything - Gemini API Proxy
 *
 * Cloudflare Worker that proxies requests to Google's Gemini API.
 * Checks Firebase cache first, only calls Gemini for new queries.
 *
 * Environment Variables (set via wrangler secret):
 * - GEMINI_API_KEY: Google AI Studio API key
 * - FIREBASE_SECRET: RTDB database secret (wrangler secret put FIREBASE_SECRET
 *   --config wrangler-benefits.toml) — required for cache writes; the rules
 *   deny unauthenticated writes
 *
 * Optional KV Namespace (for persistent rate limiting):
 * - RATE_LIMIT_KV: KV namespace for rate limit counters
 *
 * Deploy: npx wrangler deploy --config wrangler-benefits.toml
 */

const FIREBASE_URL = 'https://scottfriedman-f400d-default-rtdb.firebaseio.com';

// Model is configurable via wrangler [vars] GEMINI_MODEL without a code
// change — Google retired gemini-2.0-flash in 2026 and the page broke
// with a generic error until the pin was bumped.
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

function geminiUrl(env) {
    const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

// Environment detection
const IS_PRODUCTION = true; // Set to false for local development

// CORS headers for your domain
// SECURITY: Remove localhost in production to prevent CORS bypass attacks
const ALLOWED_ORIGINS_PROD = [
    'https://scottfriedman.ooo'
];

const ALLOWED_ORIGINS_DEV = [
    'https://scottfriedman.ooo',
    'http://localhost:8000',
    'http://localhost:8001',
    'http://127.0.0.1:8000',
    'http://127.0.0.1:8001'
];

function getCorsHeaders(request) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = IS_PRODUCTION ? ALLOWED_ORIGINS_PROD : ALLOWED_ORIGINS_DEV;
    const allowedOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    return {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
    };
}

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_PER_MINUTE = 5; // 5 requests per minute per IP (reduced from 10)
const RATE_LIMIT_MAX_PER_HOUR = 30; // 30 requests per hour per IP
const DAILY_BUDGET_LIMIT = 500; // Max API calls per day (safety net)

// In-memory rate limiting (fallback, resets on worker restart)
const rateLimitMap = new Map();
const hourlyLimitMap = new Map();
let dailyApiCalls = 0;
let dailyResetTime = Date.now();

/**
 * Check rate limit for an IP address
 * Uses in-memory counters with multiple time windows
 */
function checkRateLimit(ip, env) {
    const now = Date.now();

    // Reset daily counter at midnight UTC
    const today = new Date().toDateString();
    if (new Date(dailyResetTime).toDateString() !== today) {
        dailyApiCalls = 0;
        dailyResetTime = now;
    }

    // Check daily budget
    if (dailyApiCalls >= DAILY_BUDGET_LIMIT) {
        console.log(`Daily budget exceeded: ${dailyApiCalls}/${DAILY_BUDGET_LIMIT}`);
        return { allowed: false, reason: 'daily_limit' };
    }

    // Per-minute rate limiting
    const minuteKey = `${ip}_minute`;
    const minuteEntry = rateLimitMap.get(minuteKey);
    if (!minuteEntry || now - minuteEntry.timestamp > RATE_LIMIT_WINDOW) {
        rateLimitMap.set(minuteKey, { count: 1, timestamp: now });
    } else if (minuteEntry.count >= RATE_LIMIT_MAX_PER_MINUTE) {
        return { allowed: false, reason: 'minute_limit' };
    } else {
        minuteEntry.count++;
    }

    // Per-hour rate limiting
    const hourKey = `${ip}_hour`;
    const hourEntry = hourlyLimitMap.get(hourKey);
    const hourWindow = 3600000; // 1 hour
    if (!hourEntry || now - hourEntry.timestamp > hourWindow) {
        hourlyLimitMap.set(hourKey, { count: 1, timestamp: now });
    } else if (hourEntry.count >= RATE_LIMIT_MAX_PER_HOUR) {
        return { allowed: false, reason: 'hour_limit' };
    } else {
        hourEntry.count++;
    }

    return { allowed: true };
}

/**
 * Increment daily API call counter
 */
function incrementDailyCounter() {
    dailyApiCalls++;
}

/**
 * Clean up old rate limit entries periodically
 */
function cleanupRateLimits() {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap.entries()) {
        if (now - entry.timestamp > RATE_LIMIT_WINDOW * 2) {
            rateLimitMap.delete(key);
        }
    }
    for (const [key, entry] of hourlyLimitMap.entries()) {
        if (now - entry.timestamp > 3600000 * 2) {
            hourlyLimitMap.delete(key);
        }
    }
}

// Normalize query for caching (lowercase, trim, remove extra spaces)
function normalizeQuery(query) {
    return query.toLowerCase().trim().replace(/\s+/g, ' ');
}

// Generate Firebase-safe key from query
function queryToFirebaseKey(query) {
    // Firebase keys can't contain . $ # [ ] /
    return normalizeQuery(query)
        .replace(/[.#$\[\]\/]/g, '_')
        .replace(/\s/g, '_')
        .substring(0, 100);
}

export default {
    async fetch(request, env, ctx) {
        const corsHeaders = getCorsHeaders(request);

        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            if (path === '/api/benefits' && request.method === 'POST') {
                return await handleBenefits(request, env, corsHeaders);
            }

            if (path === '/api/more-benefit' && request.method === 'POST') {
                return await handleMoreBenefit(request, env, corsHeaders);
            }

            if (path === '/api/expand-benefit' && request.method === 'POST') {
                return await handleExpandBenefit(request, env, corsHeaders);
            }

            if (path === '/api/health') {
                return jsonResponse({ status: 'ok', timestamp: Date.now() }, 200, corsHeaders);
            }

            return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
        } catch (error) {
            console.error('Worker error:', error);
            return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders);
        }
    }
};

/**
 * POST /api/benefits
 * Body: { query: string }
 * Returns: { benefits: string[], usageTips: string[], query: string, cached: boolean }
 */
async function handleBenefits(request, env, corsHeaders) {
    // Rate limiting
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateCheck = checkRateLimit(clientIP, env);
    if (!rateCheck.allowed) {
        const messages = {
            'daily_limit': 'Daily limit reached. Please try again tomorrow.',
            'hour_limit': 'Hourly limit exceeded. Please try again later.',
            'minute_limit': 'Rate limit exceeded. Please try again in a minute.'
        };
        return jsonResponse({
            error: messages[rateCheck.reason] || 'Rate limit exceeded.'
        }, 429, corsHeaders);
    }

    // Parse request
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders);
    }

    const { query } = body;

    // Validate query
    if (!query || typeof query !== 'string') {
        return jsonResponse({ error: 'Query is required' }, 400, corsHeaders);
    }

    const normalizedQuery = normalizeQuery(query);

    if (normalizedQuery.length < 2) {
        return jsonResponse({ error: 'Query too short' }, 400, corsHeaders);
    }

    if (normalizedQuery.length > 200) {
        return jsonResponse({ error: 'Query too long' }, 400, corsHeaders);
    }

    // Check Firebase cache first
    const cacheKey = queryToFirebaseKey(normalizedQuery);
    const cached = await checkCache(cacheKey);

    if (cached) {
        return jsonResponse({
            benefits: cached.benefits,
            usageTips: cached.usageTips,
            query: query,
            normalizedQuery: normalizedQuery,
            cached: true
        }, 200, corsHeaders);
    }

    // Call Gemini API
    const result = await callGemini(env, normalizedQuery);

    if (result.error) {
        return jsonResponse({ error: result.error }, 500, corsHeaders);
    }

    // Cache the result
    await saveToCache(env, cacheKey, result);

    return jsonResponse({
        benefits: result.benefits,
        usageTips: result.usageTips,
        query: query,
        normalizedQuery: normalizedQuery,
        cached: false
    }, 200, corsHeaders);
}

/**
 * POST /api/more-benefit
 * Body: { query: string, existingBenefits: string[] }
 * Returns: { benefit: string }
 */
async function handleMoreBenefit(request, env, corsHeaders) {
    // Rate limiting
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateCheck = checkRateLimit(clientIP, env);
    if (!rateCheck.allowed) {
        const messages = {
            'daily_limit': 'Daily limit reached. Please try again tomorrow.',
            'hour_limit': 'Hourly limit exceeded. Please try again later.',
            'minute_limit': 'Rate limit exceeded. Please try again in a minute.'
        };
        return jsonResponse({
            error: messages[rateCheck.reason] || 'Rate limit exceeded.'
        }, 429, corsHeaders);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders);
    }

    const { query, existingBenefits } = body;

    if (!query || !Array.isArray(existingBenefits)) {
        return jsonResponse({ error: 'Query and existingBenefits are required' }, 400, corsHeaders);
    }

    const result = await callGeminiForMoreBenefit(env, query, existingBenefits);

    if (result.error) {
        return jsonResponse({ error: result.error }, 500, corsHeaders);
    }

    return jsonResponse({ benefit: result.benefit }, 200, corsHeaders);
}

/**
 * POST /api/expand-benefit
 * Body: { query: string, benefit: string }
 * Returns: { expansion: string }
 */
async function handleExpandBenefit(request, env, corsHeaders) {
    // Rate limiting
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateCheck = checkRateLimit(clientIP, env);
    if (!rateCheck.allowed) {
        const messages = {
            'daily_limit': 'Daily limit reached. Please try again tomorrow.',
            'hour_limit': 'Hourly limit exceeded. Please try again later.',
            'minute_limit': 'Rate limit exceeded. Please try again in a minute.'
        };
        return jsonResponse({
            error: messages[rateCheck.reason] || 'Rate limit exceeded.'
        }, 429, corsHeaders);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders);
    }

    const { query, benefit, existingExpansions } = body;

    if (!query || !benefit) {
        return jsonResponse({ error: 'Query and benefit are required' }, 400, corsHeaders);
    }

    const result = await callGeminiForExpansion(env, query, benefit, existingExpansions || []);

    if (result.error) {
        return jsonResponse({ error: result.error }, 500, corsHeaders);
    }

    return jsonResponse({ expansion: result.expansion }, 200, corsHeaders);
}

/**
 * Check Firebase cache for existing result
 */
async function checkCache(cacheKey) {
    try {
        const response = await fetch(
            `${FIREBASE_URL}/benefits/cache/${cacheKey}.json`
        );

        if (!response.ok) return null;

        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Cache check failed:', error);
        return null;
    }
}

/**
 * Save result to Firebase cache
 */
async function saveToCache(env, cacheKey, result) {
    try {
        const response = await fetch(
            `${FIREBASE_URL}/benefits/cache/${cacheKey}.json?auth=${env.FIREBASE_SECRET}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    benefits: result.benefits,
                    usageTips: result.usageTips,
                    cachedAt: Date.now()
                })
            }
        );
        if (!response.ok) {
            console.error('Cache write rejected:', response.status, await response.text());
        }
    } catch (error) {
        console.error('Cache save failed:', error);
    }
}

/**
 * Call Gemini API to generate benefits
 */
async function callGemini(env, query) {
    const prompt = `List benefits of "${query}".

Rules:
- 3 to 5 benefits (use fewer if 3 makes the point, add more only if genuinely useful)
- Each benefit is ONE sentence only (under 15 words)
- Exactly 2 usage tips, each ONE sentence only (under 15 words)
- Be specific, not generic
- For negative topics, find genuine silver linings

Return JSON only:
{
  "benefits": ["benefit 1", "benefit 2", "benefit 3"],
  "usageTips": ["tip 1", "tip 2"]
}`;

    try {
        // Track API call for daily budget and cleanup old entries
        incrementDailyCounter();
        cleanupRateLimits();

        const response = await fetch(`${geminiUrl(env)}?key=${env.GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: prompt }]
                }],
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 1024,
                    thinkingConfig: { thinkingBudget: 0 },
                    topP: 0.9
                },
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
                ]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Gemini API error:', errorText);
            return { error: 'Failed to generate benefits. Please try again.' };
        }

        const data = await response.json();

        // Extract text from Gemini response
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) {
            console.error('No text in Gemini response:', JSON.stringify(data));
            return { error: 'Empty response from AI. Please try again.' };
        }

        // Parse JSON from response (handle potential markdown wrapping)
        let parsed;
        try {
            const cleanText = text.replace(/```json\n?|\n?```/g, '').trim();
            parsed = JSON.parse(cleanText);
        } catch (parseError) {
            console.error('Failed to parse Gemini response:', text);
            return { error: 'Failed to parse AI response. Please try again.' };
        }

        // Validate structure
        if (!Array.isArray(parsed.benefits) || !Array.isArray(parsed.usageTips)) {
            console.error('Invalid response structure:', parsed);
            return { error: 'Invalid response format. Please try again.' };
        }

        return {
            benefits: parsed.benefits,
            usageTips: parsed.usageTips
        };

    } catch (error) {
        console.error('Gemini API call failed:', error);
        return { error: 'Failed to connect to AI service. Please try again.' };
    }
}

/**
 * Call Gemini to get one more benefit
 */
async function callGeminiForMoreBenefit(env, query, existingBenefits) {
    const prompt = `For "${query}", give me ONE more benefit that is different from these existing ones:
${existingBenefits.map((b, i) => `${i + 1}. ${b}`).join('\n')}

Rules:
- ONE sentence only (under 15 words)
- Must be genuinely different from the existing benefits
- Be specific, not generic

Return ONLY the benefit text, nothing else.`;

    try {
        // Track API call for daily budget
        incrementDailyCounter();

        const response = await fetch(`${geminiUrl(env)}?key=${env.GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.8,
                    maxOutputTokens: 100,
                    thinkingConfig: { thinkingBudget: 0 },
                    topP: 0.9
                },
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
                ]
            })
        });

        if (!response.ok) {
            return { error: 'Failed to generate benefit' };
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) {
            return { error: 'Empty response' };
        }

        return { benefit: text.trim() };

    } catch (error) {
        console.error('Gemini API call failed:', error);
        return { error: 'Failed to connect to AI service' };
    }
}

/**
 * Call Gemini to expand on a benefit claim
 */
async function callGeminiForExpansion(env, query, benefit, existingExpansions = []) {
    let avoidRepetitionClause = '';
    if (existingExpansions.length > 0) {
        avoidRepetitionClause = `

IMPORTANT: The following explanations have already been given for other benefits of "${query}". Do NOT repeat or heavily overlap with these points:
${existingExpansions.map((exp, i) => `- "${exp}"`).join('\n')}

Provide fresh reasoning, different evidence, or a new angle.`;
    }

    const prompt = `Regarding "${query}", someone claims: "${benefit}"

Your task: Explain why this is true. Be specific and cite evidence or reasoning where possible.

Important: Adjust your explanation length based on how much the claim actually needs explaining:
- If the benefit is obvious or self-explanatory, give a brief 1-sentence confirmation
- If moderately complex, provide 2-3 sentences
- If the benefit is counter-intuitive, technical, or requires significant justification, provide up to 4 sentences

Do NOT pad simple claims with unnecessary elaboration. Match the depth of explanation to the actual complexity of the claim.${avoidRepetitionClause}`;

    try {
        // Track API call for daily budget
        incrementDailyCounter();

        const response = await fetch(`${geminiUrl(env)}?key=${env.GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 200,
                    thinkingConfig: { thinkingBudget: 0 },
                    topP: 0.9
                },
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
                ]
            })
        });

        if (!response.ok) {
            return { error: 'Failed to expand benefit' };
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) {
            return { error: 'Empty response' };
        }

        return { expansion: text.trim() };

    } catch (error) {
        console.error('Gemini API call failed:', error);
        return { error: 'Failed to connect to AI service' };
    }
}

/**
 * Helper to create JSON responses
 */
function jsonResponse(data, status = 200, corsHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
        }
    });
}
