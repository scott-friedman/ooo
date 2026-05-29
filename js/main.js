/**
 * Collaborative Whiteboard + Quirky Interactions
 * Beautiful flowing colors & subtle controls
 */

(function() {
    'use strict';

    // ==========================================================================
    // Configuration Constants
    // ==========================================================================
    const CONFIG = {
        CANVAS_REFERENCE_WIDTH: 1200,
        THROTTLE_MS: 16,  // ~60fps
        MOBILE_DRAW_TIMEOUT_MS: 5000,
        BRUSH_SIZES: { fine: 2, medium: 4, thick: 8 },
        ERASER_MULTIPLIER: 4
    };

    // ==========================================================================
    // Utility Functions
    // ==========================================================================

    // Throttle helper for performance-sensitive operations
    function throttle(func, limit) {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }

    // ==========================================================================
    // Firebase Configuration (uses shared config if available)
    // ==========================================================================
    const FIREBASE_CONFIG = (typeof getFirebaseConfig === 'function')
        ? getFirebaseConfig('main')
        : {
            apiKey: "AIzaSyCFKStIkbW_omKXd7TQb3jUVuBJA4g3zqo",
            authDomain: "scottfriedman-f400d.firebaseapp.com",
            databaseURL: "https://scottfriedman-f400d-default-rtdb.firebaseio.com",
            projectId: "scottfriedman-f400d",
            storageBucket: "scottfriedman-f400d.firebasestorage.app",
            messagingSenderId: "1046658110090",
            appId: "1:1046658110090:web:49a24a0ff13b19cb111373"
        };

    // Get page identifier for page-specific drawings
    function getPageId() {
        const path = window.location.pathname;
        const page = path.split('/').pop().replace('.html', '') || 'index';
        return page;
    }

    // ==========================================================================
    // Responsive Drawing System
    // ==========================================================================
    // Reference width for consistent cross-device drawings
    // Drawings are stored relative to this width and scaled on other devices
    const REFERENCE_WIDTH = CONFIG.CANVAS_REFERENCE_WIDTH;

    // Get current scale and offset for responsive drawing
    function getDrawingTransform() {
        const viewportWidth = window.innerWidth;
        // On screens narrower than reference, scale down proportionally
        // On screens wider than reference, don't scale up, just center
        const scale = Math.min(1, viewportWidth / REFERENCE_WIDTH);
        // Offset to center the drawing area when viewport is wider than reference
        const offsetX = Math.max(0, (viewportWidth - REFERENCE_WIDTH * scale) / 2);
        return { scale, offsetX };
    }

    // ==========================================================================
    // Beautiful Color System
    // ==========================================================================
    const COLOR_PALETTES = {
        forest: [
            { r: 29, g: 71, b: 51 },    // deep forest
            { r: 46, g: 125, b: 84 },   // emerald
            { r: 98, g: 166, b: 117 },  // sage
        ],
        ocean: [
            { r: 35, g: 87, b: 102 },   // deep teal
            { r: 66, g: 133, b: 150 },  // ocean
            { r: 107, g: 168, b: 179 }, // seafoam
        ],
        sunset: [
            { r: 204, g: 102, b: 68 },  // burnt orange
            { r: 227, g: 139, b: 94 },  // apricot
            { r: 244, g: 187, b: 135 }, // peach
        ],
        berry: [
            { r: 143, g: 63, b: 89 },   // burgundy
            { r: 181, g: 93, b: 119 },  // dusty rose
            { r: 212, g: 145, b: 158 }, // blush
        ],
        plum: [
            { r: 88, g: 61, b: 100 },   // deep plum
            { r: 128, g: 95, b: 138 },  // mauve
            { r: 167, g: 137, b: 172 }, // lavender
        ],
        gold: [
            { r: 166, g: 124, b: 54 },  // antique gold
            { r: 199, g: 163, b: 86 },  // golden
            { r: 224, g: 196, b: 132 }, // champagne
        ],
        earth: [
            { r: 107, g: 68, b: 35 },   // chocolate
            { r: 148, g: 103, b: 61 },  // caramel
            { r: 180, g: 144, b: 103 }, // sand
        ],
        slate: [
            { r: 66, g: 72, b: 82 },    // charcoal
            { r: 105, g: 112, b: 122 }, // slate
            { r: 148, g: 154, b: 162 }, // silver
        ]
    };

    // Flow through colors in a pleasing order
    const ALL_COLORS = [
        ...COLOR_PALETTES.forest,
        ...COLOR_PALETTES.ocean,
        ...COLOR_PALETTES.plum,
        ...COLOR_PALETTES.berry,
        ...COLOR_PALETTES.sunset,
        ...COLOR_PALETTES.gold,
        ...COLOR_PALETTES.earth,
        ...COLOR_PALETTES.slate,
    ];
    let colorProgress = 0;
    let autoColorMode = true;

    function lerpColor(c1, c2, t) {
        return {
            r: Math.round(c1.r + (c2.r - c1.r) * t),
            g: Math.round(c1.g + (c2.g - c1.g) * t),
            b: Math.round(c1.b + (c2.b - c1.b) * t)
        };
    }

    function getFlowingColor() {
        if (!autoColorMode) return null;

        // Use time + stroke progress for continuous color evolution
        const timeOffset = (Date.now() / 3000) % 1;  // Slow time-based drift
        const combinedProgress = (colorProgress + timeOffset) % 1;

        // Smoothly interpolate through ALL colors
        const totalColors = ALL_COLORS.length;
        const scaledProgress = combinedProgress * totalColors;
        const colorIndex = Math.floor(scaledProgress);
        const t = scaledProgress - colorIndex;

        const c1 = ALL_COLORS[colorIndex % totalColors];
        const c2 = ALL_COLORS[(colorIndex + 1) % totalColors];
        const color = lerpColor(c1, c2, t);

        // Dynamic opacity with multiple wave frequencies
        const wave1 = Math.sin(combinedProgress * Math.PI * 6) * 0.1;
        const wave2 = Math.sin(Date.now() / 500) * 0.05;
        const opacity = 0.45 + wave1 + wave2;

        return `rgba(${color.r}, ${color.g}, ${color.b}, ${opacity.toFixed(2)})`;
    }

    function advanceColor() {
        // Faster progression through colors
        colorProgress += 0.025;
        if (colorProgress >= 1) {
            colorProgress = 0;
        }
    }

    // ==========================================================================
    // Whiteboard Drawing
    // ==========================================================================
    const canvas = document.getElementById('whiteboard');
    const ctx = canvas.getContext('2d');
    const hint = document.querySelector('.draw-hint');
    const toolbar = document.querySelector('.draw-toolbar');
    const mobileToggle = document.querySelector('.mobile-draw-toggle');

    let isDrawing = false;
    let lastX = 0;
    let lastY = 0;
    let db = null;
    let strokesRef = null;
    let currentStroke = [];
    let hasDrawn = false;
    let lastClearedTimestamp = 0;

    // Track Firebase listeners for cleanup
    const firebaseListeners = [];

    // Drawing settings
    let lineWidth = 4;
    let fixedColor = null;
    let isEraser = false;

    // Store all strokes locally for redrawing on resize
    let allStrokes = [];

    // Mobile draw mode
    let isMobile = window.matchMedia('(pointer: coarse)').matches;
    let drawModeActive = !isMobile; // Desktop: always on, Mobile: off by default
    let drawModeTimeout = null;

    function getDocumentHeight() {
        return Math.max(
            document.body.scrollHeight,
            document.body.offsetHeight,
            document.documentElement.clientHeight,
            document.documentElement.scrollHeight,
            document.documentElement.offsetHeight
        );
    }

    function resizeCanvas() {
        // Size canvas to full document
        canvas.width = window.innerWidth;
        canvas.height = getDocumentHeight();

        setupContext();

        // Redraw all strokes with new scaling
        redrawAllStrokes();
    }

    function redrawAllStrokes() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        allStrokes.forEach(stroke => {
            drawStroke(stroke.points, stroke.color, stroke.width);
        });
    }

    function setupContext() {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
    }

    function initFirebase() {
        if (!FIREBASE_CONFIG.apiKey) {
            console.log('Firebase not configured. Drawing works locally.');
            return false;
        }
        try {
            // Prevent re-initialization
            if (!firebase.apps.length) {
                firebase.initializeApp(FIREBASE_CONFIG);
            }
            db = firebase.database();

            const pageId = getPageId();
            strokesRef = db.ref('strokes/' + pageId);

            // Load existing strokes and listen for new ones
            const strokesCallback = (snapshot) => {
                const stroke = snapshot.val();
                if (stroke && stroke.points) {
                    // Store locally for redrawing on resize
                    allStrokes.push(stroke);
                    drawStroke(stroke.points, stroke.color, stroke.width);
                }
            };
            strokesRef.on('child_added', strokesCallback);
            firebaseListeners.push({ ref: strokesRef, event: 'child_added', callback: strokesCallback });

            // Listen for canvas clear events (only respond to NEW clears after page load)
            const clearRef = db.ref('canvas_cleared/' + pageId);
            // First, get current value to establish baseline
            clearRef.once('value', (snapshot) => {
                lastClearedTimestamp = snapshot.val() || 0;
                // Now listen for future changes
                const clearCallback = (snapshot) => {
                    const cleared = snapshot.val();
                    if (cleared && cleared > lastClearedTimestamp) {
                        allStrokes = [];  // Clear local strokes
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        lastClearedTimestamp = cleared;
                    }
                };
                clearRef.on('value', clearCallback);
                firebaseListeners.push({ ref: clearRef, event: 'value', callback: clearCallback });
            });

            console.log('Firebase connected for page:', pageId);
            return true;
        } catch (e) {
            console.log('Firebase init failed:', e);
            return false;
        }
    }

    function drawStroke(points, color, width) {
        if (points.length < 2) return;

        const { scale } = getDrawingTransform();

        ctx.save();
        ctx.lineWidth = (width || 4) * scale;  // Scale line width
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Check if points have per-point colors
        const hasPerPointColor = points[0].c !== undefined;

        if (hasPerPointColor) {
            // Draw each segment with its own color
            for (let i = 1; i < points.length; i++) {
                const px1 = toPixels(points[i-1]);
                const px2 = toPixels(points[i]);
                ctx.beginPath();
                ctx.strokeStyle = points[i].c || color || 'rgba(80, 60, 40, 0.5)';
                ctx.moveTo(px1.x, px1.y);
                ctx.lineTo(px2.x, px2.y);
                ctx.stroke();
            }
        } else {
            // Legacy: single color for entire stroke
            ctx.strokeStyle = color || 'rgba(80, 60, 40, 0.5)';
            ctx.beginPath();
            const firstPx = toPixels(points[0]);
            ctx.moveTo(firstPx.x, firstPx.y);
            for (let i = 1; i < points.length; i++) {
                const px = toPixels(points[i]);
                ctx.lineTo(px.x, px.y);
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    // Get position for storage (relative to REFERENCE_WIDTH for x, absolute for y)
    // x is normalized so drawings scale horizontally across devices
    // y is absolute pixels from document top (scroll position stays consistent)
    function getPos(e) {
        const { scale, offsetX } = getDrawingTransform();

        let clientX, clientY;
        if (e.touches) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        // x: Convert screen position to reference coordinates, then normalize
        const refX = (clientX - offsetX) / scale;

        return {
            x: refX / REFERENCE_WIDTH,  // normalize to 0-1 range for horizontal scaling
            y: clientY + window.scrollY  // absolute pixels from document top (no scaling)
        };
    }

    // Convert stored position to screen pixels for drawing
    function toPixels(pos) {
        const { scale, offsetX } = getDrawingTransform();
        return {
            x: pos.x * REFERENCE_WIDTH * scale + offsetX,  // scale x horizontally
            y: pos.y  // y stays absolute (no scaling)
        };
    }

    function startDrawing(e) {
        if (e.target !== canvas) return;
        if (isMobile && !drawModeActive) return;
        // Don't start a stroke while the user is interacting with a sticky note (P2-1)
        if (window.__stickyNoteInteracting) return;

        isDrawing = true;
        const pos = getPos(e);  // percentage coordinates
        const pixels = toPixels(pos);
        lastX = pixels.x;
        lastY = pixels.y;

        const color = isEraser ? 'rgba(250, 250, 250, 1)' : (fixedColor || getFlowingColor());
        currentStroke = [{
            x: pos.x,  // store as percentage
            y: pos.y,
            color: color,
            width: isEraser ? lineWidth * 4 : lineWidth
        }];

        // Hide hint after first stroke
        if (!hasDrawn && hint) {
            hasDrawn = true;
            hint.classList.add('hidden');
        }

        // Reset mobile timeout
        if (isMobile) resetDrawModeTimeout();
    }

    function draw(e) {
        if (!isDrawing) return;
        e.preventDefault();

        const { scale } = getDrawingTransform();
        const pos = getPos(e);  // reference coordinates
        const pixels = toPixels(pos);

        // Get current color (flowing or fixed)
        const color = isEraser ? 'rgba(250, 250, 250, 1)' : (fixedColor || getFlowingColor());
        const width = isEraser ? lineWidth * 4 : lineWidth;

        // Slight width variation for organic feel
        const widthVariation = autoColorMode && !isEraser ? (1 + Math.sin(Date.now() / 100) * 0.15) : 1;

        ctx.strokeStyle = color;
        ctx.lineWidth = width * widthVariation * scale;  // Scale line width

        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(pixels.x, pixels.y);
        ctx.stroke();

        currentStroke.push({ x: pos.x, y: pos.y, color, width });  // store in reference space
        lastX = pixels.x;
        lastY = pixels.y;

        // Advance color for flowing effect
        if (autoColorMode && !isEraser) advanceColor();

        // Reset mobile timeout
        if (isMobile) resetDrawModeTimeout();
    }

    function stopDrawing() {
        if (!isDrawing) return;
        isDrawing = false;

        if (strokesRef && currentStroke.length > 1) {
            // Save each point with its color for multi-color strokes
            strokesRef.push({
                points: currentStroke.map(p => ({ x: p.x, y: p.y, c: p.color })),
                width: currentStroke[0].width,
                timestamp: Date.now()
            });
        }
        currentStroke = [];
    }

    function clearCanvas() {
        allStrokes = [];  // Clear local strokes
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (db) {
            const pageId = getPageId();
            db.ref('canvas_cleared/' + pageId).set(Date.now());
            db.ref('strokes/' + pageId).remove();
        }
    }

    // ==========================================================================
    // Mobile Draw Mode Toggle
    // ==========================================================================
    function setDrawMode(active) {
        drawModeActive = active;

        if (mobileToggle) {
            mobileToggle.classList.toggle('active', active);
        }
        if (toolbar) {
            toolbar.classList.toggle('visible', active);
        }
        if (canvas) {
            canvas.classList.toggle('draw-enabled', active);
        }

        if (active) {
            resetDrawModeTimeout();
        } else {
            clearTimeout(drawModeTimeout);
        }
    }

    function resetDrawModeTimeout() {
        clearTimeout(drawModeTimeout);
        // Auto-exit draw mode after inactivity
        drawModeTimeout = setTimeout(() => {
            if (isMobile && !isDrawing) {
                setDrawMode(false);
            }
        }, CONFIG.MOBILE_DRAW_TIMEOUT_MS);
    }

    if (mobileToggle) {
        mobileToggle.addEventListener('click', () => {
            setDrawMode(!drawModeActive);
        });
    }

    // ==========================================================================
    // Initialize Canvas
    // ==========================================================================
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Also resize when content might change height
    const resizeObserver = new ResizeObserver(() => {
        const newHeight = getDocumentHeight();
        if (canvas.height !== newHeight) {
            resizeCanvas();
        }
    });
    resizeObserver.observe(document.body);

    // Throttled draw function for better performance
    const throttledDraw = throttle(draw, CONFIG.THROTTLE_MS);

    // Mouse events
    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', throttledDraw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseout', stopDrawing);

    // Touch events
    canvas.addEventListener('touchstart', startDrawing, { passive: false });
    canvas.addEventListener('touchmove', throttledDraw, { passive: false });
    canvas.addEventListener('touchend', stopDrawing);

    initFirebase();

    // Clean up Firebase listeners on page unload
    window.addEventListener('beforeunload', () => {
        firebaseListeners.forEach(({ ref, event, callback }) => {
            ref.off(event, callback);
        });
    });

    // ==========================================================================
    // Toolbar Controls
    // ==========================================================================

    // Size buttons
    document.querySelectorAll('.size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.size-btn').forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-pressed', 'false');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-pressed', 'true');
            lineWidth = parseInt(btn.dataset.size);
        });
    });

    // Color buttons
    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.color-btn').forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-pressed', 'false');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-pressed', 'true');

            const color = btn.dataset.color;
            if (color === 'auto') {
                autoColorMode = true;
                fixedColor = null;
            } else {
                autoColorMode = false;
                fixedColor = hexToRgba(color, 0.6);
            }

            // Turn off eraser when selecting color
            isEraser = false;
            const eraserBtn = document.querySelector('[data-tool="eraser"]');
            if (eraserBtn) {
                eraserBtn.classList.remove('active');
                eraserBtn.setAttribute('aria-pressed', 'false');
            }
        });
    });

    // Tool buttons
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tool = btn.dataset.tool;

            if (tool === 'eraser') {
                isEraser = !isEraser;
                btn.classList.toggle('active', isEraser);
                btn.setAttribute('aria-pressed', isEraser ? 'true' : 'false');
            }
        });
    });

    function hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }


    // ==========================================================================
    // Quirky Interactions
    // ==========================================================================
    const h1 = document.querySelector('h1');
    if (h1) {
        h1.addEventListener('click', () => {
            const rotation = (Math.random() - 0.5) * 10;
            h1.style.transform = `rotate(${rotation}deg)`;
            setTimeout(() => h1.style.transform = 'rotate(0deg)', 500);
        });
        h1.style.transition = 'transform 0.3s ease, color 0.3s ease';
    }

    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        // Let skip links use native behavior so focus moves to the target (A11y-6)
        if (anchor.classList.contains('skip-link')) return;
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });

    console.log('✎ draw anywhere on the page!');
    console.log('tip: the colors flow through forest → terracotta → earth → warm gray');

    // ==========================================================================
    // Content Loading from Firebase
    // ==========================================================================

    // Helper function to render different audio embed types
    function renderSoundEmbed(sound) {
        const { title, type, url, artist } = sound;
        let embedHtml = '';

        // Sanitize the embed URL based on type
        const safeUrl = window.Sanitize ? window.Sanitize.sanitizeEmbedUrl(url, type) : '';
        if (!safeUrl && type !== 'audio') {
            return ''; // Skip invalid embed URLs
        }

        // Build the title/artist header with escaped content
        let header = '';
        const escapeHtml = window.Sanitize ? window.Sanitize.escapeHtml : (s) => s;
        if (title || artist) {
            header = `<div class="sound-info">`;
            if (title) header += `<span class="sound-title">${escapeHtml(title)}</span>`;
            if (artist) header += `<span class="sound-artist">${escapeHtml(artist)}</span>`;
            header += `</div>`;
        }

        switch (type) {
            case 'mixcloud':
            case 'bandcamp':
                embedHtml = `<iframe width="100%" height="120" src="${escapeHtml(safeUrl)}" frameborder="0" allow="autoplay" loading="lazy"></iframe>`;
                break;

            case 'dropbox':
                // Convert Dropbox share link to direct link
                let directUrl = safeUrl;
                if (safeUrl.includes('dropbox.com') || safeUrl.includes('dropboxusercontent.com')) {
                    directUrl = safeUrl
                        .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
                        .replace('&dl=0', '&dl=1')
                        .replace('?dl=0', '?dl=1');
                    // If no dl param, add it
                    if (!directUrl.includes('dl=1')) {
                        directUrl += (directUrl.includes('?') ? '&' : '?') + 'dl=1';
                    }
                }
                // Detect audio type from extension
                const ext = directUrl.split('.').pop().split('?')[0].toLowerCase();
                const mimeTypes = {
                    'mp3': 'audio/mpeg',
                    'm4a': 'audio/mp4',
                    'wav': 'audio/wav',
                    'ogg': 'audio/ogg',
                    'aac': 'audio/aac'
                };
                const mimeType = mimeTypes[ext] || 'audio/mpeg';
                embedHtml = `<audio controls preload="metadata"><source src="${escapeHtml(directUrl)}" type="${mimeType}">Your browser does not support audio.</audio>`;
                break;

            case 'audio':
                // Validate audio URL
                const safeAudioUrl = window.Sanitize ? window.Sanitize.sanitizeUrl(url) : url;
                if (!safeAudioUrl) return '';
                embedHtml = `<audio controls preload="metadata"><source src="${escapeHtml(safeAudioUrl)}">Your browser does not support audio.</audio>`;
                break;

            default:
                // Unknown type - skip for security
                return '';
        }

        return `<div class="sound-embed">${header}${embedHtml}</div>`;
    }

    // Reorder sections in the DOM based on saved order
    function reorderSections(sectionOrder) {
        const main = document.querySelector('main');
        if (!main) return;

        // Find the first section and its preceding hr
        const sections = {};
        const hrElements = {};

        sectionOrder.forEach(id => {
            const section = document.getElementById(id);
            if (section) {
                sections[id] = section;
                // Find the hr before this section
                const prevSibling = section.previousElementSibling;
                if (prevSibling && prevSibling.tagName === 'HR') {
                    hrElements[id] = prevSibling;
                }
            }
        });

        // Find the insertion point (after nav's hr)
        const nav = main.querySelector('nav');
        if (!nav) return;
        let insertBefore = nav.nextElementSibling;
        while (insertBefore && insertBefore.tagName !== 'HR') {
            insertBefore = insertBefore.nextElementSibling;
        }
        if (insertBefore) insertBefore = insertBefore.nextElementSibling;

        // Reorder: move each section (with its preceding hr) in order
        sectionOrder.forEach(id => {
            const section = sections[id];
            const hr = hrElements[id];
            if (section) {
                // Find where to insert
                const footer = main.querySelector('footer');
                const lastHr = footer?.previousElementSibling;

                if (hr && lastHr) {
                    main.insertBefore(hr, lastHr);
                    main.insertBefore(section, lastHr);
                }
            }
        });

        // Also update the nav order
        const navEl = document.querySelector('nav');
        if (navEl) {
            const links = {};
            navEl.querySelectorAll('a').forEach(a => {
                const href = a.getAttribute('href');
                if (href && href.startsWith('#')) {
                    links[href.substring(1)] = a;
                }
            });

            // Reorder nav links
            sectionOrder.forEach(id => {
                if (links[id]) {
                    navEl.appendChild(links[id]);
                }
            });
        }
    }

    function loadContent() {
        if (!FIREBASE_CONFIG.apiKey) return;

        const contentRef = firebase.database().ref('content');
        contentRef.once('value').then((snapshot) => {
            const content = snapshot.val();
            if (!content) return;

            // Reorder sections if order is saved
            if (content.sectionOrder && content.sectionOrder.length > 0) {
                reorderSections(content.sectionOrder);
            }

            // Sanitization helper
            const escapeHtml = window.Sanitize ? window.Sanitize.escapeHtml : (s) => s;
            const sanitizeUrl = window.Sanitize ? window.Sanitize.sanitizeUrl : (s) => s;

            // Load Intro section
            if (content.about) {
                const aboutEl = document.getElementById('intro-content');
                if (aboutEl && content.about.paragraphs) {
                    aboutEl.innerHTML = content.about.paragraphs
                        .map(p => `<p>${escapeHtml(p)}</p>`)
                        .join('');
                }
            }

            // Load Projects
            if (content.projects && content.projects.length > 0) {
                const projectsEl = document.getElementById('projects-list');
                if (projectsEl) {
                    projectsEl.innerHTML = content.projects
                        .map(p => {
                            // Check if link is internal (page slug) or external (URL)
                            const link = p.link || '#';
                            const safeLink = sanitizeUrl(link);
                            if (!safeLink) return ''; // Skip items with unsafe URLs
                            const href = safeLink.startsWith('http') || safeLink.startsWith('#')
                                ? safeLink
                                : `page.html?p=${encodeURIComponent(safeLink)}`;
                            const target = '';
                            return `<li><a href="${escapeHtml(href)}"${target}>${escapeHtml(p.title)}</a><span class="desc">— ${escapeHtml(p.desc)}</span></li>`;
                        })
                        .filter(Boolean)
                        .join('');
                }
            }

            // Load Writing
            if (content.writing && content.writing.length > 0) {
                const writingEl = document.getElementById('writing-list');
                if (writingEl) {
                    writingEl.innerHTML = content.writing
                        .map(w => {
                            // Check if link is internal (page slug) or external (URL)
                            const link = w.link || '#';
                            const safeLink = sanitizeUrl(link);
                            if (!safeLink) return ''; // Skip items with unsafe URLs
                            const href = safeLink.startsWith('http') || safeLink.startsWith('#')
                                ? safeLink
                                : `page.html?p=${encodeURIComponent(safeLink)}`;
                            const target = '';
                            return `<li><span class="date">${escapeHtml(w.date)}</span><a href="${escapeHtml(href)}"${target}>${escapeHtml(w.title)}</a></li>`;
                        })
                        .filter(Boolean)
                        .join('');
                }
            }

            // Load Sounds (supports legacy mixes format)
            const soundsData = content.sounds || (content.mixes ? content.mixes.map(m => ({
                title: m.title || '',
                type: 'mixcloud',
                url: m.embedUrl || '',
                artist: ''
            })) : []);

            if (soundsData.length > 0) {
                const soundsEl = document.getElementById('sounds-list');
                if (soundsEl) {
                    soundsEl.innerHTML = soundsData.map(s => renderSoundEmbed(s)).join('');
                }
            }

            // Load Contact Links
            if (content.contact && content.contact.length > 0) {
                const contactEl = document.getElementById('contact-list');
                if (contactEl) {
                    contactEl.innerHTML = content.contact
                        .map(c => {
                            // Check if link is internal (page slug) or external (URL)
                            const url = c.url || '#';
                            const safeUrl = sanitizeUrl(url);
                            if (!safeUrl) return ''; // Skip items with unsafe URLs
                            const href = safeUrl.startsWith('http') || safeUrl.startsWith('#') || safeUrl.startsWith('mailto:')
                                ? safeUrl
                                : `page.html?p=${encodeURIComponent(safeUrl)}`;
                            const target = safeUrl.startsWith('http') ? ' target="_blank" rel="noopener noreferrer"' : '';
                            return `<li><a href="${escapeHtml(href)}"${target}>${escapeHtml(c.name)}</a></li>`;
                        })
                        .filter(Boolean)
                        .join('');
                }
            }

            // Content loaded - reveal sections
            document.body.classList.remove('content-loading');
            document.body.classList.add('content-loaded');
        }).catch(err => {
            console.log('Content load failed, using defaults:', err);
            // Still reveal sections even on error
            document.body.classList.remove('content-loading');
            document.body.classList.add('content-loaded');
        });
    }

    // Load content after Firebase is ready
    if (FIREBASE_CONFIG.apiKey) {
        loadContent();
    }

})();
