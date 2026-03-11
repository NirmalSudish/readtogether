/* ============================================
   READ TOGETHER - App / Lobby Logic
   ============================================ */

// Socket connection
// Socket connection - Use BACKEND_URL or auto-detect based on current origin
const connectionUrl = BACKEND_URL || window.location.origin;
console.log("Connecting Lobby to:", connectionUrl);

const socket = io(connectionUrl, {
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
    showLobbyCallButtons();
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
    showLobbyCallButtons();
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

    // Only host can start reading
    if (userRole === 'guest') {
        document.getElementById('start-reading-btn').style.display = 'none';
    } else {
        document.getElementById('start-reading-btn').style.display = 'flex';
    }

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

    // Notify guest to join
    socket.emit('start-reading');

    showReaderScreen();
}

function showReaderScreen() {
    showScreen('reader-screen');
    // Small delay ensures display:block dimensions are painted before EPUB.js reads them
    if (typeof initReaderSPA === 'function') {
        setTimeout(initReaderSPA, 50);
    }
}

function exitReader() {
    showScreen('room-screen');
    // We don't fully destroy the reader state here so reconnection is fast
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

// ---- Disconnect & Start Handling ----
socket.on('host-started-reading', () => {
    if (userRole === 'guest' && bookInfo && currentRoom) {
        showToast('Host started reading! Joining...', 'success');
        showReaderScreen();
    }
});

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

// ============================================
// Lobby WebRTC Call (Audio / Video)
// ============================================

let lobbyLocalStream = null;
let lobbyPeer = null;
let lobbyCallMode = 'audio';
let lobbyPendingCandidates = [];

let lobbyRtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Fetch premium TURN credentials via backend on load
async function fetchLobbyTurnConfig() {
    try {
        const response = await fetch(`${BACKEND_URL}/api/get-turn-credentials`);
        const data = await response.json();
        if (data.iceServers) {
            lobbyRtcConfig.iceServers = data.iceServers;
            console.log("Using secured ICE config");
        }
    } catch (e) {
        console.error("Failed to fetch TURN config, falling back to STUN", e);
    }
}
fetchLobbyTurnConfig();

function showLobbyCallButtons() {
    document.getElementById('lobby-call-actions').style.display = 'block';
}

async function startLobbyCall(mode) {
    lobbyCallMode = mode;
    const useVideo = mode === 'video';

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: useVideo });
        lobbyLocalStream = stream;

        document.getElementById('lobby-call-actions').style.display = 'none';
        const widget = document.getElementById('video-widget');
        widget.style.display = 'block';
        document.getElementById('call-status-text').textContent = useVideo ? 'Video call ringing...' : 'Audio call ringing...';

        if (useVideo) {
            document.getElementById('reader-cam-ctrl').style.display = 'flex';
            document.getElementById('local-video').srcObject = stream;
        }

        createLobbyPeer();

        const offer = await lobbyPeer.createOffer();
        await lobbyPeer.setLocalDescription(offer);
        socket.emit('webrtc-offer', { offer, mode });

    } catch (err) {
        console.error('Lobby call error:', err);
        alert('Could not access microphone/camera. Check browser permissions.');
    }
}

function createLobbyPeer() {
    lobbyPeer = new RTCPeerConnection(lobbyRtcConfig);
    const statusText = document.getElementById('call-status-text');

    lobbyPeer.oniceconnectionstatechange = () => {
        console.log("Lobby ICE State:", lobbyPeer.iceConnectionState);
        if (lobbyPeer.iceConnectionState === 'failed') {
            statusText.textContent = "Connection Failed. Check NAT/Twilio.";
        }
    };

    if (lobbyLocalStream) {
        lobbyLocalStream.getTracks().forEach(t => lobbyPeer.addTrack(t, lobbyLocalStream));
    }

    lobbyPeer.onicecandidate = e => {
        if (e.candidate) socket.emit('webrtc-ice-candidate', { candidate: e.candidate });
    };

    lobbyPeer.ontrack = e => {
        const remoteVideo = document.getElementById('remote-video');
        remoteVideo.srcObject = e.streams[0];
        remoteVideo.play().catch(err => console.error("Play error:", err));
        document.getElementById('call-status-text').textContent = lobbyCallMode === 'video' ? 'Video call connected' : 'Audio call connected ✓';

        if (lobbyCallMode === 'video') {
            document.getElementById('video-widget').classList.add('video-active'); // ensure layout adapts
        }
        document.getElementById('video-waiting-overlay').style.display = 'none';
    };
}

async function handleLobbyOffer(data) {
    lobbyCallMode = data.mode || 'audio';
    const useVideo = lobbyCallMode === 'video';

    const accept = confirm(`Incoming ${lobbyCallMode} call. Accept?`);
    if (!accept) {
        socket.emit('call-ended');
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: useVideo });
        lobbyLocalStream = stream;

        document.getElementById('lobby-call-actions').style.display = 'none';
        const widget = document.getElementById('video-widget');
        widget.style.display = 'block';
        document.getElementById('call-status-text').textContent = useVideo ? 'Video call connected' : 'Audio call connected ✓';

        if (useVideo) {
            document.getElementById('reader-cam-ctrl').style.display = 'flex';
            document.getElementById('local-video').srcObject = stream;
        }

        createLobbyPeer();
        await lobbyPeer.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await lobbyPeer.createAnswer();
        await lobbyPeer.setLocalDescription(answer);

        for (const c of lobbyPendingCandidates) {
            try { await lobbyPeer.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { }
        }
        lobbyPendingCandidates = [];

        socket.emit('webrtc-answer', { answer, mode: lobbyCallMode });

    } catch (err) {
        console.error('Lobby answer error:', err);
        socket.emit('call-ended');
        alert('Failed to access camera or microphone.');
    }
}

async function handleLobbyAnswer(data) {
    if (lobbyPeer) {
        await lobbyPeer.setRemoteDescription(new RTCSessionDescription(data.answer));
        for (const c of lobbyPendingCandidates) {
            try { await lobbyPeer.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { }
        }
        lobbyPendingCandidates = [];
    }
}

async function handleLobbyIce(data) {
    if (lobbyPeer && lobbyPeer.remoteDescription && lobbyPeer.remoteDescription.type) {
        try { await lobbyPeer.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) { }
    } else {
        lobbyPendingCandidates.push(data.candidate);
    }
}

function endLobbyCall() {
    if (lobbyPeer) { lobbyPeer.close(); lobbyPeer = null; }
    if (lobbyLocalStream) { lobbyLocalStream.getTracks().forEach(t => t.stop()); lobbyLocalStream = null; }

    document.getElementById('video-widget').style.display = 'none';
    document.getElementById('video-waiting-overlay').style.display = 'flex';
    const actions = document.getElementById('lobby-call-actions');
    if (actions) actions.style.display = 'block';
    lobbyPendingCandidates = [];
    socket.emit('call-ended');
}

function toggleLobbyMic() {
    if (!lobbyLocalStream) return;
    const track = lobbyLocalStream.getAudioTracks()[0];
    if (track) {
        track.enabled = !track.enabled;
        document.getElementById('toggle-mic-btn').classList.toggle('muted', !track.enabled);
    }
}

function toggleLobbyCam() {
    if (!lobbyLocalStream) return;
    const track = lobbyLocalStream.getVideoTracks()[0];
    if (track) {
        track.enabled = !track.enabled;
        document.getElementById('reader-cam-ctrl').classList.toggle('off', !track.enabled);
    }
}

// Wire up WebRTC signaling in the lobby
socket.on('webrtc-offer', handleLobbyOffer);
socket.on('webrtc-answer', handleLobbyAnswer);
socket.on('webrtc-ice-candidate', handleLobbyIce);
socket.on('call-ended', () => { if (lobbyPeer) endLobbyCall(); });

// Global toggle call for reader buttons
function toggleCall(mode) {
    if (lobbyLocalStream) {
        endLobbyCall();
    } else {
        startLobbyCall(mode);
    }
}
