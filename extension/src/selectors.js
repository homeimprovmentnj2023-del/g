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
};
