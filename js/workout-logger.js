/**
 * Workout logger — the pure logic core behind the (in-progress) logging mode
 * of the workouts page. Turns a parsed plan day-card into an editable session,
 * applies set-by-set edits, and finalizes a schema-1 session object that IS the
 * JSON the pull pipeline ingests (see me-repo
 * scripts/tests/fixtures/app-sessions/README.md — the golden contract).
 *
 * No DOM, no globals, no Date.now() — every timestamp is passed in. Each
 * mutation helper returns a fresh session (structural copy) and never mutates
 * its input, so the UI can keep undo history for free.
 *
 * Shared plan-line parsers live in workouts.js. In Node we require them; in the
 * browser they are already global bindings from the workouts.js classic script
 * loaded before this one. Same dual-environment guard idiom workouts.js uses.
 */

if (typeof module !== 'undefined' && module.exports) {
    // Node: pull the shared parser off workouts.js. In the browser this branch
    // is dead and `classifySummary` resolves to the global from workouts.js.
    // eslint-disable-next-line no-var
    var { classifySummary } = require('./workouts.js');
}

// Canonical day labels by rotation code (gym mode). Home mode appends the
// standalone `BW` token so the rotation still advances (see wiki/bodyweight-system.md).
const DAY_LABELS = {
    A1: 'A1 Squat Day',
    A2: 'A2 Bench Day',
    B1: 'B1 OHP Day',
    B2: 'B2 Deadlift Day',
};

// ─── Rep-scheme parsing (pure) ──────────────────────────────────────

/**
 * Parse a live plan rep-scheme string into a structured target.
 *   "5×3 + AMRAP"  → { sets:5, reps:3, amrapLast:true }
 *   "3×10"         → { sets:3, reps:10, amrapLast:false }
 *   "3×60s"        → { sets:3, seconds:60, amrapLast:false }
 *   "3×10–12"      → { sets:3, reps:10, repsMax:12, amrapLast:false }
 *   "5×3–5+AMRAP"  → { sets:5, reps:3, repsMax:5, amrapLast:true }
 *   "3×20–30s"     → { sets:3, seconds:20, secondsMax:30, amrapLast:false }
 * Ranges keep the low bound as the prefill and the high bound for placeholder
 * display. Anything unrecognized → null (the UI falls back to manual entry).
 */
function parseRepScheme(str) {
    if (str === null || str === undefined) return null;
    // sets × low[–high][s][ (+|+ )AMRAP]
    const m = String(str).trim().match(/^(\d+)×(\d+)(?:–(\d+))?(s)?(\s*\+\s*AMRAP)?$/);
    if (!m) return null;
    const sets = parseInt(m[1], 10);
    const low = parseInt(m[2], 10);
    const high = m[3] ? parseInt(m[3], 10) : null;
    const timed = !!m[4];
    const amrapLast = !!m[5];

    const out = { sets: sets, amrapLast: amrapLast };
    if (timed) {
        out.seconds = low;
        if (high !== null) out.secondsMax = high;
    } else {
        out.reps = low;
        if (high !== null) out.repsMax = high;
    }
    return out;
}

/** First numeric token in a weight string; "bodyweight" and the like → null. */
function parseWeight(str) {
    if (str === null || str === undefined) return null;
    const m = String(str).match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
}

// ─── Set builders (pure) ────────────────────────────────────────────

/** Build the work sets for one exercise from its scheme at a fixed weight. */
function buildWorkSets(scheme, weight) {
    if (!scheme) return [];
    const timed = typeof scheme.seconds === 'number';
    const sets = [];
    for (let i = 0; i < scheme.sets; i++) {
        const isLast = i === scheme.sets - 1;
        const amrap = !!scheme.amrapLast && isLast;
        const w = timed ? null : (typeof weight === 'number' ? weight : null);
        const r = timed ? null : (typeof scheme.reps === 'number' ? scheme.reps : null);
        const sec = timed ? scheme.seconds : null;
        sets.push({
            kind: 'work',
            weight: w,
            reps: r,
            seconds: sec,
            done: false,
            target: { weight: w, reps: r, seconds: sec, amrap: amrap },
        });
    }
    return sets;
}

/** "bar×5" → {45,5}; "60×5 (7.5/side)" → {60,5} (plate hint dropped). */
function parseWarmupSeg(seg) {
    const m = String(seg).trim().match(/^(bar|\d+(?:\.\d+)?)×(\d+)/);
    if (!m) return null;
    const weight = m[1] === 'bar' ? 45 : parseFloat(m[1]);
    return { kind: 'warmup', weight: weight, reps: parseInt(m[2], 10), seconds: null, done: false };
}

function buildWarmupSets(warmup) {
    if (!warmup) return [];
    return warmup.map(parseWarmupSeg).filter(Boolean);
}

// ─── Session construction ───────────────────────────────────────────

function buildGymExercises(day) {
    const rows = day.exercises || [];
    return rows.map((ex) => {
        const scheme = parseRepScheme(ex.reps);
        const work = buildWorkSets(scheme, parseWeight(ex.weight));
        // Only the T1 carries the warmup ramp.
        const sets = ex.tier === 'T1' ? buildWarmupSets(day.warmup).concat(work) : work;
        return {
            plan_name: ex.name,
            swapped_from: null,
            rpe: null,
            notes: null,
            sets: sets,
        };
    });
}

function buildHomeExercises(day) {
    const rows = day.bw || [];
    return rows.map((row) => {
        const scheme = parseRepScheme(row.rx);
        const sets = scheme
            ? buildWorkSets(scheme, null)
            : [{
                kind: 'work', weight: null, reps: null, seconds: null, done: false,
                target: { weight: null, reps: null, seconds: null, amrap: false },
            }];
        return {
            plan_name: row.name,
            swapped_from: null,
            rpe: null,
            notes: null,
            sets: sets,
        };
    });
}

/**
 * Build an in-progress session from a parsed plan day-card.
 * `day` = { summary, warmup, exercises, alts, bw, ... } — i.e. the event's
 * summary string plus the fields workouts.js `parseDescription` produces.
 * opts = { mode: 'gym'|'home', startedAt: 'YYYY-MM-DDTHH:MM' }.
 */
function buildSession(day, opts) {
    const mode = opts.mode;
    const startedAt = opts.startedAt;
    const cls = classifySummary(day.summary);
    const dayCode = cls.dayCode;
    const dayLabel = mode === 'home'
        ? (dayCode ? dayCode + ' BW' : null)
        : (DAY_LABELS[dayCode] || null);

    const exercises = mode === 'home' ? buildHomeExercises(day) : buildGymExercises(day);

    return {
        schema: 1,
        id: startedAt.replace(/:/g, '-'),
        status: 'in_progress',
        day_code: dayCode,
        day_label: dayLabel,
        mode: mode,
        started_at: startedAt,
        finished_at: null,
        source: 'webapp/1',
        exercises: exercises,
        sauna_minutes: null,
        weigh_in_lbs: null,
        notes: null,
    };
}

// ─── Pure mutation helpers ──────────────────────────────────────────
// Each returns a fresh session; the input is never touched. Sessions are plain
// JSON (no dates, functions, or undefined), so a JSON round-trip is a safe,
// canonical deep copy that also guarantees no `undefined` leaks into the output.

function clone(session) {
    return JSON.parse(JSON.stringify(session));
}

function applySetPatch(set, patch) {
    if (!patch) return;
    if (patch.weight !== undefined) set.weight = patch.weight;
    if (patch.reps !== undefined) set.reps = patch.reps;
    if (patch.seconds !== undefined) set.seconds = patch.seconds;
}

/** Mark a set done, optionally overriding weight/reps/seconds (e.g. AMRAP reps). */
function completeSet(session, exIdx, setIdx, patch) {
    const s = clone(session);
    const set = s.exercises[exIdx].sets[setIdx];
    applySetPatch(set, patch);
    set.done = true;
    return s;
}

function uncompleteSet(session, exIdx, setIdx) {
    const s = clone(session);
    s.exercises[exIdx].sets[setIdx].done = false;
    return s;
}

/** Edit a set's logged weight/reps/seconds. Leaves `target` and `done` alone. */
function editSet(session, exIdx, setIdx, patch) {
    const s = clone(session);
    applySetPatch(s.exercises[exIdx].sets[setIdx], patch);
    return s;
}

/** Append a set (defaults copy the last work set's target). */
function addSet(session, exIdx, spec) {
    const s = clone(session);
    const sets = s.exercises[exIdx].sets;
    spec = spec || {};
    const lastWork = sets.slice().reverse().find((x) => x.kind === 'work');
    const base = (lastWork && lastWork.target)
        ? lastWork.target
        : { weight: null, reps: null, seconds: null, amrap: false };
    const kind = spec.kind || 'work';
    const weight = spec.weight !== undefined ? spec.weight : base.weight;
    const reps = spec.reps !== undefined ? spec.reps : base.reps;
    const seconds = spec.seconds !== undefined ? spec.seconds : base.seconds;
    const set = { kind: kind, weight: weight, reps: reps, seconds: seconds, done: false };
    if (kind === 'work') {
        set.target = { weight: weight, reps: reps, seconds: seconds, amrap: false };
    }
    sets.push(set);
    return s;
}

function removeSet(session, exIdx, setIdx) {
    const s = clone(session);
    s.exercises[exIdx].sets.splice(setIdx, 1);
    return s;
}

/**
 * Swap an exercise to its equipment-taken alternate. `alt` is a workouts.js
 * parseAltSegment row: { for, name, weight, reps }. plan_name becomes the alt
 * name, swapped_from records the original, sets rebuild from the alt's
 * weight/scheme. Any notes/rpe already entered are preserved.
 */
function swapToAlt(session, exIdx, alt) {
    const s = clone(session);
    const ex = s.exercises[exIdx];
    ex.swapped_from = ex.plan_name;
    ex.plan_name = alt.name;
    ex.sets = buildWorkSets(parseRepScheme(alt.reps), parseWeight(alt.weight));
    return s;
}

/**
 * Undo swapToAlt. `original` is the pre-swap snapshot the UI captured:
 * { plan_name, sets }. Restores the name and the exact set records (including
 * any already-completed sets); notes/rpe stay, mirroring swapToAlt.
 */
function swapBack(session, exIdx, original) {
    const s = clone(session);
    const ex = s.exercises[exIdx];
    ex.plan_name = original.plan_name;
    ex.swapped_from = null;
    ex.sets = JSON.parse(JSON.stringify(original.sets));
    return s;
}

/** Mark every set of an exercise not-done (a skipped exercise renders to nothing). */
function skipExercise(session, exIdx) {
    const s = clone(session);
    for (const set of s.exercises[exIdx].sets) set.done = false;
    return s;
}

function setExerciseNotes(session, exIdx, notes) {
    const s = clone(session);
    s.exercises[exIdx].notes = notes;
    return s;
}

function setExerciseRpe(session, exIdx, rpe) {
    const s = clone(session);
    s.exercises[exIdx].rpe = rpe;
    return s;
}

/**
 * Finalize the session. opts = { finishedAt, saunaMinutes, weighInLbs, notes };
 * any omitted trailing field nulls out (schema 1 carries no undefined).
 */
function finishSession(session, opts) {
    const s = clone(session);
    opts = opts || {};
    s.status = 'complete';
    s.finished_at = opts.finishedAt !== undefined ? opts.finishedAt : null;
    s.sauna_minutes = opts.saunaMinutes != null ? opts.saunaMinutes : null;
    s.weigh_in_lbs = opts.weighInLbs != null ? opts.weighInLbs : null;
    s.notes = opts.notes != null ? opts.notes : null;
    return s;
}

// ─── Exports / global surface ───────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseRepScheme, parseWeight, buildWorkSets, buildSession,
        completeSet, uncompleteSet, editSet, addSet, removeSet,
        swapToAlt, swapBack, skipExercise, setExerciseNotes, setExerciseRpe,
        finishSession, DAY_LABELS,
    };
}

/* ====================================================================
   Browser-only logging UI + sync layer.

   Everything below runs only in a browser (guarded by `typeof document`),
   so the pure core above stays Node-testable. All declarations live inside
   one IIFE — never at script top level — so they can't collide with the
   top-level `const`s workouts.js puts in the shared global lexical scope
   (API_BASE, LS_TOKEN, el, …). Those are referenced by name from here.

   The session object is ALWAYS the schema-1 shape the pure core produces;
   this layer only builds DOM around it and PUTs it. Every mutation goes
   through the exported helpers (completeSet, editSet, …) so the golden
   contract can never drift out from under the UI.
   ==================================================================== */
if (typeof document !== 'undefined') (function () {
    'use strict';

    // ─── Config / storage keys ──────────────────────────────────────
    const API = (typeof API_BASE !== 'undefined') ? API_BASE : 'https://foobos.net/api/fitness/';
    const TOKEN_KEY = (typeof LS_TOKEN !== 'undefined') ? LS_TOKEN : 'workouts:token';
    const LS_ACTIVE = 'workouts:activeSession';   // in-progress session JSON
    const LS_ACTIVE_DAY = 'workouts:activeDay';   // UI companion (alts, sauna, skip) — not the contract
    const LS_UNSYNCED = 'workouts:unsynced';      // { id: sessionBody } failed/offline PUTs
    const LS_LOGGED = 'workouts:logged';          // { 'YYYY-MM-DD': id } local echo of finished sessions

    // ─── State ──────────────────────────────────────────────────────
    let activeSession = null;   // schema-1 session (or null)
    let loggerDay = null;       // { alts, hasSauna, saunaDefault, skipped:[] }
    let overlay = null;         // .logger-overlay root
    let resumeBar = null;       // .logger-resume
    let syncBar = null;         // .logger-sync
    let timerId = null;
    let view = 'live';          // 'live' | 'review'
    let renderedView = null;    // view the overlay DOM currently shows (scroll-keep guard)
    const openWarm = new Set(); // exIdx whose warmup expander is open (survives re-render)
    const openMenu = new Set(); // exIdx whose ⋯ panel is open (survives re-render)

    // ─── Tiny helpers ───────────────────────────────────────────────
    function pad(n) { return String(n).padStart(2, '0'); }

    function num(v) {
        if (v === null || v === undefined) return null;
        const s = String(v).trim();
        if (s === '') return null;
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : null;
    }

    function nowLocalMinute() {
        const d = new Date();
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
            + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function parseLocal(s) {
        const m = String(s || '').match(/^(\d+)-(\d+)-(\d+)T(\d+):(\d+)/);
        if (!m) return new Date();
        return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    }

    function fmtDur(sec) {
        if (sec === null || sec === undefined) return '';
        return Math.floor(sec / 60) + ':' + pad(sec % 60);
    }

    function extractSaunaMinutes(s) {
        const m = String(s || '').match(/(\d+)\s*min/);
        return m ? parseInt(m[1], 10) : 20;
    }

    function readMap(key) {
        try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (e) { return {}; }
    }
    function writeMap(key, map) {
        try { localStorage.setItem(key, JSON.stringify(map)); } catch (e) { /* private mode */ }
    }
    function getToken() {
        try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
    }

    // ─── Persistence of the active session ──────────────────────────
    function persist() {
        try {
            if (activeSession) localStorage.setItem(LS_ACTIVE, JSON.stringify(activeSession));
            else localStorage.removeItem(LS_ACTIVE);
            if (loggerDay) localStorage.setItem(LS_ACTIVE_DAY, JSON.stringify(loggerDay));
            else localStorage.removeItem(LS_ACTIVE_DAY);
        } catch (e) { /* private mode — page still works, just no crash-recovery */ }
    }

    function loadState() {
        try {
            const s = localStorage.getItem(LS_ACTIVE);
            activeSession = s ? JSON.parse(s) : null;
            const d = localStorage.getItem(LS_ACTIVE_DAY);
            loggerDay = d ? JSON.parse(d) : null;
        } catch (e) { activeSession = null; loggerDay = null; }
        if (loggerDay && !Array.isArray(loggerDay.skipped)) loggerDay.skipped = [];
        if (loggerDay && (!loggerDay.swapUndo || typeof loggerDay.swapUndo !== 'object')) loggerDay.swapUndo = {};
    }

    function clearActive() {
        activeSession = null;
        loggerDay = null;
        try { localStorage.removeItem(LS_ACTIVE); localStorage.removeItem(LS_ACTIVE_DAY); } catch (e) { /* */ }
    }

    // ─── Sync layer ─────────────────────────────────────────────────
    async function putOnce(id, body) {
        const token = getToken();
        if (!token) return false;
        const res = await fetch(API + encodeURIComponent(token) + '/session/' + encodeURIComponent(id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return res.ok;
    }

    function enqueue(id, body) {
        const map = readMap(LS_UNSYNCED);
        map[id] = body;               // latest body per id wins
        writeMap(LS_UNSYNCED, map);
        updateSyncBar();
    }
    function dequeue(id) {
        const map = readMap(LS_UNSYNCED);
        if (map[id]) { delete map[id]; writeMap(LS_UNSYNCED, map); }
        updateSyncBar();
    }

    function recordLogged(session) {
        const date = String(session.started_at || '').slice(0, 10);
        if (!date) return;
        const map = readMap(LS_LOGGED);
        map[date] = session.id;
        writeMap(LS_LOGGED, map);
        decorateLoggedPill(date);
    }

    // PUT a session; on any failure enqueue it so nothing is ever lost.
    async function pushSession(session) {
        try {
            const ok = await putOnce(session.id, session);
            if (!ok) throw new Error('bad status');
            dequeue(session.id);
            if (session.status === 'complete') recordLogged(session);
            return true;
        } catch (e) {
            enqueue(session.id, session);
            return false;
        }
    }

    async function flushQueue() {
        const map = readMap(LS_UNSYNCED);
        for (const id of Object.keys(map)) {
            const body = map[id];
            try {
                const ok = await putOnce(id, body);
                if (ok) {
                    dequeue(id);
                    if (body && body.status === 'complete') recordLogged(body);
                }
            } catch (e) { /* stays queued for the next online/flush */ }
        }
        updateSyncBar();
    }

    // ─── Sync banner ────────────────────────────────────────────────
    function ensureSyncBar() {
        if (syncBar) return syncBar;
        syncBar = el('div', 'logger-sync');
        syncBar.hidden = true;
        document.body.appendChild(syncBar);
        return syncBar;
    }
    function updateSyncBar() {
        const bar = ensureSyncBar();
        const n = Object.keys(readMap(LS_UNSYNCED)).length;
        if (n > 0) {
            bar.textContent = n + ' session' + (n === 1 ? '' : 's') + ' waiting to sync';
            bar.hidden = false;
        } else {
            bar.hidden = true;
        }
    }

    // ─── Resume bar ─────────────────────────────────────────────────
    function ensureResumeBar() {
        if (resumeBar) return resumeBar;
        resumeBar = el('div', 'logger-resume');
        resumeBar.hidden = true;
        const label = el('span', 'logger-resume-label', 'Workout in progress');
        const btns = el('div', 'logger-resume-btns');
        const resume = el('button', 'logger-resume-resume', 'Resume');
        resume.type = 'button';
        resume.addEventListener('click', openOverlay);
        const discard = el('button', 'logger-resume-discard', 'Discard');
        discard.type = 'button';
        discard.addEventListener('click', () => {
            if (confirm('Discard this in-progress workout?')) discardSession();
        });
        btns.appendChild(resume);
        btns.appendChild(discard);
        resumeBar.appendChild(label);
        resumeBar.appendChild(btns);
        document.body.appendChild(resumeBar);
        return resumeBar;
    }
    function showResumeBar() {
        const bar = ensureResumeBar();
        bar.querySelector('.logger-resume-label').textContent =
            'Workout in progress' + (activeSession && activeSession.day_label ? ' · ' + activeSession.day_label : '');
        bar.hidden = false;
    }
    function hideResumeBar() { if (resumeBar) resumeBar.hidden = true; }

    // ─── Start / resume / discard ───────────────────────────────────
    function startSession(day, mode) {
        const startedAt = nowLocalMinute();
        activeSession = buildSession(day, { mode: mode, startedAt: startedAt });
        loggerDay = {
            alts: day.alts || [],
            hasSauna: !!day.sauna,
            saunaDefault: extractSaunaMinutes(day.sauna),
            skipped: [],
            swapUndo: {},
        };
        openWarm.clear();
        openMenu.clear();
        renderedView = null; // fresh session always opens at the top
        persist();
        openOverlay();
    }

    function discardSession() {
        stopTimer();
        clearActive();
        hideResumeBar();
        if (overlay) overlay.hidden = true;
        document.body.classList.remove('logger-active');
    }

    // ─── Overlay lifecycle ──────────────────────────────────────────
    function openOverlay() {
        if (!overlay) buildOverlay();
        view = 'live';
        overlay.hidden = false;
        hideResumeBar();
        document.body.classList.add('logger-active');
        renderView();
        startTimer();
    }
    // Close but keep the session alive (a resume bar takes over the plan view).
    function closeOverlayKeep() {
        stopTimer();
        if (overlay) overlay.hidden = true;
        document.body.classList.remove('logger-active');
        if (activeSession) showResumeBar();
    }

    function buildOverlay() {
        overlay = el('div', 'logger-overlay');
        overlay.id = 'logger-overlay';
        overlay.hidden = true;
        document.body.appendChild(overlay);
    }

    // ─── Timer ──────────────────────────────────────────────────────
    function startTimer() {
        stopTimer();
        updateTimer();
        timerId = setInterval(updateTimer, 1000);
    }
    function stopTimer() {
        if (timerId) { clearInterval(timerId); timerId = null; }
    }
    function elapsedText() {
        if (!activeSession) return '0:00';
        const start = parseLocal(activeSession.started_at).getTime();
        let sec = Math.max(0, Math.round((Date.now() - start) / 1000));
        const h = Math.floor(sec / 3600);
        sec -= h * 3600;
        const m = Math.floor(sec / 60);
        const s = sec - m * 60;
        return h > 0 ? (h + ':' + pad(m)) : (m + ':' + pad(s));
    }
    function updateTimer() {
        if (!overlay) return;
        const t = overlay.querySelector('.logger-timer');
        if (t) t.textContent = elapsedText();
    }

    // ─── Progress ───────────────────────────────────────────────────
    function workProgress() {
        let done = 0; let total = 0;
        for (const ex of activeSession.exercises) {
            for (const set of ex.sets) {
                if (set.kind === 'work') { total++; if (set.done) done++; }
            }
        }
        return { done: done, total: total };
    }

    // ─── Set-row helpers ────────────────────────────────────────────
    function setLayout(set) {
        if (set.seconds !== null && set.seconds !== undefined) return 'timed';
        if (set.target && set.target.seconds !== null && set.target.seconds !== undefined) return 'timed';
        if (set.kind === 'warmup') return 'weighted';
        if (set.weight !== null && set.weight !== undefined) return 'weighted';
        if (set.target && set.target.weight !== null && set.target.weight !== undefined) return 'weighted';
        return 'bw';
    }

    function fieldInput(cls, mode, value, placeholder) {
        const i = el('input', 'set-field ' + cls);
        i.type = 'text';
        i.inputMode = mode;
        i.autocomplete = 'off';
        i.value = (value === null || value === undefined) ? '' : String(value);
        if (placeholder) i.placeholder = placeholder;
        return i;
    }

    // Read the row's current field values into a completeSet/editSet patch.
    function readRowPatch(rowEl, set) {
        const secEl = rowEl.querySelector('.set-secs');
        if (secEl) {
            const v = num(secEl.value);
            return { seconds: v === null ? set.seconds : v };
        }
        const patch = {};
        const wEl = rowEl.querySelector('.set-weight');
        if (wEl) { const w = num(wEl.value); patch.weight = w === null ? set.weight : w; }
        const rEl = rowEl.querySelector('.set-reps');
        if (rEl) { const r = num(rEl.value); patch.reps = r === null ? set.reps : r; }
        return patch;
    }

    function renderSetRow(exIdx, setIdx, set, labelText) {
        const layout = setLayout(set);
        const isAmrap = !!(set.target && set.target.amrap);
        const row = el('div', 'set-row'
            + (set.done ? ' is-done' : '')
            + (set.kind === 'warmup' ? ' is-warm' : '')
            + (isAmrap ? ' is-amrap' : ''));
        row.dataset.ex = String(exIdx);
        row.dataset.set = String(setIdx);

        row.appendChild(el('span', 'set-num', labelText));

        const fields = el('div', 'set-fields');
        if (layout === 'timed') {
            fields.appendChild(fieldInput('set-secs', 'numeric',
                set.seconds !== null && set.seconds !== undefined ? set.seconds
                    : (set.target ? set.target.seconds : ''), 'sec'));
            fields.appendChild(el('span', 'set-unit', 'sec'));
        } else if (layout === 'weighted') {
            const wVal = set.weight !== null && set.weight !== undefined ? set.weight
                : (set.target ? set.target.weight : '');
            fields.appendChild(fieldInput('set-weight', 'decimal', wVal, ''));
            fields.appendChild(el('span', 'set-x', '×'));
            const rVal = (isAmrap && !set.done) ? '' :
                (set.reps !== null && set.reps !== undefined ? set.reps : (set.target ? set.target.reps : ''));
            fields.appendChild(fieldInput('set-reps', 'numeric', rVal, isAmrap ? 'max reps' : ''));
        } else {
            const rVal = (isAmrap && !set.done) ? '' :
                (set.reps !== null && set.reps !== undefined ? set.reps : (set.target ? set.target.reps : ''));
            fields.appendChild(fieldInput('set-reps', 'numeric', rVal, isAmrap ? 'max reps' : ''));
            fields.appendChild(el('span', 'set-unit', 'reps'));
        }
        row.appendChild(fields);

        const check = el('button', 'set-check', set.done ? '✓' : '');
        check.type = 'button';
        check.setAttribute('aria-label', set.done ? 'Mark set not done' : 'Complete set');
        row.appendChild(check);

        // Persist edits (esp. edits AFTER completion, e.g. a Plank re-time) without a re-render.
        row.querySelectorAll('input.set-field').forEach((inp) => {
            inp.addEventListener('change', () => {
                const s = activeSession.exercises[exIdx].sets[setIdx];
                activeSession = editSet(activeSession, exIdx, setIdx, readRowPatch(row, s));
                persist();
                if (view === 'live') refreshProgress();
            });
            inp.addEventListener('click', (e) => e.stopPropagation());
        });

        // Big tap target: tapping the row (anywhere but an input) toggles done.
        row.addEventListener('click', (e) => {
            if (e.target.closest('input')) return;
            toggleSet(exIdx, setIdx, row);
        });
        return row;
    }

    function toggleSet(exIdx, setIdx, rowEl) {
        const set = activeSession.exercises[exIdx].sets[setIdx];
        const wasDone = set.done;
        if (wasDone) {
            activeSession = uncompleteSet(activeSession, exIdx, setIdx);
        } else {
            activeSession = completeSet(activeSession, exIdx, setIdx, readRowPatch(rowEl, set));
            unskip(exIdx);
        }
        persist();
        renderView();
        if (!wasDone) pushSession(activeSession); // draft PUT on every completion
    }

    function unskip(exIdx) {
        if (loggerDay && loggerDay.skipped) {
            const i = loggerDay.skipped.indexOf(exIdx);
            if (i >= 0) { loggerDay.skipped.splice(i, 1); persist(); }
        }
    }

    // ─── Exercise menu (⋯) ──────────────────────────────────────────
    function renderMenuPanel(exIdx) {
        const ex = activeSession.exercises[exIdx];
        const panel = el('div', 'lex-menu-panel');

        const actions = el('div', 'lex-acts');
        const add = el('button', 'lex-act', '＋ add set'); add.type = 'button'; add.dataset.act = 'add';
        add.addEventListener('click', () => { activeSession = addSet(activeSession, exIdx); persist(); renderView(); });
        const rm = el('button', 'lex-act', '－ remove set'); rm.type = 'button'; rm.dataset.act = 'remove';
        rm.disabled = ex.sets.length === 0;
        rm.addEventListener('click', () => {
            const last = activeSession.exercises[exIdx].sets.length - 1;
            if (last >= 0) { activeSession = removeSet(activeSession, exIdx, last); persist(); renderView(); }
        });
        // Swapped exercises offer the inverse ("swap back") from the snapshot
        // captured at swap time — a mis-tapped swap was otherwise permanent.
        const swapped = !!ex.swapped_from;
        const undoSnap = swapped && loggerDay && loggerDay.swapUndo
            ? loggerDay.swapUndo[String(exIdx)] : null;
        const alt = (loggerDay && loggerDay.alts || []).find((a) => a.for === ex.plan_name);
        const swap = el('button', 'lex-act', swapped ? '⇄ swap back' : '⇄ swap to alt');
        swap.type = 'button'; swap.dataset.act = 'swap';
        swap.disabled = swapped ? !undoSnap : !alt;
        if (swapped && undoSnap) swap.title = 'Back to ' + undoSnap.plan_name;
        else if (alt) swap.title = 'Swap to ' + alt.name;
        swap.addEventListener('click', () => {
            if (swapped) {
                if (!undoSnap) return;
                activeSession = swapBack(activeSession, exIdx, undoSnap);
                delete loggerDay.swapUndo[String(exIdx)];
            } else {
                if (!alt) return;
                if (!loggerDay.swapUndo) loggerDay.swapUndo = {};
                loggerDay.swapUndo[String(exIdx)] = JSON.parse(JSON.stringify(
                    { plan_name: ex.plan_name, sets: ex.sets }));
                activeSession = swapToAlt(activeSession, exIdx, alt);
            }
            persist(); renderView();
        });
        const skip = el('button', 'lex-act', '⤼ skip'); skip.type = 'button'; skip.dataset.act = 'skip';
        skip.addEventListener('click', () => {
            activeSession = skipExercise(activeSession, exIdx);
            if (loggerDay && loggerDay.skipped.indexOf(exIdx) < 0) loggerDay.skipped.push(exIdx);
            persist(); renderView();
        });
        actions.appendChild(add); actions.appendChild(rm);
        actions.appendChild(swap); actions.appendChild(skip);
        panel.appendChild(actions);

        const nf = el('label', 'lex-field');
        nf.appendChild(el('span', 'lex-field-label', 'Notes'));
        const notes = el('textarea', 'lex-notes');
        notes.rows = 2;
        notes.value = ex.notes || '';
        notes.addEventListener('change', () => {
            const v = notes.value.trim();
            activeSession = setExerciseNotes(activeSession, exIdx, v === '' ? null : v);
            persist();
        });
        nf.appendChild(notes);
        panel.appendChild(nf);

        const rf = el('label', 'lex-field');
        rf.appendChild(el('span', 'lex-field-label', 'RPE'));
        const rpe = el('input', 'lex-rpe');
        rpe.type = 'text';
        rpe.inputMode = 'decimal';
        rpe.placeholder = '7–10';
        rpe.value = (ex.rpe === null || ex.rpe === undefined) ? '' : String(ex.rpe);
        rpe.addEventListener('change', () => {
            const v = num(rpe.value);
            activeSession = setExerciseRpe(activeSession, exIdx, v);
            persist();
        });
        rf.appendChild(rpe);
        panel.appendChild(rf);

        return panel;
    }

    function renderExercise(exIdx) {
        const ex = activeSession.exercises[exIdx];
        const skipped = !!(loggerDay && loggerDay.skipped && loggerDay.skipped.indexOf(exIdx) >= 0);
        const sec = el('section', 'lex' + (skipped ? ' is-skipped' : ''));
        sec.dataset.ex = String(exIdx);

        const head = el('div', 'lex-head');
        const titles = el('div', 'lex-titles');
        const nameRow = el('div', 'lex-name-row');
        nameRow.appendChild(el('span', 'lex-name', ex.plan_name));
        if (ex.swapped_from) nameRow.appendChild(el('span', 'lex-was', 'was ' + ex.swapped_from));
        if (skipped) nameRow.appendChild(el('span', 'lex-skip-tag', 'skipped'));
        titles.appendChild(nameRow);

        const meta = el('div', 'lex-meta');
        const workSets = ex.sets.filter((s) => s.kind === 'work');
        const doneWork = workSets.filter((s) => s.done).length;
        meta.appendChild(el('span', 'lex-count', doneWork + '/' + workSets.length + ' sets'));
        if (ex.rpe !== null && ex.rpe !== undefined) meta.appendChild(el('span', 'lex-rpe-chip', 'RPE ' + ex.rpe));
        titles.appendChild(meta);
        head.appendChild(titles);

        const menuBtn = el('button', 'lex-menu', '⋯');
        menuBtn.type = 'button';
        menuBtn.setAttribute('aria-label', 'Exercise options');
        menuBtn.addEventListener('click', () => {
            if (openMenu.has(exIdx)) openMenu.delete(exIdx); else openMenu.add(exIdx);
            renderView();
        });
        head.appendChild(menuBtn);
        sec.appendChild(head);

        if (openMenu.has(exIdx)) sec.appendChild(renderMenuPanel(exIdx));
        if (ex.notes) sec.appendChild(el('p', 'lex-notes-view', ex.notes));

        // Warmup sets under a collapsible expander; each row still tappable.
        const warmups = ex.sets.map((s, i) => ({ s, i })).filter((o) => o.s.kind === 'warmup');
        if (warmups.length) {
            const det = el('details', 'lex-warm');
            det.open = openWarm.has(exIdx);
            const sum = el('summary', 'lex-warm-sum', 'Warmup (' + warmups.length + ')');
            det.appendChild(sum);
            det.addEventListener('toggle', () => {
                if (det.open) openWarm.add(exIdx); else openWarm.delete(exIdx);
            });
            let w = 0;
            for (const o of warmups) det.appendChild(renderSetRow(exIdx, o.i, o.s, 'W' + (++w)));
            sec.appendChild(det);
        }

        // Work sets.
        const workWrap = el('div', 'lex-sets');
        let n = 0;
        ex.sets.forEach((s, i) => {
            if (s.kind !== 'work') return;
            workWrap.appendChild(renderSetRow(exIdx, i, s, String(++n)));
        });
        sec.appendChild(workWrap);
        return sec;
    }

    // ─── Live view ──────────────────────────────────────────────────
    function renderLive() {
        overlay.textContent = '';
        overlay.classList.remove('is-review');

        const head = el('header', 'logger-head');
        const back = el('button', 'logger-back', '✕');
        back.type = 'button';
        back.setAttribute('aria-label', 'Close (keep workout)');
        back.addEventListener('click', closeOverlayKeep);
        head.appendChild(back);

        const titles = el('div', 'logger-head-titles');
        titles.appendChild(el('div', 'logger-title', activeSession.day_label || 'Workout'));
        const pr = workProgress();
        const stats = el('div', 'logger-stats');
        stats.appendChild(el('span', 'logger-timer', elapsedText()));
        stats.appendChild(el('span', 'logger-progress', pr.done + '/' + pr.total));
        titles.appendChild(stats);
        head.appendChild(titles);
        overlay.appendChild(head);

        const scroll = el('div', 'logger-scroll');
        activeSession.exercises.forEach((ex, i) => scroll.appendChild(renderExercise(i)));
        overlay.appendChild(scroll);

        const foot = el('footer', 'logger-foot');
        const fin = el('button', 'logger-finish', 'Finish');
        fin.type = 'button';
        fin.addEventListener('click', () => { view = 'review'; renderView(); });
        foot.appendChild(fin);
        overlay.appendChild(foot);
    }

    function refreshProgress() {
        if (!overlay) return;
        const pr = workProgress();
        const p = overlay.querySelector('.logger-progress');
        if (p) p.textContent = pr.done + '/' + pr.total;
    }

    // ─── Review view ────────────────────────────────────────────────
    function actualText(set) {
        const layout = setLayout(set);
        if (layout === 'timed') return fmtDur(set.seconds);
        if (layout === 'weighted') return (set.weight != null ? set.weight : '?') + ' × ' + (set.reps != null ? set.reps : '?');
        return (set.reps != null ? set.reps : '?') + ' reps';
    }
    function targetText(set) {
        const t = set.target || {};
        if (t.seconds != null) return fmtDur(t.seconds);
        if (t.weight != null) return t.weight + ' × ' + (t.amrap ? 'AMRAP' : t.reps);
        if (t.reps != null) return (t.amrap ? 'AMRAP' : t.reps + ' reps');
        return '';
    }
    function isMiss(set) {
        const t = set.target;
        if (!t || t.amrap) return false;
        if (t.seconds != null) return set.seconds != null && set.seconds < t.seconds;
        if (t.weight != null && set.weight != null && set.weight < t.weight) return true;
        if (t.reps != null && set.reps != null && set.reps < t.reps) return true;
        return false;
    }

    function renderReview() {
        overlay.textContent = '';
        overlay.classList.add('is-review');

        const head = el('header', 'logger-head');
        const back = el('button', 'logger-back', '‹');
        back.type = 'button';
        back.setAttribute('aria-label', 'Back to workout');
        back.addEventListener('click', () => { view = 'live'; renderView(); });
        head.appendChild(back);
        const titles = el('div', 'logger-head-titles');
        titles.appendChild(el('div', 'logger-title', 'Review'));
        head.appendChild(titles);
        overlay.appendChild(head);

        const scroll = el('div', 'logger-scroll logger-review');

        activeSession.exercises.forEach((ex) => {
            const doneSets = ex.sets.filter((s) => s.done);
            if (!doneSets.length) return; // skipped / untouched → omitted (matches renderer contract)
            const box = el('div', 'rev-ex');
            const h = el('div', 'rev-ex-head');
            h.appendChild(el('span', 'rev-ex-name', ex.plan_name));
            if (ex.rpe != null) h.appendChild(el('span', 'lex-rpe-chip', 'RPE ' + ex.rpe));
            box.appendChild(h);
            const list = el('ul', 'rev-sets');
            let n = 0; let w = 0;
            for (const s of doneSets) {
                const li = el('li', 'rev-set' + (isMiss(s) ? ' is-miss' : ''));
                li.appendChild(el('span', 'rev-set-label', s.kind === 'warmup' ? 'W' + (++w) : String(++n)));
                li.appendChild(el('span', 'rev-set-actual', actualText(s)));
                const tgt = targetText(s);
                if (tgt) li.appendChild(el('span', 'rev-set-target', 'target ' + tgt));
                if (isMiss(s)) li.appendChild(el('span', 'rev-miss', 'miss'));
                list.appendChild(li);
            }
            box.appendChild(list);
            if (ex.notes) box.appendChild(el('p', 'rev-ex-notes', ex.notes));
            scroll.appendChild(box);
        });

        const fin = el('div', 'rev-finish');
        if (loggerDay && loggerDay.hasSauna) {
            const f = el('label', 'fin-field');
            f.appendChild(el('span', 'fin-label', 'Sauna (min)'));
            const inp = el('input', 'fin-sauna');
            inp.type = 'text'; inp.inputMode = 'numeric';
            inp.value = String(loggerDay.saunaDefault || 20);
            f.appendChild(inp);
            fin.appendChild(f);
        }
        const wf = el('label', 'fin-field');
        wf.appendChild(el('span', 'fin-label', 'Weigh-in (lb)'));
        const winp = el('input', 'fin-weigh');
        winp.type = 'text'; winp.inputMode = 'decimal'; winp.placeholder = 'optional';
        wf.appendChild(winp);
        fin.appendChild(wf);

        const nf = el('label', 'fin-field');
        nf.appendChild(el('span', 'fin-label', 'Session notes'));
        const ninp = el('textarea', 'fin-notes');
        ninp.rows = 2; ninp.placeholder = 'optional';
        nf.appendChild(ninp);
        fin.appendChild(nf);

        scroll.appendChild(fin);
        overlay.appendChild(scroll);

        const foot = el('footer', 'logger-foot');
        const save = el('button', 'logger-save', 'Save workout');
        save.type = 'button';
        save.addEventListener('click', doSave);
        foot.appendChild(save);
        overlay.appendChild(foot);
    }

    async function doSave() {
        const saunaEl = overlay.querySelector('.fin-sauna');
        const weighEl = overlay.querySelector('.fin-weigh');
        const notesEl = overlay.querySelector('.fin-notes');
        const notesVal = notesEl ? notesEl.value.trim() : '';
        const finished = finishSession(activeSession, {
            finishedAt: nowLocalMinute(),
            saunaMinutes: saunaEl ? num(saunaEl.value) : null,
            weighInLbs: weighEl ? num(weighEl.value) : null,
            notes: notesVal === '' ? null : notesVal,
        });
        // Persist the finalized session before the network round-trip so a
        // crash mid-PUT still recovers the complete session (not a stale draft).
        activeSession = finished;
        persist();
        await pushSession(finished); // final PUT (or enqueue on failure)
        clearActive();
        stopTimer();
        hideResumeBar();
        overlay.hidden = true;
        document.body.classList.remove('logger-active');
    }

    // Full re-render replaces .logger-scroll, whose scrollTop resets to 0 —
    // without the restore below, every tap (set toggle, ⋯ menu, swap) snapped
    // the gym view back to the top of the workout. Scroll is kept only when
    // re-rendering the SAME view; switching live⇄review starts at the top.
    function renderView() {
        if (!overlay || !activeSession) return;
        const prev = overlay.querySelector('.logger-scroll');
        const keep = (renderedView === view && prev) ? prev.scrollTop : 0;
        if (view === 'review') renderReview(); else renderLive();
        renderedView = view;
        const next = overlay.querySelector('.logger-scroll');
        if (next && keep) next.scrollTop = keep;
    }

    // ─── Card decoration (Start buttons + logged pills) ─────────────
    function dayLabelFor(planDay, mode) {
        const code = planDay.cls.dayCode;
        if (mode === 'home') return code ? code + ' BW' : 'Workout';
        return (typeof DAY_LABELS !== 'undefined' && DAY_LABELS[code]) || displayTitle(planDay.cls);
    }

    function decorateLoggedPill(date) {
        document.querySelectorAll('#days > .day-card').forEach((card) => {
            if (!card.planDay || card.planDay.evt.date !== date) return;
            const head = card.querySelector('.day-head') || card;
            if (head.querySelector('.pill-logged')) return;
            head.appendChild(el('span', 'pill pill-logged', 'logged ✓'));
        });
    }

    function decorateCards() {
        const logged = readMap(LS_LOGGED);
        document.querySelectorAll('#days > .day-card').forEach((card) => {
            const d = card.planDay;
            if (!d) return;
            if (d.cls && d.cls.type === 'lift' && !d.cls.done && d.parsed && !card.querySelector('.logger-start')) {
                const btn = el('button', 'logger-start', '● Start workout');
                btn.type = 'button';
                btn.dataset.date = d.evt.date;
                btn.addEventListener('click', () => {
                    const mode = document.body.classList.contains('mode-home') ? 'home' : 'gym';
                    const label = dayLabelFor(d, mode);
                    if (!confirm('Start ' + label + '?')) return;
                    const day = Object.assign({ summary: d.evt.summary }, d.parsed);
                    startSession(day, mode);
                });
                card.appendChild(btn);
            }
            if (logged[d.evt.date]) decorateLoggedPill(d.evt.date);
        });
    }

    // ─── Init ───────────────────────────────────────────────────────
    loadState();
    ensureSyncBar();
    updateSyncBar();
    if (activeSession) showResumeBar();
    flushQueue();

    document.addEventListener('workouts:rendered', decorateCards);
    window.addEventListener('online', flushQueue);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && activeSession) pushSession(activeSession); // draft checkpoint
    });

    // Expose a tiny hook for tests / debugging (never used by the page itself).
    window.__logger = {
        get session() { return activeSession; },
        startSession, openOverlay, decorateCards,
    };
})();
