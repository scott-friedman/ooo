/**
 * Figurine Playground - 3D Interactive Virtual Pets
 * Three.js powered figurines with animations
 */

(function() {
    'use strict';

    // Firebase config
    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyCFKStIkbW_omKXd7TQb3jUVuBJA4g3zqo",
        authDomain: "scottfriedman-f400d.firebaseapp.com",
        databaseURL: "https://scottfriedman-f400d-default-rtdb.firebaseio.com",
        projectId: "scottfriedman-f400d",
        storageBucket: "scottfriedman-f400d.firebasestorage.app",
        messagingSenderId: "1046658110090",
        appId: "1:1046658110090:web:49a24a0ff13b19cb111373"
    };

    // Constants
    const STAT_DECAY_INTERVAL = 60000;
    const IDLE_WANDER_INTERVAL = 3000; // Check for wandering more frequently (Mii-like)
    const HUNGER_DECAY_RATE = 2;
    const HAPPINESS_DECAY_RATE = 1;
    const ENERGY_DECAY_RATE = 1;
    const ENERGY_RECOVERY_RATE = 5;
    const WALK_SPEED = 0.015; // Slightly slower for more natural movement
    const COLLISION_RADIUS = 0.4; // Collision distance between figurines (world units)
    const MIN_WANDER_DISTANCE = 5; // Minimum wander distance in grid units
    const MAX_WANDER_DISTANCE = 20; // Maximum wander distance in grid units

    // System animations to exclude from emotes (custom user animations)
    const SYSTEM_ANIMATIONS = ['idle', 'idle_loop', 'walk', 'walking', 'walk_loop',
                               'dance', 'dancing', 'dance_loop', 'sleep', 'sleeping',
                               'sit', 'sit_idle', 'eat', 'eating', 'chew', 'breathing_idle'];

    // Emojis for particles
    const HEARTS = ['❤️', '💕', '💖', '💗', '💓'];
    const FOODS = ['🍕', '🍔', '🌮', '🍩', '🍪', '🍰', '🧁', '🍦'];
    const ZZZ = ['Z', 'z', 'Z'];

    // Three.js objects
    let scene, camera, renderer;
    let raycaster, mouse;
    let clock;

    // State
    let db = null;
    let storage = null;
    let figurinesRef = null;
    const figurines = {};
    const figurineObjects = {}; // Three.js objects
    let currentTool = 'move';
    let showStats = false;

    // Drag state
    let isDragging = false;
    let draggedFigurine = null;
    let dragPlane;

    // Walking targets for smooth movement
    const walkingTargets = {}; // { figurineId: { x, z, startTime } }

    // DOM Elements
    const canvas = document.getElementById('figurine-canvas');
    const container = document.getElementById('figurines-container');
    const particlesContainer = document.getElementById('particles-container');
    const toolbar = document.querySelector('.figurine-toolbar');
    const toggleStatsBtn = document.getElementById('toggle-stats');
    const addFigurineBtn = document.getElementById('add-figurine-btn');
    const uploadModal = document.getElementById('upload-modal');

    // Intervals
    let statDecayInterval = null;
    let idleWanderInterval = null;
    let sleepParticleIntervals = {};

    // Preview scene for upload modal
    let previewScene, previewCamera, previewRenderer;

    /**
     * Check if current user is admin: the localStorage flag set on admin.html
     * AND a live auth session on this page (defense in depth; the database
     * rule is the real gate).
     */
    function isAdmin() {
        return localStorage.getItem('admin_auth') === 'true'
            && !!(window.firebase && firebase.auth && firebase.auth().currentUser);
    }

    /**
     * Show/hide delete buttons based on admin status (auth restores async)
     */
    function refreshDeleteButtons() {
        const show = isAdmin();
        document.querySelectorAll('.figurine-delete').forEach(btn => {
            btn.style.display = show ? '' : 'none';
        });
    }

    /**
     * Initialize Three.js scene
     */
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

    /**
     * Window resize handler
     */
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

    /**
     * Animation loop
     */
    function animate() {
        requestAnimationFrame(animate);

        const delta = clock.getDelta();

        // Update all figurine animations
        Object.values(figurineObjects).forEach(obj => {
            if (obj.mixer) {
                obj.mixer.update(delta);
            }

            // Procedural animations for models without embedded animations
            if (obj.model && !obj.hasAnimations) {
                updateProceduralAnimation(obj, delta);
            }

            // Smooth walking towards targets
            updateWalking(obj, delta);
        });

        renderer.render(scene, camera);

        // Update stat overlays position
        updateStatOverlays();
    }

    /**
     * Check if a position would collide with other figurines
     */
    function checkCollision(id, newX, newZ) {
        for (const [otherId, otherObj] of Object.entries(figurineObjects)) {
            if (otherId === id || !otherObj.model) continue;

            const dx = newX - otherObj.model.position.x;
            const dz = newZ - otherObj.model.position.z;
            const distance = Math.sqrt(dx * dx + dz * dz);

            if (distance < COLLISION_RADIUS) {
                return { collided: true, otherId, otherObj };
            }
        }
        return { collided: false };
    }

    /**
     * Get avoidance direction when collision detected
     */
    function getAvoidanceDirection(obj, otherObj) {
        const dx = obj.model.position.x - otherObj.model.position.x;
        const dz = obj.model.position.z - otherObj.model.position.z;
        const length = Math.sqrt(dx * dx + dz * dz) || 0.01;
        return { x: dx / length, z: dz / length };
    }

    /**
     * Update smooth walking movement
     */
    function updateWalking(obj, delta) {
        const target = walkingTargets[obj.id];
        if (!target || !obj.model) return;

        const figurine = figurines[obj.id];
        if (!figurine || figurine.state !== 'walking') {
            delete walkingTargets[obj.id];
            return;
        }

        // Calculate target position in world coordinates
        const targetX = (target.x - 50) / 10;
        const targetZ = (target.z - 50) / 10;

        // Current position
        const currentX = obj.model.position.x;
        const currentZ = obj.model.position.z;

        // Calculate distance to target
        const dx = targetX - currentX;
        const dz = targetZ - currentZ;
        const distance = Math.sqrt(dx * dx + dz * dz);

        // If close enough to target, stop walking
        if (distance < 0.05) {
            // Update Firebase with final position and rotation
            figurinesRef.child(obj.id).update({
                state: 'idle',
                x: target.x,
                z: target.z,
                rotationY: obj.baseRotationY // Preserve final facing direction
            });
            delete walkingTargets[obj.id];
            return;
        }

        // Move towards target
        const moveSpeed = WALK_SPEED * 60 * delta; // Normalize for frame rate
        const moveAmount = Math.min(moveSpeed, distance);
        let moveX = (dx / distance) * moveAmount;
        let moveZ = (dz / distance) * moveAmount;

        // Check for collision at new position
        const newX = currentX + moveX;
        const newZ = currentZ + moveZ;
        const collision = checkCollision(obj.id, newX, newZ);

        if (collision.collided) {
            // Get avoidance direction (away from the other figurine)
            const avoidDir = getAvoidanceDirection(obj, collision.otherObj);

            // Blend avoidance with original direction
            moveX = moveX * 0.3 + avoidDir.x * moveAmount * 0.7;
            moveZ = moveZ * 0.3 + avoidDir.z * moveAmount * 0.7;

            // Check if still colliding after adjustment
            const adjustedX = currentX + moveX;
            const adjustedZ = currentZ + moveZ;
            const stillColliding = checkCollision(obj.id, adjustedX, adjustedZ);

            if (stillColliding.collided) {
                // Stop and pick a new destination
                delete walkingTargets[obj.id];
                figurinesRef.child(obj.id).update({
                    state: 'idle',
                    x: (currentX * 10) + 50,
                    z: (currentZ * 10) + 50,
                    rotationY: obj.baseRotationY // Preserve facing direction
                });
                return;
            }
        }

        obj.model.position.x += moveX;
        obj.model.position.z += moveZ;

        // Face movement direction (smooth rotation)
        const targetRotation = Math.atan2(moveX, moveZ);
        const currentRotation = obj.model.rotation.y;
        const rotationDiff = targetRotation - currentRotation;

        // Normalize rotation difference to -PI to PI
        let normalizedDiff = rotationDiff;
        while (normalizedDiff > Math.PI) normalizedDiff -= 2 * Math.PI;
        while (normalizedDiff < -Math.PI) normalizedDiff += 2 * Math.PI;

        obj.model.rotation.y += normalizedDiff * 0.1; // Smooth rotation
        obj.baseRotationY = obj.model.rotation.y;
    }

    /**
     * Procedural animations for models without embedded animations
     */
    function updateProceduralAnimation(obj, delta) {
        const figurine = figurines[obj.id];
        if (!figurine || !obj.model) return;

        const time = clock.getElapsedTime();
        const state = figurine.state || 'idle';

        // Use unique offset per figurine for desynchronized animations
        const idOffset = obj.id ? obj.id.charCodeAt(0) * 0.1 : 0;
        const personalTime = time + idOffset;

        switch (state) {
            case 'idle':
                // Mii-like idle: gentle bobbing with occasional looking around
                const bobSpeed = 1.5 + Math.sin(personalTime * 0.3) * 0.3; // Varying bob speed
                obj.model.position.y = obj.baseY + Math.sin(personalTime * bobSpeed) * 0.03;

                // Occasional head turns (looking around curiously)
                const lookCycle = Math.sin(personalTime * 0.2) + Math.sin(personalTime * 0.7) * 0.5;
                const lookAmount = lookCycle * 0.15; // More pronounced looking around
                obj.model.rotation.y = obj.baseRotationY + lookAmount;

                // Subtle weight shifting (lean side to side occasionally)
                obj.model.rotation.z = Math.sin(personalTime * 0.4) * 0.02;
                break;

            case 'walking':
                // Bobbing while moving
                obj.model.position.y = obj.baseY + Math.abs(Math.sin(time * 8)) * 0.1;
                obj.model.rotation.z = Math.sin(time * 8) * 0.05;
                break;

            case 'dancing':
                // Energetic movement
                obj.model.position.y = obj.baseY + Math.abs(Math.sin(time * 6)) * 0.2;
                obj.model.rotation.y = obj.baseRotationY + Math.sin(time * 4) * 0.3;
                obj.model.rotation.z = Math.sin(time * 3) * 0.1;
                const scale = 1 + Math.sin(time * 6) * 0.05;
                obj.model.scale.setScalar(obj.baseScale * scale);
                break;

            case 'sleeping':
                // Slow breathing
                const breathe = 1 + Math.sin(time * 1) * 0.02;
                obj.model.scale.set(obj.baseScale * breathe, obj.baseScale * (breathe * 0.98), obj.baseScale * breathe);
                obj.model.position.y = obj.baseY - 0.1;
                break;

            case 'eating':
                // Quick bobs
                obj.model.position.y = obj.baseY + Math.abs(Math.sin(time * 10)) * 0.08;
                break;

            case 'emoting':
                // Let the GLTF animation play without procedural interference
                break;

            default:
                obj.model.position.y = obj.baseY;
        }
    }

    /**
     * Update HTML stat overlays to match 3D positions
     */
    function updateStatOverlays() {
        Object.entries(figurineObjects).forEach(([id, obj]) => {
            const overlay = document.querySelector(`[data-figurine-overlay="${id}"]`);
            if (!overlay || !obj.model) return;

            // Project 3D position to screen
            const vector = new THREE.Vector3();
            obj.model.getWorldPosition(vector);
            vector.project(camera);

            const x = (vector.x * 0.5 + 0.5) * window.innerWidth;
            const y = (-(vector.y * 0.5) + 0.5) * window.innerHeight;

            overlay.style.left = `${x}px`;
            overlay.style.top = `${y}px`;
        });
    }

    /**
     * Initialize Firebase
     */
    function initFirebase() {
        if (!firebase.apps.length) {
            firebase.initializeApp(FIREBASE_CONFIG);
        }
        db = firebase.database();
        storage = firebase.storage();
        figurinesRef = db.ref('figurines');

        // Delete buttons only show for a signed-in admin; auth restores async
        if (firebase.auth) {
            firebase.auth().onAuthStateChanged(() => refreshDeleteButtons());
        }

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
            updateFigurine3D(id, figurine, oldState);
        });

        figurinesRef.on('child_removed', (snapshot) => {
            const id = snapshot.key;
            delete figurines[id];
            removeFigurine3D(id);
        });

    }

    /**
     * Show a visible error when figurines can't be loaded
     */
    function showLoadError() {
        if (document.getElementById('figurines-load-error')) return;
        const msg = document.createElement('div');
        msg.id = 'figurines-load-error';
        msg.textContent = "Couldn't load figurines. Try refreshing the page.";
        msg.style.cssText = 'position:fixed;top:5rem;left:50%;transform:translateX(-50%);background:#fff3f3;color:#c0392b;border:1px solid #e0b4b4;padding:0.5rem 1rem;border-radius:6px;z-index:100;';
        document.body.appendChild(msg);
    }

    /**
     * Load a 3D figurine model
     */
    function loadFigurine(id, figurine) {
        // Skip entries without a valid modelUrl
        if (!figurine.modelUrl) {
            console.warn(`Figurine ${id} has no modelUrl, skipping`);
            return;
        }

        const loader = new THREE.GLTFLoader();

        // Convert Firebase position to 3D world position
        const worldX = ((figurine.x || 50) - 50) / 10;
        const worldZ = ((figurine.z || 0) - 50) / 10;

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

        console.log(`Loading model from URL: ${figurine.modelUrl}`);

        loader.load(
            figurine.modelUrl,
            (gltf) => {
                console.log(`Model loaded successfully for ${figurine.name}`, gltf);
                onModelLoaded(gltf, id, figurine, worldX, worldZ);
            },
            (progress) => {
                if (progress.total > 0) {
                    console.log(`Loading ${figurine.name}: ${(progress.loaded / progress.total * 100).toFixed(0)}%`);
                }
            },
            (error) => {
                console.error(`Error loading model for ${figurine.name}:`, error);
                console.error('Model URL was:', figurine.modelUrl);
                createPlaceholder(id, figurine, worldX, worldZ);
            }
        );
    }

    /**
     * Handle loaded GLTF model
     */
    function onModelLoaded(gltf, id, figurine, worldX, worldZ) {
        const model = gltf.scene;

        console.log('Model scene:', model);
        console.log('Model children:', model.children);

        // Check if model has any meshes
        let meshCount = 0;
        model.traverse((child) => {
            if (child.isMesh) {
                meshCount++;
                console.log('Found mesh:', child.name, 'Material:', child.material);
            }
        });
        console.log(`Total meshes found: ${meshCount}`);

        if (meshCount === 0) {
            console.warn('No meshes found in model, creating placeholder');
            createPlaceholder(id, figurine, worldX, worldZ);
            return;
        }

        // Scale and position
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
                    console.log('Skeleton height:', skeletonHeight, 'from Y range:', minY, 'to', maxY);
                }
            }
        });

        // Use skeleton height for animated models, bounding box for static
        const TARGET_HEIGHT = 2.625; // 75% bigger than original 1.5
        let scale;

        if (hasSkinnedMesh && skeletonHeight > 0.1) {
            // Use skeleton-based scale for animated models
            scale = TARGET_HEIGHT / skeletonHeight;
            console.log('Using skeleton-based scale:', scale);
        } else {
            // Use bounding box for static models
            const box = new THREE.Box3().setFromObject(model);
            const size = box.getSize(new THREE.Vector3());
            console.log('Model bounding box size:', size);
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

        console.log('Final calculated scale:', scale);

        model.scale.setScalar(scale);
        model.updateMatrixWorld(true);

        // Position model with feet at y=0 (for accurate shadow)
        const box = new THREE.Box3().setFromObject(model);
        const minY = box.min.y;
        model.position.set(worldX, -minY, worldZ);

        // Enable shadows and fix materials for proper rendering
        model.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;

                // Fix materials for GLB files from AI generators
                if (child.material) {
                    // Handle array of materials
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
                            // Make sure material updates
                            mat.needsUpdate = true;
                        }

                        console.log('Material adjusted:', mat.type, 'color:', mat.color, 'map:', mat.map);
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
                const name = clip.name.toLowerCase();
                animations[name] = mixer.clipAction(clip);

                if (name === 'idle' || name === 'idle_loop') {
                    animations[name].play();
                }
            });

            if (!animations['idle'] && !animations['idle_loop'] && gltf.animations.length > 0) {
                const firstAction = mixer.clipAction(gltf.animations[0]);
                firstAction.play();
            }
        }

        // Store in our objects map
        // Use saved rotation from Firebase, or default to facing forward (toward camera)
        const savedRotation = (figurine.rotationY !== undefined) ? figurine.rotationY : 0;
        figurineObjects[id] = {
            id,
            model,
            mixer,
            animations,
            hasAnimations,
            currentAction: null,
            baseY: model.position.y,
            baseRotationY: savedRotation,
            baseScale: scale,
            // Per-figurine timing for independent movement schedules
            nextWanderTime: Date.now() + Math.random() * 10000   // Stagger initial wander (0-10s)
        };

        scene.add(model);

        // Create HTML overlay for stats
        createStatOverlay(id, figurine);

        // Handle initial state
        if (figurine.state === 'sleeping') {
            startSleepParticles(id);
        } else if (figurine.state === 'walking') {
            // If loading a figurine that was walking but we don't have a target,
            // reset to idle (prevents stuck walking state after page refresh)
            if (!walkingTargets[id]) {
                figurinesRef.child(id).update({ state: 'idle' });
            }
        }

        console.log(`Loaded figurine: ${figurine.name}`);
    }

    /**
     * Create a placeholder for failed model loads
     */
    function createPlaceholder(id, figurine, worldX, worldZ) {
        const geometry = new THREE.BoxGeometry(1, 2, 0.5);
        const material = new THREE.MeshStandardMaterial({ color: 0x888888 });
        const mesh = new THREE.Mesh(geometry, material);

        mesh.position.set(worldX, 1, worldZ);
        mesh.castShadow = true;

        figurineObjects[id] = {
            id,
            model: mesh,
            mixer: null,
            animations: {},
            hasAnimations: false,
            baseY: 1,
            baseRotationY: 0,
            baseScale: 1
        };

        scene.add(mesh);
        createStatOverlay(id, figurine);
    }

    /**
     * Create HTML overlay for stats
     */
    function createStatOverlay(id, figurine) {
        const overlay = document.createElement('div');
        overlay.className = 'figurine-overlay';
        overlay.dataset.figurineOverlay = id;
        overlay.innerHTML = `
            <div class="figurine-header">
                <div class="figurine-name">${Sanitize.escapeHtml(figurine.name || 'Figurine')}</div>
                <button class="figurine-delete" data-delete-id="${Sanitize.escapeHtml(id)}" title="Delete figurine" aria-label="Delete figurine">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
            <div class="figurine-stats">
                <div class="stat-bar">
                    <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="#ff9800" stroke-width="2">
                        <path d="M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/>
                    </svg>
                    <div class="stat-track"><div class="stat-fill hunger" style="width: ${figurine.hunger || 80}%"></div></div>
                </div>
                <div class="stat-bar">
                    <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="#e91e63" stroke-width="2">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                    <div class="stat-track"><div class="stat-fill happiness" style="width: ${figurine.happiness || 80}%"></div></div>
                </div>
                <div class="stat-bar">
                    <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="#4caf50" stroke-width="2">
                        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                    </svg>
                    <div class="stat-track"><div class="stat-fill energy" style="width: ${figurine.energy || 80}%"></div></div>
                </div>
            </div>
        `;

        overlay.style.cssText = `
            position: fixed;
            transform: translate(-50%, -100%);
            pointer-events: auto;
            z-index: 60;
            opacity: 0;
            transition: opacity 0.2s;
        `;

        // Add delete handler (button is a UI hint — the database rule is the
        // real gate; only admins can delete)
        const deleteBtn = overlay.querySelector('.figurine-delete');
        if (!isAdmin()) deleteBtn.style.display = 'none';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteFigurine(id);
        });

        container.appendChild(overlay);
    }

    /**
     * Delete a figurine
     */
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

    /**
     * Update 3D figurine position and state
     */
    function updateFigurine3D(id, figurine, oldState) {
        const obj = figurineObjects[id];
        if (!obj || !obj.model) return;

        // Update position
        const worldX = ((figurine.x || 50) - 50) / 10;
        const worldZ = ((figurine.z || 0) - 50) / 10;

        // Smoothly move to new position
        if (!isDragging || draggedFigurine !== id) {
            const targetPos = new THREE.Vector3(worldX, obj.baseY, worldZ);
            obj.model.position.lerp(targetPos, 0.1);
        }

        // Update rotation from Firebase when:
        // 1. Walking (to face movement direction)
        // 2. Transitioning from walking to idle (preserve final facing direction)
        if (figurine.rotationY !== undefined) {
            const wasWalking = oldState === 'walking';
            const isWalking = figurine.state === 'walking';
            const justStoppedWalking = wasWalking && !isWalking;

            if (isWalking || justStoppedWalking) {
                obj.baseRotationY = figurine.rotationY;
            }
        }

        // Handle animation state changes
        if (obj.hasAnimations && figurine.state !== oldState) {
            switchAnimation(obj, figurine.state);
        }

        // Handle sleep particles
        if (oldState !== 'sleeping' && figurine.state === 'sleeping') {
            startSleepParticles(id);
        } else if (oldState === 'sleeping' && figurine.state !== 'sleeping') {
            stopSleepParticles(id);
        }

        // Update stat overlay
        updateStatOverlay(id, figurine);
    }

    /**
     * Switch animation for a figurine
     */
    function switchAnimation(obj, newState) {
        if (!obj.mixer || !obj.hasAnimations) return;

        // 'emoting' state is handled by playEmote() - don't interfere with it
        // This prevents the animation from being reset/restarted by Firebase sync
        if (newState === 'emoting') {
            return;
        }

        // Map states to animation names
        const animMap = {
            'idle': ['idle', 'idle_loop', 'breathing_idle'],
            'walking': ['walk', 'walking', 'walk_loop'],
            'dancing': ['dance', 'dancing', 'dance_loop'],
            'sleeping': ['sleep', 'sleeping', 'sit', 'sit_idle'],
            'eating': ['eat', 'eating', 'chew']
        };

        const animNames = animMap[newState] || ['idle'];
        let newAction = null;

        // Find matching animation
        for (const name of animNames) {
            if (obj.animations[name]) {
                newAction = obj.animations[name];
                break;
            }
        }

        // Fallback to first SYSTEM animation only (not custom emotes)
        // This prevents accidentally triggering emote animations
        if (!newAction) {
            for (const name of SYSTEM_ANIMATIONS) {
                if (obj.animations[name]) {
                    newAction = obj.animations[name];
                    break;
                }
            }
        }

        // If no animation found, stop current animation (important when leaving emote state)
        if (!newAction) {
            if (obj.currentAction) {
                obj.currentAction.fadeOut(0.3);
                obj.currentAction = null;
            }
            return;
        }

        if (newAction !== obj.currentAction) {
            if (obj.currentAction) {
                obj.currentAction.fadeOut(0.3);
            }
            newAction.reset().fadeIn(0.3).play();
            obj.currentAction = newAction;
        }
    }

    /**
     * Update stat overlay values
     */
    function updateStatOverlay(id, figurine) {
        const overlay = document.querySelector(`[data-figurine-overlay="${id}"]`);
        if (!overlay) return;

        const hungerFill = overlay.querySelector('.stat-fill.hunger');
        const happinessFill = overlay.querySelector('.stat-fill.happiness');
        const energyFill = overlay.querySelector('.stat-fill.energy');

        if (hungerFill) {
            hungerFill.style.width = `${figurine.hunger || 0}%`;
            hungerFill.classList.toggle('low', (figurine.hunger || 0) < 20);
        }
        if (happinessFill) {
            happinessFill.style.width = `${figurine.happiness || 0}%`;
            happinessFill.classList.toggle('low', (figurine.happiness || 0) < 20);
        }
        if (energyFill) {
            energyFill.style.width = `${figurine.energy || 0}%`;
            energyFill.classList.toggle('low', (figurine.energy || 0) < 20);
        }
    }

    /**
     * Remove 3D figurine
     */
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
            delete figurineObjects[id];
        }

        // Remove overlay
        const overlay = document.querySelector(`[data-figurine-overlay="${id}"]`);
        if (overlay) overlay.remove();

        stopSleepParticles(id);
    }

    /**
     * Get intersected figurine from mouse position
     */
    function getIntersectedFigurine(event) {
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);

        const models = Object.values(figurineObjects).map(obj => obj.model).filter(m => m);
        const intersects = raycaster.intersectObjects(models, true);

        if (intersects.length > 0) {
            // Find which figurine was hit
            let hitObject = intersects[0].object;
            while (hitObject.parent && !Object.values(figurineObjects).some(obj => obj.model === hitObject)) {
                hitObject = hitObject.parent;
            }

            for (const [id, obj] of Object.entries(figurineObjects)) {
                if (obj.model === hitObject) {
                    return { id, obj, point: intersects[0].point };
                }
            }
        }

        return null;
    }

    /**
     * Get world position from mouse
     */
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

    /**
     * Handle mouse/touch interactions
     */
    function onPointerDown(event) {
        event.preventDefault();

        const clientX = event.touches ? event.touches[0].clientX : event.clientX;
        const clientY = event.touches ? event.touches[0].clientY : event.clientY;

        const hit = getIntersectedFigurine({ clientX, clientY });

        // Emote tool works anywhere - triggers random figurine with emotes
        if (currentTool === 'emote') {
            triggerRandomEmote();
            return;
        }

        if (hit) {
            const { id, obj } = hit;
            const figurine = figurines[id];

            switch (currentTool) {
                case 'move':
                    isDragging = true;
                    draggedFigurine = id;
                    break;
                case 'pet':
                    petFigurine(id, obj, figurine);
                    break;
                case 'feed':
                    feedFigurine(id, obj, figurine);
                    break;
                case 'dance':
                    toggleDance(id, figurine);
                    break;
                case 'sleep':
                    toggleSleep(id, figurine);
                    break;
            }
        } else if (currentTool === 'call') {
            const worldPos = getWorldPosition({ clientX, clientY });
            if (worldPos) {
                callFigurine(worldPos, clientX, clientY);
            }
        }
    }

    function onPointerMove(event) {
        if (!isDragging || !draggedFigurine) return;

        event.preventDefault();

        const clientX = event.touches ? event.touches[0].clientX : event.clientX;
        const clientY = event.touches ? event.touches[0].clientY : event.clientY;

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

                figurinesRef.child(draggedFigurine).update({
                    x: Math.max(0, Math.min(100, x)),
                    z: Math.max(0, Math.min(100, z)),
                    lastInteraction: Date.now()
                });
            }
        }

        isDragging = false;
        draggedFigurine = null;
    }

    /**
     * Pet a figurine
     */
    function petFigurine(id, obj, figurine) {
        // Spawn heart particles at model position
        const screenPos = getScreenPosition(obj.model);

        for (let i = 0; i < 5; i++) {
            setTimeout(() => {
                spawnParticle(
                    screenPos.x + (Math.random() - 0.5) * 60,
                    screenPos.y - 30,
                    'heart',
                    HEARTS[Math.floor(Math.random() * HEARTS.length)]
                );
            }, i * 100);
        }

        // Update happiness
        const newHappiness = Math.min(100, (figurine.happiness || 0) + 15);
        figurinesRef.child(id).update({
            happiness: newHappiness,
            lastInteraction: Date.now(),
            state: 'idle'
        });
    }

    /**
     * Feed a figurine
     */
    function feedFigurine(id, obj, figurine) {
        const screenPos = getScreenPosition(obj.model);

        for (let i = 0; i < 3; i++) {
            setTimeout(() => {
                spawnParticle(
                    screenPos.x + (Math.random() - 0.5) * 40,
                    screenPos.y - 60,
                    'food',
                    FOODS[Math.floor(Math.random() * FOODS.length)]
                );
            }, i * 150);
        }

        figurinesRef.child(id).update({
            state: 'eating',
            lastInteraction: Date.now()
        });

        setTimeout(() => {
            const newHunger = Math.min(100, (figurine.hunger || 0) + 25);
            figurinesRef.child(id).update({
                hunger: newHunger,
                state: 'idle'
            });
        }, 1500);
    }

    /**
     * Toggle dance state
     */
    function toggleDance(id, figurine) {
        const newState = figurine.state === 'dancing' ? 'idle' : 'dancing';
        figurinesRef.child(id).update({
            state: newState,
            lastInteraction: Date.now()
        });
    }

    /**
     * Toggle sleep state
     */
    function toggleSleep(id, figurine) {
        const newState = figurine.state === 'sleeping' ? 'idle' : 'sleeping';
        figurinesRef.child(id).update({
            state: newState,
            lastInteraction: Date.now()
        });
    }

    /**
     * Get available custom emote animations (excludes system animations)
     */
    function getAvailableEmotes(obj) {
        if (!obj.animations) return [];
        return Object.keys(obj.animations).filter(name =>
            !SYSTEM_ANIMATIONS.includes(name)
        );
    }

    /**
     * Play a random emote animation
     */
    function playEmote(id, obj, figurine) {
        const emotes = getAvailableEmotes(obj);
        if (emotes.length === 0) return; // No custom emotes available

        // Prevent double-triggering if already emoting
        if (figurine.state === 'emoting' || obj.isEmoting) return;
        obj.isEmoting = true;

        const randomEmote = emotes[Math.floor(Math.random() * emotes.length)];
        const action = obj.animations[randomEmote];

        // Play once, then return to idle
        action.setLoop(THREE.LoopOnce);
        action.clampWhenFinished = true;

        if (obj.currentAction) {
            obj.currentAction.fadeOut(0.3);
        }
        action.reset().fadeIn(0.3).play();
        obj.currentAction = action;

        // Update Firebase state
        figurinesRef.child(id).update({
            state: 'emoting',
            lastInteraction: Date.now()
        });

        // Return to idle when animation completes
        // Use minimum 2 seconds if duration is too short or invalid
        const clipDuration = action.getClip().duration * 1000;
        const duration = Math.max(2000, clipDuration || 2000);
        console.log(`Playing emote "${randomEmote}" for ${duration}ms (clip: ${clipDuration}ms)`);

        setTimeout(() => {
            // Only update if still emoting (prevent race conditions)
            if (obj.isEmoting) {
                figurinesRef.child(id).update({ state: 'idle' });
                obj.isEmoting = false;
            }
        }, duration + 300); // +300ms for fade
    }

    /**
     * Call figurine to a location
     */
    function callFigurine(worldPos, screenX, screenY) {
        const ids = Object.keys(figurines);
        if (ids.length === 0) return;

        const id = ids[Math.floor(Math.random() * ids.length)];
        const figurine = figurines[id];
        const obj = figurineObjects[id];

        if (!obj || !obj.model) return;

        // Convert to Firebase coords
        const x = Math.max(15, Math.min(85, worldPos.x * 10 + 50));
        const z = Math.max(15, Math.min(85, worldPos.z * 10 + 50));

        // Set the walking target for smooth movement
        walkingTargets[id] = {
            x: x,
            z: z,
            startTime: Date.now()
        };

        // Update state to walking
        figurinesRef.child(id).update({
            state: 'walking',
            lastInteraction: Date.now()
        });

        // Show ripple
        showCallRipple(screenX, screenY);
    }

    /**
     * Get screen position from 3D object
     */
    function getScreenPosition(object) {
        const vector = new THREE.Vector3();
        object.getWorldPosition(vector);
        vector.project(camera);

        return {
            x: (vector.x * 0.5 + 0.5) * window.innerWidth,
            y: (-(vector.y * 0.5) + 0.5) * window.innerHeight
        };
    }

    /**
     * Spawn a particle effect
     */
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
     * Show call ripple effect
     */
    function showCallRipple(x, y) {
        const ripple = document.createElement('div');
        ripple.className = 'call-ripple';
        ripple.style.left = `${x}px`;
        ripple.style.top = `${y}px`;
        document.body.appendChild(ripple);
        setTimeout(() => ripple.remove(), 600);
    }

    /**
     * Sleep particles
     */
    function startSleepParticles(id) {
        if (sleepParticleIntervals[id]) return;

        sleepParticleIntervals[id] = setInterval(() => {
            const obj = figurineObjects[id];
            if (!obj || !obj.model) return;

            const screenPos = getScreenPosition(obj.model);
            spawnParticle(
                screenPos.x + 30,
                screenPos.y - 40,
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

    /**
     * Decay stats over time
     */
    function decayStats() {
        const now = Date.now();

        Object.entries(figurines).forEach(([id, figurine]) => {
            const updates = {};
            let hasUpdates = false;

            if (now - (figurine.lastInteraction || 0) > STAT_DECAY_INTERVAL) {
                if ((figurine.hunger || 0) > 0) {
                    updates.hunger = Math.max(0, (figurine.hunger || 0) - HUNGER_DECAY_RATE);
                    hasUpdates = true;
                }
                if ((figurine.happiness || 0) > 0) {
                    updates.happiness = Math.max(0, (figurine.happiness || 0) - HAPPINESS_DECAY_RATE);
                    hasUpdates = true;
                }

                if (figurine.state === 'sleeping') {
                    if ((figurine.energy || 0) < 100) {
                        updates.energy = Math.min(100, (figurine.energy || 0) + ENERGY_RECOVERY_RATE);
                        hasUpdates = true;
                    }
                } else if (figurine.state === 'dancing') {
                    if ((figurine.energy || 0) > 0) {
                        updates.energy = Math.max(0, (figurine.energy || 0) - (ENERGY_DECAY_RATE * 2));
                        hasUpdates = true;
                    }
                } else {
                    if ((figurine.energy || 0) > 0) {
                        updates.energy = Math.max(0, (figurine.energy || 0) - ENERGY_DECAY_RATE);
                        hasUpdates = true;
                    }
                }

                if (hasUpdates) {
                    figurinesRef.child(id).update(updates);
                }
            }
        });
    }

    /**
     * Check if a destination would be too close to other figurines
     */
    function isDestinationClear(id, destX, destZ) {
        const worldX = (destX - 50) / 10;
        const worldZ = (destZ - 50) / 10;

        for (const [otherId, otherObj] of Object.entries(figurineObjects)) {
            if (otherId === id || !otherObj.model) continue;

            const dx = worldX - otherObj.model.position.x;
            const dz = worldZ - otherObj.model.position.z;
            const distance = Math.sqrt(dx * dx + dz * dz);

            // Keep more distance for destination planning
            if (distance < COLLISION_RADIUS * 2) {
                return false;
            }
        }
        return true;
    }

    /**
     * Idle wandering - makes figurines naturally explore (Mii-like behavior)
     * Each figurine has its own schedule to prevent synchronized movement
     */
    function idleWander() {
        const now = Date.now();
        Object.entries(figurines).forEach(([id, figurine]) => {
            const obj = figurineObjects[id];
            if (!obj || !obj.model) return;

            // Check if it's time for this figurine to consider wandering
            if (now < obj.nextWanderTime) return;

            // Skip if already walking, dancing, sleeping, emoting, or has a target
            if (figurine.state !== 'idle' || walkingTargets[id]) {
                // Still update next wander time so we check again later
                obj.nextWanderTime = now + 2000 + Math.random() * 3000;
                return;
            }

            // Short delay after interaction before wandering again
            const timeSinceInteraction = now - (figurine.lastInteraction || 0);
            if (timeSinceInteraction < 2000) {
                obj.nextWanderTime = now + 2000;
                return;
            }

            // Calculate a random nearby destination
            const currentX = figurine.x || 50;
            const currentZ = figurine.z || 50;

            // Mii-like: Variable movement distances (sometimes short strolls, sometimes longer walks)
            const isShortWalk = Math.random() < 0.6;
            const maxDist = isShortWalk ? MIN_WANDER_DISTANCE + 5 : MAX_WANDER_DISTANCE;
            const minDist = isShortWalk ? MIN_WANDER_DISTANCE : MIN_WANDER_DISTANCE + 5;

            // Try to find a clear destination (up to 5 attempts)
            let newX, newZ;
            let foundClear = false;

            for (let attempt = 0; attempt < 5; attempt++) {
                // Random angle for more natural movement patterns
                const angle = Math.random() * Math.PI * 2;
                const distance = minDist + Math.random() * (maxDist - minDist);

                newX = Math.max(15, Math.min(85, currentX + Math.cos(angle) * distance));
                newZ = Math.max(15, Math.min(85, currentZ + Math.sin(angle) * distance));

                if (isDestinationClear(id, newX, newZ)) {
                    foundClear = true;
                    break;
                }
            }

            // If no clear destination found, skip and try again later
            if (!foundClear) {
                obj.nextWanderTime = now + 3000 + Math.random() * 5000;
                return;
            }

            // Set the walking target for smooth movement
            walkingTargets[id] = {
                x: newX,
                z: newZ,
                startTime: now
            };

            // Update state to walking (position will update smoothly via animation loop)
            figurinesRef.child(id).update({
                state: 'walking'
            });

            // Set next wander time (5-15 seconds after this walk completes)
            obj.nextWanderTime = now + 5000 + Math.random() * 10000;
        });
    }

    /**
     * Trigger a random emote on a random figurine that has emotes available
     */
    function triggerRandomEmote() {
        // Find all figurines that have custom emotes and are idle
        const candidates = [];
        Object.entries(figurines).forEach(([id, figurine]) => {
            const obj = figurineObjects[id];
            if (!obj || !obj.hasAnimations) return;
            if (obj.isEmoting) return;
            if (figurine.state !== 'idle') return;

            const emotes = getAvailableEmotes(obj);
            if (emotes.length > 0) {
                candidates.push({ id, obj, figurine });
            }
        });

        if (candidates.length === 0) return;

        // Pick a random candidate
        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        playEmote(chosen.id, chosen.obj, chosen.figurine);
    }

    /**
     * Setup upload modal
     */
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
                console.log('Starting upload to Firebase Storage...');

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
                            console.log(`Upload progress: ${progress}%`);
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

                console.log('Upload complete, getting download URL...');
                const downloadUrl = await storageRef.getDownloadURL();
                console.log('Download URL:', downloadUrl);

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
                    lastInteraction: Date.now()
                };

                await figurinesRef.push(newFigurine);
                console.log('Figurine added successfully');

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

    /**
     * Setup toolbar
     */
    function setupToolbar() {
        toolbar?.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tool = btn.dataset.tool;
                if (!tool) return;

                toolbar.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                currentTool = tool;
                document.body.classList.toggle('call-mode', tool === 'call');
            });
        });
    }

    /**
     * Setup stats toggle
     */
    function setupStatsToggle() {
        toggleStatsBtn?.addEventListener('click', () => {
            showStats = !showStats;
            toggleStatsBtn.classList.toggle('active', showStats);

            document.querySelectorAll('.figurine-overlay').forEach(overlay => {
                overlay.style.opacity = showStats ? '1' : '0';
            });
        });
    }

    /**
     * Setup global events
     */
    function setupGlobalEvents() {
        canvas.addEventListener('mousedown', onPointerDown);
        canvas.addEventListener('touchstart', onPointerDown, { passive: false });

        document.addEventListener('mousemove', onPointerMove);
        document.addEventListener('touchmove', onPointerMove, { passive: false });

        document.addEventListener('mouseup', onPointerUp);
        document.addEventListener('touchend', onPointerUp);
    }

    /**
     * Initialize
     */
    function init() {
        initThreeJS();
        setupToolbar();
        setupStatsToggle();
        setupGlobalEvents();
        setupUploadModal();
        initFirebase();

        statDecayInterval = setInterval(decayStats, STAT_DECAY_INTERVAL);
        idleWanderInterval = setInterval(idleWander, IDLE_WANDER_INTERVAL);
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
