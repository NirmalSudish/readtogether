// Header variables shifted to global scope for SPA sharing
let isPdf = false;
let pdfDoc = null;
let currentPdfPage = 1;
let totalPdfPages = 0;
let pdfCanvas = null;
let pdfCtx = null;
let book = null;
let rendition = null;
let sessionData = null;
let currentLocationIndex = 0;
let totalLocations = 0;
let locations = [];
let isReaderInitialized = false; // Renamed to avoid lobby collision
let chatOpen = false;
let notesOpen = false;
let fontMenuOpen = false;
let unreadMessages = 0;
let currentTheme = 'light'; // 'dark', 'light', 'sepia'
let currentFontSize = 18;
let currentFontFamily = "'Lora', serif";
let notes = JSON.parse(localStorage.getItem('readTogether_notes') || '[]');

// ---- Initialize Reader for SPA Mode ----
function initReaderSPA() {
    if (isReaderInitialized) return;
    console.log("Initializing Reader Screen...");

    sessionData = {
        roomCode: currentRoom,
        role: userRole,
        userName: userName,
        book: bookInfo
    };

    setupSocketListeners();

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
    if (notesInput) {
        notesInput.addEventListener('input', () => {
            const len = notesInput.value.length;
            document.getElementById('notes-char-count').textContent = `${len} / 1000`;
        });
    }
    renderNotes();

    isReaderInitialized = true;
    updatePageInfo();
}

// ---- Book Loading ----
function loadBook(bookData) {
    const loadingEl = document.getElementById('reader-loading');
    loadingEl.style.display = 'flex';

    document.getElementById('reader-book-title').textContent = bookData.originalName;

    // Initialize epub.js - Ensure path is absolute if BACKEND_URL is set
    const baseUrl = BACKEND_URL || window.location.origin;
    const fullPath = bookData.path.startsWith('http')
        ? bookData.path
        : `${baseUrl}${bookData.path}`;

    console.log("Loading book from:", fullPath);

    isPdf = bookData.type === '.pdf' || bookData.filename.endsWith('.pdf');

    if (isPdf) {
        initPdfReader(fullPath, loadingEl);
        return;
    }

    try {
        book = ePub(fullPath);
    } catch (e) {
        console.error("EPub init error:", e);
        loadingEl.innerHTML = `<p class="error-msg">Failed to initialize reader engine.</p>`;
        return;
    }

    // Safety timeout: If book doesn't render in 15 seconds, show error
    const loadingTimeout = setTimeout(() => {
        if (loadingEl.style.display !== 'none') {
            console.error("Book loading timed out");
            loadingEl.innerHTML = `
                <div class="error-container" style="color: var(--error); text-align: center; padding: 20px;">
                    <p class="error-msg" style="margin-bottom: 20px;">Loading is taking longer than expected. The file might be corrupted or over the size limit.</p>
                    <button class="primary-btn" onclick="location.reload()" style="padding: 10px 20px; cursor: pointer; color: white;">Refresh App</button>
                </div>
            `;
        }
    }, 15000);

    book.opened.then(() => {
        console.log("Book opened successfully");
    }).catch(err => {
        clearTimeout(loadingTimeout);
        console.error("Error opening book:", err);
        const is404 = err.message && err.message.includes('404');
        const errorMessage = is404
            ? "Book file not found on server. It may have been deleted during a server restart."
            : "Failed to load book. Make sure the server is reachable.";

        document.getElementById('reader-book-title').textContent = "Error: File Missing";
        loadingEl.innerHTML = `
            <div class="error-container" style="color: var(--error); text-align: center; padding: 20px;">
                <p class="error-msg" style="margin-bottom: 20px; font-weight: bold;">${errorMessage}</p>
                ${sessionData.role === 'host' ? '<button class="primary-btn" onclick="let s = document.getElementById(\'reader-screen\'); s.classList.remove(\'active\'); document.getElementById(\'room-screen\').classList.add(\'active\');" style="padding: 10px 20px; cursor: pointer; color: white;">Go Back to Upload</button>' : ''}
            </div>
        `;
    });

    rendition = book.renderTo('epub-viewer', {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'paginated',
        manager: 'continuous'
    });

    // Handle iframe styling after rendering
    rendition.on('started', () => {
        applyTheme(currentTheme);
        applyFontSize(currentFontSize);
        applyFontFamily(currentFontFamily);
    });

    // Apply initial theme
    applyTheme(currentTheme);
    applyFontSize(currentFontSize);
    applyFontFamily(currentFontFamily);

    // Display the book starting at the stored page or beginning
    // We do this immediately so the user doesn't wait for location generation
    if (sessionData.currentLocation && currentLocationIndex > 0) {
        rendition.display(sessionData.currentLocation);
    } else {
        rendition.display();
    }

    // Generate locations for progress tracking in the background
    book.ready.then(() => {
        console.log("Book ready, generating locations...");
        return book.locations.generate(1024);
    }).then((locs) => {
        locations = locs;
        totalLocations = locations.length;
        console.log("Locations generated:", totalLocations);

        socket.emit('set-total-locations', { total: totalLocations });

        // Sync progress now that locations are ready
        updateProgress();
    }).catch(err => {
        console.error("Error generating locations:", err);
    });

    rendition.on('rendered', () => {
        clearTimeout(loadingTimeout);
        loadingEl.style.display = 'none';
        console.log("Book rendered successfully");

        // Force a resize to fix Zero-Height rendering bugs in SPA/iOS Safari
        setTimeout(() => {
            if (rendition) {
                rendition.resize('100%', '100%');
            }
        }, 300);
    });

    // Auto-resize on window resize or device rotation
    window.addEventListener('resize', () => {
        if (rendition) {
            rendition.resize('100%', '100%');
        }
    });

    rendition.on('relocated', (location) => {
        // Update page info
        const current = location.start.location;
        currentLocationIndex = current;

        // Save precise location to session so refresh works perfectly
        if (sessionData) {
            sessionData.currentLocation = location.start.cfi;
            sessionStorage.setItem('readTogether', JSON.stringify(sessionData));
        }

        updatePageInfo();
        updateProgress();
    });

    // Handle touch/swipe on mobile
    rendition.on('touchstart', handleTouchStart);
    rendition.on('touchend', handleTouchEnd);

    // Highlighting / Selection features
    rendition.on('selected', (cfiRange, contents) => {
        currentSelectionCfi = cfiRange;
        currentSelectionText = contents.window.getSelection().toString().trim();

        // Get iframe position
        const iframe = document.querySelector('#epub-viewer iframe');
        const iframeRect = iframe.getBoundingClientRect();

        // Get selection rect inside iframe
        const range = contents.window.getSelection().getRangeAt(0);
        const rect = range.getBoundingClientRect();

        const tooltip = document.getElementById('highlight-tooltip');
        tooltip.style.display = 'flex';

        // Position it just above the selection
        const top = iframeRect.top + rect.top - 40;
        const left = Math.max(20, iframeRect.left + rect.left + (rect.width / 2));

        tooltip.style.top = `${top}px`;
        tooltip.style.left = `${left}px`;
    });

    rendition.on('click', () => {
        document.getElementById('highlight-tooltip').style.display = 'none';
    });
}

// ---- Highlighting State ----
let currentSelectionCfi = null;
let currentSelectionText = '';

function applyHighlight() {
    document.getElementById('highlight-tooltip').style.display = 'none';
    if (!currentSelectionCfi) return;

    // Auto highlight in reader
    rendition.annotations.highlight(currentSelectionCfi, {}, (e) => { });

    const shortText = currentSelectionText.length > 80 ? currentSelectionText.substring(0, 80) + '...' : currentSelectionText;

    // Send highlight context to chat
    socket.emit('chat-message', {
        text: shortText,
        isHighlight: true,
        cfi: currentSelectionCfi,
        pageIndex: currentLocationIndex
    });

    // Clear selection inside iframe natively via injected JS script or simply skip for now
    if (rendition.getContents && rendition.getContents().length > 0) {
        rendition.getContents()[0].window.getSelection().removeAllRanges();
    }
}

function jumpToCfi(cfi) {
    if (rendition) {
        // Broadcast jump to partner
        socket.emit('jump-to-scene', { cfi });

        // Local jump
        doLocalJump(cfi);
    }
}

// ---- PDF Rendering Logic ----
async function initPdfReader(url, loadingEl) {
    try {
        pdfDoc = await pdfjsLib.getDocument(url).promise;
        totalPdfPages = pdfDoc.numPages;
        totalLocations = totalPdfPages;

        // Restore session page or start at 1
        currentPdfPage = sessionData.currentLocation ? parseInt(sessionData.currentLocation) : 1;
        if (isNaN(currentPdfPage) || currentPdfPage < 1) currentPdfPage = 1;
        currentLocationIndex = currentPdfPage - 1;

        loadingEl.style.display = 'none';

        const viewer = document.getElementById('epub-viewer');
        viewer.innerHTML = '<canvas id="pdf-canvas" style="max-height: 100%; max-width: 100%; box-shadow: 0 4px 8px rgba(0,0,0,0.1);"></canvas>';
        pdfCanvas = document.getElementById('pdf-canvas');
        pdfCtx = pdfCanvas.getContext('2d');

        applyTheme(currentTheme); // apply bg colors
        renderPdfPage(currentPdfPage);

        // Auto-resize on window resize or device rotation
        window.addEventListener('resize', () => {
            if (isPdf && pdfDoc) {
                renderPdfPage(currentPdfPage);
            }
        });

    } catch (err) {
        console.error("PDF init error", err);
        loadingEl.innerHTML = `
            <div class="error-container" style="color: var(--error); text-align: center; padding: 20px;">
                <p class="error-msg" style="margin-bottom: 20px;">Failed to load PDF file.</p>
                <button class="primary-btn" onclick="location.reload()" style="padding: 10px 20px; cursor: pointer; color: white;">Refresh App</button>
            </div>
        `;
    }
}

async function renderPdfPage(pageNum) {
    if (!pdfDoc) return;
    try {
        const page = await pdfDoc.getPage(pageNum);
        const viewer = document.getElementById('epub-viewer');

        // Calculate appropriate scale based on container
        const unscaledViewport = page.getViewport({ scale: 1 });
        const scaleX = viewer.clientWidth / unscaledViewport.width;
        const scaleY = viewer.clientHeight / unscaledViewport.height;
        let scale = Math.min(scaleX, scaleY) * 0.95; // 95% to leave a tiny padding margin
        if (scale > 2) scale = 2; // cap max scale

        const viewport = page.getViewport({ scale });

        // Ensure proper HiDPI canvas rendering
        const outputScale = window.devicePixelRatio || 1;
        pdfCanvas.width = Math.floor(viewport.width * outputScale);
        pdfCanvas.height = Math.floor(viewport.height * outputScale);
        pdfCanvas.style.width = Math.floor(viewport.width) + "px";
        pdfCanvas.style.height = Math.floor(viewport.height) + "px";

        const transform = outputScale !== 1
            ? [outputScale, 0, 0, outputScale, 0, 0]
            : null;

        const renderContext = {
            canvasContext: pdfCtx,
            transform: transform,
            viewport: viewport
        };

        await page.render(renderContext).promise;

        currentLocationIndex = pageNum - 1;

        sessionData.currentLocation = pageNum;
        sessionStorage.setItem('readTogether', JSON.stringify(sessionData));

        updatePageInfo();
        updateProgress();
    } catch (e) {
        console.error("Error rendering PDF page", e);
    }
}

function doLocalJump(cfi) {
    if (isPdf) {
        // cfi for PDF is just the page number
        const pageNum = parseInt(cfi);
        if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= totalPdfPages) {
            currentPdfPage = pageNum;
            renderPdfPage(currentPdfPage);
        }
        return;
    }

    if (!rendition) return;
    const viewer = document.getElementById('epub-viewer');
    viewer.style.transition = 'opacity 0.2s';
    viewer.style.opacity = '0';
    setTimeout(() => {
        rendition.display(cfi).then(() => {
            viewer.style.opacity = '1';
        });
    }, 200);
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

        const viewer = document.getElementById('epub-viewer');

        if (isPdf) {
            viewer.style.transition = 'opacity 0.15s ease-out, transform 0.15s ease-out';
            viewer.style.opacity = '0';
            viewer.style.transform = data.direction === 'next' ? 'translateX(-30px)' : 'translateX(30px)';

            setTimeout(() => {
                currentPdfPage = data.direction === 'next' ? currentPdfPage + 1 : currentPdfPage - 1;
                if (currentPdfPage < 1) currentPdfPage = 1;
                if (currentPdfPage > totalPdfPages) currentPdfPage = totalPdfPages;

                renderPdfPage(currentPdfPage).then(() => {
                    viewer.style.transition = 'none';
                    viewer.style.transform = data.direction === 'next' ? 'translateX(30px)' : 'translateX(-30px)';
                    void viewer.offsetWidth; // Force Reflow
                    viewer.style.transition = 'opacity 0.2s ease-out, transform 0.2s ease-out';
                    viewer.style.opacity = '1';
                    viewer.style.transform = 'translateX(0)';
                });
            }, 150);
            return;
        }

        if (rendition && locations.length > 0) {
            // Slide transition out
            viewer.style.transition = 'opacity 0.15s ease-out, transform 0.15s ease-out';
            viewer.style.opacity = '0';
            viewer.style.transform = data.direction === 'next' ? 'translateX(-30px)' : 'translateX(30px)';

            setTimeout(() => {
                const action = data.direction === 'next' ? rendition.next() : rendition.prev();
                action.then(() => {
                    updatePageInfo();
                    updateProgress();

                    // Reset position to opposite side invisibly
                    viewer.style.transition = 'none';
                    viewer.style.transform = data.direction === 'next' ? 'translateX(30px)' : 'translateX(-30px)';
                    void viewer.offsetWidth; // Force Reflow

                    // Slide in transition
                    viewer.style.transition = 'opacity 0.2s ease-out, transform 0.2s ease-out';
                    viewer.style.opacity = '1';
                    viewer.style.transform = 'translateX(0)';
                });
            }, 150);
        }

        // Reset sync display
        updateSyncDisplay(0, 2);

        // Visual feedback
        flashSyncSuccess();
    });

    // Jump to Scene (highlight click sync)
    socket.on('jumped-to-scene', (data) => {
        doLocalJump(data.cfi);
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

    // Note: WebRTC event listeners have been removed from here 
    // because they are now globally handled by app.js.
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
        if (isPdf && pdfCanvas) {
            document.getElementById('epub-viewer').style.backgroundColor = '#faf8f5';
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
        if (isPdf && pdfCanvas) {
            document.getElementById('epub-viewer').style.backgroundColor = '#f4ecd8';
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
        if (isPdf && pdfCanvas) {
            document.getElementById('epub-viewer').style.backgroundColor = '#1a1a2e';
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

    if (msg.isHighlight) {
        msgEl.innerHTML = `
            ${!isOwn ? `<span class="chat-msg-sender">${escapeHtml(msg.sender)}</span>` : ''}
            <div class="chat-msg-bubble highlight-bubble" onclick="jumpToCfi('${msg.cfi}')" style="cursor: pointer; background: rgba(124,106,255,0.15); border: 1px solid rgba(124,106,255,0.3); border-radius: 8px; padding: 12px; transition: all 0.2s;">
                <div style="font-size: 0.65rem; color: var(--text-muted); font-weight: 700; margin-bottom: 6px; letter-spacing: 0.05em; display: flex; align-items: center; gap: 4px;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                    HIGHLIGHT ON LOC ${msg.pageIndex}
                </div>
                <div style="font-style: italic; font-size: 0.85rem; line-height: 1.5; color: var(--reader-text); border-left: 2px solid var(--accent); padding-left: 8px;">"${escapeHtml(msg.text)}"</div>
                <div style="font-size: 0.65rem; font-weight: 600; color: var(--accent-light); margin-top: 8px; display: flex; align-items: center; gap: 4px;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>
                    Tap to jump to page
                </div>
            </div>
            <span class="chat-msg-time">${timeStr}</span>
        `;
    } else {
        msgEl.innerHTML = `
            ${!isOwn ? `<span class="chat-msg-sender">${escapeHtml(msg.sender)}</span>` : ''}
            <div class="chat-msg-bubble">${escapeHtml(msg.text)}</div>
            <span class="chat-msg-time">${timeStr}</span>
        `;
    }

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
    if (typeof exitReader === 'function') {
        exitReader();
    } else {
        window.location.href = '/';
    }
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


// ----- Draggable Widget Logic -----
function setupDraggableWidget() {
    const widget = document.getElementById('video-widget');
    const header = document.getElementById('video-header');

    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    let xOffset = 0;
    let yOffset = 0;

    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mouseup', dragEnd);
    document.addEventListener('mousemove', drag);

    // Touch support mapping natively
    header.addEventListener('touchstart', dragStart, { passive: false });
    document.addEventListener('touchend', dragEnd);
    document.addEventListener('touchmove', drag, { passive: false });

    function dragStart(e) {
        if (e.type === 'touchstart') {
            initialX = e.touches[0].clientX - xOffset;
            initialY = e.touches[0].clientY - yOffset;
        } else {
            initialX = e.clientX - xOffset;
            initialY = e.clientY - yOffset;
        }

        if (e.target.closest('.icon-btn')) return; // ignore close button
        isDragging = true;
    }

    function dragEnd(e) {
        initialX = currentX;
        initialY = currentY;
        isDragging = false;
    }

    function drag(e) {
        if (isDragging) {
            e.preventDefault();

            if (e.type === 'touchmove') {
                currentX = e.touches[0].clientX - initialX;
                currentY = e.touches[0].clientY - initialY;
            } else {
                currentX = e.clientX - initialX;
                currentY = e.clientY - initialY;
            }

            xOffset = currentX;
            yOffset = currentY;

            // Apply transform instead of direct style left/top for perf
            widget.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
        }
    }
}

// Automatically setup dragging for global widget
document.addEventListener('DOMContentLoaded', setupDraggableWidget);
