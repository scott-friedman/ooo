/**
 * LitterRobot Dashboard
 * Fetches data from Firebase and displays live status + historical charts
 * Features: milestones, dynamic taglines, fun stats, animations
 */

(function() {
    'use strict';

    const FIREBASE_CONFIG = getFirebaseConfig('main');  // js/firebase-config.js, loaded first on every page

    // Data validation bounds
    const VALIDATION = {
        visits: { min: 0, max: 50 },
        cycles: { min: 0, max: 50 },
        weight: { min: 4, max: 25 }
    };

    // Milestones system
    const MILESTONES = {
        visits: [
            { threshold: 100, emoji: '🎉', title: '100 Club', description: 'First 100 visits!' },
            { threshold: 500, emoji: '⭐', title: 'Regular', description: '500 visits achieved' },
            { threshold: 1000, emoji: '🏆', title: 'Throne Master', description: '1,000 visits!' },
            { threshold: 5000, emoji: '👑', title: 'Royalty', description: '5,000 visits!' }
        ],
        streaks: [
            { threshold: 7, emoji: '🔥', title: 'Week Warrior', description: '7 day streak' },
            { threshold: 30, emoji: '💪', title: 'Monthly Master', description: '30 day streak' },
            { threshold: 100, emoji: '💯', title: 'Century', description: '100 day streak!' }
        ]
    };

    // Dynamic taglines
    const TAGLINES = {
        justVisited: [
            "Just visited the facilities",
            "Bathroom break champion",
            "Fresh from the throne"
        ],
        busy: [
            "Having a busy day!",
            "Very regular today",
            "Keeping the throne warm"
        ],
        idle: [
            "Napping somewhere cozy",
            "Plotting world domination",
            "Practicing their meow"
        ],
        healthy: [
            "Healthy and thriving",
            "Living their best life",
            "Purr-fectly content"
        ]
    };

    // Chart instances
    let activityChart = null;
    let weightChart = null;

    // Store history data globally for re-rendering
    let historyData = {};
    let currentData = null;

    // Current time periods for each chart
    const chartPeriods = {
        activity: 14,
        weight: 14
    };

    // Refresh countdown
    let refreshCountdown = 300; // 5 minutes in seconds
    let countdownInterval = null;

    // Chart.js default styling - cat-themed warm palette
    const chartColors = {
        visits: '#7eb07c',
        visitsLight: 'rgba(126, 176, 124, 0.2)',
        cycles: '#e07a5f',
        cyclesLight: 'rgba(224, 122, 95, 0.2)',
        weight: '#d4a847',
        weightLight: 'rgba(212, 168, 71, 0.2)',
        average: '#81b1c9',
        gray: '#666',
        gridColor: 'rgba(0, 0, 0, 0.06)'
    };

    // Initialize Firebase
    function initFirebase() {
        if (!firebase.apps.length) {
            firebase.initializeApp(FIREBASE_CONFIG);
        }
        return firebase.database();
    }

    // Data validation
    function validateMetric(value, type) {
        if (typeof value !== 'number' || isNaN(value)) return null;
        const bounds = VALIDATION[type];
        if (!bounds) return value;
        if (value < bounds.min || value > bounds.max) {
            console.warn(`Invalid ${type}: ${value}`);
            return null;
        }
        return value;
    }

    // Status code to human-readable text mapping
    const STATUS_MAP = {
        'rdy': 'Ready',
        'ccp': 'Cycle Complete',
        'ccc': 'Cleaning',
        'csf': 'Cat Sensor Fault',
        'df1': 'Drawer Almost Full',
        'df2': 'Drawer Full',
        'dfs': 'Drawer Full',
        'sdf': 'Drawer Full',
        'dhf': 'Dump + Home Fault',
        'dpf': 'Dump Position Fault',
        'ec':  'Empty Cycle',
        'hpf': 'Home Position Fault',
        'off': 'Off',
        'offline': 'Offline',
        'otf': 'Over Torque Fault',
        'p':   'Paused',
        'pause': 'Paused',
        'pd':  'Pinch Detect',
        'spf': 'Sensor Position Fault',
        'br':  'Bonnet Removed',
        'csi': 'Cat Sensor Interrupted',
        'cst': 'Cat Sensor Timing',
        'cd':  'Cat Detected',
        'ready': 'Ready',
        'clean cycle': 'Cleaning',
        'cycling': 'Cleaning',
        'drawer full': 'Drawer Full',
        'idle': 'Ready',
        'unknown': 'Unknown',
        'unavailable': 'Offline'
    };

    function getReadableStatus(statusCode) {
        if (!statusCode) return 'Unknown';
        const lower = statusCode.toLowerCase().trim();
        return STATUS_MAP[lower] || statusCode;
    }

    function timeAgo(timestamp) {
        if (!timestamp) return '--';
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

    function formatDate(dateStr, period) {
        const [year, month, day] = dateStr.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        if (period === 'all' || period >= 365) {
            return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        } else if (period >= 30) {
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    // Get dynamic tagline based on activity
    function getDynamicTagline() {
        if (!currentData) return TAGLINES.healthy[0];

        const now = Date.now();
        const updatedAt = currentData.updatedAt || 0;
        const minutesSinceUpdate = (now - updatedAt) / 60000;
        const status = (currentData.status || '').toLowerCase();

        // Just visited (within last 10 minutes and was cat-related state)
        if (minutesSinceUpdate < 10 && (status === 'cd' || status === 'cst' || status === 'ccc')) {
            return TAGLINES.justVisited[Math.floor(Math.random() * TAGLINES.justVisited.length)];
        }

        // Busy day (more than average visits today)
        const todayVisits = currentData.todayVisits || 0;
        if (todayVisits >= 5) {
            return TAGLINES.busy[Math.floor(Math.random() * TAGLINES.busy.length)];
        }

        // Idle (long time since activity)
        if (minutesSinceUpdate > 120) {
            return TAGLINES.idle[Math.floor(Math.random() * TAGLINES.idle.length)];
        }

        // Default: healthy
        return TAGLINES.healthy[Math.floor(Math.random() * TAGLINES.healthy.length)];
    }

    // Update dynamic tagline
    function updateTagline() {
        const taglineEl = document.getElementById('dynamic-tagline');
        if (taglineEl) {
            taglineEl.textContent = getDynamicTagline();
        }
    }

    // Random Tot facts for when there's no interesting data-driven fact
    const RANDOM_TOT_FACTS = [
        { value: "100%", label: "Chance Tot is judging you right now" },
        { value: "∞", label: "Amount of treats Tot deserves" },
        { value: "3am", label: "Tot's favorite time to zoom" },
        { value: "0", label: "Tasks Tot completed today" },
        { value: "24/7", label: "Tot's napping schedule" },
        { value: "Yes", label: "Tot thinks they're the boss" },
        { value: "???", label: "What Tot is plotting" },
        { value: "10/10", label: "Tot's self-rated cuteness" },
        { value: "1", label: "Brain cells (shared with all cats)" },
        { value: "∞", label: "Tot's ego size" },
        { value: "5pm", label: "Tot's dinner reminder time" },
        { value: "No", label: "Will Tot come when called" },
        { value: "Warm", label: "Tot's favorite laptop spot" },
        { value: "4am", label: "Optimal time to knock things off shelves" }
    ];

    // Calculate comprehensive stats from history data
    function calculateAllStats() {
        const dates = Object.keys(historyData).sort();
        if (dates.length === 0) return null;

        let totalVisits = 0;
        let totalCycles = 0;
        let maxVisitsDay = { date: null, count: 0 };
        let minVisitsDay = { date: null, count: Infinity };
        let currentStreak = 0;
        let longestStreak = 0;
        let tempStreak = 0;
        let perfectDays = 0; // days where visits == cycles
        let lazyDays = 0; // days with 0-2 visits
        let busyDays = 0; // days with 6+ visits
        let weights = [];
        let weekdayVisits = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat
        let weekdayCounts = [0, 0, 0, 0, 0, 0, 0];

        const today = new Date().toISOString().split('T')[0];
        const sortedDates = [...dates].sort();

        sortedDates.forEach((date, index) => {
            const dayData = historyData[date];
            const visits = typeof dayData?.visits === 'number' ? dayData.visits : 0;
            const cycles = typeof dayData?.cycles === 'number' ? dayData.cycles : 0;

            totalVisits += visits;
            totalCycles += cycles;

            // Track max/min days
            if (visits > maxVisitsDay.count) {
                maxVisitsDay = { date, count: visits };
            }
            if (visits < minVisitsDay.count && visits > 0) {
                minVisitsDay = { date, count: visits };
            }

            // Track day types
            if (visits === cycles && visits > 0) perfectDays++;
            if (visits <= 2) lazyDays++;
            if (visits >= 6) busyDays++;

            // Track weights
            if (dayData?.avgWeight) weights.push(dayData.avgWeight);
            if (dayData?.weights) {
                Object.values(dayData.weights).forEach(w => {
                    if (typeof w === 'number' && w > 4 && w < 25) weights.push(w);
                });
            }

            // Track weekday distribution
            const dayOfWeek = new Date(date).getDay();
            weekdayVisits[dayOfWeek] += visits;
            weekdayCounts[dayOfWeek]++;

            // Calculate streaks
            if (visits > 0) {
                tempStreak++;
                longestStreak = Math.max(longestStreak, tempStreak);
            } else {
                tempStreak = 0;
            }
        });

        // Calculate current streak (from most recent backwards)
        let counting = true;
        [...sortedDates].reverse().forEach((date, index) => {
            if (!counting) return;
            const visits = historyData[date]?.visits || 0;
            if (visits > 0) {
                if (index === 0) {
                    const diffDays = Math.floor((new Date(today) - new Date(date)) / 86400000);
                    if (diffDays <= 1) currentStreak++;
                    else counting = false;
                } else {
                    currentStreak++;
                }
            } else {
                counting = false;
            }
        });

        // Find busiest weekday
        const avgByWeekday = weekdayVisits.map((v, i) => weekdayCounts[i] > 0 ? v / weekdayCounts[i] : 0);
        const busiestWeekday = avgByWeekday.indexOf(Math.max(...avgByWeekday));
        const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        // Weight stats
        const avgWeight = weights.length > 0 ? weights.reduce((a, b) => a + b, 0) / weights.length : null;
        const minWeight = weights.length > 0 ? Math.min(...weights) : null;
        const maxWeight = weights.length > 0 ? Math.max(...weights) : null;

        return {
            totalVisits,
            totalCycles,
            daysTracked: dates.length,
            avgDaily: (totalVisits / dates.length).toFixed(1),
            currentStreak,
            longestStreak,
            maxVisitsDay,
            minVisitsDay,
            perfectDays,
            lazyDays,
            busyDays,
            busiestWeekday: weekdayNames[busiestWeekday],
            avgByWeekday,
            avgWeight,
            minWeight,
            maxWeight,
            cycleEfficiency: totalVisits > 0 ? ((totalCycles / totalVisits) * 100).toFixed(0) : 0
        };
    }

    // Generate creative baseball-style fun facts - randomly cycled
    function generateFunFacts(stats) {
        if (!stats) return Array(4).fill(null).map(() => getRandomTotFact());

        // Use current date + hour as seed for daily rotation that changes throughout day
        const now = new Date();
        const seed = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate() + Math.floor(now.getHours() / 6);

        const allFacts = [
            // Volume facts
            { value: stats.totalVisits.toLocaleString(), label: "Career visits" },
            { value: `${stats.avgDaily}`, label: "Visits per day (VPD)" },
            { value: `${stats.maxVisitsDay.count}`, label: `Single-day record (${formatShortDate(stats.maxVisitsDay.date)})` },
            { value: stats.totalCycles.toLocaleString(), label: "Total clean cycles" },

            // Efficiency facts
            { value: `${stats.cycleEfficiency}%`, label: "Clean cycle rate" },
            { value: `${stats.perfectDays}`, label: "Perfect days (visits = cycles)" },

            // Day type facts
            { value: `${stats.busyDays}`, label: "Busy days (6+ visits)" },
            { value: `${stats.lazyDays}`, label: "Light days (0-2 visits)" },

            // Pattern facts
            { value: stats.busiestWeekday.slice(0, 3), label: "Favorite day of the week" },

            // Weight facts (if available)
            ...(stats.avgWeight ? [
                { value: `${stats.avgWeight.toFixed(1)}`, label: "Average weight (lbs)" },
                { value: `${stats.minWeight.toFixed(1)}`, label: "Lightest weigh-in (lbs)" },
                { value: `${stats.maxWeight.toFixed(1)}`, label: "Heaviest weigh-in (lbs)" }
            ] : []),

            // Calculated/derived facts
            { value: `${Math.round(stats.totalVisits / stats.daysTracked * 7)}`, label: "Weekly visit pace" },
            { value: `${stats.daysTracked}`, label: "Days tracked" },
            { value: `~${Math.round(stats.totalVisits * 0.5)}`, label: "Est. scoops cleaned" },
            { value: `${Math.round(stats.totalCycles / stats.daysTracked * 30)}`, label: "Monthly cycle pace" },
            { value: `${(stats.totalVisits / stats.totalCycles).toFixed(1)}`, label: "Visits per cycle ratio" }
        ];

        // Seeded shuffle function
        function seededShuffle(array, s) {
            const shuffled = [...array];
            for (let i = shuffled.length - 1; i > 0; i--) {
                s = (s * 9301 + 49297) % 233280;
                const j = Math.floor((s / 233280) * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            return shuffled;
        }

        // Shuffle and pick facts
        const shuffled = seededShuffle(allFacts, seed);
        const selectedFacts = shuffled.slice(0, 3);

        // Always include one random Tot fact
        selectedFacts.push(getRandomTotFact());

        return selectedFacts;
    }

    function formatShortDate(dateStr) {
        if (!dateStr) return '';
        const [year, month, day] = dateStr.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    function getRandomTotFact() {
        // Use date as seed for daily consistency
        const today = new Date().toISOString().split('T')[0];
        const seed = today.split('-').reduce((a, b) => a + parseInt(b), 0);
        const index = seed % RANDOM_TOT_FACTS.length;
        return RANDOM_TOT_FACTS[index];
    }

    // Get earned milestones
    function getEarnedMilestones(stats) {
        if (!stats) return [];
        const earned = [];

        // Visit milestones
        MILESTONES.visits.forEach(milestone => {
            if (stats.totalVisits >= milestone.threshold) {
                earned.push({ ...milestone, type: 'visits' });
            }
        });

        // Streak milestones
        MILESTONES.streaks.forEach(milestone => {
            if (stats.currentStreak >= milestone.threshold) {
                earned.push({ ...milestone, type: 'streak' });
            }
        });

        return earned;
    }

    // Update fun facts display
    function updateFunFacts() {
        const stats = calculateAllStats();
        const facts = generateFunFacts(stats);

        facts.forEach((fact, i) => {
            const card = document.getElementById(`fun-fact-${i + 1}`);
            if (card && fact) {
                const valueEl = card.querySelector('.fact-value');
                const labelEl = card.querySelector('.fact-label');
                if (valueEl) valueEl.textContent = fact.value;
                if (labelEl) labelEl.textContent = fact.label;
            }
        });

        // Update milestones
        if (stats) updateMilestones(stats);
    }

    // Update milestones display with descriptors
    function updateMilestones(stats) {
        const container = document.getElementById('milestones-container');
        if (!container) return;

        const earned = getEarnedMilestones(stats);

        if (earned.length === 0) {
            container.innerHTML = '<p class="no-milestones">Keep visiting to earn badges!</p>';
            return;
        }

        container.innerHTML = earned.map(m => `
            <div class="milestone-badge">
                <span class="milestone-emoji">${m.emoji}</span>
                <span class="milestone-info">
                    <span class="milestone-title">${m.title}</span>
                    <span class="milestone-desc">${m.description}</span>
                </span>
            </div>
        `).join('');
    }

    function updateCurrentStatus(data) {
        if (!data) return;
        currentData = data;

        // Hide loading skeleton
        document.querySelectorAll('.skeleton').forEach(el => el.classList.remove('skeleton'));

        // Update status badge
        const statusBadge = document.getElementById('status-badge');
        const statusDot = document.getElementById('status-dot');
        const rawStatus = data.status || 'Unknown';
        const readableStatus = getReadableStatus(rawStatus);
        statusBadge.textContent = readableStatus;
        const statusClass = getStatusClass(readableStatus.toLowerCase());
        statusBadge.className = 'status-badge ' + statusClass;

        // Update status dot
        if (statusDot) {
            statusDot.className = 'status-dot ' + statusClass;
        }

        const lastUpdated = document.getElementById('last-updated');
        // Handle Unix timestamp in seconds or milliseconds
        let updatedTimestamp = data.updatedAt;
        if (typeof updatedTimestamp === 'number' && updatedTimestamp < 1e12) {
            updatedTimestamp = updatedTimestamp * 1000; // Convert seconds to ms
        }
        lastUpdated.textContent = timeAgo(updatedTimestamp);

        const wastePercent = data.wasteLevel || 0;
        const wasteFill = document.getElementById('waste-fill');
        const wasteText = document.getElementById('waste-percent');
        wasteFill.style.width = wastePercent + '%';
        wasteFill.className = 'progress-fill' + getWasteClass(wastePercent);
        wasteText.textContent = wastePercent + '%';

        const lastCycle = document.getElementById('last-cycle');
        if (data.lastCycle) {
            // Handle both Unix timestamp (seconds or ms) and date string formats
            let timestamp;
            if (typeof data.lastCycle === 'number') {
                // Unix timestamp - check if seconds or milliseconds
                timestamp = data.lastCycle < 1e12 ? data.lastCycle * 1000 : data.lastCycle;
            } else {
                // Date string - normalize "YYYY-MM-DD HH:MM:SS" to ISO format
                const normalized = data.lastCycle.replace(' ', 'T');
                timestamp = new Date(normalized).getTime();
            }
            if (!isNaN(timestamp) && timestamp > 0) {
                lastCycle.textContent = timeAgo(timestamp);
            } else {
                lastCycle.textContent = '--';
            }
        } else {
            lastCycle.textContent = '--';
        }

        const lastWeight = document.getElementById('last-weight');
        if (data.lastWeight) {
            const validWeight = validateMetric(data.lastWeight, 'weight');
            lastWeight.textContent = validWeight ? validWeight.toFixed(1) + ' lbs' : '-- lbs';
        } else {
            lastWeight.textContent = '-- lbs';
        }

        const todayVisits = document.getElementById('today-visits');
        if (todayVisits) {
            todayVisits.textContent = data.todayVisits || 0;
        }

        const todayCycles = document.getElementById('today-cycles');
        if (todayCycles) {
            todayCycles.textContent = data.todayCycles || 0;
        }

        // Update litter level if available
        const litterLevel = document.getElementById('litter-level');
        if (litterLevel && data.litterLevel !== undefined) {
            litterLevel.textContent = data.litterLevel + '%';
        }

        // Update tagline
        updateTagline();
    }

    function getStatusClass(status) {
        if (status.includes('cleaning') || status.includes('cycle')) return 'cycling';
        if (status.includes('ready') || status.includes('idle')) return 'ready';
        if (status.includes('full') || status.includes('drawer')) return 'drawer-full';
        if (status.includes('offline') || status.includes('unavailable')) return 'offline';
        if (status.includes('cat')) return 'cat-detected';
        if (status.includes('error') || status.includes('fault')) return 'error';
        return 'ready';
    }

    function getWasteClass(percent) {
        if (percent >= 80) return ' danger';
        if (percent >= 60) return ' warning';
        return '';
    }

    // Get common chart options with enhanced tooltips
    function getChartOptions(period, chartType) {
        const maxTicks = period === 'all' || period >= 365 ? 12 : (period >= 30 ? 10 : 7);
        return {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: {
                    display: chartType === 'activity',
                    position: 'top',
                    labels: {
                        boxWidth: 10,
                        padding: 12,
                        font: { size: 10 },
                        usePointStyle: true
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(45, 41, 38, 0.95)',
                    titleFont: { size: 13, weight: '600' },
                    bodyFont: { size: 12 },
                    padding: 12,
                    cornerRadius: 8,
                    displayColors: chartType === 'activity',
                    callbacks: {
                        label: (context) => {
                            const value = context.parsed.y;
                            const label = context.dataset.label;
                            if (chartType === 'weight') return `${value.toFixed(1)} lbs`;
                            if (label === 'Visits') return `${value} visit${value !== 1 ? 's' : ''}`;
                            if (label === 'Cycles') return `${value} cycle${value !== 1 ? 's' : ''}`;
                            return `${value}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        maxTicksLimit: 5,
                        font: { size: 10 },
                        color: chartColors.gray
                    },
                    grid: { color: chartColors.gridColor }
                },
                x: {
                    ticks: {
                        maxTicksLimit: maxTicks,
                        font: { size: 9 },
                        color: chartColors.gray
                    },
                    grid: { display: false }
                }
            },
            elements: {
                point: {
                    radius: period >= 30 ? 1 : 3,
                    hoverRadius: 5
                },
                line: {
                    tension: 0.3
                },
                bar: {
                    borderRadius: 4
                }
            }
        };
    }

    // Get date range based on period
    function getDateRange(period) {
        const today = new Date();
        const dates = [];

        if (period === 'all') {
            return Object.keys(historyData).sort();
        }

        for (let i = period - 1; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            dates.push(date.toISOString().split('T')[0]);
        }
        return dates;
    }

    // Calculate average for trend line
    function calculateAverage(data) {
        const validData = data.filter(v => typeof v === 'number' && !isNaN(v));
        if (validData.length === 0) return 0;
        return validData.reduce((a, b) => a + b, 0) / validData.length;
    }

    // Initialize/update combined activity chart (visits + cycles)
    function updateActivityChart(period) {
        const ctx = document.getElementById('activity-chart');
        if (!ctx) return;

        const dates = getDateRange(period);
        const labels = dates.map(d => formatDate(d, period));

        const visitsData = dates.map(d => {
            const v = historyData[d]?.visits;
            return validateMetric(typeof v === 'number' ? v : 0, 'visits') ?? 0;
        });

        const cyclesData = dates.map(d => {
            const c = historyData[d]?.cycles;
            return validateMetric(typeof c === 'number' ? c : 0, 'cycles') ?? 0;
        });

        const useBar = period !== 'all' && period <= 30;

        const datasets = [
            {
                label: 'Visits',
                data: visitsData,
                backgroundColor: useBar ? chartColors.visits : chartColors.visitsLight,
                borderColor: chartColors.visits,
                borderWidth: useBar ? 0 : 2,
                fill: !useBar,
                tension: 0.3
            },
            {
                label: 'Cycles',
                data: cyclesData,
                backgroundColor: useBar ? chartColors.cycles : chartColors.cyclesLight,
                borderColor: chartColors.cycles,
                borderWidth: useBar ? 0 : 2,
                fill: !useBar,
                tension: 0.3
            }
        ];

        if (activityChart) {
            activityChart.config.type = useBar ? 'bar' : 'line';
            activityChart.data.labels = labels;
            activityChart.data.datasets = datasets;
            activityChart.options = getChartOptions(period, 'activity');
            activityChart.update();
            return;
        }

        activityChart = new Chart(ctx, {
            type: useBar ? 'bar' : 'line',
            data: { labels, datasets },
            options: getChartOptions(period, 'activity')
        });
    }

    // Initialize/update weight chart
    function updateWeightChart(period) {
        const ctx = document.getElementById('weight-chart');
        if (!ctx) return;

        const dates = getDateRange(period);
        const weights = [];
        const labels = [];

        dates.forEach(dateKey => {
            const dayData = historyData[dateKey];
            if (dayData) {
                if (dayData.weights && typeof dayData.weights === 'object') {
                    // Handle Firebase object format (converted from array)
                    const weightValues = Object.values(dayData.weights);
                    weightValues.forEach(w => {
                        const validWeight = validateMetric(w, 'weight');
                        if (validWeight !== null) {
                            weights.push(validWeight);
                            labels.push(formatDate(dateKey, period));
                        }
                    });
                } else if (dayData.avgWeight) {
                    const validWeight = validateMetric(dayData.avgWeight, 'weight');
                    if (validWeight !== null) {
                        weights.push(validWeight);
                        labels.push(formatDate(dateKey, period));
                    }
                }
            }
        });

        if (weights.length === 0) {
            // Show empty state
            if (weightChart) {
                weightChart.data.labels = [];
                weightChart.data.datasets[0].data = [];
                weightChart.update();
            }
            return;
        }

        const average = calculateAverage(weights);
        const avgLine = new Array(weights.length).fill(average);

        const options = getChartOptions(period, 'weight');
        options.scales.y.ticks.callback = (value) => value.toFixed(1);

        const datasets = [{
            label: 'Weight (lbs)',
            data: weights,
            backgroundColor: chartColors.weightLight,
            borderColor: chartColors.weight,
            borderWidth: 2,
            fill: true,
            tension: 0.3
        }];

        if (weights.length > 7) {
            datasets.push({
                label: 'Average',
                data: avgLine,
                borderColor: chartColors.average,
                borderWidth: 1,
                borderDash: [5, 5],
                fill: false,
                pointRadius: 0,
                tension: 0
            });
        }

        if (weightChart) {
            weightChart.data.labels = labels;
            weightChart.data.datasets = datasets;
            weightChart.options = options;
            weightChart.update();
            return;
        }

        weightChart = new Chart(ctx, {
            type: 'line',
            data: { labels, datasets },
            options: options
        });
    }

    // Handle toggle button clicks
    function setupToggleListeners() {
        document.querySelectorAll('.chart-toggles').forEach(toggleGroup => {
            const chartType = toggleGroup.dataset.chart;

            toggleGroup.querySelectorAll('.toggle-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    toggleGroup.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');

                    const days = btn.dataset.days;
                    const period = days === 'all' ? 'all' : parseInt(days);
                    chartPeriods[chartType] = period;

                    if (chartType === 'activity') {
                        updateActivityChart(period);
                    } else if (chartType === 'weight') {
                        updateWeightChart(period);
                    }
                });
            });
        });
    }

    // Show error banner
    function showError(message) {
        const banner = document.getElementById('error-banner');
        const errorMsg = document.getElementById('error-message');
        if (banner && errorMsg) {
            errorMsg.textContent = message;
            banner.hidden = false;
        }
    }

    // Hide error banner
    function hideError() {
        const banner = document.getElementById('error-banner');
        if (banner) {
            banner.hidden = true;
        }
    }

    // Retry connection
    window.retryConnection = function() {
        hideError();
        loadData();
    };

    // Update refresh countdown
    function updateCountdown() {
        const countdownEl = document.getElementById('countdown');
        if (!countdownEl) return;

        refreshCountdown--;
        if (refreshCountdown <= 0) {
            refreshCountdown = 300;
            refreshData();
        }

        const minutes = Math.floor(refreshCountdown / 60);
        const seconds = refreshCountdown % 60;
        countdownEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    // Refresh data from Firebase
    // History has one entry per day forever; 400 covers the 1y chart with
    // headroom. Once the dataset outgrows it, "All" means "last 400 days".
    // Keys are YYYY-MM-DD, so orderByKey is chronological. (PERF-2)
    const HISTORY_LIMIT = 400;

    function refreshData() {
        const db = initFirebase();
        db.ref('litterrobot/history').orderByKey().limitToLast(HISTORY_LIMIT).once('value').then((snapshot) => {
            historyData = snapshot.val() || {};
            updateActivityChart(chartPeriods.activity);
            updateWeightChart(chartPeriods.weight);
            updateFunFacts();
            hideError();
        }).catch(err => {
            console.error('Error refreshing history:', err);
            showError('Unable to refresh data');
        });
    }

    function loadData() {
        const db = initFirebase();

        db.ref('litterrobot/current').once('value').then((snapshot) => {
            const data = snapshot.val();
            updateCurrentStatus(data);
            hideError();
        }).catch(err => {
            console.error('Error fetching current status:', err);
            showError('Unable to connect to database');
        });

        db.ref('litterrobot/history').orderByKey().limitToLast(HISTORY_LIMIT).once('value').then((snapshot) => {
            historyData = snapshot.val() || {};
            updateActivityChart(chartPeriods.activity);
            updateWeightChart(chartPeriods.weight);
            updateFunFacts();
        }).catch(err => {
            console.error('Error fetching history:', err);
        });
    }

    function setupRealtimeUpdates() {
        const db = initFirebase();

        db.ref('litterrobot/current').on('value', (snapshot) => {
            const data = snapshot.val();
            if (data) {
                updateCurrentStatus(data);
                hideError();
            }
        });
    }

    function init() {
        setupToggleListeners();
        loadData();
        setupRealtimeUpdates();

        // Start countdown timer
        countdownInterval = setInterval(updateCountdown, 1000);

        // Update tagline periodically
        setInterval(updateTagline, 60000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
