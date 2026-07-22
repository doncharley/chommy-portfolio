// ── Cloudflare Worker: Gemini Live API WebSocket Proxy ──
// Deploys as a WebSocket relay between the browser and Gemini's Live API.

const GEMINI_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'chommy-voice-agent',
        gemini_configured: !!env.GEMINI_API_KEY
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // WebSocket upgrade
    if (url.pathname === '/ws/voice') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      if (!env.GEMINI_API_KEY) {
        return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured on server.' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Create client WebSocket pair
      const pair = new WebSocketPair();
      const [clientWs, serverWs] = Object.values(pair);

      // Accept the client connection
      serverWs.accept();

      // Connect to Gemini Live API
      const geminiUrl = `${GEMINI_WS_BASE}?key=${env.GEMINI_API_KEY}`;

      let geminiWs;
      try {
        geminiWs = new WebSocket(geminiUrl);
      } catch (err) {
        serverWs.send(JSON.stringify({ error: 'Failed to connect to Gemini API.' }));
        serverWs.close(1011, 'Gemini connection failed');
        return new Response(null, { status: 101, webSocket: clientWs });
      }

      let geminiReady = false;

      geminiWs.addEventListener('open', () => {
        geminiReady = true;
      });

      // Forward Gemini → Client
      geminiWs.addEventListener('message', (event) => {
        if (serverWs.readyState === WebSocket.OPEN) {
          serverWs.send(typeof event.data === 'string' ? event.data : event.data.toString());
        }
      });

      geminiWs.addEventListener('error', (event) => {
        console.error('[worker] Gemini error:', event.message);
        if (serverWs.readyState === WebSocket.OPEN) {
          serverWs.send(JSON.stringify({ error: 'Gemini API error.' }));
        }
      });

      geminiWs.addEventListener('close', (event) => {
        if (serverWs.readyState === WebSocket.OPEN) {
          serverWs.close(event.code, event.reason);
        }
      });

      // Forward Client → Gemini
      serverWs.addEventListener('message', (event) => {
        if (geminiReady && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(typeof event.data === 'string' ? event.data : event.data);
        }
      });

      serverWs.addEventListener('close', () => {
        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.close();
        }
      });

      // 5-minute session timeout
      const timeout = setTimeout(() => {
        if (serverWs.readyState === WebSocket.OPEN) serverWs.close(1000, 'Session timeout');
        if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
      }, 5 * 60 * 1000);

      serverWs.addEventListener('close', () => clearTimeout(timeout));
      geminiWs.addEventListener('close', () => clearTimeout(timeout));

      return new Response(null, { status: 101, webSocket: clientWs });
    }

    return new Response('Not Found', { status: 404 });
  }
};
