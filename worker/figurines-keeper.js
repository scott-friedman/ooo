/**
 * Figurines Keeper - authoritative stat decay + caretaker notifications
 *
 * Cloudflare Worker with two jobs:
 *
 * 1. Cron (every 30 min): apply timestamp-based stat decay to every figurine
 *    (state-aware: sleeping recovers energy, dancing drains 2x), auto-wake
 *    well-rested sleepers, detect needs (hungry/lonely), email confirmed
 *    caretakers with a 48h per-need cooldown, and maintain caretakerCounts.
 *    The worker is the ONLY authoritative decay writer — clients render
 *    "effective" stats from stored value + statsUpdatedAt but never decay.
 *
 * 2. HTTP: caretaker signup (double opt-in), confirm, unsubscribe.
 *    Caretaker emails live under /caretakers, which the rules make fully
 *    private — only this worker (database secret) reads or writes them.
 *
 * Environment Variables (set via wrangler secret):
 * - FIREBASE_SECRET: RTDB database secret (wrangler secret put FIREBASE_SECRET
 *   --config wrangler-figurines.toml)
 * - RESEND_API_KEY: Resend API key for sending email (requires one-time
 *   domain verification of scottfriedman.ooo in the Resend dashboard)
 *
 * Deploy: npx wrangler deploy --config wrangler-figurines.toml
 */

const DEFAULT_FIREBASE_URL = 'https://scottfriedman-f400d-default-rtdb.firebaseio.com';

function firebaseUrl(env) {
    return env.FIREBASE_URL || DEFAULT_FIREBASE_URL;
}

// Base URL for confirm/unsubscribe links in cron-sent emails (no request
// context there); wrangler [vars] value wins.
const DEFAULT_WORKER_URL = 'https://figurines-keeper.s-friedman.workers.dev';

function workerUrl(env) {
    return env.WORKER_URL || DEFAULT_WORKER_URL;
}

const PAGE_URL = 'https://scottfriedman.ooo/figurines.html';
const EMAIL_FROM = "Scott's Figurines <figurines@scottfriedman.ooo>";

// CORS - only the signup POST is called cross-origin from the site
const ALLOWED_ORIGINS = ['https://scottfriedman.ooo'];

function getCorsHeaders(request) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
    };
}

// Outbound fetch timeouts (house pattern - a hung upstream shouldn't hold
// the request until Cloudflare kills it)
const FIREBASE_TIMEOUT_MS = 10000;
const RESEND_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Tuning - decay rates target "plant-like" neediness: a figurine gets
// genuinely needy only a few times per week, not Tamagotchi-hourly.
// ---------------------------------------------------------------------------

export const RATES = {
    hungerPerHour: 1.05,          // 100 -> 25 in ~3 days
    happinessPerHour: 0.78,       // ~4 days
    energyPerHour: 0.625,         // ~5 days awake
    energyDancingMultiplier: 2,   // dancing drains energy twice as fast
    energySleepRecoveryPerHour: 20,
};

export const AUTO_WAKE_ENERGY = 95;
export const AUTO_SLEEP_ENERGY = 15; // matches the client's auto-sleep threshold
export const NEED_THRESHOLDS = { hungry: 25, lonely: 25 };
export const NOTIFY_COOLDOWN_MS = 48 * 3600 * 1000;
// Skip decay for figurines a client touched this recently - shrinks the
// window where the cron's read-modify-write could clobber a live interaction
export const FRESH_WRITE_SKIP_MS = 60000;

// Abuse bounds
const MAX_EMAIL_LENGTH = 254;
const MAX_CARETAKERS_PER_FIGURINE = 50;
// Per-RUN cap. The cron fires 48x/day, so this doesn't bound daily volume -
// at the planned scale (48h per-need cooldowns, a handful of caretakers)
// Resend's 100/day free tier is plenty; revisit if figurines multiply.
const MAX_EMAILS_PER_CRON_RUN = 90;
const FIGURINE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Pragmatic email shape check; the double-opt-in confirmation is the real gate
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Rate limiting (in-memory, house pattern; resets on worker restart)
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX_PER_MINUTE = 5;
const RATE_LIMIT_MAX_PER_HOUR = 20;
const rateLimitMap = new Map();
const hourlyLimitMap = new Map();

function checkRateLimit(ip) {
    const now = Date.now();

    const minuteKey = `${ip}_minute`;
    const minuteEntry = rateLimitMap.get(minuteKey);
    if (!minuteEntry || now - minuteEntry.timestamp > RATE_LIMIT_WINDOW) {
        rateLimitMap.set(minuteKey, { count: 1, timestamp: now });
    } else if (minuteEntry.count >= RATE_LIMIT_MAX_PER_MINUTE) {
        return false;
    } else {
        minuteEntry.count++;
    }

    const hourKey = `${ip}_hour`;
    const hourEntry = hourlyLimitMap.get(hourKey);
    if (!hourEntry || now - hourEntry.timestamp > 3600000) {
        hourlyLimitMap.set(hourKey, { count: 1, timestamp: now });
    } else if (hourEntry.count >= RATE_LIMIT_MAX_PER_HOUR) {
        return false;
    } else {
        hourEntry.count++;
    }

    // Opportunistic cleanup
    if (rateLimitMap.size > 1000) {
        for (const [key, entry] of rateLimitMap.entries()) {
            if (now - entry.timestamp > RATE_LIMIT_WINDOW * 2) rateLimitMap.delete(key);
        }
        for (const [key, entry] of hourlyLimitMap.entries()) {
            if (now - entry.timestamp > 3600000 * 2) hourlyLimitMap.delete(key);
        }
    }

    return true;
}

// ---------------------------------------------------------------------------
// Pure logic (exported for tests/figurines-keeper.test.js)
// ---------------------------------------------------------------------------

function clamp(v) {
    return Math.max(0, Math.min(100, v));
}

function round2(v) {
    return Math.round(v * 100) / 100;
}

/**
 * One decay tick for a figurine: returns the update object to write back.
 * Missing statsUpdatedAt means "never decayed" - stamp now, no retroactive
 * starvation (migration step 2 of the plan).
 */
export function applyTick(figurine, now) {
    const last = typeof figurine.statsUpdatedAt === 'number' ? figurine.statsUpdatedAt : now;
    const hours = Math.max(0, (now - last) / 3600000);
    const state = figurine.state || 'idle';

    const hunger = round2(clamp((figurine.hunger ?? 80) - RATES.hungerPerHour * hours));
    const happiness = round2(clamp((figurine.happiness ?? 80) - RATES.happinessPerHour * hours));

    let energyRate;
    if (state === 'sleeping') {
        energyRate = RATES.energySleepRecoveryPerHour;
    } else if (state === 'dancing') {
        energyRate = -RATES.energyPerHour * RATES.energyDancingMultiplier;
    } else {
        energyRate = -RATES.energyPerHour;
    }
    const energy = round2(clamp((figurine.energy ?? 80) + energyRate * hours));

    const updates = { hunger, happiness, energy, statsUpdatedAt: now };
    if (state === 'sleeping' && energy >= AUTO_WAKE_ENERGY) {
        updates.state = 'idle';
    } else if (state !== 'sleeping' && energy < AUTO_SLEEP_ENERGY) {
        // Exhausted figurines self-sleep even when no tab is open to do it
        updates.state = 'sleeping';
    } else if (state === 'eating' && now - (figurine.lastInteraction || 0) > 60000) {
        // Heal a stuck eating state (tab closed during the 1.5s feed animation)
        updates.state = 'idle';
    }
    return updates;
}

/**
 * Clear a walk whose initiator never finished it (tab closed mid-stroll):
 * pin the figurine at the walk's destination, where every client has been
 * rendering it. Grace period gives a live initiator time to finish normally.
 */
export function staleWalkUpdates(figurine, now) {
    const walk = figurine.walk;
    if (!walk || typeof walk.startedAt !== 'number' || typeof walk.duration !== 'number') return {};
    if (now - (walk.startedAt + walk.duration) < 60000) return {};
    return { walk: null, x: walk.toX, z: walk.toZ };
}

/**
 * Which needs should trigger caretaker notifications.
 * Energy never notifies - figurines put themselves to sleep.
 */
export function detectNeeds(stats) {
    const needs = [];
    if ((stats.hunger ?? 100) < NEED_THRESHOLDS.hungry) needs.push('hungry');
    if ((stats.happiness ?? 100) < NEED_THRESHOLDS.lonely) needs.push('lonely');
    return needs;
}

/**
 * 48h per-need cooldown: one crossing = one email per caretaker.
 */
export function shouldNotify(lastNotifiedAt, now) {
    return typeof lastNotifiedAt !== 'number' || now - lastNotifiedAt > NOTIFY_COOLDOWN_MS;
}

/**
 * A caretaker who counts publicly AND gets notified: confirmed with an email.
 * Single definition so counts and notifications can never disagree.
 */
function isConfirmed(record) {
    return !!(record && record.confirmedAt && record.email);
}

/**
 * Minimal HTML escaping - figurine names are visitor-supplied and get
 * interpolated into worker HTML pages and email bodies.
 */
export function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/**
 * Text stat bar for emails, e.g. "▓▓░░░░░░░░ 22/100"
 */
export function statBar(value) {
    const filled = Math.round(clamp(value) / 10);
    return '▓'.repeat(filled) + '░'.repeat(10 - filled) + ` ${Math.round(clamp(value))}/100`;
}

const NEED_COPY = {
    hungry: {
        subject: (name) => `${name} is hungry 🌮`,
        line: (name) => `${name} is getting seriously hungry and could really use a meal.`,
        cta: 'Come feed them',
    },
    lonely: {
        subject: (name) => `${name} is feeling lonely 💔`,
        line: (name) => `${name} has been moping around and could use some attention.`,
        cta: 'Come say hi',
    },
};

export function needEmail(name, need, stats, unsubUrl) {
    const copy = NEED_COPY[need];
    // Subject is a plain-text header; the HTML body needs escaping (names
    // are visitor-supplied)
    const safeName = escapeHtml(name);
    return {
        subject: copy.subject(name),
        html: `
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:16px;color:#333">
  <p style="font-size:16px">${copy.line(safeName)}</p>
  <pre style="background:#f6f6f6;border-radius:8px;padding:12px;font-size:14px;line-height:1.6">🍔 Hunger     ${statBar(stats.hunger)}
❤️ Happiness  ${statBar(stats.happiness)}
⚡ Energy     ${statBar(stats.energy)}</pre>
  <p style="text-align:center;margin:24px 0">
    <a href="${PAGE_URL}" style="background:#2d5a3d;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;display:inline-block">${copy.cta} →</a>
  </p>
  <p style="font-size:12px;color:#999">You get these because you're one of ${safeName}'s caretakers. Any caretaker helping out fixes it for everyone.<br>
  <a href="${unsubUrl}" style="color:#999">Unsubscribe</a></p>
</div>`,
    };
}

export function confirmEmail(name, confirmUrl) {
    const safeName = escapeHtml(name);
    return {
        subject: `Confirm: become ${name}'s caretaker 🤝`,
        html: `
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:16px;color:#333">
  <p style="font-size:16px">You asked to become a caretaker of <strong>${safeName}</strong> on Scott's figurine playground. When ${safeName} gets hungry or lonely, you'll get a heads-up email so you can come help out.</p>
  <p style="text-align:center;margin:24px 0">
    <a href="${confirmUrl}" style="background:#2d5a3d;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;display:inline-block">Yes, I'll take care of ${safeName} →</a>
  </p>
  <p style="font-size:12px;color:#999">Didn't request this? Just ignore this email and nothing will happen.</p>
</div>`,
    };
}

// ---------------------------------------------------------------------------
// Firebase helpers (secret-authenticated)
// ---------------------------------------------------------------------------

async function fbGet(env, path) {
    const response = await fetch(
        `${firebaseUrl(env)}/${path}.json?auth=${env.FIREBASE_SECRET}`,
        { signal: AbortSignal.timeout(FIREBASE_TIMEOUT_MS) }
    );
    if (!response.ok) throw new Error(`Firebase GET ${path} failed: ${response.status}`);
    return response.json();
}

async function fbWrite(env, method, path, body) {
    const response = await fetch(
        `${firebaseUrl(env)}/${path}.json?auth=${env.FIREBASE_SECRET}`,
        {
            method,
            signal: AbortSignal.timeout(FIREBASE_TIMEOUT_MS),
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        }
    );
    if (!response.ok) {
        throw new Error(`Firebase ${method} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
}

// ---------------------------------------------------------------------------
// Email via Resend
// ---------------------------------------------------------------------------

async function sendEmail(env, to, { subject, html }) {
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
        headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
    });
    if (!response.ok) {
        console.error('Resend send failed:', response.status, await response.text());
        return false;
    }
    return true;
}

function randomToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Cron: decay, needs, notifications, counts
// ---------------------------------------------------------------------------

async function runCron(env) {
    const now = Date.now();
    const figurines = (await fbGet(env, 'figurines')) || {};

    // 1) Authoritative decay + state normalization + orphaned-walk cleanup:
    //    one atomic multi-path PATCH issued right after the read, so the
    //    read-modify-write window for clobbering a live interaction is tiny.
    //    Figurines a client wrote seconds ago are skipped entirely.
    const multi = {};
    for (const [id, fig] of Object.entries(figurines)) {
        if (!fig || !fig.modelUrl) continue; // skip legacy/malformed entries
        const fresh = typeof fig.statsUpdatedAt === 'number'
            && now - fig.statsUpdatedAt < FRESH_WRITE_SKIP_MS;
        const updates = fresh ? {} : applyTick(fig, now);
        Object.assign(updates, staleWalkUpdates(fig, now));
        for (const [key, value] of Object.entries(updates)) {
            multi[`${id}/${key}`] = value;
        }
        Object.assign(fig, updates);
    }
    if (Object.keys(multi).length > 0) {
        try {
            await fbWrite(env, 'PATCH', 'figurines', multi);
        } catch (error) {
            console.error('Decay write failed:', error);
        }
    }

    // 2) Needs -> notify confirmed caretakers, 48h cooldown per figurine+need
    const caretakers = (await fbGet(env, 'caretakers')) || {};
    const notifyState = (await fbGet(env, 'notifyState')) || {};
    let emailsSent = 0;
    let capped = false;

    for (const [id, fig] of Object.entries(figurines)) {
        if (!fig || !fig.modelUrl) continue;
        const confirmed = Object.values(caretakers[id] || {}).filter(isConfirmed);

        for (const need of detectNeeds(fig)) {
            const lastNotifiedAt = notifyState[id]?.[need]?.lastNotifiedAt;
            if (!shouldNotify(lastNotifiedAt, now)) continue;
            if (confirmed.length === 0) continue;

            let sentForNeed = 0;
            for (const caretaker of confirmed) {
                if (emailsSent >= MAX_EMAILS_PER_CRON_RUN) {
                    capped = true;
                    break;
                }
                const unsubUrl = `${workerUrl(env)}/caretaker/unsubscribe?token=${caretaker.unsubToken}`;
                const ok = await sendEmail(env, caretaker.email, needEmail(fig.name || 'A figurine', need, fig, unsubUrl));
                if (ok) {
                    emailsSent++;
                    sentForNeed++;
                }
            }

            // Stamp the cooldown only when at least one email actually went
            // out - a Resend outage or the per-run cap means the crossing
            // retries next run instead of being silently muted for 48h
            if (sentForNeed > 0) {
                try {
                    await fbWrite(env, 'PATCH', `notifyState/${id}/${need}`, { lastNotifiedAt: now });
                } catch (error) {
                    console.error(`notifyState write failed for ${id}/${need}:`, error);
                }
            }
        }
    }
    if (capped) {
        console.error('Cron email cap reached; unsent notifications retry next run');
    }

    // 3) Maintain public caretaker counts from a FRESH read - signups or
    //    unsubscribes may have landed while the emails above were sending
    const latest = (await fbGet(env, 'caretakers')) || {};
    const counts = {};
    for (const [id, entries] of Object.entries(latest)) {
        counts[id] = Object.values(entries || {}).filter(isConfirmed).length;
    }
    try {
        await fbWrite(env, 'PUT', 'caretakerCounts', counts);
    } catch (error) {
        console.error('caretakerCounts write failed:', error);
    }

    console.log(`Cron done: ${Object.keys(figurines).length} figurines, ${emailsSent} emails`);
}

// ---------------------------------------------------------------------------
// HTTP: caretaker signup / confirm / unsubscribe
// ---------------------------------------------------------------------------

async function handleSignup(request, env, corsHeaders) {
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(clientIP)) {
        return jsonResponse({ error: 'Too many requests. Please try again later.' }, 429, corsHeaders);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders);
    }

    const figurineId = typeof body.figurineId === 'string' ? body.figurineId.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

    if (!FIGURINE_ID_RE.test(figurineId)) {
        return jsonResponse({ error: 'Invalid figurine' }, 400, corsHeaders);
    }
    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
        return jsonResponse({ error: 'Please enter a valid email address' }, 400, corsHeaders);
    }

    const figurine = await fbGet(env, `figurines/${figurineId}`);
    if (!figurine || !figurine.modelUrl) {
        return jsonResponse({ error: 'Figurine not found' }, 404, corsHeaders);
    }
    const name = figurine.name || 'this figurine';

    const existing = (await fbGet(env, `caretakers/${figurineId}`)) || {};
    const entries = Object.entries(existing);

    const match = entries.find(([, c]) => c && c.email === email);
    if (match) {
        const [, record] = match;
        if (record.confirmedAt) {
            return jsonResponse({ ok: true, message: `You're already one of ${name}'s caretakers!` }, 200, corsHeaders);
        }
        // Unconfirmed: resend the confirmation with the existing token
        const confirmUrl = `${workerUrl(env)}/caretaker/confirm?token=${record.unsubToken}`;
        const resent = await sendEmail(env, email, confirmEmail(name, confirmUrl));
        if (!resent) {
            return jsonResponse({ error: 'Could not send the confirmation email. Please try again.' }, 502, corsHeaders);
        }
        return jsonResponse({ ok: true, message: 'Check your email to confirm!' }, 200, corsHeaders);
    }

    if (entries.length >= MAX_CARETAKERS_PER_FIGURINE) {
        return jsonResponse({ error: `${name} has all the caretakers they can handle right now.` }, 409, corsHeaders);
    }

    const token = randomToken();
    await fbWrite(env, 'POST', `caretakers/${figurineId}`, {
        email,
        unsubToken: token,
        createdAt: Date.now(),
    });

    const confirmUrl = `${workerUrl(env)}/caretaker/confirm?token=${token}`;
    const sent = await sendEmail(env, email, confirmEmail(name, confirmUrl));
    if (!sent) {
        return jsonResponse({ error: 'Could not send the confirmation email. Please try again.' }, 502, corsHeaders);
    }

    return jsonResponse({ ok: true, message: 'Check your email to confirm!' }, 200, corsHeaders);
}

/**
 * Find a caretaker record by token across all figurines.
 * The dataset is tiny (a handful of figurines x <=50 caretakers).
 */
async function findByToken(env, token) {
    if (!/^[a-f0-9]{32}$/.test(token || '')) return null;
    const caretakers = (await fbGet(env, 'caretakers')) || {};
    for (const [figurineId, entries] of Object.entries(caretakers)) {
        for (const [key, record] of Object.entries(entries || {})) {
            if (record && record.unsubToken === token) {
                return { figurineId, key, record };
            }
        }
    }
    return null;
}

async function refreshCount(env, figurineId) {
    const entries = (await fbGet(env, `caretakers/${figurineId}`)) || {};
    const count = Object.values(entries).filter(isConfirmed).length;
    await fbWrite(env, 'PUT', `caretakerCounts/${figurineId}`, count);
}

async function handleConfirm(request, env) {
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(clientIP)) {
        return htmlResponse('Too many requests', 'Please try again in a minute.', 429);
    }

    const token = new URL(request.url).searchParams.get('token');
    const found = await findByToken(env, token);
    if (!found) {
        return htmlResponse('Link not found', 'This confirmation link is invalid or was already unsubscribed.', 404);
    }

    if (!found.record.confirmedAt) {
        await fbWrite(env, 'PATCH', `caretakers/${found.figurineId}/${found.key}`, { confirmedAt: Date.now() });
        await refreshCount(env, found.figurineId);
    }

    const figurine = await fbGet(env, `figurines/${found.figurineId}`);
    const name = escapeHtml(figurine?.name || 'your figurine');
    return htmlResponse(
        `You're now ${name}'s caretaker! 🤝`,
        `When ${name} gets hungry or lonely, you'll get an email. <a href="${PAGE_URL}">Visit ${name} now →</a>`
    );
}

async function handleUnsubscribe(request, env) {
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(clientIP)) {
        return htmlResponse('Too many requests', 'Please try again in a minute.', 429);
    }

    const token = new URL(request.url).searchParams.get('token');
    const found = await findByToken(env, token);
    if (!found) {
        return htmlResponse('Link not found', 'This unsubscribe link is invalid or was already used.', 404);
    }

    await fbWrite(env, 'DELETE', `caretakers/${found.figurineId}/${found.key}`);
    await refreshCount(env, found.figurineId);

    return htmlResponse(
        'Unsubscribed 👋',
        `You won't get any more emails about this figurine. You can always <a href="${PAGE_URL}">sign up again</a>.`
    );
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(data, status = 200, corsHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
}

function htmlResponse(title, message, status = 200) {
    return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#faf9f6;color:#333}
main{max-width:420px;padding:2rem;text-align:center}h1{font-size:1.4rem}a{color:#2d5a3d}</style>
</head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

// ---------------------------------------------------------------------------

export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runCron(env));
    },

    async fetch(request, env) {
        const corsHeaders = getCorsHeaders(request);

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const path = new URL(request.url).pathname;

        try {
            if (path === '/caretaker/signup' && request.method === 'POST') {
                return await handleSignup(request, env, corsHeaders);
            }
            if (path === '/caretaker/confirm' && request.method === 'GET') {
                return await handleConfirm(request, env);
            }
            if (path === '/caretaker/unsubscribe' && request.method === 'GET') {
                return await handleUnsubscribe(request, env);
            }
            if (path === '/health') {
                return jsonResponse({ status: 'ok', timestamp: Date.now() }, 200, corsHeaders);
            }
            return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
        } catch (error) {
            console.error('Worker error:', error);
            return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders);
        }
    },
};
