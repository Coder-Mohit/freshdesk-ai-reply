// Minimal Gemini client using the REST generateContent endpoint (Node 18+ has fetch built in).
// Ticket text is never logged here.

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

class GeminiError extends Error {
  constructor(publicMessage, httpStatus = 502) {
    super(publicMessage);
    this.publicMessage = publicMessage;
    this.httpStatus = httpStatus;
  }
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    missingInformation: { type: 'ARRAY', items: { type: 'STRING' } },
    notesForAgent: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['reply', 'missingInformation', 'notesForAgent'],
};

async function generateDraft({ apiKey, model, systemInstruction, userContent }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  let response;
  try {
    response = await fetch(`${BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
        generationConfig: {
          temperature: 0.4,
          // Generous on purpose: some Gemini models spend part of this budget on internal "thinking".
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new GeminiError('Gemini took too long to respond.', 504);
    throw new GeminiError('Could not reach Gemini.', 502);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (response.status === 429) throw new GeminiError('Gemini quota or rate limit reached. Try again later.', 429);
    if (response.status === 400 || response.status === 403 || response.status === 404) {
      throw new GeminiError(
        `Gemini rejected the request (HTTP ${response.status}). Check GEMINI_API_KEY and GEMINI_MODEL.`,
        502
      );
    }
    throw new GeminiError(`Gemini returned HTTP ${response.status}.`, 502);
  }

  const data = await response.json();
  const candidate = data.candidates && data.candidates[0];
  if (!candidate) {
    const reason = data.promptFeedback && data.promptFeedback.blockReason;
    throw new GeminiError(reason ? `Gemini blocked the request (${reason}).` : 'Gemini returned no answer.');
  }

  const text = ((candidate.content && candidate.content.parts) || []).map((p) => p.text || '').join('');
  if (!text) throw new GeminiError(`Gemini returned an empty answer (finishReason: ${candidate.finishReason}).`);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeminiError(`Gemini returned invalid JSON (finishReason: ${candidate.finishReason}).`);
  }
  if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) {
    throw new GeminiError('Gemini returned an empty reply.');
  }

  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
  return {
    reply: parsed.reply.trim(),
    missingInformation: list(parsed.missingInformation),
    notesForAgent: list(parsed.notesForAgent),
  };
}

module.exports = { generateDraft, GeminiError };
