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

  // Scrapes the current listing page into a template: title, price, description,
  // and the listing's photo URLs (the large Facebook CDN images on the page).
  scrapeListingForTemplate() {
    const cur = this.scrapeCurrentListing() || {};
    const title = cur.title || document.querySelector('h1')?.textContent?.trim() || '';

    // Collect the big photos: Facebook CDN images that are reasonably large
    // (skip avatars, icons, reaction images). Dedupe by base URL.
    const photoUrls = [];
    const seen = new Set();
    document.querySelectorAll('img[src*="scontent"], img[src*="fbcdn"]').forEach(img => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 250 || h < 250) return;                 // skip small images (avatars/icons)
      const src = img.currentSrc || img.src;
      if (!src) return;
      const key = src.split('?')[0];
      if (seen.has(key)) return; seen.add(key);
      photoUrls.push(src);
    });

    return {
      title,
      price: cur.price || '',
      description: cur.description || '',
      url: cur.url || location.href,
      photoUrls: photoUrls.slice(0, 10),
    };
  },
};
