// ── Cloudflare Worker: Gemini Live API WebSocket Proxy ──
const GEMINI_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Upgrade, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Protocol',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'chommy-voice-agent',
        gemini_configured: !!env.GEMINI_API_KEY
      }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }

    if (url.pathname === '/ws/voice') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426, headers: CORS_HEADERS });
      }

      if (!env.GEMINI_API_KEY) {
        return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured.' }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }

      const pair = new WebSocketPair();
      const [clientWs, serverWs] = Object.values(pair);
      serverWs.accept();

      ctx.waitUntil(this.handleVoiceConnection(serverWs, env));

      return new Response(null, { status: 101, webSocket: clientWs });
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  },

  async handleVoiceConnection(serverWs, env) {
    const geminiUrl = `${GEMINI_WS_BASE}?key=${env.GEMINI_API_KEY}`;
    let geminiWs;
    let geminiReady = false;
    const pendingMessages = []; // Buffer messages until Gemini is ready

    try {
      geminiWs = new WebSocket(geminiUrl);
    } catch (err) {
      console.error('[worker] Failed to create Gemini WS:', err.message);
      safeSend(serverWs, JSON.stringify({ type: 'error', error: 'Failed to connect to Gemini.' }));
      serverWs.close(1011, 'Gemini connection failed');
      return;
    }

    const connectTimeout = setTimeout(() => {
      if (!geminiReady) {
        console.error('[worker] Gemini connection timeout');
        safeSend(serverWs, JSON.stringify({ type: 'error', error: 'Gemini API timed out.' }));
        try { geminiWs.close(); } catch (e) {}
        serverWs.close(1011, 'Gemini timeout');
      }
    }, 10000);

    geminiWs.addEventListener('open', () => {
      geminiReady = true;
      clearTimeout(connectTimeout);
      console.log('[worker] Connected to Gemini Live API');

      // Flush buffered messages
      for (const msg of pendingMessages) {
        try {
          geminiWs.send(msg);
        } catch (e) {
          console.error('[worker] Failed to send buffered message:', e.message);
        }
      }
      pendingMessages.length = 0;
    });

    geminiWs.addEventListener('message', (event) => {
      if (serverWs.readyState !== WebSocket.OPEN) return;
      try {
        serverWs.send(event.data);
      } catch (e) {
        console.error('[worker] Gemini→Client error:', e.message);
      }
    });

    geminiWs.addEventListener('error', (event) => {
      console.error('[worker] Gemini WS error');
      safeSend(serverWs, JSON.stringify({ type: 'error', error: 'Gemini API error.' }));
    });

    geminiWs.addEventListener('close', (event) => {
      clearTimeout(connectTimeout);
      console.log(`[worker] Gemini closed: ${event.code}`);
      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.close(event.code, event.reason || 'Gemini disconnected');
      }
    });

    // Client → Gemini (with buffering)
    serverWs.addEventListener('message', (event) => {
      try {
        if (geminiReady && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(event.data);
        } else {
          // Buffer until Gemini is connected
          pendingMessages.push(event.data);
        }
      } catch (e) {
        console.error('[worker] Client→Gemini error:', e.message);
      }
    });

    serverWs.addEventListener('close', () => {
      clearTimeout(connectTimeout);
      pendingMessages.length = 0;
      if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
    });

    const sessionTimeout = setTimeout(() => {
      console.log('[worker] Session timeout');
      if (serverWs.readyState === WebSocket.OPEN) serverWs.close(1000, 'Session timeout');
      if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
    }, 5 * 60 * 1000);

    serverWs.addEventListener('close', () => clearTimeout(sessionTimeout));
    geminiWs.addEventListener('close', () => clearTimeout(sessionTimeout));
  }
};

function safeSend(ws, data) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch (e) {}
}
