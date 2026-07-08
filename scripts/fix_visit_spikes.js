#!/usr/bin/env node
/**
 * Fix inflated visit counts caused by cat sensor flutter.
 *
 * The Litter Robot sensor bounces between rdy↔cd/cst during a single visit,
 * causing the HA counter to increment multiple times. Cycles are unaffected
 * (ccp→rdy only fires once per cleaning), so they're the source of truth.
 *
 * Logic: if visits > cycles * 2 AND visits > 8, the day is a spike.
 * Corrected visits = cycles (matching the clean data pattern where visits ≈ cycles).
 *
 * Usage: node scripts/fix_visit_spikes.js [--apply]
 *   Without --apply: preview corrections
 *   With --apply: output a single curl PATCH command to run
 */

const https = require('https');

const FIREBASE_URL = 'https://scottfriedman-f400d-default-rtdb.firebaseio.com';

function fetchHistory() {
    return new Promise((resolve, reject) => {
        https.get(`${FIREBASE_URL}/litterrobot/history.json`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data) || {}); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function main() {
    const apply = process.argv.includes('--apply');

    console.log('Fetching history from Firebase...\n');
    const history = await fetchHistory();
    const dates = Object.keys(history).sort();

    // Collect stats for context
    const cleanDays = []; // days where visits ≈ cycles (ratio < 1.5)
    const spikeDays = [];

    for (const date of dates) {
        const visits = typeof history[date].visits === 'number' ? history[date].visits : 0;
        const cycles = typeof history[date].cycles === 'number' ? history[date].cycles : 0;

        if (cycles === 0) continue; // skip days with no cycles

        const ratio = visits / cycles;

        if (visits > cycles * 2 && visits > 8) {
            spikeDays.push({ date, visits, cycles, ratio });
        } else {
            cleanDays.push({ date, visits, cycles, ratio });
        }
    }

    // Show clean data summary
    const cleanRatios = cleanDays.map(d => d.ratio);
    const avgRatio = cleanRatios.reduce((a, b) => a + b, 0) / cleanRatios.length;
    console.log(`Clean days: ${cleanDays.length} (avg visits/cycles ratio: ${avgRatio.toFixed(2)})`);
    console.log(`Spike days: ${spikeDays.length}\n`);

    if (spikeDays.length === 0) {
        console.log('No spikes found! Data looks clean.');
        return;
    }

    // Show proposed corrections
    console.log('Date         | Current | Cycles | Corrected | Removed');
    console.log('-------------|---------|--------|-----------|--------');

    let totalRemoved = 0;
    const corrections = {};

    for (const { date, visits, cycles } of spikeDays) {
        const corrected = cycles;
        const removed = visits - corrected;
        totalRemoved += removed;

        console.log(
            `${date} | ${String(visits).padStart(7)} | ${String(cycles).padStart(6)} | ${String(corrected).padStart(9)} | -${removed}`
        );

        // Build the patch: only update visits, preserve everything else
        corrections[`${date}/visits`] = corrected;
    }

    console.log(`\nTotal phantom visits to remove: ${totalRemoved}`);

    if (apply) {
        const payload = JSON.stringify(corrections);
        console.log('\n--- CURL COMMAND (paste into terminal) ---\n');
        console.log('# litterrobot is not publicly writable; export the database secret first:');
        console.log('# export FIREBASE_SECRET=<Firebase console > Project settings > Service accounts > Database secrets>');
        console.log(`curl -X PATCH "${FIREBASE_URL}/litterrobot/history.json?auth=$FIREBASE_SECRET" \\`);
        console.log(`  -H 'Content-Type: application/json' \\`);
        console.log(`  -d '${payload}'`);
        console.log('\nNote: This uses multi-path PATCH — only the visits field is');
        console.log('updated for each date. Cycles, weights, etc. are untouched.');
    } else {
        console.log('\nRun with --apply to generate the curl command.');
    }
}

main().catch(console.error);
