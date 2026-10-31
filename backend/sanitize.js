// Validates the request body from the extension and enforces size limits.
// Nothing here logs or stores ticket text.

const ROLES = new Set(['customer', 'agent', 'internal_note', 'system', 'unlabeled']);

const LIMITS = {
  maxMessages: 40,
  maxCharsPerMessage: 4000,
  maxTotalChars: 30000,
  maxNotesChars: 3000,
  maxSubjectChars: 300,
};

const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

function validateRequest(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be a JSON object.' };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { error: '"messages" must be a non-empty array.' };
  }

  let messages = body.messages
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({
      role: ROLES.has(m.role) ? m.role : 'unlabeled',
      author: str(m.author, 100),
      time: str(m.time, 60),
      text: str(m.text, LIMITS.maxCharsPerMessage).trim(),
    }));

  if (messages.length === 0) {
    return { error: 'All messages were empty.' };
  }

  // Too long? Keep the first message (usually the original description) and the newest ones.
  let truncated = false;
  if (messages.length > LIMITS.maxMessages) {
    messages = [messages[0], ...messages.slice(-(LIMITS.maxMessages - 1))];
    truncated = true;
  }
  const total = () => messages.reduce((sum, m) => sum + m.text.length, 0);
  while (total() > LIMITS.maxTotalChars && messages.length > 2) {
    messages.splice(1, 1); // drop the oldest message after the first
    truncated = true;
  }

  return {
    value: {
      channel: body.channel === 'chat' ? 'chat' : 'email',
      subject: str(body.subject, LIMITS.maxSubjectChars),
      agentNotes: str(body.agentNotes, LIMITS.maxNotesChars).trim(),
      agentName: str(body.agentName, 80).trim(),
      messages,
      truncated,
      contextIncomplete: Boolean(body.contextIncomplete) || truncated,
    },
  };
}

module.exports = { validateRequest, LIMITS };
