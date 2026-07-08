/**
 * Command Center - Smart Home Controls
 * Allows visitors to control whitelisted Home Assistant devices
 */

(function() {
    'use strict';

    // Configuration
    const WORKER_URL = 'https://ha-command-center.s-friedman.workers.dev';

    // Firebase Configuration (uses shared config if available)
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

    // State
    let isEnabled = true;
    let devices = {};
    let db = null;
    let lastLogTimestamp = 0;
    let refreshDebounceTimer = null;
    let isInitialLoad = true;
    let lastLocalActionTime = 0; // Track when WE made an action
    const LOCAL_ACTION_COOLDOWN = 3000; // Ignore Firebase refreshes for 3s after our own action

    // DOM Elements
    const devicesGrid = document.getElementById('devices-grid');
    const activityLog = document.getElementById('activity-log');
    const disabledBanner = document.getElementById('disabled-banner');

    // Escape everything interpolated into innerHTML — device names, media
    // titles, and log entries all originate outside this page.
    const esc = window.Sanitize ? window.Sanitize.escapeHtml : (s) => String(s ?? '');

    /**
     * Initialize Firebase
     */
    function initFirebase() {
        if (!firebase.apps.length) {
            firebase.initializeApp(FIREBASE_CONFIG);
        }
        db = firebase.database();
    }

    /**
     * Update UI based on enabled state
     */
    function updateEnabledUI() {
        if (isEnabled) {
            disabledBanner.style.display = 'none';
            devicesGrid.classList.remove('disabled');
        } else {
            disabledBanner.style.display = 'flex';
            devicesGrid.classList.add('disabled');
        }

        // Update all device cards
        document.querySelectorAll('.device-card').forEach(card => {
            if (isEnabled) {
                card.classList.remove('disabled');
            } else {
                card.classList.add('disabled');
            }
        });
    }

    /**
     * Listen for enabled state changes from Firebase
     */
    function listenForEnabledState() {
        db.ref('commandcenter/enabled').on('value', (snapshot) => {
            // Default OFF when unset — matches the worker's fail-closed
            // checkEnabled and the admin panel's toggle. (UX-2)
            isEnabled = snapshot.val() === true;
            updateEnabledUI();
        }, (error) => {
            console.error('Failed to load enabled state:', error);
        });
    }

    /**
     * Fetch devices and their states from the worker
     */
    async function fetchDevices() {
        try {
            const response = await fetch(`${WORKER_URL}/api/state`);
            if (!response.ok) throw new Error('Failed to fetch devices');

            const data = await response.json();
            devices = data.states || {};
            renderDevices();
        } catch (error) {
            console.error('Failed to fetch devices:', error);
            renderDevicesError();
        }
    }

    /**
     * Render device cards
     */
    function renderDevices() {
        const entityIds = Object.keys(devices);

        if (entityIds.length === 0) {
            devicesGrid.innerHTML = `
                <div class="error-message">
                    No devices configured yet. Check back later!
                </div>
            `;
            return;
        }

        devicesGrid.innerHTML = entityIds.map(entityId => {
            const device = devices[entityId];
            const isOn = device.state === 'on';
            const disabledClass = isEnabled ? '' : 'disabled';
            const isLight = entityId.startsWith('light.');
            const isFan = entityId.startsWith('fan.');
            const isMediaPlayer = entityId.startsWith('media_player.');
            const supportsColor = device.supports_color;

            // Media player gets a completely different card
            if (isMediaPlayer) {
                return renderMediaPlayerCard(entityId, device, disabledClass);
            }

            // Build extra controls HTML
            let extraControls = '';

            // Color picker for color-capable lights
            if (isLight && supportsColor) {
                const currentColor = device.rgb_color
                    ? `rgb(${device.rgb_color.join(',')})`
                    : '#ffffff';
                const presetColors = [
                    { name: 'Red', rgb: [255, 0, 0] },
                    { name: 'Orange', rgb: [255, 128, 0] },
                    { name: 'Yellow', rgb: [255, 255, 0] },
                    { name: 'Green', rgb: [0, 255, 0] },
                    { name: 'Blue', rgb: [0, 128, 255] },
                    { name: 'Purple', rgb: [128, 0, 255] },
                    { name: 'Pink', rgb: [255, 0, 128] },
                    { name: 'White', rgb: [255, 255, 255] }
                ];
                const presetSwatches = presetColors.map(c => `
                    <button
                        class="color-preset"
                        data-entity-id="${esc(entityId)}"
                        data-rgb="${c.rgb.join(',')}"
                        style="background: rgb(${c.rgb.join(',')})"
                        title="${c.name}"
                        ${!isEnabled || !isOn ? 'disabled' : ''}
                    ></button>
                `).join('');

                extraControls += `
                    <div class="color-control">
                        <label class="color-label">Color</label>
                        <div class="color-presets">
                            ${presetSwatches}
                            <label class="color-picker-wrapper" title="Custom color">
                                <input
                                    type="color"
                                    class="color-picker"
                                    data-entity-id="${esc(entityId)}"
                                    value="${rgbToHex(device.rgb_color || [255, 255, 255])}"
                                    ${!isEnabled || !isOn ? 'disabled' : ''}
                                >
                                <span class="color-picker-icon">+</span>
                            </label>
                        </div>
                        <div class="current-color">
                            <span class="current-color-swatch" style="background: ${currentColor}"></span>
                            <span class="current-color-label">Current</span>
                        </div>
                    </div>
                `;
            }

            // Fan speed controls
            if (isFan) {
                const currentSpeed = device.percentage || 0;
                extraControls += `
                    <div class="fan-control">
                        <label class="fan-label">Speed: ${currentSpeed}%</label>
                        <div class="fan-buttons">
                            <button
                                class="fan-btn ${currentSpeed === 33 ? 'active' : ''}"
                                data-entity-id="${esc(entityId)}"
                                data-speed="33"
                                ${!isEnabled || !isOn ? 'disabled' : ''}
                            >Low</button>
                            <button
                                class="fan-btn ${currentSpeed === 66 ? 'active' : ''}"
                                data-entity-id="${esc(entityId)}"
                                data-speed="66"
                                ${!isEnabled || !isOn ? 'disabled' : ''}
                            >Med</button>
                            <button
                                class="fan-btn ${currentSpeed === 100 ? 'active' : ''}"
                                data-entity-id="${esc(entityId)}"
                                data-speed="100"
                                ${!isEnabled || !isOn ? 'disabled' : ''}
                            >High</button>
                        </div>
                    </div>
                `;
            }

            return `
                <div class="device-card ${disabledClass}" data-entity-id="${esc(entityId)}">
                    <div class="device-header">
                        <span class="device-emoji">${esc(device.emoji || '🔌')}</span>
                        <span class="device-name">${esc(device.name)}</span>
                    </div>
                    <div class="device-status">
                        <span class="status-dot ${isOn ? 'on' : 'off'}"></span>
                        <span class="status-text">${isOn ? 'ON' : 'OFF'}</span>
                    </div>
                    <button
                        class="device-btn ${isOn ? 'turn-off' : 'turn-on'}"
                        data-entity-id="${esc(entityId)}"
                        data-action="${isOn ? 'turn_off' : 'turn_on'}"
                        ${!isEnabled ? 'disabled' : ''}
                    >
                        ${isOn ? 'Turn Off' : 'Turn On'}
                    </button>
                    ${extraControls}
                </div>
            `;
        }).join('');

        // Add click handlers for on/off buttons
        devicesGrid.querySelectorAll('.device-btn').forEach(btn => {
            btn.addEventListener('click', handleDeviceControl);
        });

        // Add color picker handlers
        devicesGrid.querySelectorAll('.color-picker').forEach(picker => {
            picker.addEventListener('change', handleColorChange);
        });

        // Add color preset handlers
        devicesGrid.querySelectorAll('.color-preset').forEach(btn => {
            btn.addEventListener('click', handleColorPreset);
        });

        // Add fan speed button handlers
        devicesGrid.querySelectorAll('.fan-btn').forEach(btn => {
            btn.addEventListener('click', handleFanSpeed);
        });

        // Add media player button handlers
        devicesGrid.querySelectorAll('.media-btn').forEach(btn => {
            btn.addEventListener('click', handleMediaControl);
        });
    }

    /**
     * Convert RGB array to hex color
     */
    function rgbToHex(rgb) {
        return '#' + rgb.map(c => {
            const hex = c.toString(16);
            return hex.length === 1 ? '0' + hex : hex;
        }).join('');
    }

    /**
     * Convert hex color to RGB array
     */
    function hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? [
            parseInt(result[1], 16),
            parseInt(result[2], 16),
            parseInt(result[3], 16)
        ] : [255, 255, 255];
    }

    /**
     * Render media player card (Apple TV, etc.)
     */
    function renderMediaPlayerCard(entityId, device, disabledClass) {
        const state = device.state || 'off';
        const isPlaying = state === 'playing';
        const isPaused = state === 'paused';
        const isOn = state !== 'off' && state !== 'unavailable';
        const isActive = isPlaying || isPaused;

        // Determine status badge
        let stateLabel = state.charAt(0).toUpperCase() + state.slice(1);
        if (state === 'standby') stateLabel = 'Standby';
        if (state === 'idle') stateLabel = 'Idle';
        if (state === 'off') stateLabel = 'Off';
        if (state === 'unavailable') stateLabel = 'Unavailable';

        // Media info
        const mediaTitle = device.media_title || '';
        const appName = device.app_name || '';
        const mediaArtist = device.media_artist || '';

        // Build media info display
        let mediaInfo = '';
        if (isActive && (mediaTitle || appName)) {
            mediaInfo = `
                <div class="media-info">
                    ${mediaTitle ? `<div class="media-title">${esc(mediaTitle)}</div>` : ''}
                    ${mediaArtist ? `<div class="media-artist">${esc(mediaArtist)}</div>` : ''}
                    ${appName ? `<div class="media-app">${esc(appName)}</div>` : ''}
                </div>
            `;
        } else if (isOn && !isActive) {
            mediaInfo = `
                <div class="media-info empty">
                    <div class="media-title">Nothing playing</div>
                </div>
            `;
        }

        return `
            <div class="device-card media-player-card ${disabledClass}" data-entity-id="${esc(entityId)}">
                <div class="device-header">
                    <span class="device-emoji">${esc(device.emoji || '📺')}</span>
                    <span class="device-name">${esc(device.name)}</span>
                </div>
                <div class="media-state">
                    <span class="media-state-badge ${esc(state)}">${esc(stateLabel)}</span>
                </div>
                ${mediaInfo}
                <div class="media-buttons">
                    <button
                        class="media-btn play ${isPlaying ? 'active' : ''}"
                        data-entity-id="${esc(entityId)}"
                        data-action="media_play"
                        ${!isEnabled || !isActive ? 'disabled' : ''}
                    >▶ Play</button>
                    <button
                        class="media-btn pause ${isPaused ? 'active' : ''}"
                        data-entity-id="${esc(entityId)}"
                        data-action="media_pause"
                        ${!isEnabled || !isActive ? 'disabled' : ''}
                    >⏸ Pause</button>
                </div>
                <button
                    class="device-btn media-power-btn ${isOn ? 'turn-off' : 'turn-on'}"
                    data-entity-id="${esc(entityId)}"
                    data-action="${isOn ? 'turn_off' : 'turn_on'}"
                    ${!isEnabled ? 'disabled' : ''}
                >${isOn ? 'Turn Off' : 'Turn On'}</button>
            </div>
        `;
    }

    /**
     * Render error state for devices
     */
    function renderDevicesError() {
        devicesGrid.innerHTML = `
            <div class="error-message">
                Unable to load devices. The command center may be offline.
            </div>
        `;
    }

    /**
     * Handle device control button click
     */
    async function handleDeviceControl(event) {
        const btn = event.currentTarget;
        const entityId = btn.dataset.entityId;
        const action = btn.dataset.action;

        if (!isEnabled) return;

        // Mark that WE are making an action (prevents Firebase refresh flicker)
        lastLocalActionTime = Date.now();

        // Optimistic UI update - instantly toggle the state
        const isMediaPlayer = entityId.startsWith('media_player.');
        if (isMediaPlayer) {
            // Media players go to 'idle' when turned on, 'off' when turned off
            updateMediaPlayerUI(entityId, action === 'turn_on' ? 'idle' : 'off');
        } else {
            const newState = action === 'turn_on' ? 'on' : 'off';
            updateDeviceUI(entityId, newState);
        }

        try {
            const response = await fetch(`${WORKER_URL}/api/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entity_id: entityId, action })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to control device');
            }

            // Success - trust the optimistic update, no need to refetch
            // The periodic refresh will sync state if needed
        } catch (error) {
            console.error('Failed to control device:', error);
            // Revert on error
            await fetchDevices();
            alert(error.message || 'Failed to control device. Please try again.');
        }
    }

    /**
     * Update device UI optimistically without full re-render
     */
    function updateDeviceUI(entityId, newState) {
        const card = document.querySelector(`.device-card[data-entity-id="${entityId}"]`);
        if (!card) return;

        const isOn = newState === 'on';
        const statusDot = card.querySelector('.status-dot');
        const statusText = card.querySelector('.status-text');
        const btn = card.querySelector('.device-btn');

        // Update status indicator
        statusDot.classList.toggle('on', isOn);
        statusDot.classList.toggle('off', !isOn);
        statusText.textContent = isOn ? 'ON' : 'OFF';

        // Update button
        btn.classList.toggle('turn-on', !isOn);
        btn.classList.toggle('turn-off', isOn);
        btn.dataset.action = isOn ? 'turn_off' : 'turn_on';
        btn.textContent = isOn ? 'Turn Off' : 'Turn On';

        // Update local state
        if (devices[entityId]) {
            devices[entityId].state = newState;
        }

        // Enable/disable extra controls based on state
        const colorPicker = card.querySelector('.color-picker');
        const fanButtons = card.querySelectorAll('.fan-btn');

        if (colorPicker) {
            colorPicker.disabled = !isOn || !isEnabled;
        }
        fanButtons.forEach(b => {
            b.disabled = !isOn || !isEnabled;
        });
    }

    /**
     * Update media player UI optimistically without full re-render
     */
    function updateMediaPlayerUI(entityId, newState) {
        const card = document.querySelector(`.media-player-card[data-entity-id="${entityId}"]`);
        if (!card) return;

        const isPlaying = newState === 'playing';
        const isPaused = newState === 'paused';
        const isOn = newState !== 'off' && newState !== 'unavailable';
        const isActive = isPlaying || isPaused;

        // Update state badge
        const badge = card.querySelector('.media-state-badge');
        if (badge) {
            badge.className = `media-state-badge ${newState}`;
            let label = newState.charAt(0).toUpperCase() + newState.slice(1);
            if (newState === 'standby') label = 'Standby';
            badge.textContent = label;
        }

        // Update play/pause button states
        const playBtn = card.querySelector('.media-btn.play');
        const pauseBtn = card.querySelector('.media-btn.pause');

        if (playBtn) {
            playBtn.classList.toggle('active', isPlaying);
            playBtn.disabled = !isEnabled || !isActive;
        }
        if (pauseBtn) {
            pauseBtn.classList.toggle('active', isPaused);
            pauseBtn.disabled = !isEnabled || !isActive;
        }

        // Update power button
        const powerBtn = card.querySelector('.media-power-btn');
        if (powerBtn) {
            powerBtn.className = `device-btn media-power-btn ${isOn ? 'turn-off' : 'turn-on'}`;
            powerBtn.dataset.action = isOn ? 'turn_off' : 'turn_on';
            powerBtn.textContent = isOn ? 'Turn Off' : 'Turn On';
        }

        // Update media info section
        const mediaInfo = card.querySelector('.media-info');
        if (mediaInfo) {
            if (!isOn) {
                mediaInfo.remove();
            } else if (!isActive && !mediaInfo.classList.contains('empty')) {
                mediaInfo.className = 'media-info empty';
                mediaInfo.innerHTML = '<div class="media-title">Nothing playing</div>';
            }
        }

        // Update local state
        if (devices[entityId]) {
            devices[entityId].state = newState;
        }
    }

    /**
     * Handle color picker change
     */
    async function handleColorChange(event) {
        const picker = event.currentTarget;
        const entityId = picker.dataset.entityId;
        const hexColor = picker.value;
        const rgbColor = hexToRgb(hexColor);

        if (!isEnabled) return;

        lastLocalActionTime = Date.now();
        picker.disabled = true;

        try {
            const response = await fetch(`${WORKER_URL}/api/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    entity_id: entityId,
                    action: 'turn_on',
                    rgb_color: rgbColor
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to set color');
            }

            // Refresh device states immediately
            await fetchDevices();
        } catch (error) {
            console.error('Failed to set color:', error);
            alert(error.message || 'Failed to set color. Please try again.');
        }

        picker.disabled = false;
    }

    /**
     * Handle color preset button click
     */
    async function handleColorPreset(event) {
        const btn = event.currentTarget;
        const entityId = btn.dataset.entityId;
        const rgbColor = btn.dataset.rgb.split(',').map(Number);

        if (!isEnabled) return;

        lastLocalActionTime = Date.now();

        // Disable all color presets for this device
        const presets = document.querySelectorAll(`.color-preset[data-entity-id="${entityId}"]`);
        presets.forEach(p => p.disabled = true);
        btn.classList.add('loading');

        // Optimistic UI update for current color swatch
        const card = document.querySelector(`.device-card[data-entity-id="${entityId}"]`);
        const currentSwatch = card?.querySelector('.current-color-swatch');
        if (currentSwatch) {
            currentSwatch.style.background = `rgb(${rgbColor.join(',')})`;
        }

        try {
            const response = await fetch(`${WORKER_URL}/api/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    entity_id: entityId,
                    action: 'turn_on',
                    rgb_color: rgbColor
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to set color');
            }
        } catch (error) {
            console.error('Failed to set color:', error);
            alert(error.message || 'Failed to set color. Please try again.');
        }

        btn.classList.remove('loading');
        presets.forEach(p => p.disabled = false);
    }

    /**
     * Handle fan speed button click
     */
    async function handleFanSpeed(event) {
        const btn = event.currentTarget;
        const entityId = btn.dataset.entityId;
        const speed = parseInt(btn.dataset.speed, 10);

        if (!isEnabled) return;

        lastLocalActionTime = Date.now();

        // Disable all fan buttons for this device
        const fanButtons = document.querySelectorAll(`.fan-btn[data-entity-id="${entityId}"]`);
        fanButtons.forEach(b => b.disabled = true);
        btn.classList.add('loading');

        try {
            const response = await fetch(`${WORKER_URL}/api/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    entity_id: entityId,
                    action: 'set_percentage',
                    percentage: speed
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to set fan speed');
            }

            // Refresh device states immediately
            await fetchDevices();
        } catch (error) {
            console.error('Failed to set fan speed:', error);
            alert(error.message || 'Failed to set fan speed. Please try again.');
        }

        btn.classList.remove('loading');
        fanButtons.forEach(b => b.disabled = false);
    }

    /**
     * Handle media player control button click (play/pause)
     */
    async function handleMediaControl(event) {
        const btn = event.currentTarget;
        const entityId = btn.dataset.entityId;
        const action = btn.dataset.action;

        if (!isEnabled) return;

        lastLocalActionTime = Date.now();

        // Optimistic UI update
        const newState = action === 'media_play' ? 'playing' : 'paused';
        updateMediaPlayerUI(entityId, newState);

        // Disable all media buttons for this device
        const mediaButtons = document.querySelectorAll(`.media-btn[data-entity-id="${entityId}"]`);
        mediaButtons.forEach(b => b.disabled = true);
        btn.classList.add('loading');

        try {
            const response = await fetch(`${WORKER_URL}/api/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    entity_id: entityId,
                    action: action
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to control media player');
            }

            // Don't fetch immediately - HA state lags behind
            // The optimistic update already shows correct state
            // Firebase listener will trigger eventual refresh
        } catch (error) {
            console.error('Failed to control media player:', error);
            alert(error.message || 'Failed to control media player. Please try again.');
        }

        btn.classList.remove('loading');
        mediaButtons.forEach(b => b.disabled = false);
    }

    /**
     * Listen for activity log updates from Firebase
     * Also triggers device state refresh when new actions are logged
     */
    function listenForActivityLog() {
        const logRef = db.ref('commandcenter/log').orderByChild('timestamp').limitToLast(10);

        // Listen for value changes to render the log
        logRef.on('value', (snapshot) => {
            const logs = snapshot.val();
            renderActivityLog(logs);

            // Track the latest timestamp for initial load
            if (logs) {
                Object.values(logs).forEach(log => {
                    if (log.timestamp > lastLogTimestamp) {
                        lastLogTimestamp = log.timestamp;
                    }
                });
            }
            isInitialLoad = false;
        }, (error) => {
            console.error('Failed to load activity log:', error);
            activityLog.innerHTML = '<li class="activity-placeholder">Couldn\'t load recent activity</li>';
        });

        // Listen specifically for new entries (more reliable than value for detecting additions)
        logRef.on('child_added', (snapshot) => {
            const log = snapshot.val();
            if (!log || !log.timestamp) return;

            // Skip if this is from initial load (timestamp not newer than what we've seen)
            if (log.timestamp <= lastLogTimestamp) return;

            // Skip if WE just made an action
            const timeSinceLocalAction = Date.now() - lastLocalActionTime;
            if (timeSinceLocalAction < LOCAL_ACTION_COOLDOWN) return;

            lastLogTimestamp = log.timestamp;

            // Immediately update UI based on the log action (don't wait for HA)
            if (log.entity_id && log.action) {
                const action = log.action.split(' ')[0]; // Handle "turn_on (color)" etc.
                const isMediaPlayer = log.entity_id.startsWith('media_player.');

                if (action === 'turn_on' || action === 'turn_off') {
                    const newState = action === 'turn_on' ? 'on' : 'off';
                    if (isMediaPlayer) {
                        // Media players go to 'idle' when turned on, 'off' when turned off
                        updateMediaPlayerUI(log.entity_id, action === 'turn_on' ? 'idle' : 'off');
                    } else {
                        updateDeviceUI(log.entity_id, newState);
                    }
                } else if (action === 'played' || action === 'paused') {
                    // Update media player state
                    updateMediaPlayerUI(log.entity_id, action === 'played' ? 'playing' : 'paused');
                }
            }

            // Also fetch from HA in background for eventual consistency (color, speed, etc.)
            clearTimeout(refreshDebounceTimer);
            refreshDebounceTimer = setTimeout(() => {
                fetchDevices();
            }, 2000);
        }, (error) => {
            console.error('Activity log listener cancelled:', error);
        });
    }

    /**
     * Render activity log
     */
    function renderActivityLog(logs) {
        if (!logs) {
            activityLog.innerHTML = '<li class="activity-placeholder">No recent activity</li>';
            return;
        }

        // Convert to array and sort by timestamp (newest first)
        const logArray = Object.values(logs).sort((a, b) => b.timestamp - a.timestamp);

        activityLog.innerHTML = logArray.map(log => {
            const timeAgo = getTimeAgo(log.timestamp);
            const action = log.action || '';

            // Determine action display
            let actionClass = 'action-on';
            let actionText = 'toggled';

            if (action.startsWith('turn_on')) {
                actionClass = 'action-on';
                if (action.includes('(color)')) {
                    actionText = 'changed color on';
                } else {
                    actionText = 'turned on';
                }
            } else if (action.startsWith('turn_off')) {
                actionClass = 'action-off';
                actionText = 'turned off';
            } else if (action.startsWith('set_percentage')) {
                actionClass = 'action-on';
                const match = action.match(/\((\d+)%\)/);
                if (match) {
                    const pct = parseInt(match[1]);
                    if (pct <= 33) actionText = 'set to Low';
                    else if (pct <= 66) actionText = 'set to Medium';
                    else actionText = 'set to High';
                } else {
                    actionText = 'changed speed on';
                }
            } else if (action === 'played') {
                actionClass = 'action-on';
                actionText = 'played';
            } else if (action === 'paused') {
                actionClass = 'action-off';
                actionText = 'paused';
            }

            return `
                <li>
                    <span class="activity-action">
                        <span class="${actionClass}">Someone ${actionText}</span>
                        <strong>${esc(log.deviceName || log.entity_id)}</strong>
                    </span>
                    <span class="activity-time">${timeAgo}</span>
                </li>
            `;
        }).join('');
    }

    /**
     * Get human-readable time ago string
     */
    function getTimeAgo(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        return `${days}d ago`;
    }

    /**
     * Periodically refresh device states
     */
    function startStateRefresh() {
        // Refresh every 30 seconds — but not for hidden tabs, which used to
        // poll the worker (and HA behind it) indefinitely. Refresh
        // immediately on return so the state isn't stale. (PERF-3)
        setInterval(() => {
            if (!document.hidden) fetchDevices();
        }, 30000);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) fetchDevices();
        });
    }

    /**
     * Initialize the command center
     */
    function init() {
        initFirebase();
        listenForEnabledState();
        listenForActivityLog();
        fetchDevices();
        startStateRefresh();
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
