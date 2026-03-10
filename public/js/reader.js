/* ============================================
   READ TOGETHER - Reader Logic
   ============================================ */

// ---- State ----
let socket;
let book = null;
let rendition = null;
let sessionData = null;
let currentLocationIndex = 0;
let totalLocations = 0;
let locations = [];
let isReady = false;
let chatOpen = false;
let notesOpen = false;
let fontMenuOpen = false;
let unreadMessages = 0;
let currentTheme = 'dark'; // 'dark', 'light', 'sepia'
let currentFontSize = 18;
let currentFontFamily = "'Lora', serif";
let notes = JSON.parse(localStorage.getItem('readTogether_notes') || '[]');


// ---- Initialize ----
document.addEventListener('DOMContentLoaded', () => {
    // Load session data
    const stored = sessionStorage.getItem('readTogether');
    if (!stored) {
        window.location.href = '/';
        return;
    }

    sessionData = JSON.parse(stored);

    // Connect socket
    socket = BACKEND_URL ? io(BACKEND_URL, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 10
    }) : io({
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 10
    });

    setupSocketListeners();

    // Rejoin room
    socket.on('connect', () => {
        socket.emit('reconnect-room', {
            roomCode: sessionData.roomCode,
            role: sessionData.role,
            name: sessionData.userName
        });
    });

    socket.on('reconnect-success', (data) => {
        console.log('Reconnected to room:', data.code);
        if (data.book && !book) {
            loadBook(data.book);
        }
        if (data.currentPage !== undefined) {
            currentLocationIndex = data.currentPage;
        }
    });

    socket.on('reconnect-error', (data) => {
        alert(data.message);
        window.location.href = '/';
    });

    // Load the book
    if (sessionData.book) {
        loadBook(sessionData.book);
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeydown);

    // Close menus on outside click
    document.addEventListener('click', (e) => {
        if (fontMenuOpen && !e.target.closest('.font-menu') && !e.target.closest('#font-size-btn')) {
            closeFontMenu();
        }
    });

    // Notes: char counter + initial render
    const notesInput = document.getElementById('notes-input');
    notesInput.addEventListener('input', () => {
        const len = notesInput.value.length;
        document.getElementById('notes-char-count').textContent = `${len} / 1000`;
    });
    renderNotes();
});

// ---- Book Loading ----
function loadBook(bookData) {
    const loadingEl = document.getElementById('reader-loading');
    loadingEl.style.display = 'flex';

    document.getElementById('reader-book-title').textContent = bookData.originalName;

    // Initialize epub.js
    book = ePub(bookData.path);

    rendition = book.renderTo('epub-viewer', {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'paginated',
        manager: 'continuous'
    });

    // Apply initial theme
    applyTheme(currentTheme);
    applyFontSize(currentFontSize);
    applyFontFamily(currentFontFamily);

    // Generate locations for progress tracking
    book.ready.then(() => {
        return book.locations.generate(1024);
    }).then((locs) => {
        locations = locs;
        totalLocations = locations.length;

        socket.emit('set-total-locations', { total: totalLocations });

        // Display the book starting at the stored page or beginning
        if (currentLocationIndex > 0 && locations[currentLocationIndex]) {
            rendition.display(locations[currentLocationIndex]);
        } else {
            rendition.display();
        }
    });

    rendition.on('rendered', () => {
        loadingEl.style.display = 'none';
    });

    rendition.on('relocated', (location) => {
        // Update page info
        const current = location.start.location;
        currentLocationIndex = current;

        updatePageInfo();
        updateProgress();
    });

    // Handle touch/swipe on mobile
    rendition.on('touchstart', handleTouchStart);
    rendition.on('touchend', handleTouchEnd);
}

// ---- Page Navigation with Sync ----
function requestNextPage() {
    if (isReady) {
        // Cancel ready status
        cancelReady();
        return;
    }

    isReady = true;
    updateLocalSyncUI();

    socket.emit('page-ready', {
        nextPage: currentLocationIndex + 1,
        direction: 'next'
    });
}

function requestPrevPage() {
    if (currentLocationIndex <= 0) return;

    if (isReady) {
        cancelReady();
        return;
    }

    isReady = true;
    updateLocalSyncUI();

    socket.emit('page-ready', {
        nextPage: currentLocationIndex - 1,
        direction: 'prev'
    });
}

function cancelReady() {
    isReady = false;
    updateLocalSyncUI();
    socket.emit('page-cancel');
}

function updateLocalSyncUI() {
    const nextBtn = document.getElementById('next-page-btn');
    const prevBtn = document.getElementById('prev-page-btn');

    if (isReady) {
        nextBtn.classList.add('ready');
        prevBtn.classList.add('ready');
    } else {
        nextBtn.classList.remove('ready');
        prevBtn.classList.remove('ready');
    }
}

// ---- Socket Listeners ----
function setupSocketListeners() {
    // Sync update
    socket.on('page-sync-update', (data) => {
        updateSyncDisplay(data.readyCount, data.totalUsers);
    });

    // Page advance (both users confirmed)
    socket.on('page-advance', (data) => {
        isReady = false;
        updateLocalSyncUI();

        currentLocationIndex = data.page;

        if (rendition && locations.length > 0) {
            if (data.direction === 'next') {
                rendition.next().then(() => {
                    updatePageInfo();
                    updateProgress();
                });
            } else {
                rendition.prev().then(() => {
                    updatePageInfo();
                    updateProgress();
                });
            }
        }

        // Reset sync display
        updateSyncDisplay(0, 2);

        // Visual feedback
        flashSyncSuccess();
    });

    // Chat
    socket.on('chat-received', (msg) => {
        addChatMessage(msg);

        if (!chatOpen) {
            unreadMessages++;
            updateChatBadge();
        }
    });

    // User typing
    socket.on('user-typing', (data) => {
        // Could show typing indicator
    });

    // Disconnect handling
    socket.on('host-disconnected', (data) => {
        showDisconnectOverlay('Host Disconnected', data.message);
        document.getElementById('guest-sync-avatar').classList.remove('connected');
        document.getElementById('sync-text').textContent = 'Partner offline';
    });

    socket.on('guest-disconnected', (data) => {
        showDisconnectOverlay('Partner Disconnected', data.message);
        document.getElementById('guest-sync-avatar').classList.remove('connected');
        document.getElementById('sync-text').textContent = 'Partner offline';
    });

    socket.on('host-reconnected', () => {
        hideDisconnectOverlay();
        document.getElementById('guest-sync-avatar').classList.add('connected');
        document.getElementById('sync-text').textContent = 'Both connected';
    });

    socket.on('guest-reconnected', () => {
        hideDisconnectOverlay();
        document.getElementById('guest-sync-avatar').classList.add('connected');
        document.getElementById('sync-text').textContent = 'Both connected';
    });

    socket.on('user-joined', (data) => {
        document.getElementById('guest-sync-avatar').classList.add('connected');
        document.getElementById('sync-text').textContent = 'Both connected';
    });

    socket.on('book-available', (bookData) => {
        if (!book) {
            loadBook(bookData);
        }
    });
}

// ---- Sync Display ----
function updateSyncDisplay(readyCount, totalUsers) {
    const countEl = document.getElementById('sync-count');
    const ringEl = document.getElementById('sync-ring');
    const labelEl = document.getElementById('sync-label');

    countEl.textContent = `${readyCount}/${totalUsers}`;

    // Update ring progress
    const circumference = 2 * Math.PI * 20; // r=20
    const progress = readyCount / totalUsers;
    const offset = circumference * (1 - progress);
    ringEl.style.strokeDashoffset = offset;

    if (readyCount === totalUsers && totalUsers > 1) {
        ringEl.classList.add('complete');
        labelEl.textContent = 'Advancing...';
    } else if (readyCount > 0) {
        ringEl.classList.remove('complete');
        labelEl.textContent = `${readyCount} of ${totalUsers} ready`;
    } else {
        ringEl.classList.remove('complete');
        labelEl.textContent = 'Ready to read';
    }
}

function flashSyncSuccess() {
    const footer = document.getElementById('reader-footer');
    footer.style.borderTopColor = 'rgba(74, 222, 128, 0.5)';
    setTimeout(() => {
        footer.style.borderTopColor = '';
    }, 600);
}

// ---- Page Info ----
function updatePageInfo() {
    const pageInfo = document.getElementById('page-info');
    if (totalLocations > 0) {
        pageInfo.textContent = `Location ${currentLocationIndex} of ${totalLocations}`;
    } else {
        pageInfo.textContent = `Location ${currentLocationIndex}`;
    }
}

function updateProgress() {
    if (totalLocations <= 0) return;
    const pct = Math.min((currentLocationIndex / totalLocations) * 100, 100);
    document.getElementById('reading-progress-fill').style.width = pct + '%';
}

// ---- Theme ----
function toggleTheme() {
    const themes = ['dark', 'light', 'sepia'];
    const idx = themes.indexOf(currentTheme);
    currentTheme = themes[(idx + 1) % themes.length];
    applyTheme(currentTheme);
}

function applyTheme(theme) {
    document.body.classList.remove('light-theme', 'sepia-theme');
    const sunIcon = document.querySelector('.sun-icon');
    const moonIcon = document.querySelector('.moon-icon');

    if (theme === 'light') {
        document.body.classList.add('light-theme');
        sunIcon.style.display = 'none';
        moonIcon.style.display = 'block';

        if (rendition) {
            rendition.themes.default({
                body: {
                    background: '#faf8f5 !important',
                    color: '#2a2a35 !important'
                },
                'p, div, span, h1, h2, h3, h4, h5, h6, li, a': {
                    color: '#2a2a35 !important'
                }
            });
        }
    } else if (theme === 'sepia') {
        document.body.classList.add('sepia-theme');
        sunIcon.style.display = 'block';
        moonIcon.style.display = 'none';

        if (rendition) {
            rendition.themes.default({
                body: {
                    background: '#f4ecd8 !important',
                    color: '#3a3020 !important'
                },
                'p, div, span, h1, h2, h3, h4, h5, h6, li, a': {
                    color: '#3a3020 !important'
                }
            });
        }
    } else {
        // Dark
        sunIcon.style.display = 'block';
        moonIcon.style.display = 'none';

        if (rendition) {
            rendition.themes.default({
                body: {
                    background: '#1a1a2e !important',
                    color: '#e0e0e8 !important'
                },
                'p, div, span, h1, h2, h3, h4, h5, h6, li, a': {
                    color: '#e0e0e8 !important'
                }
            });
        }
    }
}

// ---- Font Size ----
function toggleFontMenu() {
    if (fontMenuOpen) {
        closeFontMenu();
    } else {
        openFontMenu();
    }
}

function openFontMenu() {
    document.getElementById('font-menu').style.display = 'block';
    fontMenuOpen = true;
}

function closeFontMenu() {
    document.getElementById('font-menu').style.display = 'none';
    fontMenuOpen = false;
}

function adjustFontSize(delta) {
    const slider = document.getElementById('font-slider');
    let newVal = parseInt(slider.value) + delta;
    newVal = Math.max(12, Math.min(28, newVal));
    slider.value = newVal;
    setFontSize(newVal);
}

function setFontSize(size) {
    currentFontSize = parseInt(size);
    applyFontSize(currentFontSize);
}

function applyFontSize(size) {
    if (rendition) {
        rendition.themes.fontSize(size + 'px');
    }
}

// ---- Font Family ----
function setFontFamily(btn) {
    document.querySelectorAll('.font-family-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFontFamily = btn.dataset.font;
    applyFontFamily(currentFontFamily);
}

function applyFontFamily(family) {
    if (rendition) {
        rendition.themes.font(family);
    }
}

// ---- Chat ----
function toggleChat() {
    const sidebar = document.getElementById('chat-sidebar');
    chatOpen = !chatOpen;

    if (chatOpen) {
        sidebar.classList.add('open');
        unreadMessages = 0;
        updateChatBadge();
        document.getElementById('chat-input').focus();
    } else {
        sidebar.classList.remove('open');
    }
}

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text || !socket) return;

    socket.emit('chat-message', { text });
    input.value = '';
}

function handleChatKeydown(e) {
    if (e.key === 'Enter') {
        sendChatMessage();
    }
    // Emit typing indicator
    if (socket) {
        socket.emit('typing');
    }
}

function addChatMessage(msg) {
    const container = document.getElementById('chat-messages');

    // Remove empty state
    const emptyEl = container.querySelector('.chat-empty');
    if (emptyEl) emptyEl.remove();

    const isOwn = msg.senderId === socket.id;
    const msgEl = document.createElement('div');
    msgEl.className = `chat-msg ${isOwn ? 'own' : ''}`;

    const time = new Date(msg.timestamp);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    msgEl.innerHTML = `
    ${!isOwn ? `<span class="chat-msg-sender">${escapeHtml(msg.sender)}</span>` : ''}
    <div class="chat-msg-bubble">${escapeHtml(msg.text)}</div>
    <span class="chat-msg-time">${timeStr}</span>
  `;

    container.appendChild(msgEl);
    container.scrollTop = container.scrollHeight;
}

function updateChatBadge() {
    const badge = document.getElementById('chat-badge');
    if (unreadMessages > 0) {
        badge.style.display = 'flex';
        badge.textContent = unreadMessages > 9 ? '9+' : unreadMessages;
    } else {
        badge.style.display = 'none';
    }
}

// ---- Disconnect Overlay ----
function showDisconnectOverlay(title, message) {
    document.getElementById('disconnect-title').textContent = title;
    document.getElementById('disconnect-message').textContent = message;
    document.getElementById('disconnect-overlay').style.display = 'flex';
}

function hideDisconnectOverlay() {
    document.getElementById('disconnect-overlay').style.display = 'none';
}

// ---- Go Back ----
function goBackToRoom() {
    window.location.href = '/';
}

// ---- Keyboard Shortcuts ----
function handleKeydown(e) {
    // Don't handle shortcuts when typing in chat
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.key) {
        case 'ArrowRight':
        case ' ':
            e.preventDefault();
            requestNextPage();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            requestPrevPage();
            break;
        case 'Escape':
            if (chatOpen) toggleChat();
            if (fontMenuOpen) closeFontMenu();
            if (notesOpen) toggleNotes();
            break;
        case 'c':
        case 'C':
            if (!e.ctrlKey && !e.metaKey) {
                toggleChat();
            }
            break;
        case 'n':
        case 'N':
            if (!e.ctrlKey && !e.metaKey) {
                toggleNotes();
            }
            break;
    }
}

// ---- Touch Handling ----
let touchStartX = 0;
let touchStartY = 0;

function handleTouchStart(e) {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
}

function handleTouchEnd(e) {
    const dx = e.changedTouches[0].screenX - touchStartX;
    const dy = e.changedTouches[0].screenY - touchStartY;

    // Only handle horizontal swipes
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
        if (dx < 0) {
            requestNextPage();
        } else {
            requestPrevPage();
        }
    }
}

// ---- Utility ----
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ---- Notes ----
function toggleNotes() {
    const sidebar = document.getElementById('notes-sidebar');
    notesOpen = !notesOpen;

    if (notesOpen) {
        sidebar.classList.add('open');
        document.getElementById('notes-input').focus();
    } else {
        sidebar.classList.remove('open');
    }
}

function saveNote() {
    const input = document.getElementById('notes-input');
    const text = input.value.trim();
    if (!text) return;

    const note = {
        id: Date.now(),
        text,
        page: currentLocationIndex,
        timestamp: new Date().toISOString()
    };

    notes.unshift(note);
    localStorage.setItem('readTogether_notes', JSON.stringify(notes));

    input.value = '';
    document.getElementById('notes-char-count').textContent = '0 / 1000';
    renderNotes();

    // Brief visual confirmation
    const btn = document.getElementById('notes-save-btn');
    const orig = btn.textContent;
    btn.textContent = '✓ Saved';
    btn.style.opacity = '0.6';
    setTimeout(() => {
        btn.textContent = orig;
        btn.style.opacity = '';
    }, 1200);
}

function deleteNote(id) {
    notes = notes.filter(n => n.id !== id);
    localStorage.setItem('readTogether_notes', JSON.stringify(notes));
    renderNotes();
}

function renderNotes() {
    const list = document.getElementById('notes-list');
    const emptyEl = document.getElementById('notes-empty');
    const badge = document.getElementById('notes-count-badge');

    badge.textContent = notes.length;

    // Clear existing note cards (not the empty state)
    Array.from(list.querySelectorAll('.note-card')).forEach(el => el.remove());

    if (notes.length === 0) {
        if (emptyEl) emptyEl.style.display = 'flex';
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    notes.forEach(note => {
        const card = document.createElement('div');
        card.className = 'note-card';
        card.dataset.id = note.id;

        const time = new Date(note.timestamp);
        const timeStr = time.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
            ' · ' + time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const pageLabel = note.page > 0 ? `Loc ${note.page}` : 'Start';

        card.innerHTML = `
            <div class="note-card-meta">
                <span class="note-card-page">${escapeHtml(pageLabel)}</span>
                <span class="note-card-time">${escapeHtml(timeStr)}</span>
            </div>
            <div class="note-card-text">${escapeHtml(note.text)}</div>
            <div class="note-card-actions">
                <button class="note-delete-btn" onclick="deleteNote(${note.id})">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                        <path d="M10 11v6"/><path d="M14 11v6"/>
                        <path d="M9 6V4h6v2"/>
                    </svg>
                    Delete
                </button>
            </div>
        `;

        list.appendChild(card);
    });
}
