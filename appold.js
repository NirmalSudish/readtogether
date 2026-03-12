/* ============================================
   READ TOGETHER - App / Lobby Logic
   ============================================ */

// Socket connection
const socket = BACKEND_URL ? io(BACKEND_URL, {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10
}) : io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10
});

// State
let currentRoom = null;
let userRole = null;
let userName = null;
let bookInfo = null;

// ---- Screen Management ----
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) {
        target.classList.add('active');
        // Re-trigger animation
        target.style.animation = 'none';
        target.offsetHeight; // reflow
        target.style.animation = '';
    }
}

// ---- Room Creation ----
function handleCreateRoom(e) {
    e.preventDefault();
    const name = document.getElementById('host-name').value.trim();
    if (!name) return;

    userName = name;
    socket.emit('create-room', { name });
}

socket.on('room-created', (data) => {
    currentRoom = data.code;
    userRole = 'host';

    // Update UI
    document.getElementById('display-room-code').textContent = data.code;
    document.getElementById('host-name-display').textContent = data.userName;

    // Show upload area only for host
    document.getElementById('book-upload-area').style.display = 'block';

    showScreen('room-screen');
    showToast(`Room created! Share code: ${data.code}`, 'success');
});

// ---- Room Joining ----
function handleJoinRoom(e) {
    e.preventDefault();
    const name = document.getElementById('guest-name').value.trim();
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();

    if (!name || !code) return;

    userName = name;
    document.getElementById('join-error').style.display = 'none';

    socket.emit('join-room', { name, code });
}

socket.on('room-joined', (data) => {
    currentRoom = data.code;
    userRole = 'guest';

    // Update UI
    document.getElementById('display-room-code').textContent = data.code;
    document.getElementById('host-name-display').textContent = data.hostName;
    document.getElementById('guest-name-display').textContent = data.userName;
    document.getElementById('guest-role-text').textContent = 'Guest';
    document.getElementById('guest-status').className = 'user-status online';
    document.getElementById('guest-status-text').textContent = 'Connected';

    // Guest avatar
    document.querySelector('.guest-avatar').style.background = 'linear-gradient(135deg, #4ade80, #22c55e)';
    document.querySelector('.guest-avatar').style.color = 'white';

    // Hide upload area for guest
    document.getElementById('book-upload-area').style.display = 'none';

    // Show book if already uploaded
    if (data.book) {
        bookInfo = data.book;
        showBookInfo(data.book);
    }

    showScreen('room-screen');
    showToast(`Joined room ${data.code}!`, 'success');
});

socket.on('join-error', (data) => {
    const errorEl = document.getElementById('join-error');
    errorEl.textContent = data.message;
    errorEl.style.display = 'block';
});

// ---- Guest Joined (Host receives this) ----
socket.on('user-joined', (data) => {
    document.getElementById('guest-name-display').textContent = data.name;
    document.getElementById('guest-role-text').textContent = 'Guest';
    document.getElementById('guest-status').className = 'user-status online';
    document.getElementById('guest-status-text').textContent = 'Connected';

    // Guest avatar
    document.querySelector('.guest-avatar').style.background = 'linear-gradient(135deg, #4ade80, #22c55e)';
    document.querySelector('.guest-avatar').style.color = 'white';

    showToast(`${data.name} joined the room!`, 'success');
    showNotification(`${data.name} has joined! You can now start reading together.`);
});

// ---- Book Upload ----
const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('book-file-input');

if (uploadZone) {
    // Drag and drop
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('dragover');
    });

    uploadZone.addEventListener('dragleave', () => {
        uploadZone.classList.remove('dragover');
    });

    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            uploadBook(files[0]);
        }
    });

    // Click to browse
    uploadZone.addEventListener('click', (e) => {
        if (e.target.tagName !== 'BUTTON') {
            fileInput.click();
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            uploadBook(e.target.files[0]);
        }
    });
}

function uploadBook(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['epub', 'pdf'].includes(ext)) {
        showToast('Only EPUB and PDF files are supported.', 'error');
        return;
    }

    if (file.size > 100 * 1024 * 1024) {
        showToast('File size exceeds 100MB limit.', 'error');
        return;
    }

    // Show progress
    document.getElementById('upload-zone').style.display = 'none';
    document.getElementById('upload-progress').style.display = 'block';

    const formData = new FormData();
    formData.append('book', file);
    formData.append('roomCode', currentRoom);

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            document.getElementById('progress-fill').style.width = pct + '%';
            document.getElementById('progress-text').textContent = `Uploading... ${pct}%`;
        }
    });

    xhr.addEventListener('load', () => {
        document.getElementById('upload-progress').style.display = 'none';

        if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            bookInfo = data.book;
            showBookInfo(data.book);
            showToast('Book uploaded successfully!', 'success');
        } else {
            document.getElementById('upload-zone').style.display = 'block';
            showToast('Upload failed. Please try again.', 'error');
        }
    });

    xhr.addEventListener('error', () => {
        document.getElementById('upload-progress').style.display = 'none';
        document.getElementById('upload-zone').style.display = 'block';
        showToast('Upload failed. Please try again.', 'error');
    });

    const uploadUrl = BACKEND_URL ? `${BACKEND_URL}/upload` : '/upload';
    xhr.open('POST', uploadUrl);
    xhr.send(formData);
}

// ---- Book Available (notified via socket) ----
socket.on('book-available', (book) => {
    bookInfo = book;
    showBookInfo(book);
    if (userRole === 'guest') {
        showToast('A new book has been uploaded!', 'success');
    }
});

function showBookInfo(book) {
    document.getElementById('book-name').textContent = book.originalName;
    document.getElementById('book-size').textContent = formatFileSize(book.size);
    document.getElementById('book-info-card').style.display = 'flex';

    // Hide upload area
    if (document.getElementById('upload-zone')) {
        document.getElementById('upload-zone').style.display = 'none';
    }
    if (document.getElementById('upload-progress')) {
        document.getElementById('upload-progress').style.display = 'none';
    }
}

// ---- Reading ----
function startReading() {
    if (!bookInfo || !currentRoom) return;

    // Store session info
    sessionStorage.setItem('readTogether', JSON.stringify({
        roomCode: currentRoom,
        role: userRole,
        userName: userName,
        book: bookInfo
    }));

    window.location.href = '/reader.html';
}

function downloadBook() {
    if (!currentRoom) return;
    const downloadUrl = BACKEND_URL ? `${BACKEND_URL}/download/${currentRoom}` : `/download/${currentRoom}`;
    window.open(downloadUrl, '_blank');
}

// ---- Copy Room Code ----
function copyRoomCode() {
    const code = document.getElementById('display-room-code').textContent;
    navigator.clipboard.writeText(code).then(() => {
        showToast('Room code copied!', 'success');
    }).catch(() => {
        // Fallback
        const textArea = document.createElement('textarea');
        textArea.value = code;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showToast('Room code copied!', 'success');
    });
}

// ---- Notifications ----
function showNotification(text) {
    const banner = document.getElementById('notification-banner');
    document.getElementById('notification-text').textContent = text;
    banner.style.display = 'block';
    setTimeout(() => {
        banner.style.display = 'none';
    }, 8000);
}

// ---- Disconnect Handling ----
socket.on('guest-disconnected', (data) => {
    document.getElementById('guest-status').className = 'user-status waiting';
    document.getElementById('guest-status-text').textContent = 'Disconnected';
    showToast(data.message, 'error');
});

socket.on('host-disconnected', (data) => {
    showToast(data.message, 'error');
});

socket.on('guest-reconnected', (data) => {
    document.getElementById('guest-status').className = 'user-status online';
    document.getElementById('guest-status-text').textContent = 'Connected';
    showToast(`${data.name} reconnected!`, 'success');
});

socket.on('host-reconnected', () => {
    showToast('Host reconnected!', 'success');
});

// ---- Toast System ----
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'toastOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ---- Utility ----
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ---- Connection Status ----
socket.on('connect', () => {
    console.log('Connected to server');
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
});

socket.on('reconnect', () => {
    // Try to rejoin room
    if (currentRoom && userRole) {
        socket.emit('reconnect-room', {
            roomCode: currentRoom,
            role: userRole,
            name: userName
        });
    }
});
