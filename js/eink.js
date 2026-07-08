/**
 * E-Ink Display Submission
 * Handles text/image submissions, history browsing, and queue management
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import {
    getFirestore,
    collection,
    addDoc,
    getDocs,
    query,
    orderBy,
    limit,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// ==========================================================================
// Firebase Configuration — shared js/firebase-config.js (classic script,
// runs before this module) exposes window.FIREBASE_CONFIGS
// ==========================================================================
const FIREBASE_CONFIG = window.FIREBASE_CONFIGS.eink;

const app = initializeApp(FIREBASE_CONFIG);
const db = getFirestore(app);

// ==========================================================================
// Constants
// ==========================================================================
const MAX_WIDTH = 800;
const MAX_HEIGHT = 480;
const JPEG_QUALITY = 0.8;
const MAX_BASE64_SIZE = 500 * 1024;
const MIN_DISPLAY_TIME_MS = 3 * 60 * 1000; // 3 minutes

// ==========================================================================
// DOM Elements
// ==========================================================================
const form = document.getElementById('submission-form');
const modeButtons = document.querySelectorAll('.mode-btn');
const textModeSection = document.getElementById('text-mode');
const imageModeSection = document.getElementById('image-mode');
const textContent = document.getElementById('text-content');
const charCount = document.getElementById('char-count');
const imageInput = document.getElementById('image-input');
const fileUpload = document.getElementById('file-upload');
const previewContainer = document.getElementById('preview-container');
const previewImage = document.getElementById('preview-image');
const clearImageBtn = document.getElementById('clear-image');
const authorInput = document.getElementById('author-input');
const addToHistoryCheckbox = document.getElementById('add-to-history');
const submitBtn = document.getElementById('submit-btn');
const btnText = submitBtn.querySelector('.btn-text');
const btnLoading = submitBtn.querySelector('.btn-loading');
const statusMessage = document.getElementById('status-message');

// History elements
const inputView = document.getElementById('input-view');
const historyView = document.getElementById('history-view');
const historyContent = document.getElementById('history-content');
const historyMeta = document.getElementById('history-meta');
const historyIndicator = document.getElementById('history-indicator');
const historyPosition = document.getElementById('history-position');
const navPrev = document.getElementById('nav-prev');
const navNext = document.getElementById('nav-next');

// ==========================================================================
// State
// ==========================================================================
let currentMode = 'text';
let processedImageBase64 = null;
let history = [];
let historyIndex = -1; // -1 means "new submission" mode

// ==========================================================================
// Initialize
// ==========================================================================
async function init() {
    await loadHistory();
    updateNavButtons();
    console.log('E-Ink submission page loaded');
}

// ==========================================================================
// History Management
// ==========================================================================
async function loadHistory() {
    try {
        const q = query(
            collection(db, 'inky_history'),
            orderBy('created_at', 'desc'),
            limit(50)
        );
        const snapshot = await getDocs(q);
        history = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
        updateNavButtons();
    } catch (error) {
        console.error('Failed to load history:', error);
        history = [];
    }
}

function updateNavButtons() {
    // Can go back if there's history and we're not at the end
    navPrev.disabled = history.length === 0 || historyIndex >= history.length - 1;
    // Can go forward if we're viewing history (not at -1)
    navNext.disabled = historyIndex < 0;

    // Update indicator
    if (historyIndex >= 0) {
        historyPosition.textContent = `Viewing ${historyIndex + 1} of ${history.length}`;
        historyIndicator.style.opacity = '1';
    } else {
        historyPosition.textContent = '';
        historyIndicator.style.opacity = '0';
    }
}

function showHistoryItem(index) {
    if (index < 0 || index >= history.length) return;

    const item = history[index];
    historyIndex = index;

    // Switch to history view
    inputView.classList.add('hidden');
    historyView.classList.remove('hidden');

    // Show content
    historyContent.innerHTML = '';
    if (item.type === 'image') {
        const img = document.createElement('img');
        img.src = `data:image/jpeg;base64,${item.content}`;
        img.alt = 'Historical submission';
        historyContent.appendChild(img);
    } else {
        const textDiv = document.createElement('div');
        textDiv.className = 'text-content';
        textDiv.textContent = item.content;
        historyContent.appendChild(textDiv);
    }

    // Show meta
    const date = item.created_at?.toDate?.() || new Date();
    const dateStr = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });
    historyMeta.textContent = `${item.author || 'Anonymous'} • ${dateStr}`;

    // Disable form when viewing history
    submitBtn.disabled = true;

    updateNavButtons();
}

function showInputView() {
    historyIndex = -1;
    historyView.classList.add('hidden');
    inputView.classList.remove('hidden');
    submitBtn.disabled = false;
    updateNavButtons();
}

// Navigation handlers
navPrev.addEventListener('click', () => {
    if (historyIndex === -1) {
        // Currently on input, go to first history item
        if (history.length > 0) {
            showHistoryItem(0);
        }
    } else if (historyIndex < history.length - 1) {
        // Go to older item
        showHistoryItem(historyIndex + 1);
    }
});

navNext.addEventListener('click', () => {
    if (historyIndex > 0) {
        // Go to newer item
        showHistoryItem(historyIndex - 1);
    } else if (historyIndex === 0) {
        // Back to input view
        showInputView();
    }
});

// ==========================================================================
// Mode Toggle
// ==========================================================================
modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode === currentMode) return;

        // Return to input view if viewing history
        if (historyIndex >= 0) {
            showInputView();
        }

        currentMode = mode;
        modeButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (mode === 'text') {
            textModeSection.classList.remove('hidden');
            imageModeSection.classList.add('hidden');
        } else {
            textModeSection.classList.add('hidden');
            imageModeSection.classList.remove('hidden');
        }

        hideStatus();
    });
});

// ==========================================================================
// Character Count
// ==========================================================================
textContent.addEventListener('input', () => {
    charCount.textContent = `${textContent.value.length}/280`;
});

// ==========================================================================
// Image Handling
// ==========================================================================
function resizeImage(file, maxWidth, maxHeight, quality) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(img.src);
            const canvas = document.createElement('canvas');
            let { width, height } = img;

            if (width > maxWidth || height > maxHeight) {
                const ratio = Math.min(maxWidth / width, maxHeight / height);
                width = Math.round(width * ratio);
                height = Math.round(height * ratio);
            }

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);

            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            const base64 = dataUrl.split(',')[1];

            resolve({
                base64,
                width,
                height,
                size: Math.round(base64.length * 0.75)
            });
        };
        img.onerror = () => {
            URL.revokeObjectURL(img.src);
            reject(new Error('Failed to load image'));
        };
        img.src = URL.createObjectURL(file);
    });
}

async function processImage(file) {
    let quality = JPEG_QUALITY;
    let result = await resizeImage(file, MAX_WIDTH, MAX_HEIGHT, quality);

    while (result.size > MAX_BASE64_SIZE && quality > 0.3) {
        quality -= 0.1;
        result = await resizeImage(file, MAX_WIDTH, MAX_HEIGHT, quality);
    }

    if (result.size > MAX_BASE64_SIZE) {
        throw new Error('Image too large. Please try a smaller image.');
    }

    return result;
}

async function handleFileSelect(file) {
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showStatus('Please select an image file.', 'error');
        return;
    }

    if (file.size > 10 * 1024 * 1024) {
        showStatus('Image too large. Maximum size is 10MB.', 'error');
        return;
    }

    try {
        fileUpload.classList.add('hidden');
        previewContainer.classList.remove('hidden');
        previewImage.src = '';

        const result = await processImage(file);
        processedImageBase64 = result.base64;
        previewImage.src = `data:image/jpeg;base64,${result.base64}`;

        hideStatus();
    } catch (error) {
        console.error('Image processing error:', error);
        showStatus(error.message || 'Failed to process image.', 'error');
        clearImage();
    }
}

function clearImage() {
    processedImageBase64 = null;
    imageInput.value = '';
    previewContainer.classList.add('hidden');
    fileUpload.classList.remove('hidden');
    previewImage.src = '';
}

imageInput.addEventListener('change', (e) => {
    handleFileSelect(e.target.files[0]);
});

fileUpload.addEventListener('dragover', (e) => {
    e.preventDefault();
    fileUpload.classList.add('dragover');
});

fileUpload.addEventListener('dragleave', () => {
    fileUpload.classList.remove('dragover');
});

fileUpload.addEventListener('drop', (e) => {
    e.preventDefault();
    fileUpload.classList.remove('dragover');
    handleFileSelect(e.dataTransfer.files[0]);
});

clearImageBtn.addEventListener('click', clearImage);

// ==========================================================================
// Form Submission
// ==========================================================================
form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Don't allow submission when viewing history
    if (historyIndex >= 0) return;

    // Validate
    let content;
    if (currentMode === 'text') {
        content = textContent.value.trim();
        if (!content) {
            showStatus('Please enter a message.', 'error');
            return;
        }
    } else {
        if (!processedImageBase64) {
            showStatus('Please select an image.', 'error');
            return;
        }
        content = processedImageBase64;
    }

    const author = authorInput.value.trim() || 'Anonymous';
    const addToHistory = addToHistoryCheckbox.checked;

    setLoading(true);
    hideStatus();

    try {
        const timestamp = serverTimestamp();

        // Create submission document with queue timing
        const submissionDoc = {
            type: currentMode,
            content: content,
            author: author,
            status: 'pending',
            created_at: timestamp,
            // Queue fields for display timing
            display_after: null, // Will be set by server or stays null for immediate
            min_display_until: null // Will be calculated when displayed
        };

        // Submit to queue
        await addDoc(collection(db, 'inky_submissions'), submissionDoc);

        // Add to history if enabled
        if (addToHistory) {
            await addDoc(collection(db, 'inky_history'), {
                type: currentMode,
                content: content,
                author: author,
                created_at: timestamp
            });
            // Reload history
            await loadHistory();
        }

        showStatus('Sent! Your submission will appear on the display shortly.', 'success');

        // Reset form
        if (currentMode === 'text') {
            textContent.value = '';
            charCount.textContent = '0/280';
        } else {
            clearImage();
        }

    } catch (error) {
        console.error('Submission error:', error);
        showStatus('Failed to submit. Please try again.', 'error');
    } finally {
        setLoading(false);
    }
});

// ==========================================================================
// UI Helpers
// ==========================================================================
function setLoading(loading) {
    submitBtn.disabled = loading;
    btnText.classList.toggle('hidden', loading);
    btnLoading.classList.toggle('hidden', !loading);
}

function showStatus(message, type) {
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type}`;
    statusMessage.classList.remove('hidden');
}

function hideStatus() {
    statusMessage.classList.add('hidden');
}

// ==========================================================================
// Start
// ==========================================================================
init();
