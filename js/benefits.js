/**
 * Benefits of Everything
 * Find positive aspects of anything using AI
 */

(function() {
    'use strict';

    // Configuration
    const WORKER_URL = 'https://benefits-api.s-friedman.workers.dev';
    const HISTORY_LIMIT = 20;

    const FIREBASE_CONFIG = getFirebaseConfig('main');  // js/firebase-config.js, loaded first on every page

    // DOM elements
    const queryInput = document.getElementById('query-input');
    const analyzeBtn = document.getElementById('analyze-btn');
    const loadingSection = document.getElementById('loading');
    const errorSection = document.getElementById('error');
    const errorMessage = document.getElementById('error-message');
    const retryBtn = document.getElementById('retry-btn');
    const resultsSection = document.getElementById('results');
    const resultQuery = document.getElementById('result-query');
    const benefitsList = document.getElementById('benefits-list');
    const tipsList = document.getElementById('tips-list');
    const historyList = document.getElementById('history-list');
    const historyEmpty = document.getElementById('history-empty');
    const shareLink = document.getElementById('share-link');
    const tellMoreBtn = document.getElementById('tell-more-btn');
    const reallyBtn = document.getElementById('really-btn');
    const reallyExpansion = document.getElementById('really-expansion');

    // State
    let db = null;
    let historyRef = null;
    let cacheRef = null;
    let lastQuery = '';
    let historyData = {};
    let currentBenefits = [];
    let selectedBenefitIndex = -1;
    let isLoadingMore = false;
    let isLoadingReally = false;
    let expansionCache = {}; // Cache for benefit expansions keyed by "query::benefit"

    /**
     * Initialize Firebase
     */
    function initFirebase() {
        if (!firebase.apps.length) {
            firebase.initializeApp(FIREBASE_CONFIG);
        }
        db = firebase.database();
        historyRef = db.ref('benefits/history');
        cacheRef = db.ref('benefits/cache');

        // Listen for history changes (real-time)
        historyRef.orderByChild('timestamp').limitToLast(HISTORY_LIMIT).on('value', (snapshot) => {
            historyData = snapshot.val() || {};
            renderHistory();
        });
    }

    /**
     * Show a specific section, hide others
     */
    function showSection(section) {
        [loadingSection, errorSection, resultsSection].forEach(s => {
            s.classList.add('hidden');
        });
        if (section) {
            section.classList.remove('hidden');
        }
    }

    /**
     * Normalize query for comparison
     */
    function normalizeQuery(query) {
        return query.toLowerCase().trim().replace(/\s+/g, ' ');
    }

    /**
     * Generate Firebase-safe key from query
     */
    function queryToKey(query) {
        return normalizeQuery(query)
            .replace(/[.#$\[\]\/]/g, '_')
            .replace(/\s/g, '_')
            .substring(0, 100);
    }

    /**
     * Check local cache first, then Firebase cache
     */
    async function checkCache(normalizedQuery) {
        const cacheKey = queryToKey(normalizedQuery);
        try {
            const snapshot = await cacheRef.child(cacheKey).once('value');
            return snapshot.val();
        } catch (error) {
            console.error('Cache check error:', error);
            return null;
        }
    }

    /**
     * Save to history (only for new searches from input, not history clicks)
     */
    async function saveToHistory(query, normalizedQuery) {
        // Check if this query already exists in history
        const existingKey = Object.keys(historyData).find(key => {
            return historyData[key].normalizedQuery === normalizedQuery;
        });

        if (existingKey) {
            // Update timestamp to move to top, increment view count
            await historyRef.child(existingKey).update({
                timestamp: Date.now(),
                viewCount: (historyData[existingKey].viewCount || 1) + 1
            });
        } else {
            // Add new entry
            await historyRef.push({
                query: query,
                normalizedQuery: normalizedQuery,
                timestamp: Date.now(),
                viewCount: 1
            });
        }
    }

    /**
     * Increment view count for a history item (without updating timestamp)
     */
    async function incrementViewCount(key) {
        const current = historyData[key];
        if (current) {
            await historyRef.child(key).update({
                viewCount: (current.viewCount || 1) + 1
            });
        }
    }

    /**
     * Update URL with query parameter
     */
    function updateURL(query) {
        const url = new URL(window.location);
        url.searchParams.set('q', query);
        window.history.replaceState({}, '', url);
    }

    /**
     * Get query from URL
     */
    function getQueryFromURL() {
        const url = new URL(window.location);
        return url.searchParams.get('q');
    }

    /**
     * Copy share link to clipboard
     */
    async function copyShareLink() {
        const url = window.location.href;
        try {
            await navigator.clipboard.writeText(url);
            shareLink.textContent = 'COPIED!';
            setTimeout(() => {
                shareLink.textContent = 'SHARE LINK';
            }, 2000);
        } catch (error) {
            // Fallback for older browsers
            const input = document.createElement('input');
            input.value = url;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            shareLink.textContent = 'COPIED!';
            setTimeout(() => {
                shareLink.textContent = 'SHARE LINK';
            }, 2000);
        }
    }

    /**
     * Fetch benefits from the API (for new searches)
     */
    async function fetchBenefits(query, fromHistory = false) {
        showSection(loadingSection);
        const normalizedQuery = normalizeQuery(query);

        try {
            // Check Firebase cache first
            const cached = await checkCache(normalizedQuery);
            if (cached && cached.benefits && cached.usageTips) {
                renderResults({
                    benefits: cached.benefits,
                    usageTips: cached.usageTips,
                    query: query,
                    cached: true
                });
                // Only save to history if this is a new search (not from clicking history)
                if (!fromHistory) {
                    await saveToHistory(query, normalizedQuery);
                }
                updateURL(query);
                return;
            }

            // Call the API
            const response = await fetch(`${WORKER_URL}/api/benefits`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to fetch benefits');
            }

            renderResults(data);
            updateURL(query);

            // Only save to history if this is a new search
            if (!fromHistory) {
                await saveToHistory(query, normalizedQuery);
            }

        } catch (error) {
            console.error('Error:', error);
            showError(error.message);
        }
    }

    /**
     * Render the results
     */
    function renderResults(data) {
        resultQuery.textContent = data.query;

        // Store current benefits for "Tell me more" and "Really?"
        currentBenefits = [...data.benefits];
        selectedBenefitIndex = -1;

        // Reset buttons state
        reallyBtn.disabled = true;
        reallyExpansion.classList.add('hidden');
        reallyExpansion.innerHTML = '';

        // Render benefits with click handlers
        renderBenefitsList();

        // Render tips
        tipsList.innerHTML = data.usageTips.map(tip =>
            `<li>${escapeHtml(tip)}</li>`
        ).join('');

        showSection(resultsSection);

        // Scroll results into view on mobile
        if (window.innerWidth <= 600) {
            resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    /**
     * Generate cache key for expansion
     */
    function getExpansionKey(query, benefit) {
        return `${normalizeQuery(query)}::${benefit.toLowerCase().trim()}`;
    }

    /**
     * Generate Firebase-safe key for expansion
     */
    function expansionToFirebaseKey(query, benefit) {
        const combined = `${normalizeQuery(query)}__${benefit.toLowerCase().trim()}`;
        return combined
            .replace(/[.#$\[\]\/]/g, '_')
            .replace(/\s/g, '_')
            .substring(0, 150);
    }

    /**
     * Load expansion from Firebase cache
     */
    async function loadExpansionFromFirebase(query, benefit) {
        const fbKey = expansionToFirebaseKey(query, benefit);
        try {
            const snapshot = await db.ref(`benefits/expansions/${fbKey}`).once('value');
            const data = snapshot.val();
            if (data && data.expansion) {
                return data.expansion;
            }
            return null;
        } catch (error) {
            console.error('Failed to load expansion from Firebase:', error);
            return null;
        }
    }

    /**
     * Save expansion to Firebase cache
     */
    async function saveExpansionToFirebase(query, benefit, expansion) {
        const fbKey = expansionToFirebaseKey(query, benefit);
        try {
            await db.ref(`benefits/expansions/${fbKey}`).set({
                query: normalizeQuery(query),
                benefit: benefit,
                expansion: expansion,
                cachedAt: Date.now()
            });
        } catch (error) {
            console.error('Failed to save expansion to Firebase:', error);
        }
    }

    /**
     * Check if a benefit has a cached expansion
     */
    function hasExpansion(benefit) {
        const key = getExpansionKey(lastQuery, benefit);
        return !!expansionCache[key];
    }

    /**
     * Render the benefits list with click handlers
     */
    function renderBenefitsList() {
        benefitsList.innerHTML = currentBenefits.map((benefit, index) => {
            const hasExp = hasExpansion(benefit);
            return `<li data-index="${index}"${hasExp ? ' class="has-expansion"' : ''}>${escapeHtml(benefit)}${hasExp ? '<span class="expansion-indicator"></span>' : ''}</li>`;
        }).join('');

        // Add click handlers to each benefit
        benefitsList.querySelectorAll('li').forEach(li => {
            li.addEventListener('click', () => {
                const index = parseInt(li.dataset.index, 10);
                selectBenefit(index, li);
            });
        });
    }

    /**
     * Select a benefit with animation
     */
    function selectBenefit(index, element) {
        // Remove selection from previous
        benefitsList.querySelectorAll('li').forEach(li => {
            li.classList.remove('selected', 'selecting');
        });

        // Add selecting animation
        element.classList.add('selecting');

        // After animation, keep it selected
        setTimeout(() => {
            element.classList.remove('selecting');
            element.classList.add('selected');
        }, 300);

        selectedBenefitIndex = index;
        reallyBtn.disabled = false;

        // Check if this benefit has a cached expansion - auto-show it
        const selectedBenefit = currentBenefits[index];
        const cacheKey = getExpansionKey(lastQuery, selectedBenefit);
        if (expansionCache[cacheKey]) {
            showExpansion(expansionCache[cacheKey]);
        } else {
            // Clear any previous expansion
            reallyExpansion.classList.add('hidden');
            reallyExpansion.innerHTML = '';
        }
    }

    /**
     * Handle "Tell me more..." button - adds one more benefit
     */
    async function handleTellMore() {
        if (isLoadingMore || !lastQuery) return;

        isLoadingMore = true;
        const originalText = tellMoreBtn.textContent;
        tellMoreBtn.textContent = 'LOADING...';
        tellMoreBtn.disabled = true;

        try {
            const response = await fetch(`${WORKER_URL}/api/more-benefit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: lastQuery,
                    existingBenefits: currentBenefits
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to get more benefits');
            }

            if (data.benefit) {
                currentBenefits.push(data.benefit);
                renderBenefitsList();

                // Flash the new benefit
                const newLi = benefitsList.querySelector(`li[data-index="${currentBenefits.length - 1}"]`);
                if (newLi) {
                    newLi.classList.add('selecting');
                    setTimeout(() => newLi.classList.remove('selecting'), 300);
                }
            }

        } catch (error) {
            console.error('Tell me more error:', error);
        } finally {
            isLoadingMore = false;
            tellMoreBtn.textContent = originalText;
            tellMoreBtn.disabled = false;
        }
    }

    /**
     * Handle "Really?" button - expands on the selected benefit
     */
    async function handleReally() {
        if (isLoadingReally || selectedBenefitIndex < 0) return;

        const selectedBenefit = currentBenefits[selectedBenefitIndex];
        if (!selectedBenefit) return;

        // Check local cache first
        const cacheKey = getExpansionKey(lastQuery, selectedBenefit);
        if (expansionCache[cacheKey]) {
            showExpansion(expansionCache[cacheKey]);
            return;
        }

        isLoadingReally = true;
        const originalText = reallyBtn.textContent;
        reallyBtn.textContent = 'LOADING...';
        reallyBtn.disabled = true;

        try {
            // Check Firebase cache first
            const firebaseCached = await loadExpansionFromFirebase(lastQuery, selectedBenefit);
            if (firebaseCached) {
                // Found in Firebase - use it and update local cache
                expansionCache[cacheKey] = firebaseCached;
                showExpansion(firebaseCached);
                renderBenefitsList();
                const li = benefitsList.querySelector(`li[data-index="${selectedBenefitIndex}"]`);
                if (li) {
                    li.classList.add('selected');
                }
                // Don't return - let finally block run
                isLoadingReally = false;
                reallyBtn.textContent = originalText;
                reallyBtn.disabled = false;
                return;
            }

            // Gather existing expansions to avoid repetition
            const existingExpansions = [];
            for (const benefit of currentBenefits) {
                const key = getExpansionKey(lastQuery, benefit);
                if (expansionCache[key]) {
                    existingExpansions.push(expansionCache[key]);
                }
            }

            // Not in any cache - call the API
            const response = await fetch(`${WORKER_URL}/api/expand-benefit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: lastQuery,
                    benefit: selectedBenefit,
                    existingExpansions: existingExpansions
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to expand benefit');
            }

            if (data.expansion) {
                // Cache locally and in Firebase
                expansionCache[cacheKey] = data.expansion;
                saveExpansionToFirebase(lastQuery, selectedBenefit, data.expansion);
                showExpansion(data.expansion);

                // Update the list to show indicator on this benefit
                renderBenefitsList();

                // Re-select the same benefit (since we re-rendered)
                const li = benefitsList.querySelector(`li[data-index="${selectedBenefitIndex}"]`);
                if (li) {
                    li.classList.add('selected');
                }
            }

        } catch (error) {
            console.error('Really? error:', error);
        } finally {
            isLoadingReally = false;
            reallyBtn.textContent = originalText;
            reallyBtn.disabled = false;
        }
    }

    /**
     * Show expansion content
     */
    function showExpansion(expansion) {
        reallyExpansion.innerHTML = `
            <div class="expansion-label">EXPANDED:</div>
            <p>${escapeHtml(expansion)}</p>
        `;
        reallyExpansion.classList.remove('hidden');
    }

    /**
     * Show error state
     */
    function showError(message) {
        errorMessage.textContent = `ERROR: ${message}`;
        showSection(errorSection);
    }

    /**
     * Render history list
     */
    function renderHistory() {
        const entries = Object.entries(historyData);

        if (entries.length === 0) {
            historyEmpty.classList.remove('hidden');
            // Clear any existing items
            const items = historyList.querySelectorAll('.history-item');
            items.forEach(item => item.remove());
            return;
        }

        historyEmpty.classList.add('hidden');

        // Sort by timestamp descending (most recent first)
        entries.sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));

        // Build HTML
        const html = entries.map(([key, item]) => {
            const count = item.viewCount || 1;
            const countText = count === 1 ? '1 view' : `${count} views`;
            return `
                <div class="history-item" data-key="${key}" data-query="${escapeHtml(item.query)}">
                    <span class="history-prompt">&gt;</span>
                    <span class="history-query">${escapeHtml(item.query)}</span>
                    <span class="history-count">(${countText})</span>
                </div>
            `;
        }).join('');

        // Replace content (keep the empty message element)
        const items = historyList.querySelectorAll('.history-item');
        items.forEach(item => item.remove());
        historyList.insertAdjacentHTML('beforeend', html);

        // Add click handlers
        historyList.querySelectorAll('.history-item').forEach(item => {
            item.addEventListener('click', () => {
                const key = item.dataset.key;
                const query = item.dataset.query;
                handleHistoryClick(key, query);
            });
        });
    }

    /**
     * Handle click on history item - just view, don't update timestamp
     */
    async function handleHistoryClick(key, query) {
        queryInput.value = query;
        lastQuery = query;

        // Increment view count (but don't update timestamp - keeps sort order)
        await incrementViewCount(key);

        // Fetch with fromHistory=true so it doesn't save to history again
        fetchBenefits(query, true);
    }

    /**
     * Escape HTML to prevent XSS — single site-wide implementation
     * lives in js/sanitize.js. (ARCH-3)
     */
    function escapeHtml(text) {
        return Sanitize.escapeHtml(text);
    }

    /**
     * Handle form submission
     */
    function handleSubmit() {
        const query = queryInput.value.trim();

        if (!query) {
            queryInput.focus();
            return;
        }

        if (query.length < 2) {
            showError('Query too short. Enter at least 2 characters.');
            return;
        }

        lastQuery = query;
        fetchBenefits(query, false);
    }

    /**
     * Initialize event listeners
     */
    function initEventListeners() {
        // Submit button
        analyzeBtn.addEventListener('click', handleSubmit);

        // Enter key
        queryInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleSubmit();
            }
        });

        // Retry button
        retryBtn.addEventListener('click', () => {
            if (lastQuery) {
                fetchBenefits(lastQuery, false);
            } else {
                showSection(null);
                queryInput.focus();
            }
        });

        // Share link button
        if (shareLink) {
            shareLink.addEventListener('click', copyShareLink);
        }

        // Tell me more button
        if (tellMoreBtn) {
            tellMoreBtn.addEventListener('click', handleTellMore);
        }

        // Really? button
        if (reallyBtn) {
            reallyBtn.addEventListener('click', handleReally);
        }
    }

    /**
     * Initialize
     */
    function init() {
        initFirebase();
        initEventListeners();

        // Check for query in URL
        const urlQuery = getQueryFromURL();
        if (urlQuery) {
            queryInput.value = urlQuery;
            lastQuery = urlQuery;
            fetchBenefits(urlQuery, true); // fromHistory=true so it doesn't duplicate
        } else {
            queryInput.focus();
        }
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
