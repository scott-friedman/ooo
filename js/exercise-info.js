/**
 * Exercise how-to sheets — ⓘ buttons next to exercise names (read view,
 * BW swap rows, and the live logger) open a bottom sheet with a demo GIF,
 * muscles, equipment, and step-by-step instructions.
 *
 * Data: assets/exercises.json, curated by scripts/build-exercise-info.mjs
 * from hasaneyldrm/exercises-dataset (instruction text MIT; GIFs © Gym
 * visual, hotlinked at a pinned commit — never copied into this repo).
 * Fetched lazily on the first tap, then kept in memory.
 *
 * Loads as a classic script after workouts.js/workout-logger.js and shares
 * their top-level scope (el, exInfoBtn). Pure helpers are exported for
 * tests/exercise-info.test.js.
 */

/**
 * Plan text decorates names ("Face Pull (Band)", "KB Swing 53 lb"); strip
 * trailing parentheticals and weight tokens so they match curated keys.
 */
function normalizeExerciseName(name) {
    let s = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
    s = s.replace(/\s*\([^()]*\)$/, '');
    s = s.replace(/\s+\d+(?:\.\d+)?\s*(?:lbs?|kg)s?$/i, '');
    return s.trim();
}

/** Resolve a rendered name against the curated db (exact → alias → normalized). */
function lookupExercise(db, name) {
    if (!db || !db.exercises) return null;
    const tryKey = (k) => {
        if (!k) return null;
        if (db.exercises[k]) return { name: k, info: db.exercises[k] };
        const alias = db.aliases && db.aliases[k];
        if (alias && db.exercises[alias]) return { name: alias, info: db.exercises[alias] };
        return null;
    };
    const raw = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
    return tryKey(raw) || tryKey(normalizeExerciseName(raw));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeExerciseName, lookupExercise };
}

if (typeof document !== 'undefined') (function () {
    let dbPromise = null;
    let backdrop = null;
    let sheet = null;
    let lastFocus = null;

    function fetchDb() {
        if (!dbPromise) {
            dbPromise = fetch('assets/exercises.json').then((res) => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            }).catch((err) => {
                dbPromise = null; // offline now ≠ offline forever — retry next tap
                throw err;
            });
        }
        return dbPromise;
    }

    function ensureSheet() {
        if (sheet) return;
        backdrop = el('div', 'exinfo-backdrop');
        backdrop.hidden = true;
        backdrop.addEventListener('click', closeSheet);

        sheet = el('div', 'exinfo-sheet');
        sheet.hidden = true;
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.setAttribute('aria-label', 'Exercise how-to');

        const head = el('div', 'exinfo-head');
        head.appendChild(el('h3', 'exinfo-title', ''));
        const close = el('button', 'exinfo-close', '✕');
        close.type = 'button';
        close.setAttribute('aria-label', 'Close');
        close.addEventListener('click', closeSheet);
        head.appendChild(close);
        sheet.appendChild(head);
        sheet.appendChild(el('div', 'exinfo-body'));

        document.body.appendChild(backdrop);
        document.body.appendChild(sheet);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !sheet.hidden) closeSheet();
        });
    }

    function closeSheet() {
        if (!sheet || sheet.hidden) return;
        sheet.hidden = true;
        backdrop.hidden = true;
        // Drop the GIF so a closed sheet isn't animating/downloading behind the page.
        const img = sheet.querySelector('.exinfo-gif');
        if (img) img.remove();
        if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* gone */ } }
        lastFocus = null;
    }

    function renderBody(body, entry, rawName) {
        body.textContent = '';
        if (!entry) {
            body.appendChild(el('p', 'exinfo-note', 'no how-to on file for “' + rawName + '” yet'));
            return;
        }
        const info = entry.info;
        if (info.gifUrl) {
            const img = el('img', 'exinfo-gif');
            img.alt = entry.name + ' demonstration';
            img.addEventListener('error', () => img.remove());
            img.src = info.gifUrl; // set only while the sheet is open
            body.appendChild(img);
        }
        const muscles = info.target
            + (info.secondary && info.secondary.length ? ' · ' + info.secondary.join(', ') : '');
        const metaLine = el('p', 'exinfo-meta');
        metaLine.appendChild(el('span', 'exinfo-equipment', info.equipment));
        metaLine.appendChild(document.createTextNode(' — ' + muscles));
        body.appendChild(metaLine);

        const ol = el('ol', 'exinfo-steps');
        for (const step of info.steps) ol.appendChild(el('li', null, step));
        body.appendChild(ol);

        const credit = info.attribution
            ? 'Demo ' + info.attribution.replace(/\s*—.*$/, '') + ' (gymvisual.com) · instructions: exercises-dataset (MIT)'
            : 'instructions: hand-written';
        body.appendChild(el('p', 'exinfo-credit', credit));
    }

    async function openSheet(rawName, trigger) {
        ensureSheet();
        lastFocus = trigger || document.activeElement;
        sheet.querySelector('.exinfo-title').textContent = rawName;
        const body = sheet.querySelector('.exinfo-body');
        body.textContent = '';
        body.appendChild(el('p', 'exinfo-note', 'loading…'));
        backdrop.hidden = false;
        sheet.hidden = false;
        sheet.querySelector('.exinfo-close').focus();

        let db = null;
        try {
            db = await fetchDb();
        } catch (err) {
            if (sheet.hidden) return; // closed while loading
            body.textContent = '';
            body.appendChild(el('p', 'exinfo-note', 'exercise info needs a connection'));
            return;
        }
        if (sheet.hidden) return;
        const entry = lookupExercise(db, rawName);
        if (entry) sheet.querySelector('.exinfo-title').textContent = normalizeExerciseName(rawName);
        renderBody(body, entry, rawName);
        sheet.scrollTop = 0;
    }

    // Delegated: ⓘ buttons are re-rendered by both the read view and the
    // logger; one listener survives all of it.
    document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest && e.target.closest('.exinfo-btn');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        openSheet(btn.dataset.exname || '', btn);
    });
})();
