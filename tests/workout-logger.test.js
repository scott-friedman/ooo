/**
 * Tests for js/workout-logger.js — the pure logic core of the workouts
 * logging mode. Plain Node (`node --test`), no emulator or network.
 *
 * Two layers:
 *  1. parseRepScheme pinned to every literal rep-scheme format live plans emit.
 *  2. A golden walkthrough that drives the exact session from the me-repo
 *     contract fixture (tests/fixtures/app-sessions/) and deep-equals the
 *     schema-1 session.json. The fixtures are Scott's personal training data —
 *     gitignored here, so the test skips cleanly on clones/CI that lack them.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    parseRepScheme, buildSession, completeSet, uncompleteSet, editSet,
    addSet, removeSet, swapToAlt, swapBack, skipExercise, setExerciseNotes,
    setExerciseRpe, finishSession,
} = require('../js/workout-logger.js');
const { parseDescription } = require('../js/workouts.js');

const FIX_DIR = path.join(__dirname, 'fixtures', 'app-sessions');

// ─── Rep-scheme parser ──────────────────────────────────────────────

test('parseRepScheme: every live literal format + null fallback', () => {
    assert.deepStrictEqual(parseRepScheme('5×3 + AMRAP'),
        { sets: 5, reps: 3, amrapLast: true });
    assert.deepStrictEqual(parseRepScheme('3×10'),
        { sets: 3, reps: 10, amrapLast: false });
    assert.deepStrictEqual(parseRepScheme('3×12'),
        { sets: 3, reps: 12, amrapLast: false });
    assert.deepStrictEqual(parseRepScheme('3×8'),
        { sets: 3, reps: 8, amrapLast: false });
    assert.deepStrictEqual(parseRepScheme('3×15'),
        { sets: 3, reps: 15, amrapLast: false });
    assert.deepStrictEqual(parseRepScheme('3×55s'),
        { sets: 3, seconds: 55, amrapLast: false });
    assert.deepStrictEqual(parseRepScheme('3×60s'),
        { sets: 3, seconds: 60, amrapLast: false });
    assert.deepStrictEqual(parseRepScheme('3×10–12'),
        { sets: 3, reps: 10, repsMax: 12, amrapLast: false });
    assert.deepStrictEqual(parseRepScheme('5×3–5+AMRAP'),
        { sets: 5, reps: 3, repsMax: 5, amrapLast: true });
    assert.deepStrictEqual(parseRepScheme('3×20–30s'),
        { sets: 3, seconds: 20, secondsMax: 30, amrapLast: false });
    // Unrecognized → null (UI falls back to manual entry).
    assert.strictEqual(parseRepScheme('as many as possible'), null);
    assert.strictEqual(parseRepScheme(''), null);
    assert.strictEqual(parseRepScheme(null), null);
});

// ─── Golden walkthrough (contract fixture) ──────────────────────────

test('golden walkthrough reproduces schema-1 session.json', (t) => {
    if (!fs.existsSync(path.join(FIX_DIR, 'session.json'))) {
        t.skip('tests/fixtures/app-sessions/ absent — personal training data, '
            + 'source of truth is the me repo');
        return;
    }
    const evt = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'day-event.json'), 'utf8'));
    const expected = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'session.json'), 'utf8'));

    // Parse the plan day-card with workouts.js, then start the session.
    const parsed = parseDescription(evt.description);
    const day = Object.assign({ summary: evt.summary }, parsed);
    let s = buildSession(day, { mode: 'gym', startedAt: '2026-07-08T17:20' });

    // 1. Bench Press (exIdx 0): tap warmups W1–W4 (sets 0–3), leave 125×1 (set 4).
    s = completeSet(s, 0, 0);
    s = completeSet(s, 0, 1);
    s = completeSet(s, 0, 2);
    s = completeSet(s, 0, 3);
    // Complete 5 work sets @145: 3,3,3,3 (sets 5–8) then AMRAP 5 (set 9).
    s = completeSet(s, 0, 5);
    s = completeSet(s, 0, 6);
    s = completeSet(s, 0, 7);
    s = completeSet(s, 0, 8);
    s = completeSet(s, 0, 9, { reps: 5 });
    s = setExerciseNotes(s, 0, 'felt heavy off the chest');
    s = setExerciseRpe(s, 0, 8.5);

    // 2. Romanian Deadlift (exIdx 1): complete 3×10 @95.
    s = completeSet(s, 1, 0);
    s = completeSet(s, 1, 1);
    s = completeSet(s, 1, 2);

    // 3. Cable Crossover (exIdx 2) → swap to alt Incline DB, complete 3×10 @40.
    const alt = parsed.alts.find((a) => a.for === 'Cable Crossover');
    s = swapToAlt(s, 2, alt);
    s = completeSet(s, 2, 0);
    s = completeSet(s, 2, 1);
    s = completeSet(s, 2, 2);

    // 4. Lat Pulldown (exIdx 3): skip (all sets undone).
    s = skipExercise(s, 3);

    // 5. Plank (exIdx 4): complete three sets, then edit the third to 1:05.
    s = completeSet(s, 4, 0);
    s = completeSet(s, 4, 1);
    s = completeSet(s, 4, 2);
    s = editSet(s, 4, 2, { seconds: 65 });

    // Finish 18:05, sauna 20, weigh-in 142, session note.
    s = finishSession(s, {
        finishedAt: '2026-07-08T18:05',
        saunaMinutes: 20,
        weighInLbs: 142,
        notes: 'gym crowded tonight',
    });

    assert.deepStrictEqual(s, expected);
});

// ─── Mutation unit cases (synthetic session) ────────────────────────

function synthetic() {
    const day = {
        summary: 'B1 OHP DAY',
        warmup: null,
        exercises: [{ tier: 'T1', name: 'Overhead Press', weight: '75 lbs', tag: null, reps: '3×5' }],
        alts: [],
        bw: null,
    };
    return buildSession(day, { mode: 'gym', startedAt: '2026-07-08T09:00' });
}

test('buildSession: synthetic day shape and prefill', () => {
    const s = synthetic();
    assert.strictEqual(s.day_label, 'B1 OHP Day');
    assert.strictEqual(s.id, '2026-07-08T09-00');
    assert.strictEqual(s.status, 'in_progress');
    assert.strictEqual(s.exercises[0].sets.length, 3);
    assert.deepStrictEqual(s.exercises[0].sets[0], {
        kind: 'work', weight: 75, reps: 5, seconds: null, done: false,
        target: { weight: 75, reps: 5, seconds: null, amrap: false },
    });
});

test('addSet / removeSet round-trip', () => {
    const base = synthetic();
    const added = addSet(base, 0, { weight: 75, reps: 5 });
    assert.strictEqual(added.exercises[0].sets.length, 4);
    const back = removeSet(added, 0, added.exercises[0].sets.length - 1);
    assert.deepStrictEqual(back, base);
});

test('editSet is reversible and leaves target untouched', () => {
    const base = synthetic();
    const edited = editSet(base, 0, 0, { reps: 8 });
    assert.strictEqual(edited.exercises[0].sets[0].reps, 8);
    assert.strictEqual(edited.exercises[0].sets[0].target.reps, 5); // target unchanged
    const back = editSet(edited, 0, 0, { reps: 5 });
    assert.deepStrictEqual(back, base);
});

test('swapToAlt / swapBack round-trip restores name and set records', () => {
    const day = {
        summary: 'A2 BENCH DAY',
        warmup: null,
        exercises: [{ tier: 'T3', name: 'Lat Pulldown', weight: '70 lbs', tag: null, reps: '3×12' }],
        alts: [{ for: 'Lat Pulldown', name: 'DB Row', weight: '40 lb DBs', reps: '3×12' }],
        bw: null,
    };
    const base = buildSession(day, { mode: 'gym', startedAt: '2026-07-09T09:00' });
    // One set already completed before the swap.
    const oneDone = completeSet(base, 0, 0);
    // The UI snapshots {plan_name, sets} at swap time.
    const snapshot = JSON.parse(JSON.stringify({
        plan_name: oneDone.exercises[0].plan_name,
        sets: oneDone.exercises[0].sets,
    }));
    const swapped = swapToAlt(oneDone, 0, day.alts[0]);
    assert.strictEqual(swapped.exercises[0].plan_name, 'DB Row');
    assert.strictEqual(swapped.exercises[0].swapped_from, 'Lat Pulldown');
    assert.strictEqual(swapped.exercises[0].sets[0].done, false); // rebuilt from alt scheme

    const back = swapBack(swapped, 0, snapshot);
    assert.deepStrictEqual(back, oneDone); // completed set survives the round-trip
});

test('completeSet / uncompleteSet round-trip', () => {
    const base = synthetic();
    const done = completeSet(base, 0, 0);
    assert.strictEqual(done.exercises[0].sets[0].done, true);
    const back = uncompleteSet(done, 0, 0);
    assert.deepStrictEqual(back, base);
});

test('mutations do not mutate their input', () => {
    const base = synthetic();
    const snapshot = JSON.parse(JSON.stringify(base));
    completeSet(base, 0, 0);
    editSet(base, 0, 0, { reps: 99 });
    finishSession(base, { finishedAt: '2026-07-08T10:00' });
    assert.deepStrictEqual(base, snapshot);
});
