/**
 * Tests for js/exercise-info.js (exercise how-to sheets) and the curated
 * assets/exercises.json. The coverage test pins every exercise name the
 * live plan format can render — a plan rename or curation gap shows up
 * here instead of as a dead ⓘ button.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeExerciseName, lookupExercise } = require('../js/exercise-info.js');
const db = require('../assets/exercises.json');

test('normalizeExerciseName: strips decorations, keeps plain names', () => {
    assert.strictEqual(normalizeExerciseName('Face Pull (Band)'), 'Face Pull');
    assert.strictEqual(normalizeExerciseName('KB Swing 53 lb'), 'KB Swing');
    assert.strictEqual(normalizeExerciseName('KB RDL 24kg'), 'KB RDL');
    assert.strictEqual(normalizeExerciseName('Suitcase Carry 53 lb'), 'Suitcase Carry');
    assert.strictEqual(normalizeExerciseName('Bench Press'), 'Bench Press');
    assert.strictEqual(normalizeExerciseName('SL RDL'), 'SL RDL');
    assert.strictEqual(normalizeExerciseName('  Cable   Crossover '), 'Cable Crossover');
    assert.strictEqual(normalizeExerciseName(null), '');
});

test('lookupExercise: exact, alias, and normalized paths', () => {
    assert.strictEqual(lookupExercise(db, 'Bench Press').name, 'Bench Press');
    assert.strictEqual(lookupExercise(db, 'RDL').name, 'Romanian Deadlift');
    assert.strictEqual(lookupExercise(db, 'KB Swing 53 lb').name, 'KB Swing');
    assert.strictEqual(lookupExercise(db, 'Face Pull (Band)').name, 'Face Pull');
    assert.strictEqual(lookupExercise(db, 'No Such Movement'), null);
    assert.strictEqual(lookupExercise(null, 'Bench Press'), null);
});

test('curated entries are well-formed', () => {
    assert.ok(Object.keys(db.exercises).length >= 30);
    for (const [name, info] of Object.entries(db.exercises)) {
        assert.ok(Array.isArray(info.steps) && info.steps.length >= 3, name + ' has steps');
        assert.ok(info.target, name + ' has target');
        assert.ok(info.equipment, name + ' has equipment');
        if (info.gifUrl !== null) {
            assert.match(info.gifUrl, /^https:\/\/raw\.githubusercontent\.com\/hasaneyldrm\/exercises-dataset\/[0-9a-f]{40}\/videos\/.+\.gif$/,
                name + ' gif is pinned');
            assert.strictEqual(info.attribution, '© Gym visual — https://gymvisual.com/');
        }
    }
    for (const [alias, target] of Object.entries(db.aliases)) {
        assert.ok(db.exercises[target], 'alias ' + alias + ' points at real entry');
    }
});

test('every name the live plan renders resolves to a curated entry', () => {
    // T-lines, alt lines, and BW-swap rows from the current plan format,
    // post kg→lb conversion. Extend when the plan rotates in a new movement.
    const liveNames = [
        // T1/T2/T3 gym lifts
        'Bench Press', 'Close-Grip Bench Press', 'Incline DB', 'Overhead Press',
        'Deadlift', 'Romanian Deadlift', 'Leg Press', 'Seated Leg Curl',
        'Lat Pulldown', 'DB Row', 'Face Pull', 'Cable Crossover', 'Cable Crunch',
        'Back Extension', 'Plank',
        // Alt (if taken) rows
        'Seated Row', 'Rear Delt Fly', 'Hanging Knee Raise',
        // BW swap (home) rows as rendered after conversion
        'Decline Push Up', 'Diamond Push Up', 'Pike Push Up', 'Banded Push Up',
        'Table Row', 'Glute Bridge', 'KB Swing 53 lb', 'KB RDL 53 lb',
        'SL RDL', 'Suitcase Carry 53 lb',
    ];
    for (const name of liveNames) {
        assert.ok(lookupExercise(db, name), 'no curated entry resolves for: ' + name);
    }
});
