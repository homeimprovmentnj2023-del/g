// Reads listing data from the current Facebook Marketplace page.
window.FBMScraper = {
  // Extracts the listing ID from the current URL or a link href.
  extractId(url) {
    const m = (url || location.href).match(/\/marketplace\/item\/(\d+)/);
    return m ? m[1] : null;
  },

  // Scrapes all visible listing cards on the "Your listings" or browse page.
  scrapeListingCards() {
    const S = window.FBM_SELECTORS;
    const cards = [];
    document.querySelectorAll('a[href*="/marketplace/item/"]').forEach(link => {
      const id = this.extractId(link.href);
      if (!id) return;
      const container = link.closest('div[class]') || link.parentElement;
      const title = container?.querySelector(S.listingTitle)?.textContent?.trim() || '';
      const price = container?.querySelector(S.listingPrice)?.textContent?.trim() || '';
      if (id && (title || price)) {
        cards.push({ id, title, price, url: link.href });
      }
    });
    // Deduplicate by id
    const seen = new Set();
    return cards.filter(c => seen.has(c.id) ? false : seen.add(c.id));
  },

  // Scrapes the detail view for the current listing page.
  scrapeCurrentListing() {
    const S = window.FBM_SELECTORS;
    const id = this.extractId(location.href);
    if (!id) return null;

    const title = document.querySelector(S.listingDetailTitle)?.textContent?.trim() || '';
    const price = document.querySelector(S.listingDetailPrice)?.textContent?.trim() || '';
    const status = document.querySelector(S.listingDetailStatus)?.textContent?.trim() || 'active';
    const description = document.querySelector('div[data-ad-preview="message"]')?.textContent?.trim() || '';

    return { id, title, price, status, description, url: location.href, scrapedAt: Date.now() };
  },

  // Scrapes competitor browse results. Call while on a marketplace browse/search page.
  scrapeCompetitors() {
    const results = [];
    document.querySelectorAll('a[href*="/marketplace/item/"]').forEach(link => {
      const id = this.extractId(link.href);
      if (!id) return;
      const container = link.closest('div[class]') || link.parentElement;
      const title = container?.querySelector('span')?.textContent?.trim() || '';
      const spans = container?.querySelectorAll('span') || [];
      const price = [...spans].find(s => /\$[\d,]+/.test(s.textContent))?.textContent?.trim() || '';
      const location = [...spans].reverse().find(s => s.textContent && !s.textContent.includes('$'))?.textContent?.trim() || '';
      if (id && title) {
        results.push({ id, title, price, location, url: link.href, scrapedAt: Date.now() });
      }
    });
    const seen = new Set();
    return results.filter(c => seen.has(c.id) ? false : seen.add(c.id));
  },
};
