/**
 * Sticky Notes - Collaborative Message Board
 * Allows users to create, position, and share sticky notes
 */

(function() {
    'use strict';

    // Firebase config (same as main.js)
    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyCFKStIkbW_omKXd7TQb3jUVuBJA4g3zqo",
        authDomain: "scottfriedman-f400d.firebaseapp.com",
        databaseURL: "https://scottfriedman-f400d-default-rtdb.firebaseio.com",
        projectId: "scottfriedman-f400d",
        storageBucket: "scottfriedman-f400d.firebasestorage.app",
        messagingSenderId: "1046658110090",
        appId: "1:1046658110090:web:49a24a0ff13b19cb111373"
    };

    const COLORS = ['yellow', 'pink', 'blue', 'green', 'orange', 'purple'];
    const FONTS = [
        { id: 'caveat', label: 'Aa', name: 'Caveat', family: "'Caveat', cursive" },
        { id: 'patrick', label: 'Aa', name: 'Patrick Hand', family: "'Patrick Hand', cursive" },
        { id: 'marker', label: 'Aa', name: 'Permanent Marker', family: "'Permanent Marker', cursive" }
    ];

    // Movement (px) before a press becomes a drag. Below this, a touch scrolls
    // the page and a mouse press counts as a plain click (no no-op write). (P0-5)
    const DRAG_THRESHOLD_TOUCH = 8;
    const DRAG_THRESHOLD_MOUSE = 3;
    const DEFAULT_NOTE_WIDTH = 200;
    const DEFAULT_NOTE_HEIGHT = 150;

    let db = null;
    let notesRef = null;
    const notes = {};

    // Becomes true once Firebase has delivered the initial batch of notes, so
    // only notes that arrive afterwards play the spawn animation. (P1-5)
    let initialLoaded = false;

    // DOM Elements
    const container = document.getElementById('notes-container');
    const addBtn = document.getElementById('add-note-btn');

    // Currently editing note element (not yet saved to Firebase)
    let editingNote = null;

    // Drag state
    let draggedNote = null;     // committed drag
    let pendingNote = null;     // pressed, not yet past the drag threshold
    let pendingIsTouch = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let startClientX = 0;
    let startClientY = 0;
    let startLeft = '';         // note position at press, to detect real movement
    let startTop = '';

    /**
     * Announce a message to screen readers via the live region. (A11y-1)
     */
    function announce(msg) {
        const a = document.getElementById('status-announcer');
        if (a) {
            a.textContent = '';
            a.textContent = msg;
        }
    }

    /**
     * Check if current user is admin: the localStorage flag set on admin.html
     * AND a live auth session on this page (defense in depth; the database
     * rule is the real gate). (P0-2)
     */
    function isAdmin() {
        return localStorage.getItem('admin_auth') === 'true'
            && !!(window.firebase && firebase.auth && firebase.auth().currentUser);
    }

    /**
     * Initialize Firebase
     */
    function initFirebase() {
        // Firebase may already be initialized by main.js
        if (!firebase.apps.length) {
            firebase.initializeApp(FIREBASE_CONFIG);
        }
        db = firebase.database();
        notesRef = db.ref('stickynotes');

        // The admin session restores asynchronously after the auth SDK loads,
        // so re-render delete buttons once auth state resolves. (P0-2)
        if (firebase.auth) {
            firebase.auth().onAuthStateChanged(() => refreshDeleteButtons());
        }

        // Flag the end of the initial load so existing notes don't all animate. (P1-5)
        notesRef.once('value', () => { initialLoaded = true; });

        // Listen for notes
        notesRef.on('child_added', (snapshot) => {
            const note = snapshot.val();
            const id = snapshot.key;
            notes[id] = note;
            renderNote(id, note, initialLoaded);
        });

        notesRef.on('child_changed', (snapshot) => {
            const note = snapshot.val();
            const id = snapshot.key;
            notes[id] = note;
            updateNotePosition(id, note);
        });

        notesRef.on('child_removed', (snapshot) => {
            const id = snapshot.key;
            delete notes[id];
            removeNoteElement(id);
        });
    }

    /**
     * Build a delete button wired to remove the given note. (P0-2)
     */
    function createDeleteButton(id) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-note';
        deleteBtn.textContent = '×';
        deleteBtn.title = 'Delete note';
        deleteBtn.setAttribute('aria-label', 'Delete note'); // A11y-2
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteNote(id);
        });
        return deleteBtn;
    }

    /**
     * Ensure every saved note shows a delete button iff the viewer is admin.
     * Called when auth state resolves after the async session restore. (P0-2)
     */
    function refreshDeleteButtons() {
        const admin = isAdmin();
        document.querySelectorAll('.sticky-note[data-note-id]').forEach(el => {
            const existing = el.querySelector('.delete-note');
            if (admin && !existing) {
                el.appendChild(createDeleteButton(el.dataset.noteId));
            } else if (!admin && existing) {
                existing.remove();
            }
        });
    }

    /**
     * Render a saved sticky note
     */
    function renderNote(id, note, isNew = false) {
        // Check if note already exists
        if (document.querySelector(`[data-note-id="${id}"]`)) {
            updateNotePosition(id, note);
            return;
        }

        const el = document.createElement('div');
        el.className = 'sticky-note' + (isNew ? ' new' : '');
        el.dataset.noteId = id;
        el.dataset.color = note.color || 'yellow';
        el.dataset.font = note.font || 'caveat';
        el.dataset.rotation = (typeof note.rotation === 'number' ? note.rotation : 0); // P0-4
        el.style.cssText = `
            left: ${note.x}%;
            top: ${note.y}px;
            --rotation: ${note.rotation || 0}deg;
        `;

        // Note-list semantics for screen readers (P3-4)
        el.setAttribute('role', 'listitem');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', `Note: ${note.text}`);

        // Note text
        const textEl = document.createElement('div');
        textEl.className = 'note-text';
        textEl.textContent = note.text;
        el.appendChild(textEl);

        // Delete button (admin only)
        if (isAdmin()) {
            el.appendChild(createDeleteButton(id));
        }

        // Setup drag events
        setupDrag(el, id);

        container.appendChild(el);

        // Remove new class after animation
        if (isNew) {
            setTimeout(() => el.classList.remove('new'), 400);
        }
    }

    /**
     * Create a new editable note (not yet saved)
     */
    function createEditableNote() {
        // If already editing one, cancel it first
        if (editingNote) {
            cancelEdit();
        }

        const color = COLORS[Math.floor(Math.random() * COLORS.length)];
        const font = 'caveat';

        // Position near center of viewport
        const x = 30 + Math.random() * 40;
        const y = 100 + Math.random() * 150 + window.scrollY;
        const rotation = (Math.random() - 0.5) * 10;

        const el = document.createElement('div');
        el.className = 'sticky-note editing new';
        el.dataset.color = color;
        el.dataset.font = font;
        el.dataset.rotation = rotation; // stash numeric rotation for save (P0-4)
        el.style.cssText = `
            left: ${x}%;
            top: ${y}px;
            --rotation: ${rotation}deg;
        `;

        // Hidden text element (will show after saving)
        const textEl = document.createElement('div');
        textEl.className = 'note-text';
        el.appendChild(textEl);

        // Textarea for editing
        const textarea = document.createElement('textarea');
        textarea.className = 'note-textarea';
        textarea.placeholder = 'Write something...';
        textarea.maxLength = 200;
        textarea.setAttribute('aria-label', 'Note text'); // A11y-3
        // Auto-grow with content so long notes stay visible (P1-4)
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
        });
        el.appendChild(textarea);

        // Options bar
        const options = document.createElement('div');
        options.className = 'note-options';

        // Color buttons
        const colorsDiv = document.createElement('div');
        colorsDiv.className = 'note-colors';
        colorsDiv.setAttribute('role', 'group');
        colorsDiv.setAttribute('aria-label', 'Note color');
        COLORS.forEach(c => {
            const btn = document.createElement('button');
            const active = c === color;
            btn.className = 'note-color-btn' + (active ? ' active' : '');
            btn.dataset.color = c;
            btn.setAttribute('aria-label', `${c.charAt(0).toUpperCase() + c.slice(1)} note color`); // A11y-2
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                colorsDiv.querySelectorAll('.note-color-btn').forEach(b => {
                    b.classList.remove('active');
                    b.setAttribute('aria-pressed', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-pressed', 'true');
                el.dataset.color = c;
            });
            colorsDiv.appendChild(btn);
        });
        options.appendChild(colorsDiv);

        // Divider
        const div1 = document.createElement('span');
        div1.className = 'options-divider';
        options.appendChild(div1);

        // Font buttons
        const fontsDiv = document.createElement('div');
        fontsDiv.className = 'note-fonts';
        fontsDiv.setAttribute('role', 'group');
        fontsDiv.setAttribute('aria-label', 'Note font');
        FONTS.forEach(f => {
            const btn = document.createElement('button');
            const active = f.id === font;
            btn.className = 'note-font-btn' + (active ? ' active' : '');
            btn.dataset.font = f.id;
            btn.style.fontFamily = f.family;
            btn.textContent = f.label;
            btn.setAttribute('aria-label', `${f.name} font`); // A11y-2
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                fontsDiv.querySelectorAll('.note-font-btn').forEach(b => {
                    b.classList.remove('active');
                    b.setAttribute('aria-pressed', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-pressed', 'true');
                el.dataset.font = f.id;
            });
            fontsDiv.appendChild(btn);
        });
        options.appendChild(fontsDiv);

        // Cancel button
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'note-cancel-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            cancelEdit();
        });
        options.appendChild(cancelBtn);

        // Save button
        const saveBtn = document.createElement('button');
        saveBtn.className = 'note-save-btn';
        saveBtn.textContent = 'Stick it!';
        saveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            saveEditingNote();
        });
        options.appendChild(saveBtn);

        el.appendChild(options);
        container.appendChild(el);

        editingNote = el;

        // Focus textarea after animation
        setTimeout(() => {
            textarea.focus();
            el.classList.remove('new');
        }, 100);

        // Setup drag for the editing note
        setupDrag(el, null);
    }

    /**
     * Save the currently editing note to Firebase
     */
    function saveEditingNote() {
        if (!editingNote) return;

        const textarea = editingNote.querySelector('.note-textarea');
        const text = textarea.value.trim();

        if (!text) {
            announce('Note is empty — write something first'); // A11y-1
            textarea.focus();
            return;
        }

        const note = {
            text: text,
            color: editingNote.dataset.color,
            font: editingNote.dataset.font,
            x: parseFloat(editingNote.style.left),
            y: parseFloat(editingNote.style.top),
            rotation: parseFloat(editingNote.dataset.rotation) || 0,   // P0-4 (no NaN)
            createdAt: firebase.database.ServerValue.TIMESTAMP          // P3-6 server-stamp
        };

        // Push first, tear down only on success. Hide the editing node during
        // the write so it doesn't briefly duplicate the optimistic render;
        // restore it on failure so the note is never silently lost. (P0-3)
        const node = editingNote;
        const saveBtn = node.querySelector('.note-save-btn');
        if (saveBtn) saveBtn.disabled = true;
        node.style.visibility = 'hidden';

        notesRef.push(note)
            .then(() => {
                node.remove();
                if (editingNote === node) editingNote = null;
                announce('Note added'); // A11y-1
                addBtn.focus();         // A11y-4
            })
            .catch(() => {
                node.style.visibility = '';
                if (saveBtn) saveBtn.disabled = false;
                announce('Could not save note — please try again.'); // A11y-1 / P0-3
            });
    }

    /**
     * Cancel editing and remove unsaved note
     */
    function cancelEdit() {
        if (editingNote) {
            editingNote.remove();
            editingNote = null;
            addBtn.focus(); // A11y-4
        }
    }

    /**
     * Update note position in DOM
     */
    function updateNotePosition(id, note) {
        const el = document.querySelector(`[data-note-id="${id}"]`);
        if (!el) return;

        // Only update if we're not currently dragging this note
        if (el.classList.contains('dragging')) return;

        el.style.left = `${note.x}%`;
        el.style.top = `${note.y}px`;
    }

    /**
     * Remove note element from DOM
     */
    function removeNoteElement(id) {
        const el = document.querySelector(`[data-note-id="${id}"]`);
        if (el) {
            el.style.transform = 'scale(0) rotate(20deg)';
            el.style.opacity = '0';
            el.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
            setTimeout(() => el.remove(), 300);
        }
    }

    /**
     * Setup drag and drop for a note
     */
    function setupDrag(el, noteId) {
        el.addEventListener('mousedown', startDrag);
        el.addEventListener('touchstart', startDrag, { passive: false });

        function startDrag(e) {
            // Ignore if clicking buttons/textarea
            if (e.target.tagName === 'BUTTON' ||
                e.target.tagName === 'TEXTAREA' ||
                e.target.closest('button')) {
                return;
            }

            // Record the press but DON'T commit to a drag yet. We wait until the
            // pointer moves past a threshold, so a touch can scroll the page and
            // a plain click doesn't trigger a no-op write. No preventDefault
            // here — that would block scrolling. (P0-5)
            pendingNote = el;
            pendingIsTouch = e.type === 'touchstart';
            const clientX = pendingIsTouch ? e.touches[0].clientX : e.clientX;
            const clientY = pendingIsTouch ? e.touches[0].clientY : e.clientY;
            startClientX = clientX;
            startClientY = clientY;
            startLeft = el.style.left;
            startTop = el.style.top;

            const rect = el.getBoundingClientRect();
            dragOffsetX = clientX - rect.left;
            dragOffsetY = clientY - rect.top;

            // Ask the drawing canvas to stand down while we interact. (P2-1)
            window.__stickyNoteInteracting = true;
        }
    }

    /**
     * Promote a pending press to an active drag.
     */
    function beginDrag() {
        draggedNote = pendingNote;
        pendingNote = null;
        draggedNote.classList.remove('new'); // avoid new+dragging transform clash (P3-2)
        draggedNote.classList.add('dragging');
    }

    /**
     * Handle drag movement
     */
    function onDrag(e) {
        // Commit a pending press once it moves past the threshold. (P0-5)
        if (!draggedNote && pendingNote) {
            const isTouch = e.type === 'touchmove';
            const clientX = isTouch ? e.touches[0].clientX : e.clientX;
            const clientY = isTouch ? e.touches[0].clientY : e.clientY;
            const dist = Math.hypot(clientX - startClientX, clientY - startClientY);
            const threshold = pendingIsTouch ? DRAG_THRESHOLD_TOUCH : DRAG_THRESHOLD_MOUSE;
            if (dist < threshold) {
                return; // below threshold: let the page scroll / treat as a click
            }
            beginDrag();
        }

        if (!draggedNote) return;

        e.preventDefault();
        const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
        const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;

        // Calculate new position
        const newX = clientX - dragOffsetX;
        const newY = clientY - dragOffsetY + window.scrollY;

        // Convert to percentage for x
        const xPercent = (newX / window.innerWidth) * 100;

        // Clamp X using the note's measured width (160px on mobile), not a
        // hardcoded 200, so the right edge is correct everywhere. (P1-3)
        const w = draggedNote.offsetWidth || DEFAULT_NOTE_WIDTH;
        const maxXPercent = 100 - (w / window.innerWidth * 100);
        const clampedX = Math.max(0, Math.min(xPercent, maxXPercent));

        // Upper-clamp Y so a note can't be parked in unreachable space. (P2-2)
        const h = draggedNote.offsetHeight || DEFAULT_NOTE_HEIGHT;
        const maxY = Math.max(document.documentElement.scrollHeight, window.innerHeight) - h;
        const clampedY = Math.max(0, Math.min(newY, maxY));

        draggedNote.style.left = `${clampedX}%`;
        draggedNote.style.top = `${clampedY}px`;
    }

    /**
     * Handle drag end
     */
    function onDragEnd() {
        // A press that never crossed the threshold is just a click: clean up,
        // no wobble, no write. (P0-5)
        if (!draggedNote) {
            pendingNote = null;
            window.__stickyNoteInteracting = false;
            return;
        }

        const noteId = draggedNote.dataset.noteId;
        draggedNote.classList.remove('dragging');

        // Get final position
        const xPercent = parseFloat(draggedNote.style.left);
        const yPixels = parseFloat(draggedNote.style.top);

        // Only animate + persist if the note actually moved. (P0-5)
        const moved = draggedNote.style.left !== startLeft || draggedNote.style.top !== startTop;

        if (moved) {
            draggedNote.classList.remove('new'); // P3-2
            draggedNote.classList.add('dropped');
            const note = draggedNote;
            setTimeout(() => note.classList.remove('dropped'), 300);

            // Only save to Firebase if this is a saved note (has ID)
            if (noteId) {
                notesRef.child(noteId).update({
                    x: xPercent,
                    y: yPixels
                }).catch(() => announce('Could not move note — please try again.'));
            }
        }

        draggedNote = null;
        window.__stickyNoteInteracting = false;
    }

    /**
     * Re-clamp notes that would fall off the right edge when the window
     * narrows, so a note can never become unreachable. DOM-only (no write). (P1-3)
     */
    function reclampNotes() {
        document.querySelectorAll('.sticky-note[data-note-id]').forEach(el => {
            if (el === draggedNote) return;
            const w = el.offsetWidth || DEFAULT_NOTE_WIDTH;
            const maxXPercent = 100 - (w / window.innerWidth * 100);
            const left = parseFloat(el.style.left);
            if (!isNaN(left) && left > maxXPercent) {
                el.style.left = `${Math.max(0, maxXPercent)}%`;
            }
        });
    }

    /**
     * Delete a note (admin only)
     */
    function deleteNote(noteId) {
        if (!isAdmin()) return;

        if (confirm('Delete this note?')) {
            notesRef.child(noteId).remove()
                .then(() => announce('Note deleted')) // A11y-1
                .catch(() => announce('Could not delete note — please try again.'));
        }
    }

    /**
     * Setup event listeners
     */
    function setupEvents() {
        // Add note button
        addBtn.addEventListener('click', createEditableNote);

        // Drag events on document
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('touchmove', onDrag, { passive: false });
        document.addEventListener('mouseup', onDragEnd);
        document.addEventListener('touchend', onDragEnd);
        document.addEventListener('touchcancel', onDragEnd); // don't strand the interaction flag

        // Keep notes reachable when the viewport narrows (P1-3)
        window.addEventListener('resize', reclampNotes);

        // Skip link: move focus to the add-note button (A11y-6)
        const skip = document.querySelector('.skip-link');
        if (skip) {
            skip.addEventListener('click', () => {
                if (addBtn) addBtn.focus();
            });
        }

        // Escape to cancel editing
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && editingNote) {
                cancelEdit();
            }
        });
    }

    /**
     * Initialize
     */
    function init() {
        setupEvents();
        initFirebase();
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
