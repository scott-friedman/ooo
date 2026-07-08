/**
 * Workouts page — renders the fitness plan JSON (the same data behind the
 * calendar feed) as phone-legible day cards with a Gym/Home toggle.
 *
 * Data flow: the plan pipeline pushes fitness-plan.json to Cloudflare KV on
 * every update; foobos.net/api/fitness/<token>.json serves it with CORS for
 * this origin. The token arrives once via URL fragment, is stored in
 * localStorage, and is scrubbed from the address bar. It must never be
 * hardcoded here — this repo is public.
 *
 * Parsing functions are pure and exported for tests/workouts-parser.test.js.
 * Any per-day parse failure falls back to rendering the raw description —
 * a format drift can never blank the page.
 */

const API_BASE = 'https://foobos.net/api/fitness/';
const LS_TOKEN = 'workouts:token';
const LS_MODE = 'workouts:mode';
const LS_CACHE = 'workouts:planCache';

// ─── Parsing (pure) ─────────────────────────────────────────────────

/**
 * Classify an event summary like "A2 BENCH DAY (40-55 min)",
 * "DONE — B2 DEADLIFT DAY", "EASY RUN (30 min)", "REST".
 */
function classifySummary(summary) {
    let s = (summary || '').trim();
    const done = /^DONE\s*—\s*/.test(s);
    if (done) s = s.replace(/^DONE\s*—\s*/, '');

    let qualifier = null;
    const qm = s.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    if (qm) { s = qm[1]; qualifier = qm[2]; }

    const liftMatch = s.match(/^([AB][12])\b/);
    let type = 'other';
    if (liftMatch) type = 'lift';
    else if (/^REST\b/.test(s)) type = 'rest';
    else if (/\bRUN\b/.test(s)) type = 'run';

    return { done, type, title: s, qualifier, dayCode: liftMatch ? liftMatch[1] : null };
}

/** "B2 DEADLIFT DAY" → "DEADLIFT" (day-code chip and DAY suffix are rendered separately). */
function displayTitle(cls) {
    let t = cls.title;
    if (cls.dayCode) t = t.replace(/^[AB][12]\s+/, '');
    return t.replace(/\s+DAY$/, '');
}

/** Peel the trailing "(tag)" off a weight string; the last paren group wins. */
function parseWeightTag(s) {
    const m = s.match(/^(.*\S)\s*\(([^()]*)\)$/);
    if (m) return { weight: m[1], tag: m[2] };
    return { weight: s.trim(), tag: null };
}

/** "T1  Bench Press — 145 lbs (retry) — 5×3 + AMRAP" → structured row, or null. */
function parseTLine(line) {
    const m = line.match(/^(T\d)\s+(.+)$/);
    if (!m) return null;
    const parts = m[2].split(' — ');
    if (parts.length < 3) return null;
    const wt = parseWeightTag(parts.slice(1, -1).join(' — '));
    return {
        tier: m[1],
        name: parts[0],
        weight: wt.weight,
        tag: wt.tag,
        reps: parts[parts.length - 1],
    };
}

/**
 * "Lat Pulldown → DB Row — 40 lb DBs — 3×12" → {for, name, weight, reps},
 * or null. `for` is the T3 row the alternate replaces when its equipment
 * is taken (the pipeline's `Alt (if taken):` line, one segment per T3).
 */
function parseAltSegment(s) {
    const m = s.trim().match(/^(.+?)\s+→\s+(.+)$/);
    if (!m) return null;
    const parts = m[2].split(' — ');
    if (parts.length < 3) return null;
    return {
        for: m[1],
        name: parts[0],
        weight: parts.slice(1, -1).join(' — '),
        reps: parts[parts.length - 1],
    };
}

/** "Decline Push Up 5×3–5+AMRAP" → {name, rx}; unmatched stays name-only. */
function parseBwSegment(s) {
    s = s.trim();
    const m = s.match(/^(.+?)\s+(\d+×.+)$/);
    if (m) return { name: m[1], rx: m[2] };
    return { name: s, rx: null };
}

/**
 * Line-oriented parse of an event description into structured pieces.
 * Anything unrecognized lands in `prose` so nothing is ever dropped.
 */
function parseDescription(desc) {
    const out = {
        warmup: null, exercises: [], plates: null,
        alts: [], bw: null, sauna: null, notes: [], prose: [],
    };
    if (!desc) return out;

    let inSauna = false;
    for (const line of desc.split('\n')) {
        const t = line.trim();
        if (!t) { inSauna = false; continue; }
        if (inSauna && /^\s/.test(line)) { out.sauna += '\n' + t; continue; }
        inSauna = false;

        let m;
        if ((m = t.match(/^Warmup\s*·\s*(.+)$/))) { out.warmup = m[1].split(' · '); continue; }
        const ex = parseTLine(t);
        if (ex) { out.exercises.push(ex); continue; }
        if ((m = t.match(/^Plates\s*·\s*(.+)$/))) { out.plates = m[1].split(' · '); continue; }
        if ((m = t.match(/^Alt \(if taken\):\s*(.+)$/))) {
            out.alts = m[1].split(' · ').map(parseAltSegment).filter(Boolean);
            continue;
        }
        if ((m = t.match(/^BW swap \(home\):\s*(.+)$/))) {
            // Compound segments ("KB Swing 5×10 + Glute Bridge 3×10") split into rows.
            out.bw = m[1].split(' · ')
                .flatMap((seg) => seg.split(' + '))
                .map(parseBwSegment);
            continue;
        }
        if (/^—\s*Sauna/.test(t)) { out.sauna = t.replace(/^—\s*/, ''); inSauna = true; continue; }
        if ((m = t.match(/^•\s*(.+)$/))) { out.notes.push(m[1]); continue; }
        out.prose.push(t);
    }
    return out;
}

/** Progression-tag flavor for pill coloring. */
function tagKind(tag) {
    if (!tag) return null;
    if (tag === 'retry') return 'retry';
    if (tag === 'tbd') return 'tbd';
    if (tag.includes('+')) return 'up';
    return 'hold';
}

// ─── Rendering ──────────────────────────────────────────────────────

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function localDateStr(d) {
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function formatDay(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return days[dt.getDay()] + ' ' + months[dt.getMonth()] + ' ' + dt.getDate();
}

function renderExerciseRow(ex, alt) {
    const li = el('li', 'ex-row');
    li.appendChild(el('span', 'tier tier-' + ex.tier.toLowerCase(), ex.tier));
    const body = el('div', 'ex');

    const primary = el('div', 'ex-variant ex-primary');
    primary.appendChild(el('span', 'ex-name', ex.name));
    const line2 = el('span', 'ex-line2');
    line2.appendChild(el('b', 'ex-weight', ex.weight));
    line2.appendChild(el('span', 'ex-reps', ex.reps));
    const kind = tagKind(ex.tag);
    if (kind) line2.appendChild(el('span', 'tag tag-' + kind, ex.tag));
    primary.appendChild(line2);
    body.appendChild(primary);

    if (alt) {
        // Equipment-taken alternate: hidden until the alt button toggles it in.
        const altBox = el('div', 'ex-variant ex-alt');
        altBox.appendChild(el('span', 'ex-name', alt.name));
        const altLine2 = el('span', 'ex-line2');
        altLine2.appendChild(el('b', 'ex-weight', alt.weight));
        altLine2.appendChild(el('span', 'ex-reps', alt.reps));
        altLine2.appendChild(el('span', 'tag tag-alt', 'alt'));
        altBox.appendChild(altLine2);
        body.appendChild(altBox);

        const btn = el('button', 'alt-btn', '⇄ alt');
        btn.type = 'button';
        btn.setAttribute('aria-pressed', 'false');
        btn.title = 'Equipment taken? Swap to ' + alt.name;
        btn.addEventListener('click', () => {
            const on = li.classList.toggle('show-alt');
            btn.setAttribute('aria-pressed', String(on));
            btn.textContent = on ? '⇄ back' : '⇄ alt';
        });
        li.appendChild(body);
        li.appendChild(btn);
        return li;
    }

    li.appendChild(body);
    return li;
}

function renderBwBlock(bw) {
    const wrap = el('div', 'bw-only');
    wrap.appendChild(el('p', 'bw-caption', 'bodyweight swap · home'));
    const ul = el('ul', 'bw-list');
    for (const item of bw) {
        const li = el('li', 'bw-row');
        li.appendChild(el('span', 'bw-name', item.name));
        if (item.rx) li.appendChild(el('span', 'bw-rx', item.rx));
        ul.appendChild(li);
    }
    wrap.appendChild(ul);
    return wrap;
}

function renderNotes(notes, open) {
    const details = el('details', 'notes');
    if (open) details.open = true;
    details.appendChild(el('summary', null, 'Notes (' + notes.length + ')'));
    const ul = el('ul', 'notes-list');
    for (const n of notes) ul.appendChild(el('li', null, n));
    details.appendChild(ul);
    return details;
}

/** The card body shared by expanded (today/future) and collapsed (past) cards. */
function renderDayBody(evt, cls, parsed, isToday) {
    const body = el('div', 'day-body');
    const hasBw = !!(parsed.bw && parsed.bw.length);
    const gymOnly = hasBw ? ' gym-only' : '';

    if (parsed.warmup) {
        const w = el('p', 'warmup' + gymOnly);
        w.appendChild(el('span', 'warmup-label', 'Warmup'));
        w.appendChild(document.createTextNode(' ' + parsed.warmup.join(' · ')));
        body.appendChild(w);
    }
    if (parsed.exercises.length) {
        const altFor = new Map((parsed.alts || []).map((a) => [a.for, a]));
        const ul = el('ul', 'exercise-list' + gymOnly);
        for (const ex of parsed.exercises) ul.appendChild(renderExerciseRow(ex, altFor.get(ex.name)));
        body.appendChild(ul);
    }
    for (const p of parsed.prose) {
        // On lift days with a home swap, lead-in prose is gym context.
        body.appendChild(el('p', 'prose' + (cls.type === 'lift' ? gymOnly : ''), p));
    }
    if (parsed.plates) body.appendChild(el('p', 'plates' + gymOnly, 'Plates · ' + parsed.plates.join(' · ')));
    if (hasBw) body.appendChild(renderBwBlock(parsed.bw));
    if (cls.type === 'lift' && !hasBw && !cls.done) {
        body.appendChild(el('p', 'no-bw-note', 'no home swap listed for this day'));
    }
    if (parsed.sauna) body.appendChild(el('p', 'sauna' + gymOnly, parsed.sauna));
    if (parsed.notes.length) body.appendChild(renderNotes(parsed.notes, isToday));
    return body;
}

function renderHeadInto(container, evt, cls, isToday) {
    const dateLine = el('span', 'day-date', formatDay(evt.date));
    if (isToday) dateLine.appendChild(el('span', 'pill pill-today', 'today'));
    container.appendChild(dateLine);

    const h2 = el('h2', 'day-title');
    if (cls.dayCode) h2.appendChild(el('span', 'day-code', cls.dayCode));
    h2.appendChild(el('span', 'day-name type-' + cls.type, displayTitle(cls)));
    if (cls.done) h2.appendChild(el('span', 'done-check', '✓'));
    if (cls.qualifier) h2.appendChild(el('span', 'duration', cls.qualifier.replace('-', '–')));
    container.appendChild(h2);
}

function renderDayCard(evt, todayStr) {
    const cls = classifySummary(evt.summary);
    const isToday = evt.date === todayStr;
    const isPast = evt.date < todayStr || cls.done;

    let parsed;
    try {
        parsed = parseDescription(evt.description || '');
    } catch (err) {
        parsed = null;
    }

    const typeClass = 'day-card type-' + cls.type
        + (parsed && parsed.bw && parsed.bw.length ? ' has-bw' : '')
        + (isToday ? ' is-today' : '') + (isPast ? ' past' : '');

    let card;
    if (isPast && !isToday) {
        card = el('details', typeClass);
        const summary = el('summary', 'day-head');
        renderHeadInto(summary, evt, cls, false);
        card.appendChild(summary);
    } else {
        card = el('article', typeClass);
        const head = el('header', 'day-head');
        renderHeadInto(head, evt, cls, isToday);
        card.appendChild(head);
    }
    if (isToday) card.id = 'today';

    if (parsed) {
        card.appendChild(renderDayBody(evt, cls, parsed, isToday));
    } else {
        const pre = el('pre', 'raw-fallback', evt.description || '');
        card.appendChild(pre);
    }
    return card;
}

function renderPlan(plan, fetchedAt, stale) {
    const daysEl = document.getElementById('days');
    daysEl.textContent = '';
    document.getElementById('token-section').hidden = true;

    const meta = document.getElementById('plan-meta');
    let metaText = plan.name || 'Fitness plan';
    if (plan.phase && plan.phase.target_exit) {
        metaText += ' · phase ends ' + formatDay(plan.phase.target_exit).replace(/^\w+ /, '');
    }
    meta.textContent = metaText;

    const todayStr = localDateStr(new Date());
    const events = (plan.events || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const evt of events) {
        if (!evt.date) continue;
        daysEl.appendChild(renderDayCard(evt, todayStr));
    }

    const banner = document.getElementById('banner');
    if (stale) {
        banner.textContent = '';
        banner.appendChild(document.createTextNode(
            'offline — saved copy from ' + new Date(fetchedAt).toLocaleString([], {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            }) + ' '));
        const retry = el('button', 'retry-btn', 'retry');
        retry.addEventListener('click', () => location.reload());
        banner.appendChild(retry);
        banner.hidden = false;
    } else {
        banner.hidden = true;
    }

    document.getElementById('fetched-at').textContent =
        'updated ' + new Date(fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    const target = document.getElementById('today')
        || daysEl.querySelector('article.day-card:not(.past)');
    if (target) target.scrollIntoView({ block: 'start' });
}

// ─── Mode toggle ────────────────────────────────────────────────────

function setMode(mode) {
    document.body.classList.toggle('mode-home', mode === 'home');
    try { localStorage.setItem(LS_MODE, mode); } catch (e) { /* private mode */ }
    for (const btn of document.querySelectorAll('.mode-toggle button')) {
        btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
    }
}

// ─── Token + fetch ──────────────────────────────────────────────────

function captureToken() {
    const fragment = location.hash.replace(/^#/, '').trim();
    if (fragment) {
        try { localStorage.setItem(LS_TOKEN, fragment); } catch (e) { /* private mode */ }
        history.replaceState(null, '', location.pathname + location.search);
        return fragment;
    }
    try { return localStorage.getItem(LS_TOKEN); } catch (e) { return null; }
}

function showTokenForm(message) {
    document.getElementById('days').textContent = '';
    document.getElementById('banner').hidden = true;
    const section = document.getElementById('token-section');
    section.hidden = false;
    const msg = document.getElementById('token-message');
    msg.textContent = message || '';
    msg.hidden = !message;
    let stored = null;
    try { stored = localStorage.getItem(LS_TOKEN); } catch (e) { /* private mode */ }
    if (stored) document.getElementById('token-input').value = stored;
}

function readCache() {
    try {
        const raw = localStorage.getItem(LS_CACHE);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

async function loadPlan() {
    const token = captureToken();
    if (!token) { showTokenForm(); return; }

    try {
        const res = await fetch(API_BASE + encodeURIComponent(token) + '.json');
        if (res.status === 404) {
            showTokenForm('token not recognized — check the link and paste it again');
            return;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const plan = await res.json();
        const fetchedAt = Date.now();
        try {
            localStorage.setItem(LS_CACHE, JSON.stringify({ fetchedAt, plan }));
        } catch (e) { /* storage full/private — page still works */ }
        renderPlan(plan, fetchedAt, false);
    } catch (err) {
        const cache = readCache();
        if (cache && cache.plan) {
            renderPlan(cache.plan, cache.fetchedAt, true);
        } else {
            showTokenForm("couldn't reach the plan server — check your connection and retry");
        }
    }
}

// ─── Init ───────────────────────────────────────────────────────────

function init() {
    let mode = null;
    try { mode = localStorage.getItem(LS_MODE); } catch (e) { /* private mode */ }
    setMode(mode === 'home' ? 'home' : 'gym');

    for (const btn of document.querySelectorAll('.mode-toggle button')) {
        btn.addEventListener('click', () => setMode(btn.dataset.mode));
    }

    document.getElementById('token-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const value = document.getElementById('token-input').value.trim();
        if (!value) return;
        try { localStorage.setItem(LS_TOKEN, value); } catch (err) { /* private mode */ }
        loadPlan();
    });

    document.getElementById('reset-token').addEventListener('click', (e) => {
        e.preventDefault();
        try { localStorage.removeItem(LS_TOKEN); } catch (err) { /* private mode */ }
        showTokenForm();
    });

    loadPlan();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        classifySummary, displayTitle, parseWeightTag, parseTLine,
        parseAltSegment, parseBwSegment, parseDescription, tagKind,
    };
}

if (typeof document !== 'undefined') init();
