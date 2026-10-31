require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const { validateRequest } = require('./sanitize');
const { SYSTEM_INSTRUCTION, buildUserContent } = require('./prompt');
const { generateDraft, GeminiError } = require('./gemini');

const {
  GEMINI_API_KEY,
  EXTENSION_TOKEN,
  GEMINI_MODEL = 'gemini-2.5-flash',
  PORT = '3000',
  HOST = '127.0.0.1',
  RATE_LIMIT_PER_MIN = '20',
} = process.env;

if (!GEMINI_API_KEY || !EXTENSION_TOKEN) {
  console.error('Missing GEMINI_API_KEY or EXTENSION_TOKEN. Copy .env.example to .env and fill them in.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// --- Auth: the extension must send the shared token --------------------------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const expectedHash = sha(EXTENSION_TOKEN);

function requireToken(req, res, next) {
  const supplied = req.get('x-extension-token') || '';
  if (!crypto.timingSafeEqual(sha(supplied), expectedHash)) {
    return res.status(401).json({ error: 'Invalid or missing extension token.' });
  }
  next();
}

// --- Tiny in-memory rate limiter (per IP, per minute) ------------------------
const hits = new Map();
function rateLimit(req, res, next) {
  const limit = Number(RATE_LIMIT_PER_MIN) || 20;
  const now = Date.now();
  const entry = hits.get(req.ip);
  if (!entry || entry.resetAt < now) {
    hits.set(req.ip, { count: 1, resetAt: now + 60000 });
    return next();
  }
  entry.count += 1;
  if (entry.count > limit) {
    return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
  }
  next();
}

// --- Routes ------------------------------------------------------------------
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/generate', requireToken, rateLimit, async (req, res, next) => {
  try {
    const { value, error } = validateRequest(req.body);
    if (error) return res.status(400).json({ error });

    const draft = await generateDraft({
      apiKey: GEMINI_API_KEY,
      model: GEMINI_MODEL,
      systemInstruction: SYSTEM_INSTRUCTION,
      userContent: buildUserContent(value),
    });

    res.json({ ...draft, model: GEMINI_MODEL, truncated: value.truncated });
  } catch (err) {
    next(err);
  }
});

// --- Error handler: log only the kind of failure, never request content -------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof GeminiError) {
    console.error(`[generate] ${err.httpStatus}: ${err.publicMessage}`);
    return res.status(err.httpStatus).json({ error: err.publicMessage });
  }
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: 'Invalid or too large JSON body.' });
  }
  console.error(`[server] unexpected error: ${err.name}`);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(Number(PORT), HOST, () => {
  console.log(`AI reply backend listening on http://${HOST}:${PORT} (model: ${GEMINI_MODEL})`);
});
