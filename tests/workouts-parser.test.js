/**
 * Parser tests for js/workouts.js (the workouts page).
 *
 * The fitness pipeline generates event descriptions in a stable format;
 * these tests pin the parser to representative literal lines so a format
 * drift shows up here instead of as a silently broken page. Pure Node —
 * no emulator or network. Fixtures are workout lines only; the page's
 * access token must never appear in this repo.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
    classifySummary, displayTitle, parseWeightTag, parseTLine,
    parseAltSegment, parseBwSegment, parseDescription, tagKind,
    convertKgToLb, deriveSlug,
} = require('../js/workouts.js');

test('classifySummary: lift day with duration', () => {
    const c = classifySummary('A2 BENCH DAY (40-55 min)');
    assert.deepStrictEqual(
        { done: c.done, type: c.type, dayCode: c.dayCode, qualifier: c.qualifier },
        { done: false, type: 'lift', dayCode: 'A2', qualifier: '40-55 min' });
    assert.strictEqual(displayTitle(c), 'BENCH');
});

test('classifySummary: completed lift day', () => {
    const c = classifySummary('DONE — B2 DEADLIFT DAY');
    assert.strictEqual(c.done, true);
    assert.strictEqual(c.type, 'lift');
    assert.strictEqual(c.dayCode, 'B2');
    assert.strictEqual(displayTitle(c), 'DEADLIFT');
});

test('classifySummary: completed unplanned run', () => {
    const c = classifySummary('DONE — EASY RUN (unplanned)');
    assert.strictEqual(c.done, true);
    assert.strictEqual(c.type, 'run');
    assert.strictEqual(c.qualifier, 'unplanned');
});

test('classifySummary: rest and run days', () => {
    assert.strictEqual(classifySummary('REST').type, 'rest');
    assert.strictEqual(classifySummary('EASY RUN (30 min)').type, 'run');
});

test('parseWeightTag: every live weight/tag shape', () => {
    assert.deepStrictEqual(parseWeightTag('145 lbs (retry)'),
        { weight: '145 lbs', tag: 'retry' });
    assert.deepStrictEqual(parseWeightTag('TBD (after 7/8) (tbd)'),
        { weight: 'TBD (after 7/8)', tag: 'tbd' });
    assert.deepStrictEqual(parseWeightTag('bodyweight + 5 lb (2/3)'),
        { weight: 'bodyweight + 5 lb', tag: '2/3' });
    assert.deepStrictEqual(parseWeightTag('70 lbs (3/3 → +5)'),
        { weight: '70 lbs', tag: '3/3 → +5' });
    assert.deepStrictEqual(parseWeightTag('40 lb DBs (+5)'),
        { weight: '40 lb DBs', tag: '+5' });
    assert.deepStrictEqual(parseWeightTag('12.5 lbs per side (2/3)'),
        { weight: '12.5 lbs per side', tag: '2/3' });
    assert.deepStrictEqual(parseWeightTag('95 lbs'),
        { weight: '95 lbs', tag: null });
});

test('parseTLine: standard and edge-case rows', () => {
    assert.deepStrictEqual(
        parseTLine('T1  Bench Press — 145 lbs (retry) — 5×3 + AMRAP'),
        { tier: 'T1', name: 'Bench Press', weight: '145 lbs', tag: 'retry', reps: '5×3 + AMRAP' });
    assert.deepStrictEqual(
        parseTLine('T3  Close-Grip Bench Press — TBD (after 7/8) (tbd) — 3×10'),
        { tier: 'T3', name: 'Close-Grip Bench Press', weight: 'TBD (after 7/8)', tag: 'tbd', reps: '3×10' });
    assert.deepStrictEqual(
        parseTLine('T3  Back Extension — bodyweight + 5 lb (2/3) — 3×12'),
        { tier: 'T3', name: 'Back Extension', weight: 'bodyweight + 5 lb', tag: '2/3', reps: '3×12' });
    // Not T-lines: prose that happens to mention tiers, or too few fields.
    assert.strictEqual(parseTLine('DL T1 210×3×4 + AMRAP 5 → re-earns +10 accel'), null);
    assert.strictEqual(parseTLine('T1  Bench Press — 145 lbs'), null);
});

test('parseAltSegment: equipment-taken alternate shapes', () => {
    assert.deepStrictEqual(
        parseAltSegment('Lat Pulldown → DB Row — 40 lb DBs — 3×12'),
        { for: 'Lat Pulldown', name: 'DB Row', weight: '40 lb DBs', reps: '3×12' });
    assert.deepStrictEqual(
        parseAltSegment('Cable Crunch → Hanging Knee Raise — bodyweight — 3×10–12'),
        { for: 'Cable Crunch', name: 'Hanging Knee Raise', weight: 'bodyweight', reps: '3×10–12' });
    // Malformed: no arrow, or too few em-dash fields.
    assert.strictEqual(parseAltSegment('DB Row — 40 lb DBs — 3×12'), null);
    assert.strictEqual(parseAltSegment('Lat Pulldown → DB Row — 3×12'), null);
});

test('parseBwSegment: name/prescription split', () => {
    assert.deepStrictEqual(parseBwSegment('Decline Push Up 5×3–5+AMRAP'),
        { name: 'Decline Push Up', rx: '5×3–5+AMRAP' });
    assert.deepStrictEqual(parseBwSegment('KB RDL 24kg 3×10'),
        { name: 'KB RDL 24kg', rx: '3×10' });
    assert.deepStrictEqual(parseBwSegment('Face Pull (Band) 3×15'),
        { name: 'Face Pull (Band)', rx: '3×15' });
    assert.deepStrictEqual(parseBwSegment('Suitcase Carry 24kg'),
        { name: 'Suitcase Carry 24kg', rx: null });
});

test('parseDescription: full structured lift day', () => {
    const desc = [
        'Warmup · bar×5 · 60×5 (7.5/side) · 80×3 (17.5/side) · 100×2 (27.5/side) · 125×1 (40/side)',
        'T1  Bench Press — 145 lbs (retry) — 5×3 + AMRAP',
        'T2  Romanian Deadlift — 95 lbs (hold) — 3×10',
        'T3  Lat Pulldown — 70 lbs (3/3 → +5) — 3×12',
        '',
        'Plates · T1 45+5/side · T2 25/side · CGBP 25+5/side',
        '',
        'Alt (if taken): Lat Pulldown → DB Row — 40 lb DBs — 3×12',
        '',
        'BW swap (home): Decline Push Up 5×3–5+AMRAP · KB RDL 24kg 3×10 · Table Row 3×10–12',
        '',
        '— Sauna (default-on): 20 min at 160-175°F, post-workout cooldown.',
        '  Hydration: 500 ml + salt pre · 750 ml post w/ electrolytes · ≥2h before bed.',
        '',
        '• Bench T1: 145 (retry) — Jun 18 AMRAP 4 held.',
        '• RDL debuts in the squat T2-slot: knee-sparing hinge.',
    ].join('\n');

    const p = parseDescription(desc);
    assert.strictEqual(p.warmup.length, 5);
    assert.strictEqual(p.exercises.length, 3);
    assert.strictEqual(p.exercises[1].name, 'Romanian Deadlift');
    assert.deepStrictEqual(p.plates, ['T1 45+5/side', 'T2 25/side', 'CGBP 25+5/side']);
    assert.deepStrictEqual(p.alts,
        [{ for: 'Lat Pulldown', name: 'DB Row', weight: '40 lb DBs', reps: '3×12' }]);
    assert.strictEqual(p.bw.length, 3);
    assert.match(p.sauna, /^Sauna \(default-on\)/);
    assert.match(p.sauna, /\nHydration:/);
    assert.strictEqual(p.notes.length, 2);
    assert.deepStrictEqual(p.prose, []);
});

test('parseDescription: compound BW segments split into rows', () => {
    const p = parseDescription(
        'BW swap (home): KB Swing 24kg 5×10 + Glute Bridge 3×10 · Plank 3×60s + Suitcase Carry 24kg');
    assert.deepStrictEqual(p.bw.map((b) => b.name),
        ['KB Swing 24kg', 'Glute Bridge', 'Plank', 'Suitcase Carry 24kg']);
});

test('parseDescription: far-future lift day with no T-lines yet', () => {
    const desc = [
        'Weights resolve after 7/8 (Lat Pulldown: after 7/12 · CGBP: after 7/10).',
        'A2 Bench day — Bench T1, Romanian Deadlift T2, + Cable Crossover / Lat Pulldown / Close-Grip Bench.',
        '',
        '• Sauna (default-on) post-workout.',
        '',
        'BW swap (home): Decline Push Up 5×3–5+AMRAP · KB RDL 24kg 3×10',
    ].join('\n');

    const p = parseDescription(desc);
    assert.strictEqual(p.exercises.length, 0);
    assert.strictEqual(p.prose.length, 2);
    assert.strictEqual(p.bw.length, 2);
    assert.strictEqual(p.notes.length, 1);
});

test('convertKgToLb: kg tokens become rounded pounds', () => {
    assert.strictEqual(convertKgToLb('KB Swing 24kg 5×10'), 'KB Swing 53 lb 5×10');
    assert.strictEqual(convertKgToLb('Suitcase Carry 24 kg'), 'Suitcase Carry 53 lb');
    assert.strictEqual(convertKgToLb('16KG bell'), '35 lb bell');   // case-insensitive
    assert.strictEqual(convertKgToLb('24.5 kg'), '54 lb');          // decimals round
    assert.strictEqual(convertKgToLb('two swings 24kg + carry 32kg'),
        'two swings 53 lb + carry 71 lb');                          // multiple tokens
});

test('convertKgToLb: leaves non-kg text alone and is idempotent', () => {
    assert.strictEqual(convertKgToLb('145 lbs (retry)'), '145 lbs (retry)');
    assert.strictEqual(convertKgToLb('bodyweight + 5 lb'), 'bodyweight + 5 lb');
    assert.strictEqual(convertKgToLb('10kgs of effort'), '10kgs of effort'); // \b guard
    assert.strictEqual(convertKgToLb(null), '');
    const once = convertKgToLb('KB RDL 24kg 3×10');
    assert.strictEqual(convertKgToLb(once), once);
});

test('convertKgToLb: converted BW-swap line still parses, no kg survives', () => {
    const p = parseDescription(convertKgToLb(
        'BW swap (home): KB Swing 24kg 5×10 + Glute Bridge 3×10 · Plank 3×60s + Suitcase Carry 24kg'));
    assert.deepStrictEqual(p.bw.map((b) => b.name),
        ['KB Swing 53 lb', 'Glute Bridge', 'Plank', 'Suitcase Carry 53 lb']);
    for (const b of p.bw) assert.doesNotMatch(b.name, /kg/i);
});

test('deriveSlug: deterministic 32-char lowercase hex with fixed vector', async () => {
    const slug = await deriveSlug('test');
    // = hex(SHA-256('workouts.scottfriedman.ooo:v1:' + 'test')).slice(0, 32)
    assert.strictEqual(slug, '8035a3432077ef9aefa744f619a8847d');
    assert.match(slug, /^[0-9a-f]{32}$/);
    assert.strictEqual(await deriveSlug('test'), slug);
    assert.notStrictEqual(await deriveSlug('Test'), slug);
});

test('tagKind: pill coloring buckets', () => {
    assert.strictEqual(tagKind('retry'), 'retry');
    assert.strictEqual(tagKind('tbd'), 'tbd');
    assert.strictEqual(tagKind('+5'), 'up');
    assert.strictEqual(tagKind('3/3 → +5'), 'up');
    assert.strictEqual(tagKind('hold'), 'hold');
    assert.strictEqual(tagKind('2/3'), 'hold');
    assert.strictEqual(tagKind(null), null);
});
