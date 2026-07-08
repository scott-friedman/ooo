/**
 * Home Assistant Proxy Worker
 *
 * Cloudflare Worker that securely proxies requests to Home Assistant.
 * Keeps the HA token server-side and only allows whitelisted devices/actions.
 *
 * Environment Variables (set in Cloudflare dashboard):
 * - HA_URL: Your Nabu Casa URL (e.g., https://xxxxxxxx.ui.nabu.casa)
 * - HA_TOKEN: Long-Lived Access Token from Home Assistant
 * - FIREBASE_URL: Firebase Realtime Database URL
 * - FIREBASE_SECRET: RTDB database secret (wrangler secret put FIREBASE_SECRET)
 *   — required for activity-log writes; the rules deny public writes
 *
 * Deploy: wrangler deploy
 */

// Environment detection
const IS_PRODUCTION = true; // Set to false for local development

// CORS headers for your domain
// SECURITY: Localhost origins only allowed in development
const ALLOWED_ORIGINS_PROD = [
    'https://scottfriedman.ooo'
];

const ALLOWED_ORIGINS_DEV = [
    'https://scottfriedman.ooo',
    'http://localhost:8000',
    'http://127.0.0.1:8000'
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

// Allowed actions (whitelist)
const ALLOWED_ACTIONS = ['turn_on', 'turn_off', 'set_percentage', 'media_play', 'media_pause'];

// Rate limiting (prevent abuse). Per-isolate in-memory — see SEC-5 for the
// caveat; a KV-backed limiter is the real fix.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_CONTROLS = 20; // 20 control actions per minute per IP
const RATE_LIMIT_MAX_GETS = 60; // reads are cheaper but hit HA via Nabu Casa (SEC-6)

// Outbound fetch timeout — a hung HA/Firebase upstream should fail the
// request in 10s, not hang until Cloudflare kills it. (PERF-4)
const FETCH_TIMEOUT_MS = 10000;

// /api/state hits HA's full /api/states through Nabu Casa and the page polls
// it every 30s per visitor — a short shared cache absorbs most of it. (SEC-6)
const STATE_CACHE_MS = 15000;
let stateCache = { body: null, timestamp: 0 };

/**
 * Check rate limit, keyed by IP + limit class
 */
function checkRateLimit(ip, maxPerWindow = RATE_LIMIT_MAX_CONTROLS) {
    const now = Date.now();
    const key = `${ip}:${maxPerWindow}`;
    const entry = rateLimitMap.get(key);

    // Cleanup old entries periodically
    if (rateLimitMap.size > 1000) {
        for (const [k, val] of rateLimitMap.entries()) {
            if (now - val.timestamp > RATE_LIMIT_WINDOW * 2) {
                rateLimitMap.delete(k);
            }
        }
    }

    if (!entry || now - entry.timestamp > RATE_LIMIT_WINDOW) {
        rateLimitMap.set(key, { count: 1, timestamp: now });
        return true;
    }

    if (entry.count >= maxPerWindow) {
        return false;
    }

    entry.count++;
    return true;
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
            // GET routes were previously unthrottled; each one reaches
            // Firebase and/or HA over Nabu Casa. (SEC-6)
            const isGet = ['/api/status', '/api/state', '/api/devices'].includes(path);
            if (isGet) {
                const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
                if (!checkRateLimit(clientIP, RATE_LIMIT_MAX_GETS)) {
                    return jsonResponse({ error: 'Rate limit exceeded. Please slow down.' }, 429, corsHeaders);
                }
            }

            // Route handling
            if (path === '/api/status') {
                return await handleStatus(env, corsHeaders);
            }

            if (path === '/api/state') {
                return await handleGetState(env, corsHeaders);
            }

            if (path === '/api/control' && request.method === 'POST') {
                return await handleControl(request, env, corsHeaders, ctx);
            }

            if (path === '/api/devices') {
                return await handleGetDevices(env, corsHeaders);
            }

            return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
        } catch (error) {
            console.error('Worker error:', error);
            return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders);
        }
    }
};

/**
 * Check if command center is enabled
 */
async function checkEnabled(env) {
    try {
        const response = await fetch(
            `${env.FIREBASE_URL}/commandcenter/enabled.json`,
            { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
        );
        const enabled = await response.json();
        return enabled === true;
    } catch (error) {
        console.error('Firebase check failed:', error);
        return false; // Fail closed
    }
}

/**
 * Get allowed devices from Firebase
 * Returns object keyed by actual entity_id (decoded from Firebase keys)
 * Only returns devices that are individually enabled
 */
async function getAllowedDevices(env) {
    try {
        const response = await fetch(
            `${env.FIREBASE_URL}/commandcenter/devices.json`,
            { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
        );
        const rawDevices = await response.json();
        if (!rawDevices) return {};

        // Convert Firebase structure to entity_id keyed object
        // Only include devices that are enabled (enabled !== false)
        const devices = {};
        for (const [key, device] of Object.entries(rawDevices)) {
            // Skip disabled devices
            if (device.enabled === false) continue;

            // Use entity_id field if present, otherwise decode the key
            const entityId = device.entity_id || key.replace(/__/g, '.');
            devices[entityId] = {
                name: device.name,
                emoji: device.emoji,
                type: device.type
            };
        }
        return devices;
    } catch (error) {
        console.error('Failed to get devices:', error);
        // null = "couldn't fetch the list" — callers must not confuse this
        // with "no devices allowed" (it used to surface as a 403). (ERR-4)
        return null;
    }
}

/**
 * Log action to Firebase
 */
async function logAction(env, entityId, action, deviceName) {
    try {
        const response = await fetch(
            `${env.FIREBASE_URL}/commandcenter/log.json?auth=${env.FIREBASE_SECRET}`,
            {
                method: 'POST',
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    entity_id: entityId,
                    action: action,
                    deviceName: deviceName,
                    timestamp: Date.now()
                })
            }
        );
        if (!response.ok) {
            console.error('Log write rejected:', response.status, await response.text());
        }
    } catch (error) {
        console.error('Failed to log action:', error);
    }
}

// Keep only the most recent log entries — the log previously grew forever
// and the page downloads it. Push keys sort chronologically. (PERF-3)
const MAX_LOG_ENTRIES = 200;

async function pruneLog(env) {
    try {
        const res = await fetch(
            `${env.FIREBASE_URL}/commandcenter/log.json?shallow=true&auth=${env.FIREBASE_SECRET}`,
            { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
        );
        const keys = Object.keys((await res.json()) || {});
        if (keys.length <= MAX_LOG_ENTRIES) return;
        keys.sort();
        const excess = keys.slice(0, keys.length - MAX_LOG_ENTRIES);
        const deletions = Object.fromEntries(excess.map(k => [k, null]));
        await fetch(
            `${env.FIREBASE_URL}/commandcenter/log.json?auth=${env.FIREBASE_SECRET}`,
            {
                method: 'PATCH',
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(deletions)
            }
        );
    } catch (error) {
        console.error('Log prune failed:', error);
    }
}

/**
 * GET /api/status - Check if command center is enabled
 */
async function handleStatus(env, corsHeaders) {
    const enabled = await checkEnabled(env);
    return jsonResponse({ enabled }, 200, corsHeaders);
}

/**
 * GET /api/devices - Get list of allowed devices with names
 */
async function handleGetDevices(env, corsHeaders) {
    const devices = await getAllowedDevices(env);
    if (devices === null) {
        return jsonResponse({ error: 'Device list unavailable' }, 503, corsHeaders);
    }
    return jsonResponse({ devices }, 200, corsHeaders);
}

/**
 * GET /api/state - Get current state of all allowed devices
 */
async function handleGetState(env, corsHeaders) {
    // Serve from the short-lived cache when fresh — the page polls this
    // every 30s per visitor. (SEC-6)
    if (stateCache.body && Date.now() - stateCache.timestamp < STATE_CACHE_MS) {
        return jsonResponse(stateCache.body, 200, corsHeaders);
    }

    const devices = await getAllowedDevices(env);
    if (devices === null) {
        return jsonResponse({ error: 'Device list unavailable' }, 503, corsHeaders);
    }
    const entityIds = Object.keys(devices);

    if (entityIds.length === 0) {
        return jsonResponse({ states: {} }, 200, corsHeaders);
    }

    try {
        // Fetch states from Home Assistant
        const response = await fetch(
            `${env.HA_URL}/api/states`,
            {
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                headers: {
                    'Authorization': `Bearer ${env.HA_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!response.ok) {
            throw new Error(`HA API error: ${response.status}`);
        }

        const allStates = await response.json();

        // Filter to only allowed entities
        const states = {};
        for (const state of allStates) {
            if (entityIds.includes(state.entity_id)) {
                const deviceInfo = {
                    state: state.state,
                    name: devices[state.entity_id]?.name || state.attributes?.friendly_name,
                    emoji: devices[state.entity_id]?.emoji || '',
                    type: devices[state.entity_id]?.type || 'switch'
                };

                // Add light-specific attributes
                if (state.entity_id.startsWith('light.')) {
                    if (state.attributes?.brightness !== undefined) {
                        deviceInfo.brightness = Math.round((state.attributes.brightness / 255) * 100);
                    }
                    if (state.attributes?.rgb_color) {
                        deviceInfo.rgb_color = state.attributes.rgb_color;
                    }
                    if (state.attributes?.hs_color) {
                        deviceInfo.hs_color = state.attributes.hs_color;
                    }
                    if (state.attributes?.color_mode) {
                        deviceInfo.color_mode = state.attributes.color_mode;
                    }
                    // Check if light supports color
                    deviceInfo.supports_color = state.attributes?.supported_color_modes?.some(
                        mode => ['rgb', 'rgbw', 'rgbww', 'hs', 'xy'].includes(mode)
                    ) || false;
                }

                // Add fan-specific attributes
                if (state.entity_id.startsWith('fan.')) {
                    if (state.attributes?.percentage !== undefined) {
                        deviceInfo.percentage = state.attributes.percentage;
                    }
                    if (state.attributes?.preset_mode) {
                        deviceInfo.preset_mode = state.attributes.preset_mode;
                    }
                }

                // Add media_player-specific attributes
                if (state.entity_id.startsWith('media_player.')) {
                    if (state.attributes?.media_title) {
                        deviceInfo.media_title = state.attributes.media_title;
                    }
                    if (state.attributes?.app_name) {
                        deviceInfo.app_name = state.attributes.app_name;
                    }
                    if (state.attributes?.media_artist) {
                        deviceInfo.media_artist = state.attributes.media_artist;
                    }
                    if (state.attributes?.media_content_type) {
                        deviceInfo.media_content_type = state.attributes.media_content_type;
                    }
                }

                states[state.entity_id] = deviceInfo;
            }
        }

        stateCache = { body: { states }, timestamp: Date.now() };
        return jsonResponse({ states }, 200, corsHeaders);
    } catch (error) {
        console.error('Failed to get HA states:', error);
        return jsonResponse({ error: 'Failed to get device states' }, 500, corsHeaders);
    }
}

/**
 * POST /api/control - Control a device
 * Body: { entity_id: string, action: "turn_on" | "turn_off" | "set_percentage", ...params }
 * Optional params for turn_on: rgb_color ([r,g,b]), brightness (0-100)
 * Optional params for set_percentage: percentage (0-100)
 */
async function handleControl(request, env, corsHeaders, ctx) {
    // Rate limiting
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(clientIP)) {
        return jsonResponse({
            error: 'Rate limit exceeded. Please slow down.'
        }, 429, corsHeaders);
    }

    // Check if enabled
    const enabled = await checkEnabled(env);
    if (!enabled) {
        return jsonResponse({ error: 'Command center is currently disabled' }, 403, corsHeaders);
    }

    // Parse request body
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders);
    }

    const { entity_id, action, rgb_color, brightness, percentage } = body;

    // Validate action
    if (!ALLOWED_ACTIONS.includes(action)) {
        return jsonResponse({ error: 'Invalid action' }, 400, corsHeaders);
    }

    // Validate entity is allowed
    const devices = await getAllowedDevices(env);
    if (devices === null) {
        return jsonResponse({ error: 'Device list unavailable, try again' }, 503, corsHeaders);
    }
    if (!devices[entity_id]) {
        return jsonResponse({ error: 'Device not allowed' }, 403, corsHeaders);
    }

    // Determine the HA service based on entity type and action
    const entityType = entity_id.split('.')[0]; // e.g., "light", "fan", "switch"

    // Build service data
    const serviceData = { entity_id };

    // Add optional parameters for lights
    if (entityType === 'light' && action === 'turn_on') {
        if (rgb_color && Array.isArray(rgb_color) && rgb_color.length === 3) {
            serviceData.rgb_color = rgb_color;
        }
        if (brightness !== undefined) {
            // Convert 0-100 to 0-255
            serviceData.brightness = Math.round((brightness / 100) * 255);
        }
    }

    // Add percentage for fans
    if (entityType === 'fan' && action === 'set_percentage') {
        if (percentage !== undefined) {
            serviceData.percentage = percentage;
        }
    }

    try {
        // Call Home Assistant API
        const response = await fetch(
            `${env.HA_URL}/api/services/${entityType}/${action}`,
            {
                method: 'POST',
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                headers: {
                    'Authorization': `Bearer ${env.HA_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(serviceData)
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error('HA API error:', errorText);
            return jsonResponse({ error: 'Failed to control device' }, 500, corsHeaders);
        }

        // Build log message
        let logMessage = action;
        if (rgb_color) logMessage += ` (color)`;
        if (percentage !== undefined) logMessage += ` (${percentage}%)`;
        // Friendly names for media actions
        if (action === 'media_play') logMessage = 'played';
        if (action === 'media_pause') logMessage = 'paused';

        // Log the action; prune old entries after the response goes out
        await logAction(env, entity_id, logMessage, devices[entity_id]?.name);
        if (ctx) ctx.waitUntil(pruneLog(env));

        return jsonResponse({
            success: true,
            entity_id,
            action,
            message: `${devices[entity_id]?.name || entity_id} updated`
        }, 200, corsHeaders);
    } catch (error) {
        console.error('Failed to control device:', error);
        return jsonResponse({ error: 'Failed to control device' }, 500, corsHeaders);
    }
}

/**
 * Helper to create JSON responses with CORS headers
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
