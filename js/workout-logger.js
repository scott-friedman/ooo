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
        swapToAlt, skipExercise, setExerciseNotes, setExerciseRpe,
        finishSession, DAY_LABELS,
    };
}
