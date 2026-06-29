// Reads listing data from the current Facebook Marketplace page.
window.FBMScraper = {
  // Extracts the listing ID from the current URL or a link href.
  extractId(url) {
    const m = (url || location.href).match(/\/marketplace\/item\/(\d+)/);
    return m ? m[1] : null;
  },

  // True when we're on the user's own "Your Listings" page.
  isYourListingsPage() {
    return /\/marketplace\/you(\/|$)/.test(location.pathname);
  },

  // True when the current listing detail page is one the user OWNS — detected by
  // owner-only controls. Conservative: defaults to false so other people's
  // listings are never tracked as "yours".
  isOwnListing() {
    if (this.isYourListingsPage()) return true;
    const labels = ['mark as sold', 'mark as available', 'mark as pending', 'edit listing',
      'boost listing', 'manage listing', 'delete listing', 'listing insights'];
    const nodes = document.querySelectorAll('[aria-label], div[role="button"]');
    for (const el of nodes) {
      const t = ((el.getAttribute && el.getAttribute('aria-label')) || el.textContent || '').trim().toLowerCase();
      if (t && t.length < 40 && labels.some(l => t === l || t.includes(l))) return true;
    }
    return false;
  },

  // Read a status from a "Your Listings" card (Pending / Sold / etc.).
  cardStatus(container) {
    const txt = ((container && container.textContent) || '').toLowerCase();
    if (/\bsold\b/.test(txt)) return 'removed';
    if (/\bpending\b/.test(txt)) return 'pending';
    if (/\bexpired\b/.test(txt)) return 'expired';
    if (/needs? attention|action required/.test(txt)) return 'requires_attention';
    return 'active';
  },

  // Scrapes visible listing cards. Tags them as OWNED only on the Your Listings page.
  scrapeListingCards() {
    const S = window.FBM_SELECTORS;
    const owned = this.isYourListingsPage();
    const cards = [];
    document.querySelectorAll('a[href*="/marketplace/item/"]').forEach(link => {
      const id = this.extractId(link.href);
      if (!id) return;
      const container = link.closest('div[class]') || link.parentElement;
      const title = container?.querySelector(S.listingTitle)?.textContent?.trim() || '';
      const price = container?.querySelector(S.listingPrice)?.textContent?.trim() || '';
      if (id && (title || price)) {
        cards.push({ id, title, price, url: link.href, owned, status: owned ? this.cardStatus(container) : undefined });
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

    return { id, title, price, status, description, url: location.href, owned: this.isOwnListing(), scrapedAt: Date.now() };
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

  // Scrapes the current listing page into a template. Uses Facebook's og: meta
  // tags (the most reliable source) and falls back to DOM scraping.
  scrapeListingForTemplate() {
    const og = (p) => document.querySelector(`meta[property="og:${p}"]`)?.getAttribute('content') || '';

    // Title — og:title, then the first <h1>.
    let title = og('title') || document.querySelector('h1')?.textContent?.trim() || '';
    title = title.replace(/\s*[-–|]\s*Facebook.*$/i, '').trim();

    // Price — scan the main column for the first "$1,234" token.
    let price = '';
    const priceEl = [...document.querySelectorAll('span, div')]
      .find(el => /^\s*\$[\d,]+(\.\d+)?\s*$/.test(el.textContent || ''));
    if (priceEl) price = priceEl.textContent.trim();
    if (!price) { const m = (og('title') + ' ' + (document.body.innerText || '')).match(/\$[\d,]+(\.\d{2})?/); if (m) price = m[0]; }

    // Description — og:description, then a long text block.
    let description = og('description') || '';
    if (!description) {
      const blocks = [...document.querySelectorAll('div[data-ad-preview="message"], span, div')]
        .map(e => (e.textContent || '').trim())
        .filter(t => t.length > 40 && t.length < 1500);
      description = blocks.sort((a, b) => b.length - a.length)[0] || '';
    }

    // Category — a marketplace category link, or text after a "Category" label.
    let category = '';
    const catLink = document.querySelector('a[href*="/marketplace/category/"]');
    if (catLink) category = catLink.textContent.trim();
    if (!category) {
      const labelled = [...document.querySelectorAll('span, div')]
        .find(e => /^\s*Category\s*:?/i.test(e.textContent || '') && (e.textContent || '').length < 60);
      if (labelled) category = labelled.textContent.replace(/^\s*Category\s*:?\s*/i, '').trim();
    }

    // Photos — og:image (the primary listing photo) plus other large FB images.
    const photoUrls = [];
    const seen = new Set();
    const addUrl = (src) => {
      if (!src) return;
      const key = src.split('?')[0];
      if (seen.has(key)) return; seen.add(key);
      photoUrls.push(src);
    };
    document.querySelectorAll('meta[property="og:image"]').forEach(m => addUrl(m.getAttribute('content')));
    document.querySelectorAll('img[src*="scontent"], img[src*="fbcdn"]').forEach(img => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 250 || h < 250) return; // skip avatars/icons
      addUrl(img.currentSrc || img.src);
    });

    // Location — Facebook item pages show "Listed in City, ST" or a place link.
    let listingLocation = '';
    const li = [...document.querySelectorAll('a, span, div')]
      .find(e => /^\s*listed in /i.test(e.textContent || '') && (e.textContent || '').length < 60);
    if (li) listingLocation = li.textContent.replace(/^\s*listed in\s*/i, '').trim();
    if (!listingLocation) {
      const m = [...document.querySelectorAll('span, a')]
        .find(e => /[A-Za-z]+,\s*[A-Z]{2}\b/.test(e.textContent || '') && (e.textContent || '').length < 40);
      if (m) listingLocation = m.textContent.trim();
    }

    return { title, price, description, category, location: listingLocation, url: location.href, photoUrls: photoUrls.slice(0, 10) };
  },
};
