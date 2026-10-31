// =============================================================================
// Freshdesk page selectors. EVERYTHING HERE IS INTENTIONALLY EMPTY (null).
//
// I have not seen your Freshdesk HTML, so I have not guessed any selectors.
// Fill these in after inspecting a real ticket (see README, "Verify extraction").
// After editing this file: chrome://extensions -> click the reload icon on the extension.
//
// A "selector" is a normal CSS selector string, e.g. ".some-class" or "[data-test-id='x']".
// Until conversationItem and domOrder are set, "Read ticket" will tell you what is missing.
// "Read selected text" works without any selectors.
// =============================================================================

const FD_SELECTORS = {
  // Element holding the ticket subject (text is read from it). Optional but recommended.
  subject: null,

  // Element holding the ORIGINAL ticket description (the first message). Optional if
  // the description is already one of the conversationItem elements.
  description: null,

  // Matches EACH message in the conversation (customer replies, agent replies, notes).
  // One element per message. REQUIRED for "Read ticket".
  conversationItem: null,

  // Selectors searched INSIDE each conversationItem.
  item: {
    body: null, // the message text. If null, the whole item element is used.
    author: null, // optional: sender name
    time: null, // optional: timestamp (reads a "datetime" or "title" attribute first, then text)
    // Selectors for content to REMOVE from the body before reading, e.g. quoted email
    // chains or signatures. Leave [] until you have verified what they look like.
    stripSelectors: [],
  },

  // How to tell who wrote each message. Each value is a selector tested against the
  // item itself and against its descendants. Checked in this order; first match wins.
  // IMPORTANT: internal_note must be configured, otherwise private notes cannot be
  // told apart and the extension will exclude every message by default for safety.
  roles: {
    internal_note: null, // private notes (agent-only)
    customer: null, // messages from the customer/requester
    agent: null, // public replies from agents
    system: null, // status changes, automation events, etc. (excluded by default)
  },

  // Order of conversationItem elements in the page, as you verified it:
  //   'oldest-first' or 'newest-first'. REQUIRED. The extension sends oldest-first to the AI.
  domOrder: null,

  // Optional hints that older content is hidden. If an element matching one of these
  // exists on the page, the extension shows an "incomplete context" warning.
  incompleteHints: {
    loadMore: null, // button/link that loads earlier messages
    collapsedContent: null, // "show more" / "show quoted text" style toggles
  },
};
