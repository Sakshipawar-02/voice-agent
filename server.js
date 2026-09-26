import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import multer from 'multer';
import { initDB, saveConversation, getConversations } from './database.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite Database
initDB();

// REST API Endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'voice-agent', timestamp: new Date().toISOString() });
});

app.get('/api/history', async (req, res) => {
  try {
    const logs = await getConversations();
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/audio-upload', upload.single('audio'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded' });
  }
  res.json({
    message: 'Audio received successfully',
    filename: req.file.filename,
    size: req.file.size
  });
});

// WebSocket Handler for Real-Time Bidirectional Voice/Audio
wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  ws.on('message', async (message) => {
    try {
      // 1. Handle JSON Control Messages (e.g. metadata or config)
      if (typeof message === 'string' || (Buffer.isBuffer(message) && message.toString().trim().startsWith('{'))) {
        const payload = JSON.parse(message.toString());
        console.log('[WS] Received control signal:', payload);

        if (payload.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        } else if (payload.type === 'start') {
          ws.send(JSON.stringify({ type: 'status', message: 'Voice stream active' }));
        }
        return;
      }

      // 2. Handle Binary PCM Audio Streaming Chunks
      if (Buffer.isBuffer(message)) {
        // Echo back audio acknowledge or process chunk
        // Here you pass the binary buffer to Sarvam AI, Groq, or Gemini WebSocket pipelines
        ws.send(JSON.stringify({
          type: 'audio_ack',
          bytesReceived: message.length
        }));
      }

    } catch (err) {
      console.error('[WS] Error parsing websocket message:', err.message);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('[WS] Socket error:', err);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`Voice Agent Server running on port ${PORT}`);
  console.log(`Web App: http://localhost:${PORT}`);
  console.log(`========================================`);
});