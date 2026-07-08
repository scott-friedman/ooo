/**
 * Music Maker - Collaborative Step Sequencer
 * Create 4/4 bars, save them, and arrange into songs
 */

(function() {
    'use strict';

    // ==========================================================================
    // Configuration
    // ==========================================================================

    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyCFKStIkbW_omKXd7TQb3jUVuBJA4g3zqo",
        authDomain: "scottfriedman-f400d.firebaseapp.com",
        databaseURL: "https://scottfriedman-f400d-default-rtdb.firebaseio.com",
        projectId: "scottfriedman-f400d",
        storageBucket: "scottfriedman-f400d.firebasestorage.app",
        messagingSenderId: "1046658110090",
        appId: "1:1046658110090:web:49a24a0ff13b19cb111373"
    };

    const STEPS = 16;

    // Simple mode instruments
    const SIMPLE_DRUMS = ['Kick', 'Snare', 'Hi-hat'];
    const SIMPLE_MELODY = ['A4', 'G4', 'E4', 'D4', 'C4']; // Pentatonic (top to bottom)

    // Advanced mode instruments
    const ADVANCED_DRUMS = ['Kick', 'Snare', 'HH Closed', 'HH Open', 'Clap', 'Perc'];
    const ADVANCED_MELODY = ['C5', 'B4', 'A4', 'G4', 'F4', 'E4', 'D4', 'C4']; // Full octave

    let currentMode = 'simple';
    let bpm = 100;
    let isPlaying = false;
    let currentStep = 0;
    let sequence = null;
    let nextChordStep = 0; // Track where to place next chord

    // Grid state - always full size for compatibility
    let drumGrid = Array(6).fill(null).map(() => Array(STEPS).fill(0));
    let melodyGrid = Array(8).fill(null).map(() => Array(STEPS).fill(0));

    // Song arranger state
    let songBars = [];
    let allBars = {};

    // Audio state - defer initialization for iOS Safari
    let audioInitialized = false;

    // Synths
    let kick, snare, hihatClosed, hihatOpen, clap, perc, melodySynth;

    // Master effects
    let masterReverb, masterFilter, hihatFilter;

    // ==========================================================================
    // Firebase Setup
    // ==========================================================================

    function initFirebase() {
        if (!firebase.apps.length) {
            firebase.initializeApp(FIREBASE_CONFIG);
        }
        return firebase.database();
    }

    // ==========================================================================
    // Audio Setup (Tone.js)
    // ==========================================================================

    // Ensure audio is initialized (required for iOS Safari)
    async function ensureAudio() {
        if (!audioInitialized) {
            await Tone.start();
            initAudio();
            audioInitialized = true;
        }
    }

    function initAudio() {
        // Master effects chain for warmth
        masterReverb = new Tone.Reverb({
            decay: 1.2,
            wet: 0.15
        }).toDestination();

        masterFilter = new Tone.Filter({
            frequency: 6000,
            type: 'lowpass',
            rolloff: -12
        }).connect(masterReverb);

        // Hi-hat filter (highpass to keep it crisp but not harsh)
        hihatFilter = new Tone.Filter({
            frequency: 7000,
            type: 'highpass'
        }).connect(masterFilter);

        // Kick drum - warm and punchy
        kick = new Tone.MembraneSynth({
            pitchDecay: 0.05,
            octaves: 6,
            oscillator: { type: 'sine' },
            envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.1 }
        }).connect(masterFilter);
        kick.volume.value = -4;

        // Snare - pink noise with body, softer attack
        snare = new Tone.NoiseSynth({
            noise: { type: 'pink' },
            envelope: { attack: 0.005, decay: 0.15, sustain: 0, release: 0.08 }
        }).connect(masterFilter);
        snare.volume.value = -6;

        // Hi-hat closed - soft noise instead of harsh metallic
        hihatClosed = new Tone.NoiseSynth({
            noise: { type: 'white' },
            envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.02 }
        }).connect(hihatFilter);
        hihatClosed.volume.value = -14;

        // Hi-hat open - longer decay
        hihatOpen = new Tone.NoiseSynth({
            noise: { type: 'white' },
            envelope: { attack: 0.001, decay: 0.25, sustain: 0, release: 0.1 }
        }).connect(hihatFilter);
        hihatOpen.volume.value = -14;

        // Clap - softer with gentle attack
        clap = new Tone.NoiseSynth({
            noise: { type: 'pink' },
            envelope: { attack: 0.008, decay: 0.12, sustain: 0, release: 0.08 }
        }).connect(masterFilter);
        clap.volume.value = -8;

        // Percussion - soft woodblock-like
        perc = new Tone.MembraneSynth({
            pitchDecay: 0.02,
            octaves: 3,
            oscillator: { type: 'sine' },
            envelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.05 }
        }).connect(masterFilter);
        perc.volume.value = -6;

        // Melody synth - warm sine/triangle with gentle envelope
        melodySynth = new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: 'sine' },
            envelope: { attack: 0.05, decay: 0.2, sustain: 0.4, release: 0.6 }
        }).connect(masterReverb);
        melodySynth.volume.value = -8;
    }

    function triggerDrum(index) {
        switch(index) {
            case 0: kick.triggerAttackRelease('C1', '8n'); break;
            case 1: snare.triggerAttackRelease('8n'); break;
            case 2: hihatClosed.triggerAttackRelease('C4', '32n'); break;
            case 3: hihatOpen.triggerAttackRelease('C4', '16n'); break;
            case 4: clap.triggerAttackRelease('16n'); break;
            case 5: perc.triggerAttackRelease('G3', '16n'); break;
        }
    }

    function triggerMelody(note) {
        melodySynth.triggerAttackRelease(note, '8n');
    }

    // ==========================================================================
    // Grid Generation
    // ==========================================================================

    function buildGrid() {
        const drumTracks = document.getElementById('drum-tracks');
        const melodyTracks = document.getElementById('melody-tracks');

        const drums = currentMode === 'simple' ? SIMPLE_DRUMS : ADVANCED_DRUMS;
        const melody = currentMode === 'simple' ? SIMPLE_MELODY : ADVANCED_MELODY;

        // Build drum rows
        drumTracks.innerHTML = drums.map((name, rowIndex) => `
            <div class="track-row" data-type="drum" data-row="${rowIndex}">
                <div class="track-label">${name}</div>
                <div class="track-cells">
                    ${Array(STEPS).fill(0).map((_, colIndex) => `
                        <div class="cell drum ${drumGrid[rowIndex][colIndex] ? 'active' : ''}"
                             data-row="${rowIndex}" data-col="${colIndex}"></div>
                    `).join('')}
                </div>
            </div>
        `).join('');

        // Build melody rows
        melodyTracks.innerHTML = melody.map((note, rowIndex) => `
            <div class="track-row" data-type="melody" data-row="${rowIndex}">
                <div class="track-label">${note}</div>
                <div class="track-cells">
                    ${Array(STEPS).fill(0).map((_, colIndex) => `
                        <div class="cell melody ${melodyGrid[rowIndex][colIndex] ? 'active' : ''}"
                             data-row="${rowIndex}" data-col="${colIndex}" data-note="${note}"></div>
                    `).join('')}
                </div>
            </div>
        `).join('');

        // Add click handlers
        document.querySelectorAll('.cell').forEach(cell => {
            cell.addEventListener('click', handleCellClick);
        });

        // Add drop handlers for chord drag-and-drop (melody cells only)
        document.querySelectorAll('.cell.melody').forEach(cell => {
            cell.addEventListener('dragover', handleChordDragOver);
            cell.addEventListener('dragleave', handleChordDragLeave);
            cell.addEventListener('drop', handleChordDrop);
        });
    }

    function handleChordDragOver(e) {
        e.preventDefault();
        if (draggedChord) {
            // Highlight the entire column
            const col = parseInt(e.target.dataset.col);
            document.querySelectorAll('.cell.melody').forEach(cell => {
                if (parseInt(cell.dataset.col) === col) {
                    cell.classList.add('drop-target');
                }
            });
        }
    }

    function handleChordDragLeave(e) {
        // Only remove if leaving the column entirely
        const col = parseInt(e.target.dataset.col);
        const related = e.relatedTarget;
        if (!related || !related.classList?.contains('cell') || parseInt(related.dataset?.col) !== col) {
            document.querySelectorAll('.cell.melody').forEach(cell => {
                if (parseInt(cell.dataset.col) === col) {
                    cell.classList.remove('drop-target');
                }
            });
        }
    }

    function handleChordDrop(e) {
        e.preventDefault();
        document.querySelectorAll('.cell').forEach(c => c.classList.remove('drop-target'));

        if (draggedChord) {
            const col = parseInt(e.target.dataset.col);
            addChordAtStep(draggedChord, col);
            draggedChord = null;
        }
    }

    async function handleCellClick(e) {
        const cell = e.target;
        const row = parseInt(cell.dataset.row);
        const col = parseInt(cell.dataset.col);
        const isDrum = cell.classList.contains('drum');

        // Ensure audio is ready (iOS Safari requires user gesture)
        await ensureAudio();

        if (isDrum) {
            drumGrid[row][col] = drumGrid[row][col] ? 0 : 1;
            cell.classList.toggle('active');
            if (drumGrid[row][col]) triggerDrum(row);
        } else {
            melodyGrid[row][col] = melodyGrid[row][col] ? 0 : 1;
            cell.classList.toggle('active');
            if (melodyGrid[row][col]) triggerMelody(cell.dataset.note);
        }
    }

    function clearGrid() {
        drumGrid = Array(6).fill(null).map(() => Array(STEPS).fill(0));
        melodyGrid = Array(8).fill(null).map(() => Array(STEPS).fill(0));
        nextChordStep = 0;
        buildGrid();
    }

    // ==========================================================================
    // Playback
    // ==========================================================================

    async function startPlayback() {
        await ensureAudio();
        Tone.Transport.bpm.value = bpm;

        if (sequence) {
            sequence.dispose();
        }

        const melody = currentMode === 'simple' ? SIMPLE_MELODY : ADVANCED_MELODY;

        sequence = new Tone.Sequence((time, step) => {
            currentStep = step;

            // Highlight current step
            document.querySelectorAll('.cell').forEach(cell => {
                cell.classList.remove('playing');
                if (parseInt(cell.dataset.col) === step) {
                    cell.classList.add('playing');
                }
            });

            // Play drums
            for (let i = 0; i < drumGrid.length; i++) {
                if (drumGrid[i][step]) {
                    Tone.Draw.schedule(() => triggerDrum(i), time);
                }
            }

            // Play melody
            for (let i = 0; i < melody.length; i++) {
                if (melodyGrid[i][step]) {
                    melodySynth.triggerAttackRelease(melody[i], '8n', time);
                }
            }
        }, [...Array(STEPS).keys()], '16n');

        sequence.start(0);
        Tone.Transport.start();
        isPlaying = true;
    }

    function stopPlayback() {
        if (sequence) {
            sequence.stop();
        }
        Tone.Transport.stop();
        isPlaying = false;
        currentStep = 0;

        document.querySelectorAll('.cell').forEach(cell => {
            cell.classList.remove('playing');
        });
    }

    // ==========================================================================
    // Firebase Operations
    // ==========================================================================

    function saveBar(name, creator) {
        const db = initFirebase();
        const barRef = db.ref('music/bars').push();

        const barData = {
            name: name || 'Untitled',
            creator: creator || 'Anonymous',
            bpm: bpm,
            drums: drumGrid,
            melody: melodyGrid,
            createdAt: Date.now()
        };

        return barRef.set(barData).then(() => {
            loadBars();
            return barRef.key;
        });
    }

    function loadBars() {
        const db = initFirebase();
        db.ref('music/bars').orderByChild('createdAt').limitToLast(50).once('value')
            .then(snapshot => {
                allBars = {};
                const library = document.getElementById('bar-library');

                if (!snapshot.exists()) {
                    library.innerHTML = '<p class="loading">No bars yet. Create the first one!</p>';
                    return;
                }

                const bars = [];
                snapshot.forEach(child => {
                    const bar = child.val();
                    bar.id = child.key;
                    allBars[bar.id] = bar;
                    bars.push(bar);
                });

                bars.reverse(); // Newest first

                library.innerHTML = bars.map(bar => `
                    <div class="bar-card" data-id="${bar.id}">
                        <div class="bar-preview">${renderMiniGrid(bar)}</div>
                        <div class="bar-name">${escapeHtml(bar.name)}</div>
                        <div class="bar-creator">by ${escapeHtml(bar.creator)}</div>
                        <div class="bar-actions">
                            <button class="bar-btn preview" data-id="${bar.id}">▶</button>
                            <button class="bar-btn add" data-id="${bar.id}">+ Add</button>
                        </div>
                    </div>
                `).join('');

                // Add event listeners
                document.querySelectorAll('.bar-btn.preview').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        previewBar(btn.dataset.id);
                    });
                });

                document.querySelectorAll('.bar-btn.add').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        addBarToSong(btn.dataset.id);
                    });
                });

                document.querySelectorAll('.bar-card').forEach(card => {
                    card.addEventListener('click', () => {
                        loadBarToEditor(card.dataset.id);
                    });
                });
            })
            .catch(err => {
                console.error('Failed to load bars:', err);
                const library = document.getElementById('bar-library');
                if (library) library.innerHTML = '<p class="loading">Couldn’t load bars — check your connection and refresh.</p>';
            });
    }

    function renderMiniGrid(bar) {
        // Render a simplified mini preview showing active cells
        let html = '';
        for (let col = 0; col < STEPS; col++) {
            let hasNote = false;
            for (let row = 0; row < bar.drums.length; row++) {
                if (bar.drums[row] && bar.drums[row][col]) hasNote = true;
            }
            for (let row = 0; row < bar.melody.length; row++) {
                if (bar.melody[row] && bar.melody[row][col]) hasNote = true;
            }
            html += `<div class="mini-cell ${hasNote ? 'active' : ''}"></div>`;
        }
        return html;
    }

    function previewBar(barId) {
        const bar = allBars[barId];
        if (!bar) return;

        // Temporarily load and play
        const oldDrums = [...drumGrid];
        const oldMelody = [...melodyGrid];
        const oldBpm = bpm;

        drumGrid = bar.drums.map(row => [...row]);
        melodyGrid = bar.melody.map(row => [...row]);
        bpm = bar.bpm || 100;

        buildGrid();
        startPlayback();

        // Stop after one loop
        setTimeout(() => {
            stopPlayback();
            drumGrid = oldDrums;
            melodyGrid = oldMelody;
            bpm = oldBpm;
            buildGrid();
        }, (60 / bpm) * 4 * 1000 + 100);
    }

    function loadBarToEditor(barId) {
        const bar = allBars[barId];
        if (!bar) return;

        drumGrid = bar.drums.map(row => [...row]);
        melodyGrid = bar.melody.map(row => [...row]);
        bpm = bar.bpm || 100;

        document.getElementById('tempo-select').value = bpm;
        document.getElementById('tempo-slider').value = bpm;
        document.getElementById('tempo-value').textContent = bpm;

        buildGrid();
    }

    // ==========================================================================
    // Song Arranger
    // ==========================================================================

    function addBarToSong(barId) {
        const bar = allBars[barId];
        if (!bar) return;

        songBars.push(barId);
        renderSongTimeline();
    }

    function removeBarFromSong(index) {
        songBars.splice(index, 1);
        renderSongTimeline();
    }

    function renderSongTimeline() {
        const timeline = document.getElementById('song-timeline');

        if (songBars.length === 0) {
            timeline.innerHTML = '<p class="timeline-hint">Add bars from the library above</p>';
            return;
        }

        timeline.innerHTML = songBars.map((barId, index) => {
            const bar = allBars[barId];
            return `
                <div class="timeline-bar" draggable="true" data-index="${index}">
                    <span>${bar ? escapeHtml(bar.name) : 'Unknown'}</span>
                    <button class="remove-bar" data-index="${index}">×</button>
                </div>
            `;
        }).join('');

        // Add drag/drop and remove handlers
        document.querySelectorAll('.timeline-bar').forEach(bar => {
            bar.addEventListener('dragstart', handleDragStart);
            bar.addEventListener('dragover', handleDragOver);
            bar.addEventListener('drop', handleDrop);
            bar.addEventListener('dragend', handleDragEnd);
        });

        document.querySelectorAll('.remove-bar').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeBarFromSong(parseInt(btn.dataset.index));
            });
        });
    }

    let draggedIndex = null;

    function handleDragStart(e) {
        draggedIndex = parseInt(e.target.dataset.index);
        e.target.classList.add('dragging');
    }

    function handleDragOver(e) {
        e.preventDefault();
    }

    function handleDrop(e) {
        e.preventDefault();
        const targetIndex = parseInt(e.target.closest('.timeline-bar').dataset.index);

        if (draggedIndex !== null && draggedIndex !== targetIndex) {
            const [removed] = songBars.splice(draggedIndex, 1);
            songBars.splice(targetIndex, 0, removed);
            renderSongTimeline();
        }
    }

    function handleDragEnd(e) {
        e.target.classList.remove('dragging');
        draggedIndex = null;
    }

    async function playSong() {
        if (songBars.length === 0) return;

        await ensureAudio();

        let currentBarIndex = 0;
        const playNextBar = () => {
            if (currentBarIndex >= songBars.length) {
                stopPlayback();
                return;
            }

            const bar = allBars[songBars[currentBarIndex]];
            if (!bar) {
                currentBarIndex++;
                playNextBar();
                return;
            }

            drumGrid = bar.drums.map(row => [...row]);
            melodyGrid = bar.melody.map(row => [...row]);
            bpm = bar.bpm || 100;
            Tone.Transport.bpm.value = bpm;

            buildGrid();

            // Schedule next bar
            const barDuration = (60 / bpm) * 4 * 1000;
            setTimeout(() => {
                currentBarIndex++;
                playNextBar();
            }, barDuration);
        };

        startPlayback();
        playNextBar();
    }

    function saveSong(name, creator) {
        if (songBars.length === 0) return Promise.reject('No bars in song');

        const db = initFirebase();
        const songRef = db.ref('music/songs').push();

        const songData = {
            name: name || 'Untitled Song',
            creator: creator || 'Anonymous',
            barIds: songBars,
            createdAt: Date.now()
        };

        return songRef.set(songData).then(() => {
            loadSongs();
            return songRef.key;
        });
    }

    function loadSongs() {
        const db = initFirebase();
        db.ref('music/songs').orderByChild('createdAt').limitToLast(20).once('value')
            .then(snapshot => {
                const songList = document.getElementById('song-list');

                if (!snapshot.exists()) {
                    songList.innerHTML = '<p class="loading">No songs yet. Create the first one!</p>';
                    return;
                }

                const songs = [];
                snapshot.forEach(child => {
                    const song = child.val();
                    song.id = child.key;
                    songs.push(song);
                });

                songs.reverse();

                songList.innerHTML = songs.map(song => `
                    <div class="song-item" data-id="${song.id}">
                        <div class="song-info">
                            <div class="song-name">${escapeHtml(song.name)}</div>
                            <div class="song-meta">by ${escapeHtml(song.creator)} · ${song.barIds ? song.barIds.length : 0} bars</div>
                        </div>
                        <button class="song-btn" data-id="${song.id}">▶ Play</button>
                    </div>
                `).join('');

                document.querySelectorAll('.song-item .song-btn').forEach(btn => {
                    btn.addEventListener('click', () => loadAndPlaySong(btn.dataset.id));
                });
            })
            .catch(err => {
                console.error('Failed to load songs:', err);
                const songList = document.getElementById('song-list');
                if (songList) songList.innerHTML = '<p class="loading">Couldn’t load songs — check your connection and refresh.</p>';
            });
    }

    function loadAndPlaySong(songId) {
        const db = initFirebase();
        db.ref('music/songs/' + songId).once('value').then(snapshot => {
            const song = snapshot.val();
            if (!song) return;

            songBars = song.barIds || [];
            renderSongTimeline();
            playSong();
        }).catch(err => {
            console.error('Failed to load song:', err);
            alert('Couldn’t load that song. Please try again.');
        });
    }

    // ==========================================================================
    // Modal Handling
    // ==========================================================================

    let saveType = 'bar'; // 'bar' or 'song'

    function showSaveModal(type) {
        saveType = type;
        document.getElementById('modal-title').textContent = type === 'bar' ? 'Save Bar' : 'Save Song';
        document.getElementById('save-name').value = '';

        // Remember creator name
        const savedName = localStorage.getItem('musicMakerName') || '';
        document.getElementById('creator-name').value = savedName;

        document.getElementById('save-modal').classList.add('active');
        document.getElementById('save-name').focus();
    }

    function hideSaveModal() {
        document.getElementById('save-modal').classList.remove('active');
    }

    function handleSave() {
        const name = document.getElementById('save-name').value.trim();
        const creator = document.getElementById('creator-name').value.trim();

        if (!name) {
            document.getElementById('save-name').focus();
            return;
        }

        // Remember creator name
        if (creator) {
            localStorage.setItem('musicMakerName', creator);
        }

        if (saveType === 'bar') {
            saveBar(name, creator).then(() => {
                hideSaveModal();
                clearGrid();
            }).catch(err => {
                console.error('Failed to save bar:', err);
                alert('Couldn’t save your bar — please try again.');
            });
        } else {
            saveSong(name, creator).then(() => {
                hideSaveModal();
            }).catch(err => {
                if (err === 'No bars in song') {
                    alert('Add some bars to your song first!');
                } else {
                    console.error('Failed to save song:', err);
                    alert('Couldn’t save your song — please try again.');
                }
            });
        }
    }

    // ==========================================================================
    // Mode Switching
    // ==========================================================================

    function setMode(mode) {
        currentMode = mode;

        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        // Toggle tempo controls
        const tempoSelect = document.querySelector('.tempo-simple');
        const tempoSlider = document.querySelector('.tempo-advanced');
        const tempoValue = document.getElementById('tempo-value');

        if (mode === 'simple') {
            tempoSelect.style.display = 'block';
            document.getElementById('tempo-slider').style.display = 'none';
            tempoValue.style.display = 'none';
        } else {
            tempoSelect.style.display = 'none';
            document.getElementById('tempo-slider').style.display = 'block';
            tempoValue.style.display = 'inline';
        }

        buildGrid();
    }

    // ==========================================================================
    // Utility
    // ==========================================================================

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;');
    }

    // ==========================================================================
    // Initialize
    // ==========================================================================

    // Chord definitions for simple mode (pentatonic: A4, G4, E4, D4, C4 - rows 0-4)
    const CHORDS = {
        'C':  [4, 2, 1],     // C, E, G (rows for C4, E4, G4)
        'Am': [0, 4, 2],     // A, C, E
        'G':  [1, 3],        // G, D (partial - no B in pentatonic)
        'Dm': [3, 0],        // D, A (partial)
        'Em': [2, 1, 4]      // E, G, C (relative minor feel)
    };

    // Currently dragged chord
    let draggedChord = null;

    function addChordAtStep(chordName, step) {
        const notes = CHORDS[chordName];
        if (!notes) return;

        // Clear any existing notes in this column
        for (let row = 0; row < 5; row++) {
            melodyGrid[row][step] = 0;
        }

        // Add chord notes
        notes.forEach(row => {
            if (row < 5) { // Only for simple mode rows
                melodyGrid[row][step] = 1;
            }
        });

        buildGrid();

        // Play the chord preview
        ensureAudio().then(() => {
            const melody = currentMode === 'simple' ? SIMPLE_MELODY : ADVANCED_MELODY;
            notes.forEach(row => {
                if (melody[row]) {
                    triggerMelody(melody[row]);
                }
            });
        });
    }

    function addChord(chordName) {
        // Find next available step (or wrap around)
        const step = nextChordStep % STEPS;
        addChordAtStep(chordName, step);
        nextChordStep++;
    }

    // Randomize bar generation
    function randomizeBar() {
        // Clear existing
        drumGrid = Array(6).fill(null).map(() => Array(STEPS).fill(0));
        melodyGrid = Array(8).fill(null).map(() => Array(STEPS).fill(0));

        const drums = currentMode === 'simple' ? SIMPLE_DRUMS : ADVANCED_DRUMS;
        const melody = currentMode === 'simple' ? SIMPLE_MELODY : ADVANCED_MELODY;

        // Generate drum pattern
        // Kick on beats 1 and 3 (steps 0, 8) with some variation
        for (let step = 0; step < STEPS; step++) {
            if (step % 8 === 0) drumGrid[0][step] = 1; // Kick on 1 and 3
            if (step % 8 === 4 && Math.random() > 0.3) drumGrid[0][step] = 1; // Sometimes on 2 and 4
        }

        // Snare on beats 2 and 4 (steps 4, 12)
        drumGrid[1][4] = 1;
        drumGrid[1][12] = 1;
        // Add ghost notes sometimes
        if (Math.random() > 0.5) drumGrid[1][10] = 1;

        // Hi-hats - 8th notes or 16th notes
        const hihatPattern = Math.random() > 0.5 ? 2 : 4; // Every 2 or 4 steps
        for (let step = 0; step < STEPS; step++) {
            if (step % hihatPattern === 0) drumGrid[2][step] = 1;
        }

        // Generate melody using chord progression
        const chordProgression = ['C', 'Am', 'G', 'C'];
        const chordSteps = [0, 4, 8, 12];

        chordSteps.forEach((step, i) => {
            const chord = chordProgression[i];
            const notes = CHORDS[chord];
            if (notes) {
                // Add chord notes
                notes.forEach(row => {
                    if (row < melody.length) {
                        melodyGrid[row][step] = 1;
                    }
                });

                // Maybe add a passing note
                if (Math.random() > 0.5 && step + 2 < STEPS) {
                    const passingNote = Math.floor(Math.random() * melody.length);
                    melodyGrid[passingNote][step + 2] = 1;
                }
            }
        });

        nextChordStep = 0;
        buildGrid();

        // Play a preview
        ensureAudio().then(() => startPlayback());
    }

    function init() {
        // Audio is initialized lazily on first interaction (for iOS Safari)
        buildGrid();
        loadBars();
        loadSongs();

        // Mode toggle
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => setMode(btn.dataset.mode));
        });

        // Tempo controls
        document.getElementById('tempo-select').addEventListener('change', (e) => {
            bpm = parseInt(e.target.value);
            if (isPlaying) {
                Tone.Transport.bpm.value = bpm;
            }
        });

        document.getElementById('tempo-slider').addEventListener('input', (e) => {
            bpm = parseInt(e.target.value);
            document.getElementById('tempo-value').textContent = bpm;
            if (isPlaying) {
                Tone.Transport.bpm.value = bpm;
            }
        });

        // Playback controls
        document.getElementById('play-btn').addEventListener('click', startPlayback);
        document.getElementById('stop-btn').addEventListener('click', stopPlayback);
        document.getElementById('clear-btn').addEventListener('click', clearGrid);
        document.getElementById('save-bar-btn').addEventListener('click', () => showSaveModal('bar'));

        // Song controls
        document.getElementById('play-song-btn').addEventListener('click', playSong);
        document.getElementById('stop-song-btn').addEventListener('click', stopPlayback);
        document.getElementById('clear-song-btn').addEventListener('click', () => {
            songBars = [];
            renderSongTimeline();
        });
        document.getElementById('save-song-btn').addEventListener('click', () => showSaveModal('song'));

        // Modal
        document.getElementById('modal-cancel').addEventListener('click', hideSaveModal);
        document.getElementById('modal-save').addEventListener('click', handleSave);
        document.getElementById('save-modal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) hideSaveModal();
        });

        // Enter key in modal
        document.getElementById('save-name').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleSave();
        });
        document.getElementById('creator-name').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleSave();
        });

        // Chord helper buttons - click to add, drag to place
        document.querySelectorAll('.chord-btn').forEach(btn => {
            btn.setAttribute('draggable', 'true');
            btn.addEventListener('click', () => addChord(btn.dataset.chord));
            btn.addEventListener('dragstart', (e) => {
                draggedChord = btn.dataset.chord;
                btn.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'copy';
            });
            btn.addEventListener('dragend', () => {
                btn.classList.remove('dragging');
                draggedChord = null;
                document.querySelectorAll('.cell').forEach(c => c.classList.remove('drop-target'));
            });
        });

        // Randomize button
        const randomizeBtn = document.getElementById('randomize-btn');
        if (randomizeBtn) {
            randomizeBtn.addEventListener('click', randomizeBar);
        }
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
