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

  // Create listing form fields
  createListingBtn: 'a[href*="/marketplace/create"]',
  titleInput: 'label[aria-label="Title"] input, input[placeholder*="Title"]',
  priceInput: 'label[aria-label="Price"] input, input[placeholder*="Price"]',
  descriptionInput: 'label[aria-label="Description"] textarea, textarea[placeholder*="Description"]',
  categorySelect: 'label[aria-label="Category"] div[role="button"]',
  locationInput: 'label[aria-label="Location"] input',
  photoUploadBtn: 'input[type="file"][accept*="image"]',
  publishBtn: 'div[aria-label="Publish"][role="button"], div[aria-label="Next"][role="button"]',

  // Listing detail page
  listingDetailTitle: 'h1[class*="x1heor9g"], span[class*="x193iq5w"][class*="x1pd3egz"]',
  listingDetailPrice: 'span[class*="x193iq5w"][class*="xeuugli"]',
  listingDetailStatus: 'div[class*="x1n2onr6"] span[class*="x1vvkbs"]',
  listingDetailId: null, // extracted from URL: /marketplace/item/{id}

  // Competitor / browse results
  browseCard: 'div[class*="x9f619"][class*="xu3j5b3"] a[href*="/marketplace/item/"]',
  browseCardTitle: 'span[class*="x1lliihq"]',
  browseCardPrice: 'span[class*="x193iq5w"]',
  browseCardLocation: 'span[class*="x1vvkbs"]:last-child',
};
