/**
 * Builds assets/exercises.json — the curated exercise how-to data behind the
 * ⓘ buttons on workouts.html.
 *
 * Source: github.com/hasaneyldrm/exercises-dataset, pinned to DATASET_COMMIT.
 * Instruction text is MIT-licensed and embedded; GIFs are © Gym visual and
 * are hotlinked from the dataset repo at the pinned commit, never copied
 * into this repo. Exercises missing from the dataset carry hand-written
 * steps and no GIF.
 *
 * Usage: node scripts/build-exercise-info.mjs /path/to/exercises-dataset
 * (a local clone; only data/exercises.json is read).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATASET_COMMIT = '118e4bd6b14da6df0e36605d7169b65db18389a4';
const RAW_BASE = `https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/${DATASET_COMMIT}/`;

// Canonical plan name → dataset id. `steps: [...]` overrides the dataset
// steps where ours fit the actual prescription better (e.g. standing OHP).
const FROM_DATASET = {
    'Bench Press': { id: '0025' },
    'Close-Grip Bench Press': { id: '0030' },
    'Incline DB': { id: '0314' },
    'Overhead Press': {
        id: '1457', // closest demo (standing barbell press, slightly wide grip)
        steps: [
            'Set the bar at upper-chest height in the rack; grip just outside shoulder-width, forearms vertical.',
            'Unrack with the bar resting on your front shoulders, elbows slightly in front of the bar; brace core and squeeze glutes.',
            'Press the bar straight up past your face, moving your head back slightly to clear the bar path.',
            'Lock out overhead with the bar over your mid-foot, shrugging your shoulders up into the bar at the top.',
            'Lower under control back to your shoulders and repeat.',
        ],
    },
    'Deadlift': { id: '0032' },
    'Romanian Deadlift': { id: '0085' },
    'Leg Press': { id: '0739' },
    'Seated Leg Curl': { id: '0599' },
    'Lat Pulldown': { id: '0198' },
    'DB Row': { id: '0293' },
    'Seated Row': { id: '0861' },
    'Rear Delt Fly': { id: '0383' },
    'Cable Crossover': { id: '1269' },
    'Cable Crunch': { id: '0175' },
    'Back Extension': { id: '0489' },
    'Squat': { id: '0043' },
    'Hanging Knee Raise': { id: '0011' },
    'KB Swing': { id: '0549' },
    'SL RDL': { id: '1757' },
    'Table Row': { id: '2300' },
    'Decline Push Up': { id: '0279' },
    'Diamond Push Up': { id: '0283' },
    'Glute Bridge': { id: '3013' },
    'SL Glute Bridge': { id: '3645' },
};

// Not in the dataset — hand-written how-tos, no GIF.
const HAND_WRITTEN = {
    'Face Pull': {
        equipment: 'cable (rope) or band',
        target: 'rear delts',
        secondary: ['traps', 'rotator cuff'],
        steps: [
            'Set a cable pulley (or anchor a band) at upper-chest to eye height and grab the rope with both palms facing in.',
            'Step back until the cable is taut, arms straight, feet shoulder-width apart.',
            'Pull the rope toward your face, driving your elbows high and wide until your hands reach your ears.',
            'At the end, pull the rope apart so your knuckles face behind you — squeeze rear delts and upper back.',
            'Return to straight arms under control; keep shoulders down away from your ears throughout.',
        ],
    },
    'Plank': {
        equipment: 'body weight',
        target: 'abs',
        secondary: ['glutes', 'lower back', 'shoulders'],
        steps: [
            'Forearms on the floor, elbows directly under shoulders, legs extended behind you on your toes.',
            'Brace your abs and squeeze your glutes so your body forms a straight line from head to heels.',
            'Don’t let the hips sag or pike up; keep your neck neutral, gaze at the floor.',
            'Breathe steadily and hold for the prescribed time.',
        ],
    },
    'KB RDL': {
        equipment: 'kettlebell',
        target: 'hamstrings',
        secondary: ['glutes', 'lower back'],
        steps: [
            'Stand with feet hip-width apart, kettlebell held in both hands in front of your thighs.',
            'With soft knees, hinge at the hips by pushing your butt straight back — the bell slides down close to your legs.',
            'Lower until you feel a strong hamstring stretch with a flat back (roughly mid-shin).',
            'Drive your hips forward to stand tall, squeezing your glutes at the top.',
            'Don’t turn it into a squat — your knee angle should barely change.',
        ],
    },
    'Suitcase Carry': {
        equipment: 'kettlebell or dumbbell',
        target: 'obliques',
        secondary: ['grip', 'traps', 'core'],
        steps: [
            'Deadlift the weight up at one side with one hand, like picking up a suitcase.',
            'Stand tall with shoulders level — don’t lean toward or away from the weight.',
            'Walk slow, controlled steps for the prescribed distance or time, core braced the whole way.',
            'Set it down with a flat back, switch hands, and repeat on the other side.',
        ],
    },
    'Pike Push Up': {
        equipment: 'body weight',
        target: 'delts',
        secondary: ['triceps', 'upper chest'],
        steps: [
            'From a push-up position, walk your feet toward your hands and lift your hips high into an inverted V.',
            'Bend your elbows to lower the crown of your head toward the floor between your hands.',
            'Press back up to the V position, keeping your legs straight and your weight stacked over your shoulders.',
            'Elevate your feet on a step to make it harder.',
        ],
    },
    'Banded Push Up': {
        equipment: 'band + body weight',
        target: 'pectorals',
        secondary: ['triceps', 'shoulders'],
        steps: [
            'Loop a resistance band across your upper back and pin an end under each palm.',
            'Set up in a push-up position: hands slightly wider than shoulders, straight line from head to heels.',
            'Lower your chest to just above the floor with elbows about 45° from your torso.',
            'Press up against the band — it’s heaviest at lockout, so stay tight and don’t let your hips sag.',
        ],
    },
    'Wall Sit': {
        equipment: 'body weight',
        target: 'quads',
        secondary: ['glutes', 'calves'],
        steps: [
            'Stand with your back flat against a wall and walk your feet out about two feet.',
            'Slide down until your thighs are parallel to the floor, knees at 90° directly over your ankles.',
            'Press your lower back into the wall and keep your hands off your thighs.',
            'Hold for the prescribed time, breathing steadily.',
        ],
    },
    'Hollow Hold': {
        equipment: 'body weight',
        target: 'abs',
        secondary: ['hip flexors'],
        steps: [
            'Lie on your back and press your lower back firmly into the floor.',
            'Raise your shoulders and legs a few inches off the floor, arms extended overhead (or by your sides to make it easier).',
            'Your body forms a shallow banana shape — the lower back stays glued down the entire time.',
            'Hold for the prescribed time while breathing; if the lower back arches up, shorten the set.',
        ],
    },
    'Superman': {
        equipment: 'body weight',
        target: 'lower back',
        secondary: ['glutes', 'rear delts'],
        steps: [
            'Lie face down with your arms extended overhead.',
            'Raise your arms, chest, and legs off the floor together, squeezing your lower back and glutes.',
            'Pause a beat at the top, then lower with control. Keep your neck neutral — look at the floor.',
        ],
    },
    'Sliding Leg Curl': {
        equipment: 'sliders or towel + body weight',
        target: 'hamstrings',
        secondary: ['glutes', 'core'],
        steps: [
            'Lie on your back with your heels on sliders (or a towel on a smooth floor), knees bent, hips bridged up.',
            'Slide your heels away until your legs are nearly straight, keeping your hips up.',
            'Pull your heels back toward your butt while holding the bridge — your hamstrings do the work.',
            'Keep your hips extended for the whole set; letting them sag is the rest position.',
        ],
    },
    'Prone Y-T-W': {
        equipment: 'body weight',
        target: 'rear delts',
        secondary: ['lower traps', 'rotator cuff'],
        steps: [
            'Lie face down on the floor (or chest-down on an incline bench) with your arms hanging.',
            'Y: raise your arms overhead at 45° with thumbs up, squeeze, and lower.',
            'T: raise your arms straight out to the sides, squeeze your shoulder blades together, and lower.',
            'W: pull your elbows down and back to form a W, squeeze, and lower. That’s one rep.',
        ],
    },
};

// Alternate spellings the plan/pipeline uses → canonical key above.
const ALIASES = {
    'RDL': 'Romanian Deadlift',
    'OHP': 'Overhead Press',
    'CGBP': 'Close-Grip Bench Press',
    'Incline DB Press': 'Incline DB',
    'KB Swings': 'KB Swing',
    'Single-Leg RDL': 'SL RDL',
    'Y-T-W Raise': 'Prone Y-T-W',
    'Prone Y-T-W Raise': 'Prone Y-T-W',
    'Hyperextension': 'Back Extension',
    'Inverted Row': 'Table Row',
};

// The dataset has stray mojibake (e.g. "45в°"); scrub anything we embed.
const sanitize = (s) => s.replace(/в°/g, '°').replace(/\s+/g, ' ').trim();

const datasetDir = process.argv[2];
if (!datasetDir) {
    console.error('usage: node scripts/build-exercise-info.mjs /path/to/exercises-dataset');
    process.exit(1);
}
const records = JSON.parse(readFileSync(join(datasetDir, 'data', 'exercises.json'), 'utf8'));
const byId = new Map(records.map((r) => [r.id, r]));

const exercises = {};
for (const [name, spec] of Object.entries(FROM_DATASET)) {
    const rec = byId.get(spec.id);
    if (!rec) throw new Error(`dataset id ${spec.id} (${name}) not found`);
    exercises[name] = {
        steps: (spec.steps || rec.instruction_steps.en).map(sanitize),
        target: sanitize(rec.target),
        secondary: (rec.secondary_muscles || []).map(sanitize),
        equipment: sanitize(rec.equipment),
        gifUrl: RAW_BASE + rec.gif_url,
        attribution: '© Gym visual — https://gymvisual.com/',
    };
}
for (const [name, spec] of Object.entries(HAND_WRITTEN)) {
    exercises[name] = {
        steps: spec.steps, target: spec.target, secondary: spec.secondary,
        equipment: spec.equipment, gifUrl: null, attribution: null,
    };
}

const out = {
    meta: {
        dataset: 'hasaneyldrm/exercises-dataset',
        commit: DATASET_COMMIT,
        instructionsLicense: 'MIT (dataset instruction text); hand-written entries have gifUrl: null',
        gifCopyright: '© Gym visual — https://gymvisual.com/ (hotlinked, not redistributed)',
    },
    aliases: ALIASES,
    exercises,
};

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'exercises.json');
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${outPath}: ${Object.keys(exercises).length} exercises, ${Object.keys(ALIASES).length} aliases`);
