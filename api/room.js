// api/room.js
//
// Minimal serverless proxy for Sketch Showdown's room state, backed by a
// Redis store (Upstash, via a Vercel Storage/Marketplace integration).
//
// This replaces the old setup where the browser talked directly to the
// public, unauthenticated kvdb.io service. Now:
//   - the store's credentials live only in this function's environment,
//     never in client-side code
//   - room codes and key names are validated server-side
//   - payload size is capped
//   - idle rooms expire automatically instead of living forever
//
// Access control is still "knowing the room code" — same model as before,
// just no longer sitting on a fully public third-party store with no
// account behind it. Don't reuse this pattern for anything that needs
// real per-user authentication.

const ALLOWED_KEYS = new Set(['players', 'meta', 'strokes', 'guesses']);
const ROOM_RE = /^[A-Za-z0-9_-]{4,64}$/;
const ROOM_TTL_SECONDS = 60 * 60 * 12; // idle rooms expire after 12h
const MAX_BODY_BYTES = 256 * 1024;

function bodyToString(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}

/**
 * Sends one command to the Redis REST API (Upstash's single-command form:
 * POST the command + args as a JSON array, get back {"result": ...}).
 * Accepts either the "KV_REST_API_*" or "UPSTASH_REDIS_REST_*" env var
 * names since different Vercel storage integrations use different ones.
 */
async function redisCmd(...args) {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) throw new Error('KV store is not configured (missing env vars)');
  const res = await fetch(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`redis ${args[0]} failed: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

function randomRoomCode() {
  return (Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6)).toUpperCase();
}

module.exports = async (req, res) => {
  try {
    const action = req.query.action;

    // ---- create a new room ----
    if (req.method === 'POST' && action === 'create') {
      let code;
      for (let attempt = 0; attempt < 5; attempt++) {
        code = randomRoomCode();
        const existing = await redisCmd('GET', `room:${code}:players`);
        if (existing === null) break; // unclaimed
      }
      await redisCmd('SET', `room:${code}:players`, '[]', 'EX', String(ROOM_TTL_SECONDS));
      res.status(200).json({ room: code });
      return;
    }

    // ---- read/write one key within a room ----
    const { room, key } = req.query;
    if (!ROOM_RE.test(room || '') || !ALLOWED_KEYS.has(key)) {
      res.status(400).json({ error: 'invalid room or key' });
      return;
    }
    const redisKey = `room:${room}:${key}`;

    if (req.method === 'GET') {
      const value = await redisCmd('GET', redisKey);
      if (value === null || value === undefined) { res.status(404).end(); return; }
      res.status(200).setHeader('Content-Type', 'text/plain; charset=utf-8').send(value);
      return;
    }

    if (req.method === 'POST') {
      const text = bodyToString(req);
      if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
        res.status(413).json({ error: 'payload too large' });
        return;
      }
      try { JSON.parse(text); } catch (e) {
        res.status(400).json({ error: 'body must be JSON' });
        return;
      }
      await redisCmd('SET', redisKey, text, 'EX', String(ROOM_TTL_SECONDS));
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    res.status(502).json({ error: e.message || 'upstream error' });
  }
};
