require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
app.use(cors()); // Allow requests from any origin (e.g., Netlify)

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 100 * 1024 * 1024, // 100MB for large files
  cors: {
    origin: '*', // Allow connections from Netlify
    methods: ['GET', 'POST']
  }
});

// Twilio TURN server generation endpoint for WebRTC stability
app.get('/api/get-turn-credentials', (req, res) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  // If no Twilio creds exist, just return standard free STUN servers
  if (!accountSid || !authToken) {
    return res.json({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
  }

  try {
    const client = twilio(accountSid, authToken);
    client.tokens.create().then(token => {
      res.json(token);
    }).catch(err => {
      console.error("Twilio error:", err);
      res.status(500).json({ error: 'Failed to fetch TURN credentials' });
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.epub', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only EPUB and PDF files are allowed'));
    }
  }
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// Room storage
const rooms = new Map();

// Generate a 6-character room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// File upload endpoint
app.post('/upload', upload.single('book'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const roomCode = req.body.roomCode;
  const room = rooms.get(roomCode);

  if (!room) {
    // Clean up uploaded file
    fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Room not found' });
  }

  // Store book info in room
  room.book = {
    originalName: req.file.originalname,
    filename: req.file.filename,
    path: `/uploads/${req.file.filename}`,
    size: req.file.size,
    type: path.extname(req.file.originalname).toLowerCase()
  };

  // Reset reading state
  room.currentPage = 0;
  room.readyUsers = new Set();

  // Notify all users in the room
  io.to(roomCode).emit('book-available', room.book);

  res.json({ success: true, book: room.book });
});

// Download endpoint
app.get('/download/:roomCode', (req, res) => {
  const room = rooms.get(req.params.roomCode);
  if (!room || !room.book) {
    return res.status(404).json({ error: 'Book not found' });
  }

  const filePath = path.join(uploadsDir, room.book.filename);
  res.download(filePath, room.book.originalName);
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create room
  socket.on('create-room', (data) => {
    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      host: {
        id: socket.id,
        name: data.name || 'Host'
      },
      guest: null,
      book: null,
      currentPage: 0,
      totalLocations: 0,
      readyUsers: new Set(),
      chatMessages: [],
      createdAt: new Date()
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = true;
    socket.userName = data.name || 'Host';

    socket.emit('room-created', {
      code: roomCode,
      role: 'host',
      userName: socket.userName
    });

    console.log(`Room created: ${roomCode} by ${socket.userName}`);
  });

  // Join room
  socket.on('join-room', (data) => {
    const roomCode = data.code.toUpperCase();
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit('join-error', { message: 'Room not found. Please check the code and try again.' });
      return;
    }

    let targetRole = 'guest';

    // Intelligent slot reassignment if a user disconnected and lost their session completely
    if (room.host && room.host.connected === false && (!room.guest || room.guest.connected !== false)) {
      // Host dropped out, let them reclaim the host slot!
      targetRole = 'host';
    } else if (room.guest && room.guest.connected === false) {
      // Guest dropped out, they reclaim the guest slot.
      targetRole = 'guest';
    } else if (!room.guest) {
      // Normal guest join
      targetRole = 'guest';
    } else if (room.host && room.host.id === socket.id) {
      targetRole = 'host';
    } else if (room.guest && room.guest.id === socket.id) {
      targetRole = 'guest';
    } else {
      // Both are strictly connected
      socket.emit('join-error', { message: 'Room is full. Only two readers per room.' });
      return;
    }

    const userName = data.name || (targetRole === 'host' ? 'Host' : 'Guest');

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = (targetRole === 'host');
    socket.userName = userName;

    if (targetRole === 'host') {
      room.host = {
        id: socket.id,
        name: userName,
        connected: true
      };

      // Let the joined user know they successfully became the host again
      socket.emit('room-created', {
        code: roomCode,
        role: 'host',
        userName: socket.userName
      });

      // If the guest is still here waiting, silently tell them the host is back!
      if (room.guest && room.guest.connected !== false) {
        io.to(room.guest.id).emit('host-reconnected', { name: userName });
      }

      console.log(`Reclaimed host slot for room: ${roomCode}`);
    } else {
      room.guest = {
        id: socket.id,
        name: userName,
        connected: true
      };

      // Send room info to guest
      socket.emit('room-joined', {
        code: roomCode,
        role: 'guest',
        userName: socket.userName,
        hostName: room.host.name,
        book: room.book,
        currentPage: room.currentPage
      });

      // Notify host that guest connected or reconnected
      if (room.host && room.host.connected !== false) {
        io.to(room.host.id).emit('user-joined', {
          name: socket.userName,
          id: socket.id
        });
      }

      console.log(`${userName} joined room: ${roomCode}`);
    }
  });

  // Start reading
  socket.on('start-reading', () => {
    socket.to(socket.roomCode).emit('host-started-reading');
  });

  // Jump to specific CFI location (shared highlight)
  socket.on('jump-to-scene', (data) => {
    socket.to(socket.roomCode).emit('jumped-to-scene', data);
  });

  // Page ready (user wants to advance)
  socket.on('page-ready', (data) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.readyUsers.add(socket.id);

    const totalUsers = room.guest ? 2 : 1;
    const readyCount = room.readyUsers.size;

    // Broadcast ready status
    io.to(socket.roomCode).emit('page-sync-update', {
      readyCount,
      totalUsers,
      readyUsers: Array.from(room.readyUsers)
    });

    // If all users are ready, advance the page
    if (readyCount >= totalUsers && totalUsers === 2) {
      room.currentPage = data.nextPage;
      room.readyUsers.clear();

      io.to(socket.roomCode).emit('page-advance', {
        page: room.currentPage,
        direction: data.direction || 'next'
      });
    }
  });

  // Cancel ready status
  socket.on('page-cancel', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.readyUsers.delete(socket.id);

    const totalUsers = room.guest ? 2 : 1;
    const readyCount = room.readyUsers.size;

    io.to(socket.roomCode).emit('page-sync-update', {
      readyCount,
      totalUsers,
      readyUsers: Array.from(room.readyUsers)
    });
  });

  // Set total locations
  socket.on('set-total-locations', (data) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    room.totalLocations = data.total;
  });

  // Chat message
  socket.on('chat-message', (data) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    const message = {
      id: uuidv4(),
      sender: socket.userName,
      senderId: socket.id,
      text: data.text,
      timestamp: new Date().toISOString(),
      isHighlight: data.isHighlight || false,
      cfi: data.cfi || null,
      pageIndex: data.pageIndex || 0
    };

    room.chatMessages.push(message);

    // Keep only last 200 messages
    if (room.chatMessages.length > 200) {
      room.chatMessages = room.chatMessages.slice(-200);
    }

    io.to(socket.roomCode).emit('chat-received', message);
  });

  // Bookmark
  socket.on('add-bookmark', (data) => {
    io.to(socket.roomCode).emit('bookmark-added', {
      page: data.page,
      user: socket.userName,
      label: data.label
    });
  });

  // Typing indicator
  socket.on('typing', () => {
    socket.to(socket.roomCode).emit('user-typing', {
      name: socket.userName
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);

    if (socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (!room) return;

      room.readyUsers.delete(socket.id);

      if (socket.isHost) {
        // Host disconnected - notify guest
        if (room.guest) {
          io.to(room.guest.id).emit('host-disconnected', {
            message: 'The host has disconnected.'
          });
        }
        // Keep room alive for reconnection
        room.host.connected = false;
      } else {
        // Guest disconnected - notify host
        if (room.host) {
          io.to(room.host.id).emit('guest-disconnected', {
            message: `${socket.userName} has disconnected.`
          });
        }
        if (room.guest && room.guest.id === socket.id) {
          room.guest.connected = false;
        }
      }

      // Update sync status
      const totalUsers = (room.guest && room.guest.connected !== false) ? 2 : 1;
      const readyCount = room.readyUsers.size;
      io.to(socket.roomCode).emit('page-sync-update', {
        readyCount,
        totalUsers,
        readyUsers: Array.from(room.readyUsers)
      });
    }
  });

  // --- WebRTC Signaling ---
  socket.on('webrtc-offer', (data) => {
    socket.to(socket.roomCode).emit('webrtc-offer', {
      offer: data.offer,
      mode: data.mode,
      senderId: socket.id
    });
  });

  socket.on('webrtc-answer', (data) => {
    socket.to(socket.roomCode).emit('webrtc-answer', {
      answer: data.answer,
      mode: data.mode,
      senderId: socket.id
    });
  });

  socket.on('webrtc-ice-candidate', (data) => {
    socket.to(socket.roomCode).emit('webrtc-ice-candidate', {
      candidate: data.candidate,
      senderId: socket.id
    });
  });

  socket.on('call-ended', () => {
    socket.to(socket.roomCode).emit('call-ended');
  });

  // Reconnect to room
  socket.on('reconnect-room', (data) => {
    const room = rooms.get(data.roomCode);
    if (!room) {
      socket.emit('reconnect-error', { message: 'Room no longer exists.' });
      return;
    }

    socket.join(data.roomCode);
    socket.roomCode = data.roomCode;

    if (data.role === 'host' && room.host) {
      room.host.id = socket.id;
      room.host.connected = true;
      socket.isHost = true;
      socket.userName = room.host.name;

      if (room.guest) {
        io.to(room.guest.id).emit('host-reconnected', { name: room.host.name });
      }
    } else if (data.role === 'guest' && room.guest) {
      room.guest.id = socket.id;
      room.guest.connected = true;
      socket.isHost = false;
      socket.userName = room.guest.name;

      if (room.host) {
        io.to(room.host.id).emit('guest-reconnected', { name: room.guest.name });
      }
    }

    socket.emit('reconnect-success', {
      code: data.roomCode,
      role: data.role,
      book: room.book,
      currentPage: room.currentPage,
      userName: socket.userName
    });
  });
});

// Cleanup old rooms every hour
setInterval(() => {
  const now = new Date();
  for (const [code, room] of rooms) {
    const age = now - room.createdAt;
    if (age > 24 * 60 * 60 * 1000) { // 24 hours
      // Clean up uploaded book file
      if (room.book) {
        const filePath = path.join(uploadsDir, room.book.filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
      rooms.delete(code);
      console.log(`Cleaned up old room: ${code}`);
    }
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n📚 Read Together server running at http://localhost:${PORT}\n`);
});
