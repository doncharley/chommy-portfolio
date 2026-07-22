import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your-gemini-api-key-here') {
  console.error('\x1b[31m%s\x1b[0m', '⚠  GEMINI_API_KEY is not set in .env');
  console.log('Get your key at: https://aistudio.google.com/apikey');
  console.log('Then add it to .env: GEMINI_API_KEY="your-key-here"\n');
}

// ── Express server (serves static files + health check) ──
const app = express();
app.use(express.static(__dirname));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', gemini_configured: !!GEMINI_API_KEY && GEMINI_API_KEY !== 'your-gemini-api-key-here' });
});

const server = createServer(app);

// ── WebSocket server (proxies to Gemini Live API) ──
const wss = new WebSocketServer({ server, path: '/ws/voice' });

wss.on('connection', (clientWs, req) => {
  console.log(`[proxy] Client connected from ${req.socket.remoteAddress}`);

  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your-gemini-api-key-here') {
    clientWs.send(JSON.stringify({
      error: 'GEMINI_API_KEY not configured on server. Add it to .env and restart.'
    }));
    clientWs.close(1011, 'API key not configured');
    return;
  }

  // Connect to Gemini Live API
  let geminiWs;
  try {
    geminiWs = new WebSocket(GEMINI_WS_URL);
  } catch (err) {
    console.error('[proxy] Failed to create Gemini WebSocket:', err.message);
    clientWs.send(JSON.stringify({ error: 'Failed to connect to Gemini API.' }));
    clientWs.close(1011, 'Gemini connection failed');
    return;
  }

  let geminiReady = false;

  geminiWs.on('open', () => {
    console.log('[proxy] Connected to Gemini Live API');
    geminiReady = true;

    // Forward the setup message from client to Gemini
    // (client sends setup as first message)
  });

  geminiWs.on('message', (data) => {
    // Forward Gemini responses to client
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data.toString());
    }
  });

  geminiWs.on('error', (err) => {
    console.error('[proxy] Gemini WebSocket error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ error: 'Gemini API error: ' + err.message }));
    }
  });

  geminiWs.on('close', (code, reason) => {
    console.log(`[proxy] Gemini WebSocket closed: ${code} ${reason}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(code, reason.toString());
    }
  });

  // Forward client messages to Gemini
  clientWs.on('message', (data) => {
    if (geminiReady && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.send(data);
    }
  });

  clientWs.on('error', (err) => {
    console.error('[proxy] Client WebSocket error:', err.message);
  });

  clientWs.on('close', (code) => {
    console.log(`[proxy] Client disconnected: ${code}`);
    if (geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  });

  // Cleanup on timeout (5 min max session)
  const timeout = setTimeout(() => {
    console.log('[proxy] Session timeout (5 min)');
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1000, 'Session timeout');
    if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
  }, 5 * 60 * 1000);

  clientWs.on('close', () => clearTimeout(timeout));
  geminiWs.on('close', () => clearTimeout(timeout));
});

// ── Start server ──
server.listen(PORT, () => {
  console.log('\n\x1b[36m%s\x1b[0m', '╔══════════════════════════════════════╗');
  console.log('\x1b[36m%s\x1b[0m', '║   Chommy Voice Agent Server          ║');
  console.log('\x1b[36m%s\x1b[0m', '╚══════════════════════════════════════╝');
  console.log(`\n  🌐 Static files:  http://localhost:${PORT}`);
  console.log(`  🔌 Voice WebSocket: ws://localhost:${PORT}/ws/voice`);
  console.log(`  💓 Health check:   http://localhost:${PORT}/health`);
  console.log(`  🗝  API Key:       ${GEMINI_API_KEY && GEMINI_API_KEY !== 'your-gemini-api-key-here' ? '✅ Configured' : '❌ Not set (add to .env)'}\n`);
});
