/**
 * Figurine Playground - 3D Interactive Virtual Pets
 *
 * Shared world: every visitor sees the same figurines in the same places.
 * - Movement is calm: mostly idle with an occasional short stroll. Strolls are
 *   written to Firebase as a `walk` object and every client (including the
 *   initiator) animates position from it with timestamp math, so motion is
 *   smooth and identical everywhere.
 * - Stats decay in real time. The figurines-keeper worker is the only
 *   authoritative decay writer; clients render "effective" stats computed
 *   from the stored value + statsUpdatedAt, and materialize them on writes.
 * - Click a figurine to open its card (stats, Pet/Feed/Dance/Sleep,
 *   caretaker signup). Drag still moves it.
 */

(function() {
    'use strict';

    const FIREBASE_CONFIG = getFirebaseConfig('main');  // js/firebase-config.js, loaded first on every page

    const KEEPER_URL = 'https://figurines-keeper.s-friedman.workers.dev';

    // Decay tuning - MUST match worker/figurines-keeper.js RATES. Clients only
    // use these to render effective stats between authoritative writes.
    const RATES = {
        hungerPerHour: 1.05,
        happinessPerHour: 0.78,
        energyPerHour: 0.625,
        energyDancingMultiplier: 2,
        energySleepRecoveryPerHour: 20
    };

    // Movement: calm & clickable
    const STROLL_MIN_DELAY = 45000;   // ms between stroll considerations
    const STROLL_MAX_DELAY = 120000;
    const STROLL_MIN_DIST = 3;        // grid units
    const STROLL_MAX_DIST = 8;
    const STROLL_SPEED = 0.35;        // world units per second (grid / 10)
    const WALK_CLIP_TIMESCALE = 0.5;  // slow walk clips toward the amble speed above
    const PROXIMITY_PAUSE_PX = 120;   // cursor this close = no strolling
    const COLLISION_RADIUS = 0.4;     // world units between figurines

    // Mood thresholds
    const HUNGRY_THRESHOLD = 30;      // mopey + pizza thoughts below this
    const SAD_THRESHOLD = 30;
    const AUTO_SLEEP_ENERGY = 15;
    const HAPPY_BURST_THRESHOLD = 85;
    const FEED_REFUSE_ABOVE = 90;
    // Below these, a stat's sliver pulses and its need emoji floats up
    const LOW_THRESHOLDS = {
        hunger: HUNGRY_THRESHOLD,
        happiness: SAD_THRESHOLD,
        energy: AUTO_SLEEP_ENERGY
    };

    // Pet diminishing returns within a rolling 60s window per figurine
    const PET_DELTAS = [15, 8, 3, 1];
    const PET_WINDOW_MS = 60000;

    // Clip-name keywords per state, tried in order. Substring match: Meshy
    // exports name clips like "Armature|ymca_dance|baselayer", so an
    // exact-name lookup never found anything. A state with no matching clip
    // renders as a frozen pose + procedural motion (see freezePose).
    const STATE_CLIP_KEYWORDS = {
        idle: ['idle', 'breath'],
        walking: ['walk', 'run', 'jog'],
        dancing: ['dance', 'spin', 'jump', 'tantrum', 'twerk'],
        sleeping: ['sleep', 'nap'],
        eating: ['eat', 'chew', 'bite']
    };
    // Name of the idle clip synthesized for rigs that don't ship one
    // (contains 'idle' so findClipForState picks it up naturally)
    const GENERATED_IDLE = 'generated_relaxed_idle';

    // Emojis for particles
    const HEARTS = ['❤️', '💕', '💖', '💗', '💓'];
    const FOODS = ['🍕', '🍔', '🌮', '🍩', '🍪', '🍰', '🧁', '🍦'];
    const ZZZ = ['Z', 'z', 'Z'];
    const NEED_EMOJI = { hunger: '🍕', happiness: '💔', energy: '😴' };

    // Three.js objects
    let scene, camera, renderer;
    let raycaster, mouse;
    let clock;

    // State
    let db = null;
    let storage = null;
    let figurinesRef = null;
    let serverTimeOffset = 0;
    const figurines = {};
    const figurineObjects = {}; // Three.js objects + per-figurine client state
    let caretakerCounts = {};
    let selectedId = null;

    // Walks this client initiated (this client is responsible for finishing them)
    const initiatedWalks = new Set();

    // Pointer state
    let pointerDown = null; // { id, x, y } while pressing on a figurine
    let isDragging = false;
    let draggedFigurine = null;
    let dragPlane;
    const pointerScreen = { x: -9999, y: -9999 };
    let lastProximityCheck = 0;

    // Pet diminishing-returns history: id -> [timestamps]
    const petHistory = {};

    // DOM Elements
    const canvas = document.getElementById('figurine-canvas');
    const container = document.getElementById('figurines-container');
    const particlesContainer = document.getElementById('particles-container');
    const addFigurineBtn = document.getElementById('add-figurine-btn');
    const uploadModal = document.getElementById('upload-modal');
    let card = null; // the single figurine card element, created lazily

    // Intervals
    let sleepParticleIntervals = {};

    // Preview scene for upload modal
    let previewScene, previewCamera, previewRenderer;

    /**
     * Server-corrected clock. Walk interpolation and statsUpdatedAt math use
     * this so clients with skewed clocks agree on where everything is.
     */
    function now() {
        return Date.now() + serverTimeOffset;
    }

    function clampStat(v) {
        return Math.max(0, Math.min(100, v));
    }

    function round2(v) {
        return Math.round(v * 100) / 100;
    }

    function easeInOutQuad(t) {
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    /**
     * Deterministic pseudo-random in [0,1) from a string. Used so all clients
     * agree on "spontaneous" behavior windows without any writes.
     */
    function hashFrac(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return ((h >>> 0) % 100000) / 100000;
    }

    /**
     * Check if current user is admin: the localStorage flag set on admin.html
     * AND a live auth session on this page (defense in depth; the database
     * rule is the real gate).
     */
    function isAdmin() {
        return localStorage.getItem('admin_auth') === 'true'
            && !!(window.firebase && firebase.auth && firebase.auth().currentUser);
    }

    // =========================================================================
    // Effective stats - stored value + decay since statsUpdatedAt
    // =========================================================================

    function effectiveStats(figurine) {
        const last = typeof figurine.statsUpdatedAt === 'number' ? figurine.statsUpdatedAt : now();
        const hours = Math.max(0, (now() - last) / 3600000);
        const state = figurine.state || 'idle';

        let energyRate;
        if (state === 'sleeping') {
            energyRate = RATES.energySleepRecoveryPerHour;
        } else if (state === 'dancing') {
            energyRate = -RATES.energyPerHour * RATES.energyDancingMultiplier;
        } else {
            energyRate = -RATES.energyPerHour;
        }

        return {
            hunger: clampStat((figurine.hunger ?? 80) - RATES.hungerPerHour * hours),
            happiness: clampStat((figurine.happiness ?? 80) - RATES.happinessPerHour * hours),
            energy: clampStat((figurine.energy ?? 80) + energyRate * hours)
        };
    }

    /**
     * Update a figurine, logging (instead of silently dropping) rules
     * rejections - every client write goes through here.
     */
    function fbUpdate(id, updates) {
        figurinesRef.child(id).update(updates).catch((error) => {
            console.error(`Figurine update failed for ${id}:`, error);
        });
    }

    /**
     * Write an interaction: materialize all three effective stats (so the
     * shared statsUpdatedAt baseline stays correct), apply deltas, and stamp
     * timestamps. Reads current data at write time - no stale closures.
     */
    function writeStats(id, deltas = {}, extra = {}) {
        const figurine = figurines[id];
        if (!figurine) return;
        const stats = effectiveStats(figurine);
        fbUpdate(id, {
            hunger: round2(clampStat(stats.hunger + (deltas.hunger || 0))),
            happiness: round2(clampStat(stats.happiness + (deltas.happiness || 0))),
            energy: round2(clampStat(stats.energy + (deltas.energy || 0))),
            statsUpdatedAt: now(),
            lastInteraction: now(),
            ...extra
        });
    }

    /**
     * Fields that safely cancel a walk (active OR stale): pin the figurine at
     * its currently rendered position so no client snaps it back to the
     * stroll's start coordinates. Empty when there is no walk to cancel.
     */
    function walkClearFields(id) {
        const figurine = figurines[id];
        const obj = figurineObjects[id];
        if (!figurine || !figurine.walk || !obj || !obj.model) return {};
        return {
            walk: null,
            x: round2(Math.max(0, Math.min(100, obj.model.position.x * 10 + 50))),
            z: round2(Math.max(0, Math.min(100, obj.model.position.z * 10 + 50)))
        };
    }

    // =========================================================================
    // Three.js setup
    // =========================================================================

    function initThreeJS() {
        // Scene
        scene = new THREE.Scene();

        // Camera - orthographic for consistent sizing
        const aspect = window.innerWidth / window.innerHeight;
        const frustumSize = 10;
        camera = new THREE.OrthographicCamera(
            frustumSize * aspect / -2,
            frustumSize * aspect / 2,
            frustumSize / 2,
            frustumSize / -2,
            0.1,
            1000
        );
        camera.position.set(0, 5, 10);
        camera.lookAt(0, 0, 0);

        // Renderer
        renderer = new THREE.WebGLRenderer({
            canvas: canvas,
            alpha: true,
            antialias: true
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        // Enable proper color output for PBR materials
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;

        // Lighting - natural, soft lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
        scene.add(ambientLight);

        // Hemisphere light for natural sky/ground ambient
        const hemiLight = new THREE.HemisphereLight(0xffeedd, 0x444444, 0.3);
        hemiLight.position.set(0, 20, 0);
        scene.add(hemiLight);

        // Main directional light - positioned for accurate shadows
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
        directionalLight.position.set(3, 10, 5);
        directionalLight.target.position.set(0, 0, 0);
        directionalLight.castShadow = true;
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        directionalLight.shadow.camera.near = 0.1;
        directionalLight.shadow.camera.far = 30;
        directionalLight.shadow.camera.left = -15;
        directionalLight.shadow.camera.right = 15;
        directionalLight.shadow.camera.top = 15;
        directionalLight.shadow.camera.bottom = -15;
        directionalLight.shadow.bias = -0.0005;
        directionalLight.shadow.normalBias = 0.01;
        scene.add(directionalLight);
        scene.add(directionalLight.target);

        // Soft fill light from opposite side
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.2);
        fillLight.position.set(-3, 4, -3);
        scene.add(fillLight);

        // Ground plane for shadows - at model feet level
        const groundGeometry = new THREE.PlaneGeometry(50, 50);
        const groundMaterial = new THREE.ShadowMaterial({ opacity: 0.25 });
        const ground = new THREE.Mesh(groundGeometry, groundMaterial);
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = 0;
        ground.receiveShadow = true;
        scene.add(ground);

        // Drag plane (invisible, for raycasting during drag)
        const dragGeometry = new THREE.PlaneGeometry(100, 100);
        const dragMaterial = new THREE.MeshBasicMaterial({ visible: false });
        dragPlane = new THREE.Mesh(dragGeometry, dragMaterial);
        dragPlane.rotation.x = -Math.PI / 2;
        dragPlane.position.y = 0;
        scene.add(dragPlane);

        // Raycaster for click detection
        raycaster = new THREE.Raycaster();
        mouse = new THREE.Vector2();

        // Clock for animations
        clock = new THREE.Clock();

        // Handle resize
        window.addEventListener('resize', onWindowResize);

        // Start animation loop
        animate();
    }

    function onWindowResize() {
        const aspect = window.innerWidth / window.innerHeight;
        const frustumSize = 10;

        camera.left = frustumSize * aspect / -2;
        camera.right = frustumSize * aspect / 2;
        camera.top = frustumSize / 2;
        camera.bottom = frustumSize / -2;
        camera.updateProjectionMatrix();

        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    // =========================================================================
    // Animation loop
    // =========================================================================

    function animate() {
        requestAnimationFrame(animate);

        const delta = clock.getDelta();
        const t = now();

        Object.entries(figurineObjects).forEach(([id, obj]) => {
            if (!obj.model) return;
            const figurine = figurines[id];
            if (!figurine) return;

            updateMotion(id, obj, figurine, delta, t);

            // Drive animation clips from the effective state (walk presence,
            // spontaneous bursts, then the stored state)
            const animState = effectiveState(id, figurine, t);
            if (obj.hasAnimations && animState !== obj.lastAnimState) {
                switchAnimation(obj, animState);
            }
            obj.lastAnimState = animState;

            if (obj.mixer) obj.mixer.update(delta);
            // Static-pose models (holding a neutral pose because no clip
            // fits the state) get the same procedural motion as clip-less
            // models, layered on the root
            if (!obj.hasAnimations || obj.staticPose) {
                updateProceduralAnimation(id, obj, figurine, animState, t);
            }

            if (obj.hitProxy) {
                obj.hitProxy.position.x = obj.model.position.x;
                obj.hitProxy.position.z = obj.model.position.z;
            }

            // Feed-refusal head shake works for both animated and procedural models
            if (obj.refuseUntil && obj.refuseUntil > t) {
                obj.model.rotation.y = obj.baseRotationY + Math.sin(t * 0.045) * 0.3;
            }
        });

        renderer.render(scene, camera);

        updateHudPositions();
    }

    /**
     * What the figurine is visibly doing right now, independent of what the
     * database `state` field says: an active walk always renders as walking,
     * and very happy figurines break into short deterministic dance bursts
     * that every client computes identically (no writes involved).
     */
    function effectiveState(id, figurine, t) {
        if (activeWalk(figurine, t)) return 'walking';
        if (burstActive(id, figurine, t)) return 'dancing';
        return figurine.state || 'idle';
    }

    function activeWalk(figurine, t) {
        const walk = figurine.walk;
        if (!walk || typeof walk.startedAt !== 'number' || typeof walk.duration !== 'number') return null;
        if (t >= walk.startedAt + walk.duration) return null; // stale = arrived
        return walk;
    }

    function burstActive(id, figurine, t) {
        if ((figurine.state || 'idle') !== 'idle' || figurine.walk) return false;
        const win = Math.floor(t / 90000);
        if (t - win * 90000 > 6000) return false;      // bursts occupy the first 6s of a 90s window
        if (hashFrac(id + ':' + win) >= 0.2) return false;
        return effectiveStats(figurine).happiness > HAPPY_BURST_THRESHOLD;
    }

    /**
     * Position + facing every frame. Walking figurines interpolate the shared
     * walk path by timestamp (deterministic on every client). Idle figurines
     * ease toward the authoritative x/z each frame, which keeps remote drags
     * smooth (the old code lerped once per database event and crept 10% per
     * update - that was the janky remote movement bug).
     */
    function updateMotion(id, obj, figurine, delta, t) {
        if (isDragging && draggedFigurine === id) return;

        const walk = figurine.walk;
        if (walk && typeof walk.startedAt === 'number' && typeof walk.duration === 'number') {
            const progress = Math.min(1, Math.max(0, (t - walk.startedAt) / walk.duration));
            const eased = easeInOutQuad(progress);
            const gx = walk.fromX + (walk.toX - walk.fromX) * eased;
            const gz = walk.fromZ + (walk.toZ - walk.fromZ) * eased;
            obj.model.position.x = (gx - 50) / 10;
            obj.model.position.z = (gz - 50) / 10;

            // Face the walking direction, smoothly
            const dx = walk.toX - walk.fromX;
            const dz = walk.toZ - walk.fromZ;
            if (progress < 1 && (dx !== 0 || dz !== 0)) {
                const targetRotation = Math.atan2(dx, dz);
                let diff = targetRotation - obj.model.rotation.y;
                while (diff > Math.PI) diff -= 2 * Math.PI;
                while (diff < -Math.PI) diff += 2 * Math.PI;
                obj.model.rotation.y += diff * Math.min(1, delta * 8);
                obj.baseRotationY = obj.model.rotation.y;
            }

            // The initiator finishes the walk: final position written, walk cleared
            if (progress >= 1 && initiatedWalks.has(id)) {
                finishWalk(id, walk.toX, walk.toZ);
            }
            return;
        }

        // No active walk: ease toward the authoritative position
        const targetX = ((figurine.x ?? 50) - 50) / 10;
        const targetZ = ((figurine.z ?? 50) - 50) / 10;
        const k = Math.min(1, delta * 6);
        obj.model.position.x += (targetX - obj.model.position.x) * k;
        obj.model.position.z += (targetZ - obj.model.position.z) * k;
    }

    /**
     * Procedural animations for models without embedded animation clips.
     * Mood-aware: hungry or sad figurines mope (slow bob, head down).
     */
    function updateProceduralAnimation(id, obj, figurine, state, t) {
        const time = clock.getElapsedTime();

        // Use unique offset per figurine for desynchronized animations
        const idOffset = id ? id.charCodeAt(0) * 0.1 : 0;
        const personalTime = time + idOffset;

        // Undo any dance/sleep scaling once the state moves on
        if (state !== 'dancing' && state !== 'sleeping') {
            obj.model.scale.setScalar(obj.baseScale);
        }

        switch (state) {
            case 'idle': {
                // cachedStats refreshes every 500ms in updateTagStats - plenty
                // for a posture decision, and avoids per-frame recomputation
                const stats = obj.cachedStats || effectiveStats(figurine);
                const mopey = stats.hunger < HUNGRY_THRESHOLD || stats.happiness < SAD_THRESHOLD;

                if (mopey) {
                    // Slumped: slow shallow bob, head down, no curious looking
                    obj.model.position.y = obj.baseY + Math.sin(personalTime * 0.8) * 0.015;
                    obj.model.rotation.y = obj.baseRotationY;
                    obj.model.rotation.x = 0.09;
                    obj.model.rotation.z = 0;
                } else {
                    // Mii-like idle: gentle bobbing with occasional looking
                    // around. Fixed bob frequency - modulating it inside
                    // sin(t * f(t)) accelerates the phase as t grows, which
                    // turned the bob frantic after minutes on the page.
                    obj.model.position.y = obj.baseY + Math.sin(personalTime * 1.5) * 0.03;

                    const lookCycle = Math.sin(personalTime * 0.2) + Math.sin(personalTime * 0.7) * 0.5;
                    obj.model.rotation.y = obj.baseRotationY + lookCycle * 0.15;
                    obj.model.rotation.x = 0;
                    obj.model.rotation.z = Math.sin(personalTime * 0.4) * 0.02;
                }
                break;
            }

            case 'walking':
                // Subtle shuffle - the old 0.1-unit hop read as bouncing
                obj.model.position.y = obj.baseY + Math.abs(Math.sin(time * 6)) * 0.04;
                obj.model.rotation.x = 0;
                obj.model.rotation.z = Math.sin(time * 6) * 0.03;
                break;

            case 'dancing': {
                obj.model.position.y = obj.baseY + Math.abs(Math.sin(time * 6)) * 0.2;
                obj.model.rotation.y = obj.baseRotationY + Math.sin(time * 4) * 0.3;
                obj.model.rotation.x = 0;
                obj.model.rotation.z = Math.sin(time * 3) * 0.1;
                const scale = 1 + Math.sin(time * 6) * 0.05;
                obj.model.scale.setScalar(obj.baseScale * scale);
                break;
            }

            case 'sleeping': {
                const breathe = 1 + Math.sin(time * 1) * 0.02;
                obj.model.scale.set(obj.baseScale * breathe, obj.baseScale * (breathe * 0.98), obj.baseScale * breathe);
                obj.model.position.y = obj.baseY - 0.1;
                obj.model.rotation.x = 0;
                break;
            }

            case 'eating':
                obj.model.position.y = obj.baseY + Math.abs(Math.sin(time * 10)) * 0.08;
                obj.model.rotation.x = 0;
                break;

            default:
                obj.model.position.y = obj.baseY;
                obj.model.rotation.x = 0;
        }
    }

    // =========================================================================
    // Strolling - calm, occasional, synced
    // =========================================================================

    function checkCollision(id, newX, newZ) {
        for (const [otherId, otherObj] of Object.entries(figurineObjects)) {
            if (otherId === id || !otherObj.model) continue;

            // Too close to where the other figurine currently is?
            const dx = newX - otherObj.model.position.x;
            const dz = newZ - otherObj.model.position.z;
            if (Math.sqrt(dx * dx + dz * dz) < COLLISION_RADIUS * 2) {
                return true;
            }

            // ...or to where its in-progress walk is headed?
            const otherWalk = figurines[otherId]?.walk;
            if (otherWalk) {
                const wx = newX - (otherWalk.toX - 50) / 10;
                const wz = newZ - (otherWalk.toZ - 50) / 10;
                if (Math.sqrt(wx * wx + wz * wz) < COLLISION_RADIUS * 2) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Consider starting a stroll for each figurine. Runs every second; each
     * figurine has its own randomized 45-120s schedule (per-client jitter also
     * makes N-tab initiation collisions rare - and they're harmless anyway,
     * last write wins on a small object).
     */
    function considerStrolls() {
        if (document.hidden) return;
        const t = now();

        Object.entries(figurines).forEach(([id, figurine]) => {
            const obj = figurineObjects[id];
            if (!obj || !obj.model) return;

            if (t < obj.nextStrollTime) return;
            obj.nextStrollTime = t + STROLL_MIN_DELAY + Math.random() * (STROLL_MAX_DELAY - STROLL_MIN_DELAY);

            // Only calm, unattended, idle figurines stroll
            if ((figurine.state || 'idle') !== 'idle') return;
            if (activeWalk(figurine, t)) return;
            if (id === selectedId) return;
            if (isDragging && draggedFigurine === id) return;
            if (pointerNear(obj)) return;

            // Current rendered position is the truth (handles stale walks)
            const fromX = Math.max(0, Math.min(100, round2(obj.model.position.x * 10 + 50)));
            const fromZ = Math.max(0, Math.min(100, round2(obj.model.position.z * 10 + 50)));

            // Find a clear destination (up to 5 attempts)
            let toX = null, toZ = null;
            for (let attempt = 0; attempt < 5; attempt++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = STROLL_MIN_DIST + Math.random() * (STROLL_MAX_DIST - STROLL_MIN_DIST);
                const candX = Math.max(15, Math.min(85, fromX + Math.cos(angle) * dist));
                const candZ = Math.max(15, Math.min(85, fromZ + Math.sin(angle) * dist));
                if (!checkCollision(id, (candX - 50) / 10, (candZ - 50) / 10)) {
                    toX = round2(candX);
                    toZ = round2(candZ);
                    break;
                }
            }
            if (toX === null) return;

            const gridDist = Math.sqrt((toX - fromX) ** 2 + (toZ - fromZ) ** 2);
            if (gridDist < 1) return;
            const duration = Math.max(1000, Math.min(60000, Math.round((gridDist / 10) / STROLL_SPEED * 1000)));

            initiatedWalks.add(id);
            figurinesRef.child(id).update({
                x: fromX,
                z: fromZ,
                walk: { fromX, fromZ, toX, toZ, startedAt: t, duration }
            }).catch((error) => {
                console.error('Failed to start stroll:', error);
                initiatedWalks.delete(id);
            });
        });
    }

    /**
     * The initiator writes the final position and clears the walk.
     */
    function finishWalk(id, gx, gz) {
        initiatedWalks.delete(id);
        const obj = figurineObjects[id];
        fbUpdate(id, {
            x: round2(Math.max(0, Math.min(100, gx))),
            z: round2(Math.max(0, Math.min(100, gz))),
            rotationY: obj && obj.model ? round2(obj.model.rotation.y) : 0,
            walk: null
        });
    }

    /**
     * Stop an in-progress walk right now at the interpolated position.
     * Used when the cursor gets close (initiator only), and when anyone
     * clicks or starts dragging a strolling figurine.
     */
    function finishWalkEarly(id) {
        const obj = figurineObjects[id];
        if (!obj || !obj.model) return;
        finishWalk(id, obj.model.position.x * 10 + 50, obj.model.position.z * 10 + 50);
    }

    function pointerNear(obj) {
        if (!obj.screenPos) return false;
        const dx = pointerScreen.x - obj.screenPos.x;
        const dy = pointerScreen.y - obj.screenPos.y;
        return Math.sqrt(dx * dx + dy * dy) < PROXIMITY_PAUSE_PX;
    }

    /**
     * Cursor near a strolling figurine we initiated - stop it so it's clickable.
     * Throttled from pointermove.
     */
    function checkProximityPause() {
        const t = now();
        if (t - lastProximityCheck < 200) return;
        lastProximityCheck = t;

        initiatedWalks.forEach((id) => {
            const figurine = figurines[id];
            const obj = figurineObjects[id];
            if (!figurine || !obj) return;
            if (activeWalk(figurine, t) && pointerNear(obj)) {
                finishWalkEarly(id);
            }
        });
    }

    // =========================================================================
    // Mood behaviors - visible consequences of the stats
    // =========================================================================

    function runMoodBehaviors() {
        if (document.hidden) return;
        const t = now();

        Object.entries(figurines).forEach(([id, figurine]) => {
            const obj = figurineObjects[id];
            if (!obj || !obj.model) return;
            const stats = effectiveStats(figurine);
            const state = figurine.state || 'idle';

            // Exhausted figurines put themselves to sleep. Random jitter +
            // re-check keeps N open tabs from racing (harmless anyway).
            if (stats.energy < AUTO_SLEEP_ENERGY && state !== 'sleeping' && state !== 'eating' && id !== selectedId) {
                setTimeout(() => {
                    const current = figurines[id];
                    if (!current || current.state === 'sleeping') return;
                    if (effectiveStats(current).energy >= AUTO_SLEEP_ENERGY) return;
                    writeStats(id, {}, { state: 'sleeping', ...walkClearFields(id) });
                }, Math.random() * 3000);
            }

            // Hungry (or sad) figurines daydream about what they're missing
            if (stats.hunger < HUNGRY_THRESHOLD && state === 'idle' && Math.random() < 0.25) {
                showThought(obj, NEED_EMOJI.hunger);
            } else if (stats.happiness < SAD_THRESHOLD && state === 'idle' && Math.random() < 0.15) {
                showThought(obj, NEED_EMOJI.happiness);
            }

            // Need emoji floats once when a stat crosses its low threshold
            Object.entries(LOW_THRESHOLDS).forEach(([stat, threshold]) => {
                const isLow = stats[stat] < threshold;
                if (isLow && !obj.lowFlags[stat] && obj.screenPos) {
                    spawnParticle(obj.screenPos.x, obj.screenPos.y - 20, 'heart', NEED_EMOJI[stat]);
                }
                obj.lowFlags[stat] = isLow;
            });
        });
    }

    function showThought(obj, content) {
        if (!obj.screenPos) return;
        const bubble = document.createElement('div');
        bubble.className = 'thought-bubble';
        bubble.textContent = content;
        bubble.style.left = `${obj.screenPos.x + 26}px`;
        bubble.style.top = `${obj.screenPos.y - 14}px`;
        particlesContainer.appendChild(bubble);
        setTimeout(() => bubble.remove(), 2500);
    }

    // =========================================================================
    // Firebase
    // =========================================================================

    function initFirebase() {
        if (!firebase.apps.length) {
            firebase.initializeApp(FIREBASE_CONFIG);
        }
        db = firebase.database();
        storage = firebase.storage();
        figurinesRef = db.ref('figurines');

        // Clock-skew correction for shared walk/stat timestamp math
        db.ref('.info/serverTimeOffset').on('value', (snap) => {
            serverTimeOffset = snap.val() || 0;
        });

        // Admin-only UI (delete button on the card) restores async
        if (firebase.auth) {
            firebase.auth().onAuthStateChanged(() => {
                if (selectedId) renderCard();
            });
        }

        db.ref('caretakerCounts').on('value', (snap) => {
            caretakerCounts = snap.val() || {};
            if (selectedId) renderCardCaretakers();
        });

        // Listen for figurines
        figurinesRef.on('child_added', (snapshot) => {
            const figurine = snapshot.val();
            const id = snapshot.key;
            figurines[id] = figurine;
            loadFigurine(id, figurine);
        }, (error) => {
            console.error('Failed to load figurines:', error);
            showLoadError();
        });

        figurinesRef.on('child_changed', (snapshot) => {
            const figurine = snapshot.val();
            const id = snapshot.key;
            const oldState = figurines[id]?.state;
            figurines[id] = figurine;
            onFigurineChanged(id, figurine, oldState);
        });

        figurinesRef.on('child_removed', (snapshot) => {
            const id = snapshot.key;
            delete figurines[id];
            removeFigurine3D(id);
        });
    }

    function onFigurineChanged(id, figurine, oldState) {
        // Walk gone (finished or cancelled by anyone) - release ownership so a
        // stale entry can't make this client meddle with someone else's walk
        if (!figurine.walk) initiatedWalks.delete(id);

        const obj = figurineObjects[id];
        if (obj) {
            // Sync facing when idle (walk facing is computed per-frame locally)
            if (figurine.rotationY !== undefined && !activeWalk(figurine, now()) &&
                !(isDragging && draggedFigurine === id)) {
                obj.baseRotationY = figurine.rotationY;
            }
        }

        // Sleep particles follow the stored state
        if (oldState !== 'sleeping' && figurine.state === 'sleeping') {
            startSleepParticles(id);
        } else if (oldState === 'sleeping' && figurine.state !== 'sleeping') {
            stopSleepParticles(id);
        }

        updateTagStats(id, figurine);
        if (selectedId === id) renderCardStats();
    }

    function showLoadError() {
        if (document.getElementById('figurines-load-error')) return;
        const msg = document.createElement('div');
        msg.id = 'figurines-load-error';
        msg.textContent = "Couldn't load figurines. Try refreshing the page.";
        msg.style.cssText = 'position:fixed;top:5rem;left:50%;transform:translateX(-50%);background:#fff3f3;color:#c0392b;border:1px solid #e0b4b4;padding:0.5rem 1rem;border-radius:6px;z-index:100;';
        document.body.appendChild(msg);
    }

    // =========================================================================
    // Model loading (unchanged behavior)
    // =========================================================================

    function loadFigurine(id, figurine) {
        // Skip entries without a valid modelUrl
        if (!figurine.modelUrl) {
            console.warn(`Figurine ${id} has no modelUrl, skipping`);
            return;
        }

        const loader = new THREE.GLTFLoader();

        // Convert Firebase position to 3D world position (?? not ||: 0 is a
        // valid edge coordinate, and updateMotion defaults to 50 too)
        const worldX = ((figurine.x ?? 50) - 50) / 10;
        const worldZ = ((figurine.z ?? 50) - 50) / 10;

        // Handle data URLs differently from regular URLs
        if (figurine.modelUrl.startsWith('data:')) {
            // Convert data URL to array buffer and parse
            fetch(figurine.modelUrl)
                .then(res => res.arrayBuffer())
                .then(buffer => {
                    loader.parse(buffer, '',
                        (gltf) => onModelLoaded(gltf, id, figurine, worldX, worldZ),
                        (error) => {
                            console.error(`Error parsing model for ${figurine.name}:`, error);
                            createPlaceholder(id, figurine, worldX, worldZ);
                        }
                    );
                })
                .catch(error => {
                    console.error(`Error fetching model for ${figurine.name}:`, error);
                    createPlaceholder(id, figurine, worldX, worldZ);
                });
            return;
        }

        loader.load(
            figurine.modelUrl,
            (gltf) => onModelLoaded(gltf, id, figurine, worldX, worldZ),
            undefined,
            (error) => {
                console.error(`Error loading model for ${figurine.name}:`, error);
                createPlaceholder(id, figurine, worldX, worldZ);
            }
        );
    }

    function onModelLoaded(gltf, id, figurine, worldX, worldZ) {
        const model = gltf.scene;

        // Check if model has any meshes
        let meshCount = 0;
        model.traverse((child) => {
            if (child.isMesh) meshCount++;
        });

        if (meshCount === 0) {
            console.warn('No meshes found in model, creating placeholder');
            createPlaceholder(id, figurine, worldX, worldZ);
            return;
        }

        // Reset transforms on root
        model.position.set(0, 0, 0);
        model.rotation.set(0, 0, 0);
        model.scale.set(1, 1, 1);
        model.updateMatrixWorld(true);

        // For skinned meshes (animated models from Meshy), the geometry is often
        // exported at 1/100 scale while the skeleton is at normal scale.
        // We need to use the skeleton bounds, not the mesh geometry bounds.
        let hasSkinnedMesh = false;
        let skeletonHeight = 0;
        model.traverse(child => {
            if (child.isSkinnedMesh && child.skeleton) {
                hasSkinnedMesh = true;
                const bones = child.skeleton.bones;
                if (bones.length > 0) {
                    // Find the vertical extent of the skeleton (min to max Y)
                    let minY = Infinity, maxY = -Infinity;
                    bones.forEach(bone => {
                        const pos = new THREE.Vector3();
                        bone.getWorldPosition(pos);
                        minY = Math.min(minY, pos.y);
                        maxY = Math.max(maxY, pos.y);
                    });
                    skeletonHeight = maxY - minY;
                }
            }
        });

        // Use skeleton height for animated models, bounding box for static
        const TARGET_HEIGHT = 2.625; // 75% bigger than original 1.5
        let scale;

        if (hasSkinnedMesh && skeletonHeight > 0.1) {
            scale = TARGET_HEIGHT / skeletonHeight;
        } else {
            const box = new THREE.Box3().setFromObject(model);
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            scale = maxDim > 0 ? TARGET_HEIGHT / maxDim : 1;
        }

        // Sanity check
        if (scale > 50) {
            console.warn('Extreme scale detected, capping to 50:', scale);
            scale = 50;
        }
        if (scale < 0.001) {
            console.warn('Extreme scale detected, flooring to 0.001:', scale);
            scale = 0.001;
        }

        model.scale.setScalar(scale);
        model.updateMatrixWorld(true);

        // Position model with feet at y=0 (for accurate shadow)
        const box = new THREE.Box3().setFromObject(model);
        const minY = box.min.y;
        model.position.set(worldX, -minY, worldZ);

        // Where tags anchor. Skinned boxes measure bind-pose geometry (the
        // Meshy 1/100 trap), so use the normalized height for those.
        const headY = (hasSkinnedMesh && skeletonHeight > 0.1)
            ? TARGET_HEIGHT + 0.15
            : box.getSize(new THREE.Vector3()).y + 0.15;

        // Enable shadows and fix materials for proper rendering
        model.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;

                // Fix materials for GLB files from AI generators
                if (child.material) {
                    const materials = Array.isArray(child.material) ? child.material : [child.material];
                    materials.forEach(mat => {
                        // Make double-sided to handle inverted normals
                        mat.side = THREE.DoubleSide;

                        // For MeshStandardMaterial (PBR), adjust settings
                        if (mat.isMeshStandardMaterial) {
                            // Slightly reduce metalness if very high (prevents overly dark look)
                            if (mat.metalness > 0.8) {
                                mat.metalness = 0.6;
                            }
                            // Ensure roughness isn't too low (causes dark appearance without env map)
                            if (mat.roughness < 0.3) {
                                mat.roughness = 0.4;
                            }
                            // Set texture encoding for color maps
                            if (mat.map) {
                                mat.map.encoding = THREE.sRGBEncoding;
                            }
                            if (mat.emissiveMap) {
                                mat.emissiveMap.encoding = THREE.sRGBEncoding;
                            }
                            mat.needsUpdate = true;
                        }
                    });
                }
            }
        });

        // Setup animations if available
        let mixer = null;
        let hasAnimations = false;
        const animations = {};

        if (gltf.animations && gltf.animations.length > 0) {
            hasAnimations = true;
            mixer = new THREE.AnimationMixer(model);

            gltf.animations.forEach((clip) => {
                animations[clip.name.toLowerCase()] = mixer.clipAction(clip);
            });
            const hasIdleClip = Object.keys(animations).some(
                (n) => STATE_CLIP_KEYWORDS.idle.some((kw) => n.includes(kw)));
            if (!hasIdleClip) {
                animations[GENERATED_IDLE] = mixer.clipAction(buildGeneratedIdleClip(model));
            }
            // Nothing plays here: the first animate() frame runs
            // switchAnimation, which starts the right clip for the state.
            // Playing one directly bypassed currentAction tracking, so it
            // kept running under every later clip (the deformed-model bug).
        }

        // Use saved rotation from Firebase, or default to facing forward (toward camera)
        const savedRotation = (figurine.rotationY !== undefined) ? figurine.rotationY : 0;
        figurineObjects[id] = makeFigurineObject(id, model, {
            mixer,
            animations,
            hasAnimations,
            baseY: model.position.y,
            baseRotationY: savedRotation,
            baseScale: scale,
            headY
        });

        scene.add(model);

        createTag(id, figurine);

        // Handle initial state
        if (figurine.state === 'sleeping') {
            startSleepParticles(id);
        } else if (figurine.state === 'walking' || figurine.state === 'emoting') {
            // Legacy states the new system never writes - normalize
            fbUpdate(id, { state: 'idle' });
        } else if (figurine.state === 'eating' &&
                   now() - (figurine.lastInteraction || 0) > 30000) {
            // Stuck eating (tab closed mid-feed)
            fbUpdate(id, { state: 'idle' });
        }
    }

    /**
     * Invisible cylinder used for click detection. Raycasting the models
     * directly fails on r128: skinned meshes are tested against their
     * undeformed bind-pose geometry (tiny for Meshy exports), so clicks
     * never land. The proxy tracks the model's position each frame.
     */
    function makeHitProxy() {
        const proxy = new THREE.Mesh(
            new THREE.CylinderGeometry(0.5, 0.5, 2.8, 8),
            new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
        );
        proxy.position.y = 1.4;
        scene.add(proxy);
        return proxy;
    }

    /**
     * Per-figurine client state shared by real models and placeholders.
     */
    function makeFigurineObject(id, model, opts) {
        return {
            hitProxy: makeHitProxy(),
            id,
            model,
            mixer: opts.mixer || null,
            animations: opts.animations || {},
            hasAnimations: !!opts.hasAnimations,
            currentAction: null,
            lastAnimState: null,
            baseY: opts.baseY,
            baseRotationY: opts.baseRotationY || 0,
            baseScale: opts.baseScale ?? 1,
            headY: opts.headY ?? 2.8,
            staticPose: false,
            screenPos: null,
            cachedStats: null,
            tagEl: null,
            refuseUntil: 0,
            lowFlags: {},
            // Per-figurine, per-client stroll schedule (staggered start)
            nextStrollTime: now() + 10000 + Math.random() * (STROLL_MAX_DELAY - 10000)
        };
    }

    function createPlaceholder(id, figurine, worldX, worldZ) {
        const geometry = new THREE.BoxGeometry(1, 2, 0.5);
        const material = new THREE.MeshStandardMaterial({ color: 0x888888 });
        const mesh = new THREE.Mesh(geometry, material);

        mesh.position.set(worldX, 1, worldZ);
        mesh.castShadow = true;

        figurineObjects[id] = makeFigurineObject(id, mesh, { baseY: 1, headY: 2.2 });

        scene.add(mesh);
        createTag(id, figurine);
    }

    function removeFigurine3D(id) {
        const obj = figurineObjects[id];
        if (obj) {
            if (obj.model) {
                scene.remove(obj.model);
                // Dispose of geometry and materials
                obj.model.traverse((child) => {
                    if (child.isMesh) {
                        if (child.geometry) child.geometry.dispose();
                        if (child.material) {
                            if (Array.isArray(child.material)) {
                                child.material.forEach(m => m.dispose());
                            } else {
                                child.material.dispose();
                            }
                        }
                    }
                });
            }
            if (obj.hitProxy) {
                scene.remove(obj.hitProxy);
                obj.hitProxy.geometry.dispose();
                obj.hitProxy.material.dispose();
            }
            if (obj.tagEl) obj.tagEl.remove();
            delete figurineObjects[id];
        }

        initiatedWalks.delete(id);
        if (selectedId === id) closeCard();
        stopSleepParticles(id);
    }

    function deleteFigurine(id) {
        if (!isAdmin()) return;
        if (!confirm('Delete this figurine?')) return;

        // Remove from Firebase; the child_removed listener handles scene
        // cleanup, so a rejected delete leaves the figurine intact
        figurinesRef.child(id).remove()
            .catch((error) => {
                console.error('Failed to delete figurine:', error);
                alert('Failed to delete figurine: ' + error.message);
            });
    }

    // =========================================================================
    // Animation clip switching
    // =========================================================================

    function findClipForState(obj, state) {
        const keywords = STATE_CLIP_KEYWORDS[state] || STATE_CLIP_KEYWORDS.idle;
        for (const kw of keywords) {
            for (const name of Object.keys(obj.animations)) {
                if (name.includes(kw)) return obj.animations[name];
            }
        }
        return null;
    }

    function configureActionForState(action, state) {
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.setEffectiveTimeScale(state === 'walking' ? WALK_CLIP_TIMESCALE : 1);
    }

    function switchAnimation(obj, newState) {
        if (!obj.mixer || !obj.hasAnimations) return;

        // No clip fits this state: fall back to the neutral idle pose (real
        // or generated) and let updateProceduralAnimation supply the motion
        let action = findClipForState(obj, newState);
        let isStatic = false;
        if (!action) {
            action = findClipForState(obj, 'idle');
            isStatic = true;
        }
        if (!action) return;

        configureActionForState(action, isStatic ? 'idle' : newState);
        if (action === obj.currentAction) {
            // Same clip, new state: restart without a crossfade - fading a
            // clip against itself dips through the bind pose
            action.reset();
            action.setEffectiveWeight(1);
            action.play();
        } else {
            if (obj.currentAction) obj.currentAction.fadeOut(0.3);
            action.reset().fadeIn(0.3).play();
            obj.currentAction = action;
        }
        obj.staticPose = isStatic || action === obj.animations[GENERATED_IDLE];
    }

    /**
     * Synthesized idle for rigs that ship without one (Meshy emote exports).
     * An empty clip holds the bind pose - natural for scans rigged in their
     * scanned stance. If the bind pose is a T-pose (armspan comparable to
     * height), add single-keyframe tracks that swing each upper arm down to
     * the body's side. Faded-out clips blend back to the bind pose, so
     * crossfading into this clip works like any other.
     * Must run while the skeleton is still in its bind pose (before the
     * mixer first updates).
     */
    function buildGeneratedIdleClip(model) {
        const tracks = [];
        model.updateMatrixWorld(true);

        const min = new THREE.Vector3(Infinity, Infinity, Infinity);
        const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        const p = new THREE.Vector3();
        model.traverse((n) => {
            if (n.isBone) {
                n.getWorldPosition(p);
                min.min(p);
                max.max(p);
            }
        });
        const height = max.y - min.y;
        const span = Math.max(max.x - min.x, max.z - min.z);

        if (height > 0.1 && span / height > 0.6) {
            ['Left', 'Right'].forEach((side) => {
                let arm = null, fore = null;
                model.traverse((n) => {
                    if (!n.isBone) return;
                    if (n.name.endsWith(side + 'Arm') && !n.name.includes('Fore')) arm = n;
                    if (n.name.endsWith(side + 'ForeArm')) fore = n;
                });
                if (!arm || !fore) return;

                const armPos = new THREE.Vector3();
                const forePos = new THREE.Vector3();
                arm.getWorldPosition(armPos);
                fore.getWorldPosition(forePos);
                const dir = forePos.sub(armPos).normalize();
                // Mostly down, slightly outward so hands clear the hips
                const target = new THREE.Vector3(side === 'Left' ? 0.12 : -0.12, -1, 0.05).normalize();
                const deltaWorld = new THREE.Quaternion().setFromUnitVectors(dir, target);
                const parentWorld = new THREE.Quaternion();
                arm.parent.getWorldQuaternion(parentWorld);
                // World-space delta expressed locally: P^-1 * delta * P, on
                // top of the bind rotation
                const q = parentWorld.clone().invert()
                    .multiply(deltaWorld)
                    .multiply(parentWorld)
                    .multiply(arm.quaternion);
                tracks.push(new THREE.QuaternionKeyframeTrack(
                    arm.name + '.quaternion', [0], [q.x, q.y, q.z, q.w]));
            });
        }

        return new THREE.AnimationClip(GENERATED_IDLE, 1, tracks);
    }

    // =========================================================================
    // HUD: lightweight always-visible tags (name + stat slivers)
    // =========================================================================

    function createTag(id, figurine) {
        const tag = document.createElement('div');
        tag.className = 'figurine-tag';
        tag.dataset.figurineTag = id;
        tag.innerHTML = `
            <div class="tag-name">${Sanitize.escapeHtml(figurine.name || 'Figurine')}</div>
            <div class="tag-slivers">
                <div class="sliver hunger"><i></i></div>
                <div class="sliver happiness"><i></i></div>
                <div class="sliver energy"><i></i></div>
            </div>
        `;
        container.appendChild(tag);
        const obj = figurineObjects[id];
        if (obj) {
            obj.tagEl = tag;
            // Measured once - the name never changes, so neither does the size
            obj.tagSize = { w: tag.offsetWidth, h: tag.offsetHeight };
        }
        updateTagStats(id, figurine);
    }

    function updateTagStats(id, figurine) {
        const obj = figurineObjects[id];
        if (!obj || !obj.tagEl || !figurine) return;
        const stats = effectiveStats(figurine);
        obj.cachedStats = stats; // reused by the per-frame mood/posture checks

        ['hunger', 'happiness', 'energy'].forEach((stat) => {
            const sliver = obj.tagEl.querySelector(`.sliver.${stat}`);
            sliver.firstElementChild.style.width = `${stats[stat]}%`;
            sliver.classList.toggle('low', stats[stat] < LOW_THRESHOLDS[stat]);
        });
    }

    function refreshAllTagStats() {
        if (document.hidden) return;
        Object.entries(figurines).forEach(([id, figurine]) => updateTagStats(id, figurine));
        if (selectedId) renderCardStats();
    }

    /**
     * Project every figurine's head position to the screen: positions the
     * tags, the open card, and caches screenPos for proximity checks.
     */
    function updateHudPositions() {
        const vector = new THREE.Vector3();
        Object.entries(figurineObjects).forEach(([id, obj]) => {
            if (!obj.model) return;

            // Feet sit at y=0; headY is this model's measured height
            vector.set(obj.model.position.x, obj.headY, obj.model.position.z);
            vector.project(camera);

            const x = (vector.x * 0.5 + 0.5) * window.innerWidth;
            const y = (-(vector.y * 0.5) + 0.5) * window.innerHeight;
            obj.screenPos = { x, y };

            // Tags and card render translated (-50%, -100%) above this anchor;
            // clamp so they stay fully on screen wherever the figurine is
            if (obj.tagEl) {
                const halfW = (obj.tagSize?.w || 60) / 2;
                const tagH = obj.tagSize?.h || 40;
                obj.tagEl.style.left = `${Math.min(Math.max(x, halfW + 4), window.innerWidth - halfW - 4)}px`;
                obj.tagEl.style.top = `${Math.min(Math.max(y, tagH + 6), window.innerHeight - 6)}px`;
                obj.tagEl.classList.toggle('hidden', id === selectedId);
            }

            if (id === selectedId && card) {
                const halfW = card.offsetWidth / 2;
                card.style.left = `${Math.min(Math.max(x, halfW + 8), window.innerWidth - halfW - 8)}px`;
                card.style.top = `${Math.min(Math.max(y, card.offsetHeight + 16), window.innerHeight - 8)}px`;
            }
        });
    }

    // =========================================================================
    // Figurine card - click to open, act, and sign up as caretaker
    // =========================================================================

    function ensureCard() {
        if (card) return;
        card = document.createElement('div');
        card.className = 'figurine-card';
        card.hidden = true;
        card.innerHTML = `
            <div class="card-header">
                <span class="card-name"></span>
                <span class="card-header-actions">
                    <button class="card-delete" title="Delete figurine" aria-label="Delete figurine">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                    </button>
                    <button class="card-close" title="Close" aria-label="Close">×</button>
                </span>
            </div>
            <div class="card-stats">
                <div class="card-stat" data-stat="hunger"><span class="stat-emoji">🍔</span><div class="stat-track"><div class="stat-fill hunger"></div></div><span class="stat-value"></span></div>
                <div class="card-stat" data-stat="happiness"><span class="stat-emoji">❤️</span><div class="stat-track"><div class="stat-fill happiness"></div></div><span class="stat-value"></span></div>
                <div class="card-stat" data-stat="energy"><span class="stat-emoji">⚡</span><div class="stat-track"><div class="stat-fill energy"></div></div><span class="stat-value"></span></div>
            </div>
            <div class="card-actions">
                <button data-action="pet">🖐️ Pet</button>
                <button data-action="feed">🍔 Feed</button>
                <button data-action="dance">🕺 Dance</button>
                <button data-action="sleep">😴 Sleep</button>
            </div>
            <div class="card-caretakers">
                <div class="caretaker-count"></div>
                <button class="become-caretaker">Become a caretaker 🤝</button>
                <form class="caretaker-form" hidden>
                    <input type="email" placeholder="you@email.com" maxlength="254" required>
                    <button type="submit">Sign up</button>
                </form>
                <div class="caretaker-msg" hidden></div>
            </div>
        `;
        container.appendChild(card);

        card.querySelector('.card-close').addEventListener('click', closeCard);
        card.querySelector('.card-delete').addEventListener('click', () => {
            if (selectedId) deleteFigurine(selectedId);
        });

        card.querySelectorAll('.card-actions button').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (!selectedId) return;
                handleAction(btn.dataset.action, selectedId);
            });
        });

        const becomeBtn = card.querySelector('.become-caretaker');
        const form = card.querySelector('.caretaker-form');
        becomeBtn.addEventListener('click', () => {
            becomeBtn.hidden = true;
            form.hidden = false;
            form.querySelector('input').focus();
        });
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            submitCaretakerSignup();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeCard();
        });
    }

    function openCard(id) {
        const figurine = figurines[id];
        const obj = figurineObjects[id];
        if (!figurine || !obj) return;

        ensureCard();

        // A clicked figurine stops (clearing even a stale orphaned walk) and
        // faces the camera
        if (figurine.walk) {
            finishWalkEarly(id);
        }
        obj.baseRotationY = 0;
        if ((figurine.rotationY || 0) !== 0) {
            fbUpdate(id, { rotationY: 0 });
        }

        selectedId = id;
        resetCaretakerForm();
        card.hidden = false;
        renderCard();
    }

    function closeCard() {
        selectedId = null;
        if (card) card.hidden = true;
    }

    function renderCard() {
        if (!selectedId || !card) return;
        const figurine = figurines[selectedId];
        if (!figurine) return;

        card.querySelector('.card-name').textContent = figurine.name || 'Figurine';
        card.querySelector('.card-delete').style.display = isAdmin() ? '' : 'none';
        renderCardStats();
        renderCardCaretakers();
    }

    function renderCardStats() {
        if (!selectedId || !card || card.hidden) return;
        const figurine = figurines[selectedId];
        if (!figurine) return;
        const stats = effectiveStats(figurine);

        ['hunger', 'happiness', 'energy'].forEach((stat) => {
            const row = card.querySelector(`.card-stat[data-stat="${stat}"]`);
            row.querySelector('.stat-fill').style.width = `${stats[stat]}%`;
            row.querySelector('.stat-value').textContent = Math.round(stats[stat]);
        });

        const state = figurine.state || 'idle';
        card.querySelector('[data-action="dance"]').textContent =
            state === 'dancing' ? '🧍 Stop' : '🕺 Dance';
        card.querySelector('[data-action="sleep"]').textContent =
            state === 'sleeping' ? '☀️ Wake' : '😴 Sleep';
    }

    function renderCardCaretakers() {
        if (!selectedId || !card) return;
        const count = caretakerCounts[selectedId] || 0;
        const name = figurines[selectedId]?.name || 'this figurine';
        const countEl = card.querySelector('.caretaker-count');
        countEl.textContent = count === 0
            ? `Nobody takes care of ${name} yet`
            : count === 1
                ? `1 person takes care of ${name}`
                : `${count} people take care of ${name}`;
    }

    function resetCaretakerForm() {
        if (!card) return;
        card.querySelector('.become-caretaker').hidden = false;
        const form = card.querySelector('.caretaker-form');
        form.hidden = true;
        form.querySelector('input').value = '';
        form.querySelector('button').disabled = false;
        const msg = card.querySelector('.caretaker-msg');
        msg.hidden = true;
        msg.textContent = '';
    }

    async function submitCaretakerSignup() {
        const form = card.querySelector('.caretaker-form');
        const input = form.querySelector('input');
        const submitBtn = form.querySelector('button');
        const msg = card.querySelector('.caretaker-msg');
        const figurineId = selectedId;
        const email = input.value.trim();
        if (!figurineId || !email) return;

        submitBtn.disabled = true;
        msg.hidden = false;
        msg.textContent = 'Signing up…';

        try {
            const response = await fetch(`${KEEPER_URL}/caretaker/signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ figurineId, email })
            });
            const data = await response.json();
            if (response.ok && data.ok) {
                form.hidden = true;
                msg.textContent = data.message || 'Check your email to confirm!';
            } else {
                msg.textContent = data.error || 'Something went wrong. Please try again.';
                submitBtn.disabled = false;
            }
        } catch (error) {
            console.error('Caretaker signup failed:', error);
            msg.textContent = "Couldn't reach the signup service. Please try again.";
            submitBtn.disabled = false;
        }
    }

    // =========================================================================
    // Actions - Pet / Feed / Dance / Sleep
    // =========================================================================

    function handleAction(action, id) {
        const figurine = figurines[id];
        const obj = figurineObjects[id];
        if (!figurine || !obj) return;

        switch (action) {
            case 'pet': petFigurine(id, obj, figurine); break;
            case 'feed': feedFigurine(id, obj, figurine); break;
            case 'dance': toggleDance(id, figurine); break;
            case 'sleep': toggleSleep(id, figurine); break;
        }
    }

    /**
     * Pet: +happiness with diminishing returns inside a rolling 60s window.
     * Does NOT change state - except waking a sleeping figurine.
     */
    function petFigurine(id, obj, figurine) {
        const t = now();
        petHistory[id] = (petHistory[id] || []).filter((ts) => t - ts < PET_WINDOW_MS);
        const delta = PET_DELTAS[Math.min(petHistory[id].length, PET_DELTAS.length - 1)];
        petHistory[id].push(t);

        const extra = figurine.state === 'sleeping' ? { state: 'idle' } : {};
        writeStats(id, { happiness: delta }, extra);

        // screenPos is set every frame; the card can only be open on a
        // rendered figurine
        const screenPos = obj.screenPos;
        if (!screenPos) return;
        for (let i = 0; i < 5; i++) {
            setTimeout(() => {
                spawnParticle(
                    screenPos.x + (Math.random() - 0.5) * 60,
                    screenPos.y + 20,
                    'heart',
                    HEARTS[Math.floor(Math.random() * HEARTS.length)]
                );
            }, i * 100);
        }
        spawnFeedback(screenPos.x, screenPos.y - 10, `+${delta} ❤️`);
    }

    /**
     * Feed: +25 hunger, brief eating state. Full figurines refuse.
     * Reads current data at write time (the old version captured a stale
     * closure in its setTimeout, so rapid feeds didn't stack).
     */
    function feedFigurine(id, obj, figurine) {
        const stats = effectiveStats(figurine);
        const screenPos = obj.screenPos;

        if (stats.hunger > FEED_REFUSE_ABOVE) {
            obj.refuseUntil = now() + 900;
            showThought(obj, 'not hungry!');
            return;
        }

        if (screenPos) {
            for (let i = 0; i < 3; i++) {
                setTimeout(() => {
                    spawnParticle(
                        screenPos.x + (Math.random() - 0.5) * 40,
                        screenPos.y + 30,
                        'food',
                        FOODS[Math.floor(Math.random() * FOODS.length)]
                    );
                }, i * 150);
            }
            spawnFeedback(screenPos.x, screenPos.y - 10, '+25 🍔');
        }

        const extra = figurine.state === 'idle' || figurine.state === 'eating' || !figurine.state
            ? { state: 'eating' } : {};
        writeStats(id, { hunger: 25 }, extra);

        if (extra.state) {
            setTimeout(() => {
                if (figurines[id]?.state === 'eating') {
                    fbUpdate(id, { state: 'idle' });
                }
            }, 1500);
        }
    }

    function toggleDance(id, figurine) {
        const newState = figurine.state === 'dancing' ? 'idle' : 'dancing';
        // Materialize stats at the state change - decay rate depends on state
        writeStats(id, {}, { state: newState, ...walkClearFields(id) });
    }

    function toggleSleep(id, figurine) {
        const newState = figurine.state === 'sleeping' ? 'idle' : 'sleeping';
        writeStats(id, {}, { state: newState, ...walkClearFields(id) });
    }

    // =========================================================================
    // Pointer handling - click opens the card, drag moves
    // =========================================================================

    function getIntersectedFigurine(event) {
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);

        // Raycast the hit proxies, not the models (see makeHitProxy)
        const proxies = Object.values(figurineObjects).map(obj => obj.hitProxy).filter(p => p);
        const intersects = raycaster.intersectObjects(proxies, false);

        if (intersects.length > 0) {
            for (const [id, obj] of Object.entries(figurineObjects)) {
                if (obj.hitProxy === intersects[0].object) {
                    return { id, obj, point: intersects[0].point };
                }
            }
        }

        return null;
    }

    function getWorldPosition(event) {
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObject(dragPlane);

        if (intersects.length > 0) {
            return intersects[0].point;
        }
        return null;
    }

    function onPointerDown(event) {
        event.preventDefault();

        const clientX = event.touches ? event.touches[0].clientX : event.clientX;
        const clientY = event.touches ? event.touches[0].clientY : event.clientY;

        const hit = getIntersectedFigurine({ clientX, clientY });

        if (hit) {
            // Decide click vs drag on pointermove/up
            pointerDown = { id: hit.id, x: clientX, y: clientY };
        } else {
            closeCard();
        }
    }

    function onPointerMove(event) {
        const clientX = event.touches ? event.touches[0].clientX : event.clientX;
        const clientY = event.touches ? event.touches[0].clientY : event.clientY;

        pointerScreen.x = clientX;
        pointerScreen.y = clientY;
        checkProximityPause();

        if (pointerDown && !isDragging) {
            const moved = Math.hypot(clientX - pointerDown.x, clientY - pointerDown.y);
            if (moved > 6) {
                // Threshold crossed: this is a drag, not a click. Cancel any
                // walk (stale ones included) so it can't fight the drag.
                isDragging = true;
                draggedFigurine = pointerDown.id;
                if (figurines[draggedFigurine]?.walk) {
                    finishWalkEarly(draggedFigurine);
                }
            }
        }

        if (!isDragging || !draggedFigurine) return;

        event.preventDefault();

        const worldPos = getWorldPosition({ clientX, clientY });
        if (worldPos) {
            const obj = figurineObjects[draggedFigurine];
            if (obj && obj.model) {
                obj.model.position.x = worldPos.x;
                obj.model.position.z = worldPos.z;
            }
        }
    }

    function onPointerUp() {
        if (isDragging && draggedFigurine) {
            const obj = figurineObjects[draggedFigurine];
            if (obj && obj.model) {
                // Convert back to Firebase coordinates
                const x = obj.model.position.x * 10 + 50;
                const z = obj.model.position.z * 10 + 50;

                // walk: null guards against a stroll another client initiated
                // mid-drag - the drop position wins
                fbUpdate(draggedFigurine, {
                    x: round2(Math.max(0, Math.min(100, x))),
                    z: round2(Math.max(0, Math.min(100, z))),
                    walk: null,
                    lastInteraction: now()
                });
            }
        } else if (pointerDown) {
            openCard(pointerDown.id);
        }

        pointerDown = null;
        isDragging = false;
        draggedFigurine = null;
    }

    // =========================================================================
    // Particles & feedback
    // =========================================================================

    function spawnParticle(x, y, type, content) {
        const particle = document.createElement('div');
        particle.className = `particle ${type}`;
        particle.textContent = content;
        particle.style.left = `${x}px`;
        particle.style.top = `${y}px`;

        particlesContainer.appendChild(particle);
        setTimeout(() => particle.remove(), type === 'zzz' ? 2000 : 1000);
    }

    /**
     * Floating action feedback, e.g. "+15 ❤️"
     */
    function spawnFeedback(x, y, text) {
        const el = document.createElement('div');
        el.className = 'feedback-float';
        el.textContent = text;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        particlesContainer.appendChild(el);
        setTimeout(() => el.remove(), 1200);
    }

    function startSleepParticles(id) {
        if (sleepParticleIntervals[id]) return;

        sleepParticleIntervals[id] = setInterval(() => {
            if (document.hidden) return;
            const obj = figurineObjects[id];
            if (!obj || !obj.model || !obj.screenPos) return;

            spawnParticle(
                obj.screenPos.x + 30,
                obj.screenPos.y + 20,
                'zzz',
                ZZZ[Math.floor(Math.random() * ZZZ.length)]
            );
        }, 1500);
    }

    function stopSleepParticles(id) {
        if (sleepParticleIntervals[id]) {
            clearInterval(sleepParticleIntervals[id]);
            delete sleepParticleIntervals[id];
        }
    }

    // =========================================================================
    // Upload modal (unchanged behavior)
    // =========================================================================

    function setupUploadModal() {
        const dropzone = document.getElementById('upload-dropzone');
        const fileInput = document.getElementById('model-file');
        const fileInfo = document.getElementById('file-info');
        const nameInput = document.getElementById('figurine-name');
        const submitBtn = document.getElementById('submit-figurine');
        const cancelBtn = document.getElementById('cancel-upload');
        const closeBtn = uploadModal.querySelector('.close-modal');
        const previewCanvas = document.getElementById('preview-canvas');
        const previewPlaceholder = document.querySelector('.preview-placeholder');

        let selectedFile = null;

        // Open modal
        addFigurineBtn?.addEventListener('click', () => {
            uploadModal.classList.add('active');
            resetUploadForm();
        });

        // Close modal
        const closeModal = () => {
            uploadModal.classList.remove('active');
            resetUploadForm();
        };

        closeBtn?.addEventListener('click', closeModal);
        cancelBtn?.addEventListener('click', closeModal);
        uploadModal?.addEventListener('click', (e) => {
            if (e.target === uploadModal) closeModal();
        });

        // Dropzone events
        dropzone?.addEventListener('click', () => fileInput?.click());

        dropzone?.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });

        dropzone?.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });

        dropzone?.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (file && (file.name.endsWith('.glb') || file.name.endsWith('.gltf'))) {
                handleFileSelect(file);
            }
        });

        fileInput?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) handleFileSelect(file);
        });

        // File selection handler
        function handleFileSelect(file) {
            selectedFile = file;
            fileInfo.querySelector('.file-name').textContent = file.name;
            dropzone.style.display = 'none';
            fileInfo.style.display = 'flex';
            updateSubmitButton();
            previewModel(file);
        }

        // Remove file
        fileInfo?.querySelector('.remove-file')?.addEventListener('click', () => {
            selectedFile = null;
            fileInput.value = '';
            dropzone.style.display = 'block';
            fileInfo.style.display = 'none';
            previewPlaceholder.style.display = 'block';
            updateSubmitButton();
            clearPreview();
        });

        // Name input
        nameInput?.addEventListener('input', updateSubmitButton);

        function updateSubmitButton() {
            submitBtn.disabled = !selectedFile || !nameInput.value.trim();
        }

        // Preview model
        function previewModel(file) {
            try {
                if (!previewScene) {
                    initPreviewScene();
                }

                clearPreview();
                if (previewPlaceholder) previewPlaceholder.style.display = 'none';

                const reader = new FileReader();
                reader.onerror = () => {
                    console.error('Error reading file');
                    if (previewPlaceholder) previewPlaceholder.style.display = 'block';
                };
                reader.onload = (e) => {
                    const loader = new THREE.GLTFLoader();
                    loader.parse(
                        e.target.result,
                        '',
                        (gltf) => {
                            try {
                                const model = gltf.scene;

                                const box = new THREE.Box3().setFromObject(model);
                                const size = box.getSize(new THREE.Vector3());
                                const maxDim = Math.max(size.x, size.y, size.z);
                                const scale = maxDim > 0 ? 2 / maxDim : 1;
                                model.scale.setScalar(scale);

                                box.setFromObject(model);
                                const center = box.getCenter(new THREE.Vector3());
                                model.position.sub(center);

                                previewScene.add(model);
                                previewScene.userData.model = model;

                                animatePreview();
                            } catch (err) {
                                console.error('Error setting up model:', err);
                            }
                        },
                        (error) => {
                            console.error('Error parsing GLB:', error);
                            if (previewPlaceholder) {
                                previewPlaceholder.textContent = 'Could not load preview';
                                previewPlaceholder.style.display = 'block';
                            }
                        }
                    );
                };
                reader.readAsArrayBuffer(file);
            } catch (err) {
                console.error('Error in previewModel:', err);
            }
        }

        function initPreviewScene() {
            try {
                previewScene = new THREE.Scene();
                previewScene.background = new THREE.Color(0xf9f9f9);

                // Ensure canvas has dimensions
                const width = previewCanvas.clientWidth || 300;
                const height = previewCanvas.clientHeight || 200;

                previewCamera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
                previewCamera.position.set(0, 1, 3);
                previewCamera.lookAt(0, 0, 0);

                previewRenderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true });
                previewRenderer.setSize(width, height);
                previewRenderer.outputEncoding = THREE.sRGBEncoding;
                previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
                previewRenderer.toneMappingExposure = 1.2;

                const light = new THREE.DirectionalLight(0xffffff, 1.2);
                light.position.set(5, 5, 5);
                previewScene.add(light);
                previewScene.add(new THREE.AmbientLight(0xffffff, 1.0));
                // Add hemisphere light for better preview
                const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
                previewScene.add(hemi);
            } catch (err) {
                console.error('Error initializing preview scene:', err);
            }
        }

        function animatePreview() {
            if (!uploadModal.classList.contains('active')) return;
            if (!previewRenderer || !previewScene || !previewCamera) return;

            requestAnimationFrame(animatePreview);

            if (previewScene.userData.model) {
                previewScene.userData.model.rotation.y += 0.01;
            }

            try {
                previewRenderer.render(previewScene, previewCamera);
            } catch (err) {
                console.error('Error rendering preview:', err);
            }
        }

        function clearPreview() {
            if (previewScene?.userData.model) {
                previewScene.remove(previewScene.userData.model);
                previewScene.userData.model = null;
            }
        }

        function resetUploadForm() {
            selectedFile = null;
            if (fileInput) fileInput.value = '';
            if (nameInput) nameInput.value = '';
            if (dropzone) dropzone.style.display = 'block';
            if (fileInfo) fileInfo.style.display = 'none';
            if (previewPlaceholder) previewPlaceholder.style.display = 'block';
            if (submitBtn) submitBtn.disabled = true;
            clearPreview();
        }

        // Submit
        submitBtn?.addEventListener('click', async () => {
            if (!selectedFile || !nameInput.value.trim()) return;

            submitBtn.disabled = true;
            submitBtn.textContent = 'Uploading...';

            try {
                // Upload to Firebase Storage
                const filename = `figurines/${Date.now()}_${selectedFile.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
                const storageRef = storage.ref(filename);

                // Upload with progress tracking
                const uploadTask = storageRef.put(selectedFile);

                await new Promise((resolve, reject) => {
                    uploadTask.on('state_changed',
                        (snapshot) => {
                            const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                            submitBtn.textContent = `Uploading ${Math.round(progress)}%`;
                        },
                        (error) => {
                            console.error('Upload error:', error);
                            reject(error);
                        },
                        () => {
                            resolve();
                        }
                    );
                });

                const downloadUrl = await storageRef.getDownloadURL();

                // Create figurine entry
                const newFigurine = {
                    modelUrl: downloadUrl,
                    name: nameInput.value.trim(),
                    x: 50,
                    z: 50,
                    rotationY: 0,
                    state: 'idle',
                    hunger: 80,
                    happiness: 80,
                    energy: 80,
                    statsUpdatedAt: now(),
                    lastInteraction: now()
                };

                await figurinesRef.push(newFigurine);

                closeModal();
            } catch (error) {
                console.error('Error uploading figurine:', error);

                // Provide helpful error messages
                let message = error.message;
                if (error.code === 'storage/unauthorized') {
                    message = 'Storage permission denied. Please check Firebase Storage rules.';
                } else if (error.code === 'storage/canceled') {
                    message = 'Upload was canceled.';
                }

                alert('Failed to upload figurine: ' + message);
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Add Figurine';
            }
        });
    }

    // =========================================================================
    // Init
    // =========================================================================

    function setupGlobalEvents() {
        canvas.addEventListener('mousedown', onPointerDown);
        canvas.addEventListener('touchstart', onPointerDown, { passive: false });

        document.addEventListener('mousemove', onPointerMove);
        document.addEventListener('touchmove', onPointerMove, { passive: false });

        document.addEventListener('mouseup', onPointerUp);
        document.addEventListener('touchend', onPointerUp);
    }

    function init() {
        initThreeJS();
        setupGlobalEvents();
        setupUploadModal();
        initFirebase();

        setInterval(considerStrolls, 1000);
        setInterval(refreshAllTagStats, 500);
        setInterval(runMoodBehaviors, 5000);
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
