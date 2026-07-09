/**
 * Unit tests for the figurines-keeper worker's pure decay/need logic.
 * No emulator needed — these import the exported functions directly.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HOUR = 3600 * 1000;
const NOW = 1750000000000;

const keeper = import('../worker/figurines-keeper.js');

const baseFigurine = (overrides = {}) => ({
    modelUrl: 'https://firebasestorage.googleapis.com/x.glb',
    name: 'Testy',
    state: 'idle',
    hunger: 80,
    happiness: 80,
    energy: 80,
    statsUpdatedAt: NOW,
    ...overrides,
});

test('applyTick with no statsUpdatedAt stamps now without decay', async () => {
    const { applyTick } = await keeper;
    const fig = baseFigurine();
    delete fig.statsUpdatedAt;
    const updates = applyTick(fig, NOW);
    assert.deepStrictEqual(updates, {
        hunger: 80, happiness: 80, energy: 80, statsUpdatedAt: NOW,
    });
});

test('applyTick decays idle stats by the hourly rates', async () => {
    const { applyTick, RATES } = await keeper;
    const fig = baseFigurine({ statsUpdatedAt: NOW - 24 * HOUR });
    const updates = applyTick(fig, NOW);
    assert.strictEqual(updates.hunger, 80 - RATES.hungerPerHour * 24);
    assert.strictEqual(updates.happiness, 80 - RATES.happinessPerHour * 24);
    assert.strictEqual(updates.energy, 80 - RATES.energyPerHour * 24);
    assert.strictEqual(updates.statsUpdatedAt, NOW);
    assert.strictEqual(updates.state, undefined);
});

test('hunger decays from full to needy in roughly 3 days', async () => {
    const { applyTick, NEED_THRESHOLDS } = await keeper;
    const fig = baseFigurine({ hunger: 100, statsUpdatedAt: NOW - 72 * HOUR });
    const updates = applyTick(fig, NOW);
    assert.ok(updates.hunger < NEED_THRESHOLDS.hungry + 2, `hunger ${updates.hunger} should be near the threshold`);
    assert.ok(updates.hunger > NEED_THRESHOLDS.hungry - 5, `hunger ${updates.hunger} should not be far past it`);
});

test('sleeping recovers energy and auto-wakes at the threshold', async () => {
    const { applyTick, AUTO_WAKE_ENERGY } = await keeper;
    const resting = applyTick(
        baseFigurine({ state: 'sleeping', energy: 50, statsUpdatedAt: NOW - 1 * HOUR }), NOW);
    assert.strictEqual(resting.energy, 70);
    assert.strictEqual(resting.state, undefined); // still below wake threshold

    const rested = applyTick(
        baseFigurine({ state: 'sleeping', energy: 50, statsUpdatedAt: NOW - 3 * HOUR }), NOW);
    assert.strictEqual(rested.energy, 100);
    assert.ok(rested.energy >= AUTO_WAKE_ENERGY);
    assert.strictEqual(rested.state, 'idle');
});

test('dancing drains energy twice as fast as idling', async () => {
    const { applyTick } = await keeper;
    const idle = applyTick(baseFigurine({ statsUpdatedAt: NOW - 8 * HOUR }), NOW);
    const dancing = applyTick(baseFigurine({ state: 'dancing', statsUpdatedAt: NOW - 8 * HOUR }), NOW);
    assert.strictEqual(80 - dancing.energy, (80 - idle.energy) * 2);
});

test('stats clamp at 0 and 100', async () => {
    const { applyTick } = await keeper;
    const starved = applyTick(
        baseFigurine({ hunger: 2, happiness: 1, energy: 1, statsUpdatedAt: NOW - 100 * HOUR }), NOW);
    assert.strictEqual(starved.hunger, 0);
    assert.strictEqual(starved.happiness, 0);
    assert.strictEqual(starved.energy, 0);

    const overslept = applyTick(
        baseFigurine({ state: 'sleeping', energy: 99, statsUpdatedAt: NOW - 100 * HOUR }), NOW);
    assert.strictEqual(overslept.energy, 100);
});

test('detectNeeds fires below thresholds only', async () => {
    const { detectNeeds } = await keeper;
    assert.deepStrictEqual(detectNeeds({ hunger: 24, happiness: 80 }), ['hungry']);
    assert.deepStrictEqual(detectNeeds({ hunger: 25, happiness: 80 }), []);
    assert.deepStrictEqual(detectNeeds({ hunger: 80, happiness: 10 }), ['lonely']);
    assert.deepStrictEqual(detectNeeds({ hunger: 5, happiness: 5 }), ['hungry', 'lonely']);
    // Energy never notifies — figurines self-sleep
    assert.deepStrictEqual(detectNeeds({ hunger: 80, happiness: 80, energy: 0 }), []);
});

test('shouldNotify enforces the 48h cooldown', async () => {
    const { shouldNotify } = await keeper;
    assert.strictEqual(shouldNotify(undefined, NOW), true);
    assert.strictEqual(shouldNotify(NOW - 47 * HOUR, NOW), false);
    assert.strictEqual(shouldNotify(NOW - 49 * HOUR, NOW), true);
});

test('worker auto-sleeps exhausted figurines (even dancing ones)', async () => {
    const { applyTick, AUTO_SLEEP_ENERGY } = await keeper;
    const exhausted = applyTick(
        baseFigurine({ energy: AUTO_SLEEP_ENERGY + 1, statsUpdatedAt: NOW - 8 * HOUR }), NOW);
    assert.ok(exhausted.energy < AUTO_SLEEP_ENERGY);
    assert.strictEqual(exhausted.state, 'sleeping');

    const dancedOut = applyTick(
        baseFigurine({ state: 'dancing', energy: 10, statsUpdatedAt: NOW - 1 * HOUR }), NOW);
    assert.strictEqual(dancedOut.state, 'sleeping');

    const fine = applyTick(baseFigurine({ statsUpdatedAt: NOW - 1 * HOUR }), NOW);
    assert.strictEqual(fine.state, undefined);
});

test('worker heals a stuck eating state after a minute', async () => {
    const { applyTick } = await keeper;
    const stuck = applyTick(
        baseFigurine({ state: 'eating', lastInteraction: NOW - 2 * HOUR, statsUpdatedAt: NOW - 2 * HOUR }), NOW);
    assert.strictEqual(stuck.state, 'idle');

    const midBite = applyTick(
        baseFigurine({ state: 'eating', lastInteraction: NOW - 1000, statsUpdatedAt: NOW - 2 * HOUR }), NOW);
    assert.strictEqual(midBite.state, undefined);
});

test('staleWalkUpdates clears orphaned walks at their destination', async () => {
    const { staleWalkUpdates } = await keeper;
    const walk = { fromX: 40, fromZ: 40, toX: 60, toZ: 55, duration: 5000 };

    // No walk, or one that ended recently (initiator may still finish it): no-op
    assert.deepStrictEqual(staleWalkUpdates(baseFigurine(), NOW), {});
    assert.deepStrictEqual(
        staleWalkUpdates(baseFigurine({ walk: { ...walk, startedAt: NOW - 10000 } }), NOW), {});

    // Ended over a minute ago: pin at the destination and clear
    assert.deepStrictEqual(
        staleWalkUpdates(baseFigurine({ walk: { ...walk, startedAt: NOW - 120000 } }), NOW),
        { walk: null, x: 60, z: 55 });
});

test('client RATES stay in lockstep with the worker RATES', async () => {
    const { RATES } = await keeper;
    // js/figurines.js is an IIFE, so extract its RATES literal from source -
    // the client renders effective stats with these and the worker writes
    // authoritative values; drift makes stats visibly jump on every cron
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'figurines.js'), 'utf8');
    const block = src.match(/const RATES = \{([\s\S]*?)\};/);
    assert.ok(block, 'client RATES literal not found in js/figurines.js');

    const clientKeys = [...block[1].matchAll(/(\w+):\s*([\d.]+)/g)];
    assert.strictEqual(clientKeys.length, Object.keys(RATES).length,
        'client and worker RATES have a different number of entries');
    for (const [, key, value] of clientKeys) {
        assert.strictEqual(Number(value), RATES[key],
            `client RATES.${key} (${value}) !== worker RATES.${key} (${RATES[key]})`);
    }
});

test('statBar renders a bounded 10-cell bar', async () => {
    const { statBar } = await keeper;
    assert.strictEqual(statBar(0), '░░░░░░░░░░ 0/100');
    assert.strictEqual(statBar(100), '▓▓▓▓▓▓▓▓▓▓ 100/100');
    assert.strictEqual(statBar(22), '▓▓░░░░░░░░ 22/100');
    assert.strictEqual(statBar(250), '▓▓▓▓▓▓▓▓▓▓ 100/100');
});
