// CSS selectors for Facebook Marketplace UI elements.
// Facebook updates their DOM regularly — this is the single file to fix when things break.
window.FBM_SELECTORS = {
  // Listing cards on the browse/your-listings page
  listingCard: '[data-testid="marketplace_pdp_component"], div[class*="x9f619"][class*="x1n2onr6"]',
  listingTitle: 'span[class*="x1lliihq"]',
  listingPrice: 'span[class*="x193iq5w"][class*="xeuugli"]',

  // Your listings page indicators
  yourListingsNav: 'a[href*="/marketplace/you/selling"]',
  listingStatusBadge: 'span[class*="x1vvkbs"]',

  // ── Create listing form ───────────────────────────────────────────────────
  // Step 0: listing type selection (appears on /marketplace/create)
  itemForSaleBtn: 'div[aria-label="Item for sale"], a[href*="/marketplace/create/item"]',

  // Step 1: fill fields
  titleInput:       'label[aria-label="Title"] input, input[placeholder*="Title"]',
  priceInput:       'label[aria-label="Price"] input, input[placeholder*="Price"]',
  descriptionInput: 'label[aria-label="Description"] textarea, textarea[placeholder*="Description"]',
  locationInput:    'label[aria-label="Location"] input, input[placeholder*="Location"]',

  // Category — click the button, then search/select
  categoryBtn:      'label[aria-label="Category"] div[role="button"], div[aria-label="Category"][role="button"]',
  categorySearch:   'input[placeholder*="Search categories"], input[aria-label*="category"]',

  // Condition dropdown
  conditionBtn:     'label[aria-label="Condition"] div[role="button"]',

  // Photo upload — hidden file input triggered by clicking a visible upload area
  photoUploadInput: 'input[type="file"][accept*="image"]',
  photoUploadArea:  'div[aria-label*="photo"], div[aria-label*="Photo"], div[role="button"][tabindex="0"] svg',

  // Navigation buttons  (text-matched in code, these are fallback attribute selectors)
  nextBtn:    'div[aria-label="Next"][role="button"], div[aria-label="next"][role="button"]',
  publishBtn: 'div[aria-label="Publish"][role="button"], div[aria-label="publish"][role="button"]',

  // Autocomplete suggestion list
  autocompleteSuggestion: 'ul[role="listbox"] li:first-child, div[role="option"]:first-child',

  // Listing detail page
  listingDetailTitle:  'h1[class*="x1heor9g"], span[class*="x193iq5w"][class*="x1pd3egz"]',
  listingDetailPrice:  'span[class*="x193iq5w"][class*="xeuugli"]',
  listingDetailStatus: 'div[class*="x1n2onr6"] span[class*="x1vvkbs"]',

  // Competitor / browse results
  browseCard:         'div[class*="x9f619"][class*="xu3j5b3"] a[href*="/marketplace/item/"]',
  browseCardTitle:    'span[class*="x1lliihq"]',
  browseCardPrice:    'span[class*="x193iq5w"]',
  browseCardLocation: 'span[class*="x1vvkbs"]:last-child',

  // ── Marketplace inbox / chat (used by marketplace-chat.js bridge) ──────────
  // These drive the read-inbound → reply loop. Facebook's chat DOM changes
  // often; verify/adjust these with the "Capture Form (debug)" tool while the
  // Marketplace inbox is open. Each value may be null until verified.
  chat: {
    // The scrolling container that holds all message rows in the open thread.
    messageList:    'div[role="main"] div[aria-label*="Messages"], div[role="main"]',
    // Each individual message row/bubble.
    messageRow:     'div[role="row"], div[data-testid="message-container"]',
    // Text node inside a message bubble.
    messageText:    'div[dir="auto"]',
    // Marks a row as the user's OWN (outbound) message so we never reply to it.
    // FB has no stable "outbound" attribute — alignment classes vary; leave the
    // selector-based ones and rely also on our injected data-fbm-bot marker.
    outboundMarker: null,
    outboundRowMatch: null,
    // The buyer's display name (thread header).
    contactName:    'div[role="main"] h1 span, div[aria-label="Conversation information"] span',
    // The reply input (contenteditable) and the send button.
    composeBox:     'div[contenteditable="true"][role="textbox"], div[aria-label*="Message"][contenteditable="true"]',
    sendButton:     'div[aria-label="Press enter to send"], div[aria-label="Send"][role="button"]',
    // ── Inbox conversation list (used to move to the next unread conversation
    //    after replying). conversationRow = each conversation entry in the left
    //    list; unreadHint = an optional explicit "unread" marker. Leave both null
    //    to use the built-in defaults (left-pane rows + bold-preview detection).
    conversationRow: null,
    unreadHint:      null,
  },
};
