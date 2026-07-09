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
    const LS_REST_BY_EX = 'workouts:restByExercise'; // { exerciseName: seconds } — Strong-style per-exercise rest memory
    const LS_REST_MUTED = 'workouts:restMuted';   // '1' when the end-of-rest beep is muted
    const REST_DEFAULT = 90;                      // seconds — auto-rest length between sets (Scott 2026-07-09)
    const REST_STEP = 15;                         // ± nudge granularity

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

    // Rest timer — transient (the running countdown lives only in memory; only
    // the per-exercise durations persist). Distinct from the elapsed timer above.
    let restEndsAt = null;      // ms epoch the current rest ends (null = idle)
    let restTotal = 0;          // sec — full length of the current rest (ring + per-exercise save)
    let restExName = null;      // exercise the rest is for (adjustments save under this name)
    let restTickId = null;      // setInterval handle for the countdown
    let restRang = false;       // already fired the end-of-rest beep this rest
    let restPanelOpen = false;  // exact-seconds + mute expander open (survives re-render)
    let audioCtx = null;        // lazily unlocked on a completion tap (iOS gesture rule)

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
            inlineConfirm(discard, 'Discard workout?', discardSession);
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
        clearRest();
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
        if (restEndsAt !== null) startRestTick(); // resume a rest that survived a keep-close
    }
    // Close but keep the session alive (a resume bar takes over the plan view).
    function closeOverlayKeep() {
        stopTimer();
        stopRestTick(); // keep rest state; the countdown resumes from wall-clock on reopen
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

    // ─── Rest timer ─────────────────────────────────────────────────
    // A work-set completion auto-starts a countdown (REST_DEFAULT, or the length
    // remembered for that exercise). Adjustable in-workout (±15s / exact seconds
    // / mute); beeps at zero. Separate from the elapsed-session timer above — that
    // one counts up, this counts down between sets. The running countdown is
    // transient (memory only); only the per-exercise durations persist.
    function restDefaultFor(name) {
        const map = readMap(LS_REST_BY_EX);
        const v = name ? map[name] : null;
        return (typeof v === 'number' && v > 0) ? v : REST_DEFAULT;
    }
    function saveRestFor(name, sec) {
        if (!name || !(sec > 0)) return;
        const map = readMap(LS_REST_BY_EX);
        map[name] = sec;
        writeMap(LS_REST_BY_EX, map);
    }
    function isMuted() {
        try { return localStorage.getItem(LS_REST_MUTED) === '1'; } catch (e) { return false; }
    }
    function setMuted(b) {
        try { localStorage.setItem(LS_REST_MUTED, b ? '1' : '0'); } catch (e) { /* */ }
    }

    // iOS Safari only plays WebAudio once a user gesture has unlocked a context.
    // Unlock runs synchronously from the completion tap, so the end-of-rest beep
    // (fired later from a timer, not a gesture) plays from an already-running ctx.
    function unlockAudio() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            if (!audioCtx) audioCtx = new Ctx();
            if (audioCtx.state === 'suspended') audioCtx.resume();
        } catch (e) { audioCtx = null; }
    }
    function beep() {
        if (isMuted() || !audioCtx) return;
        try {
            const t = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, t);
            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
            osc.connect(gain); gain.connect(audioCtx.destination);
            osc.start(t); osc.stop(t + 0.42);
        } catch (e) { /* audio unavailable — the visual countdown still stands */ }
    }

    function restRemaining() {
        if (restEndsAt === null) return null;
        const ms = restEndsAt - Date.now();
        return ms >= 0 ? Math.ceil(ms / 1000) : Math.floor(ms / 1000);
    }
    function startRestTick() {
        stopRestTick();
        restTickId = setInterval(restTick, 250); // sub-second so the beep lands near 0
    }
    function stopRestTick() {
        if (restTickId) { clearInterval(restTickId); restTickId = null; }
    }
    function restTick() {
        if (restEndsAt === null) { stopRestTick(); return; }
        const ms = restEndsAt - Date.now();
        if (ms <= 0 && !restRang) { restRang = true; beep(); }
        if (ms <= -600000) stopRestTick(); // stop counting up 10 min past zero
        syncRestBar();
    }
    function startRest(name) {
        unlockAudio();
        restExName = name || null;
        restTotal = restDefaultFor(name);
        restEndsAt = Date.now() + restTotal * 1000;
        restRang = false;
        startRestTick();
        renderRestBar();
    }
    function clearRest() {
        stopRestTick();
        restEndsAt = null; restTotal = 0; restExName = null; restRang = false; restPanelOpen = false;
        renderRestBar();
    }
    function nudgeRest(delta) {
        if (restEndsAt === null) return;
        restTotal = Math.max(REST_STEP, restTotal + delta);
        restEndsAt = Math.max(Date.now(), restEndsAt + delta * 1000);
        if (restEndsAt - Date.now() > 0) restRang = false;
        saveRestFor(restExName, restTotal);
        startRestTick();
        syncRestBar();
    }
    function setRestSeconds(sec) {
        if (restEndsAt === null || !(sec > 0)) return;
        restTotal = sec;
        restEndsAt = Date.now() + sec * 1000;
        restRang = false;
        saveRestFor(restExName, restTotal);
        startRestTick();
        syncRestBar();
    }

    function fmtCountdown(sec) {
        const a = Math.abs(sec);
        return (sec < 0 ? '+' : '') + Math.floor(a / 60) + ':' + pad(a % 60);
    }
    function buildRestBar() {
        const bar = el('div', 'logger-rest');
        bar.appendChild(el('div', 'logger-rest-fill'));

        const main = el('div', 'logger-rest-main');
        const time = el('button', 'logger-rest-time');
        time.type = 'button';
        time.setAttribute('aria-label', 'Rest options');
        time.addEventListener('click', () => { restPanelOpen = !restPanelOpen; renderRestBar(); });
        main.appendChild(time);

        const ctrls = el('div', 'logger-rest-ctrls');
        const minus = el('button', 'logger-rest-btn', '−15'); minus.type = 'button';
        minus.addEventListener('click', () => nudgeRest(-REST_STEP));
        const plus = el('button', 'logger-rest-btn', '+15'); plus.type = 'button';
        plus.addEventListener('click', () => nudgeRest(REST_STEP));
        const skip = el('button', 'logger-rest-skip', 'Skip'); skip.type = 'button';
        skip.addEventListener('click', clearRest);
        ctrls.appendChild(minus); ctrls.appendChild(plus); ctrls.appendChild(skip);
        main.appendChild(ctrls);
        bar.appendChild(main);

        const panel = el('div', 'logger-rest-panel');
        const secWrap = el('label', 'logger-rest-secwrap');
        secWrap.appendChild(el('span', 'logger-rest-seclabel', 'Rest sec'));
        const secInp = el('input', 'logger-rest-sec');
        secInp.type = 'text'; secInp.inputMode = 'numeric'; secInp.autocomplete = 'off';
        secInp.addEventListener('click', (e) => e.stopPropagation());
        secInp.addEventListener('change', () => {
            const v = num(secInp.value);
            if (v && v > 0) setRestSeconds(Math.round(v));
        });
        secWrap.appendChild(secInp);
        panel.appendChild(secWrap);
        const mute = el('button', 'logger-rest-mute'); mute.type = 'button';
        mute.addEventListener('click', () => { setMuted(!isMuted()); renderRestBar(); });
        panel.appendChild(mute);
        bar.appendChild(panel);
        return bar;
    }
    function renderRestBar() {
        if (!overlay) return;
        let bar = overlay.querySelector('.logger-rest');
        const active = restEndsAt !== null && view === 'live';
        if (!active) { if (bar) bar.remove(); return; }
        if (!bar) {
            bar = buildRestBar();
            const foot = overlay.querySelector('.logger-foot');
            if (foot) overlay.insertBefore(bar, foot); else overlay.appendChild(bar);
        }
        syncRestBar(bar);
    }
    function syncRestBar(bar) {
        bar = bar || (overlay && overlay.querySelector('.logger-rest'));
        if (!bar) return;
        const rem = restRemaining();
        if (rem === null) return;
        const over = rem < 0;
        bar.classList.toggle('is-over', over);
        bar.classList.toggle('is-open', restPanelOpen);
        const time = bar.querySelector('.logger-rest-time');
        if (time) time.textContent = over ? ('Done ' + fmtCountdown(rem)) : fmtCountdown(rem);
        const fill = bar.querySelector('.logger-rest-fill');
        if (fill) {
            const frac = restTotal > 0 ? Math.max(0, Math.min(1, rem / restTotal)) : 0;
            fill.style.width = (frac * 100).toFixed(1) + '%';
        }
        const sec = bar.querySelector('.logger-rest-sec');
        if (sec && document.activeElement !== sec) sec.value = String(restTotal);
        const mute = bar.querySelector('.logger-rest-mute');
        if (mute) mute.textContent = isMuted() ? '🔇 Muted' : '🔔 Sound';
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
            // Select-all on focus: re-entering a prefilled field types clean —
            // no backspacing over the prescription (item 25).
            inp.addEventListener('focus', () => { try { inp.select(); } catch (e) { /* */ } });
        });

        // Big tap target: tapping the row (anywhere but an input) toggles done.
        row.addEventListener('click', (e) => {
            if (e.target.closest('input')) return;
            toggleSet(exIdx, setIdx, row);
        });
        return row;
    }

    // Surgically sync ONE set row's done-state visuals to the model — no
    // rebuild, so scrollTop and document.activeElement survive a tap under the
    // finger (item 22). Mirrors the done / AMRAP branches of renderSetRow.
    function refreshSetRow(exIdx, setIdx, rowEl) {
        if (!rowEl) return;
        const set = activeSession.exercises[exIdx].sets[setIdx];
        rowEl.classList.toggle('is-done', !!set.done);
        const check = rowEl.querySelector('.set-check');
        if (check) {
            check.textContent = set.done ? '✓' : '';
            check.setAttribute('aria-label', set.done ? 'Mark set not done' : 'Complete set');
        }
        // An uncompleted AMRAP returns to its "max reps" placeholder (a full
        // re-render blanks it; match that so a re-tap re-arms via item 23).
        if (!set.done && set.target && set.target.amrap) {
            const r = rowEl.querySelector('.set-reps');
            if (r) r.value = '';
        }
    }

    // Update an exercise's "n/m sets" count in place after a toggle.
    function refreshExerciseCount(exIdx) {
        if (!overlay) return;
        const sec = overlay.querySelector('.lex[data-ex="' + exIdx + '"]');
        const c = sec && sec.querySelector('.lex-count');
        if (!c) return;
        const work = activeSession.exercises[exIdx].sets.filter((s) => s.kind === 'work');
        c.textContent = work.filter((s) => s.done).length + '/' + work.length + ' sets';
    }

    // The single choke point for a set COMPLETION — full view today, item 19's
    // dummy view tomorrow. Mutate → un-skip → persist → in-place DOM refresh →
    // draft PUT → dispatch logger:setCompleted (the rest timer's auto-start hook).
    // A dummy-mode tap routed here yields the byte-identical schema-1 mutation and
    // draft PUT as a full-view tap. `rowEl` present → surgical refresh; absent
    // (dummy view) → the caller re-renders itself.
    function commitCompletion(exIdx, setIdx, patch, rowEl) {
        activeSession = completeSet(activeSession, exIdx, setIdx, patch);
        unskip(exIdx);
        persist();
        refreshSetRow(exIdx, setIdx, rowEl);
        refreshExerciseCount(exIdx);
        if (view === 'live') refreshProgress();
        pushSession(activeSession);       // draft PUT on every completion
        onSetCompleted(exIdx, setIdx);    // rest timer + future dummy view
    }

    function toggleSet(exIdx, setIdx, rowEl) {
        const set = activeSession.exercises[exIdx].sets[setIdx];
        if (set.done) {
            // Uncomplete: surgical, no draft PUT / event (matches prior behavior —
            // drafts never reach the pipeline, and finish sends the final PUT).
            activeSession = uncompleteSet(activeSession, exIdx, setIdx);
            persist();
            refreshSetRow(exIdx, setIdx, rowEl);
            refreshExerciseCount(exIdx);
            if (view === 'live') refreshProgress();
            return;
        }
        const patch = readRowPatch(rowEl, set);
        // AMRAP type-to-arm (item 23): an AMRAP set's reps ARE the progression
        // signal, so never silently log the scheme's base reps — require a typed
        // count before the row can complete. (Full-view analogue of the dummy
        // view's disabled complete button; the pure core is untouched.)
        if (set.target && set.target.amrap) {
            const r = rowEl && rowEl.querySelector('.set-reps');
            if (!r || r.value.trim() === '' || num(r.value) === null) { nudgeForReps(rowEl); return; }
        }
        commitCompletion(exIdx, setIdx, patch, rowEl);
    }

    // Visual nudge when an AMRAP completion is blocked for want of a rep count.
    function nudgeForReps(rowEl) {
        if (!rowEl) return;
        const r = rowEl.querySelector('.set-reps');
        rowEl.classList.add('needs-reps');
        setTimeout(() => rowEl.classList.remove('needs-reps'), 900);
        if (r) { try { r.focus(); r.select(); } catch (e) { /* */ } }
    }

    // The single place a completion fans out its side effects. The rest timer
    // listens here; item 19's dummy view will route its complete button through
    // the same event so both views behave identically (the plan's seam).
    function onSetCompleted(exIdx, setIdx) {
        document.dispatchEvent(new CustomEvent('logger:setCompleted', {
            detail: { exIdx: exIdx, setIdx: setIdx },
        }));
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
            // Insert/remove the ⋯ panel node in place — a full re-render here
            // would blur a focused field and jump scroll under the finger (item 22).
            const existing = sec.querySelector('.lex-menu-panel');
            if (openMenu.has(exIdx)) {
                openMenu.delete(exIdx);
                if (existing) existing.remove();
            } else {
                openMenu.add(exIdx);
                if (!existing) head.insertAdjacentElement('afterend', renderMenuPanel(exIdx));
            }
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

        renderRestBar(); // a full re-render wipes the bar; re-add it if a rest is running
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
        clearRest();
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

    // Inline two-tap confirm — replaces native confirm(), which blocks the JS
    // thread and is a browser-automation hazard (item 24). First tap arms the
    // control (question + ✓/✕); ✓ confirms, ✕ or a 4s timeout cancels.
    function inlineConfirm(trigger, question, onYes) {
        if (trigger.dataset.confirming === '1') return; // already armed — ignore re-tap
        trigger.dataset.confirming = '1';
        // Inline display (not [hidden]): .logger-start's author `display:block`
        // beats the UA `[hidden]{display:none}`, so the attribute wouldn't hide it.
        trigger.style.display = 'none';
        const box = el('div', 'inline-confirm');
        box.appendChild(el('span', 'inline-confirm-q', question));
        const yes = el('button', 'inline-confirm-yes', '✓');
        yes.type = 'button'; yes.setAttribute('aria-label', 'Confirm');
        const no = el('button', 'inline-confirm-no', '✕');
        no.type = 'button'; no.setAttribute('aria-label', 'Cancel');
        box.appendChild(yes); box.appendChild(no);
        trigger.insertAdjacentElement('afterend', box);
        let settled = false;
        const done = () => {
            if (settled) return; settled = true;
            clearTimeout(timer);
            box.remove();
            trigger.style.display = '';
            delete trigger.dataset.confirming;
        };
        const timer = setTimeout(done, 4000);
        yes.addEventListener('click', () => { done(); onYes(); });
        no.addEventListener('click', done);
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
                    inlineConfirm(btn, 'Start ' + label + '?', () => {
                        const day = Object.assign({ summary: d.evt.summary }, d.parsed);
                        startSession(day, mode);
                    });
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

    // Auto-start the rest timer on a WORK-set completion (warmup ramp steps don't rest).
    document.addEventListener('logger:setCompleted', (e) => {
        if (!activeSession) return;
        const ex = activeSession.exercises[e.detail.exIdx];
        const set = ex && ex.sets[e.detail.setIdx];
        if (!set || set.kind !== 'work') return;
        startRest(ex.plan_name);
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && activeSession) pushSession(activeSession); // draft checkpoint
    });

    // Expose a tiny hook for tests / debugging (never used by the page itself).
    window.__logger = {
        get session() { return activeSession; },
        startSession, openOverlay, decorateCards,
        restState: function () {
            return {
                endsAt: restEndsAt, total: restTotal, exName: restExName,
                remaining: restRemaining(), muted: isMuted(), panelOpen: restPanelOpen,
            };
        },
    };
})();
