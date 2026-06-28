// Main content script — runs on every facebook.com/marketplace page.
// Injects the sidebar and wires up scraper / autofill / backend communication.

const BACKEND = 'http://localhost:3333';

(function init() {
  injectSidebar();
  reportPageToBackend();
  listenForMessages();
})();

// ── Safe backend helper ────────────────────────────────────────────────────────
// Every call to the local backend goes through here so a network failure (backend
// closed / not started) NEVER throws an uncaught error — it returns {ok:false}
// and shows a friendly message instead.

async function api(path, options, { quiet = false } = {}) {
  try {
    const res = await fetch(`${BACKEND}${path}`, options);
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (!quiet) {
      showToast('Can’t reach the local app. Keep the backend window open (run start.bat).');
    }
    return { ok: false, error: err.message };
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function injectSidebar() {
  if (document.getElementById('fbm-sidebar')) return;

  const sidebar = document.createElement('div');
  sidebar.id = 'fbm-sidebar';
  sidebar.innerHTML = buildSidebarHTML();
  document.body.appendChild(sidebar);

  // Toggle button
  const toggle = document.createElement('button');
  toggle.id = 'fbm-toggle';
  toggle.textContent = '📋';
  toggle.title = 'FB Marketplace Manager';
  toggle.onclick = () => sidebar.classList.toggle('fbm-open');
  document.body.appendChild(toggle);

  wireupSidebar(sidebar);
}

function buildSidebarHTML() {
  return `
    <div id="fbm-header">
      <span>FB Marketplace Manager</span>
      <button id="fbm-close">✕</button>
    </div>
    <div id="fbm-tabs">
      <button class="fbm-tab fbm-active" data-tab="templates">Templates</button>
      <button class="fbm-tab" data-tab="listings">My Listings</button>
      <button class="fbm-tab" data-tab="competitors">Competitors</button>
    </div>
    <div id="fbm-content">
      <div id="fbm-tab-templates" class="fbm-panel fbm-active">
        <button id="fbm-new-template">+ New Template</button>
        <button id="fbm-template-from-listing">📋 Save THIS listing as Template</button>
        <div id="fbm-template-list"><p class="fbm-dim">Loading…</p></div>
      </div>
      <div id="fbm-tab-listings" class="fbm-panel">
        <button id="fbm-scan-listings">Scan This Page</button>
        <div id="fbm-listing-list"><p class="fbm-dim">Click scan to load listings.</p></div>
      </div>
      <div id="fbm-tab-competitors" class="fbm-panel">
        <button id="fbm-scan-competitors">Scan Competitors</button>
        <div id="fbm-competitor-list"><p class="fbm-dim">Click scan on a browse page.</p></div>
      </div>
    </div>
    <div id="fbm-footer">
      <a href="${BACKEND}" target="_blank">Open Dashboard ↗</a>
    </div>
  `;
}

function wireupSidebar(sidebar) {
  sidebar.querySelector('#fbm-close').onclick = () => sidebar.classList.remove('fbm-open');

  // Tab switching
  sidebar.querySelectorAll('.fbm-tab').forEach(btn => {
    btn.onclick = () => {
      sidebar.querySelectorAll('.fbm-tab').forEach(b => b.classList.remove('fbm-active'));
      sidebar.querySelectorAll('.fbm-panel').forEach(p => p.classList.remove('fbm-active'));
      btn.classList.add('fbm-active');
      sidebar.querySelector(`#fbm-tab-${btn.dataset.tab}`)?.classList.add('fbm-active');
      if (btn.dataset.tab === 'templates') loadTemplates(sidebar);
    };
  });

  sidebar.querySelector('#fbm-scan-listings').onclick = () => scanAndReportListings(sidebar).catch(reportErr);
  sidebar.querySelector('#fbm-scan-competitors').onclick = () => scanAndReportCompetitors(sidebar).catch(reportErr);
  sidebar.querySelector('#fbm-new-template').onclick = () => openNewTemplateForm(sidebar);
  sidebar.querySelector('#fbm-template-from-listing').onclick = () => saveListingAsTemplate(sidebar).catch(reportErr);

  loadTemplates(sidebar);
}

// ── Templates ─────────────────────────────────────────────────────────────────

async function loadTemplates(sidebar) {
  const list = sidebar.querySelector('#fbm-template-list');
  list.innerHTML = '<p class="fbm-dim">Loading…</p>';

  const res = await api('/api/templates', undefined, { quiet: true });
  if (!res.ok) {
    list.innerHTML = '<p class="fbm-dim">Backend offline. Open the backend window (run start.bat) and reopen this sidebar.</p>';
    return;
  }
  const templates = res.data || [];
  if (!templates.length) {
    list.innerHTML = '<p class="fbm-dim">No templates yet. Create one above.</p>';
    return;
  }
  list.innerHTML = templates.map(t => `
    <div class="fbm-card">
      <strong>${escHtml(t.title)}</strong>
      <span class="fbm-price">$${escHtml(t.price)}</span>
      <div class="fbm-card-actions">
        <button class="fbm-btn-fill"    data-id="${t.id}">Fill Form</button>
        <button class="fbm-btn-publish" data-id="${t.id}">Publish</button>
        <button class="fbm-btn-del"     data-id="${t.id}">Delete</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.fbm-btn-fill').forEach(btn => {
    btn.onclick = () => fillFromTemplate(btn.dataset.id, sidebar).catch(reportErr);
  });
  list.querySelectorAll('.fbm-btn-publish').forEach(btn => {
    btn.onclick = () => publishTemplate(btn.dataset.id, sidebar).catch(reportErr);
  });
  list.querySelectorAll('.fbm-btn-del').forEach(btn => {
    btn.onclick = () => deleteTemplate(btn.dataset.id, sidebar).catch(reportErr);
  });
}

async function fillFromTemplate(id, sidebar) {
  const res = await api(`/api/templates/${id}`);
  if (!res.ok) return;
  const result = await window.FBMAutofill.fill(res.data);
  showToast(result.ok ? 'Form filled!' : `Error: ${result.error}`);
}

async function deleteTemplate(id, sidebar) {
  if (!confirm('Delete this template?')) return;
  await api(`/api/templates/${id}`, { method: 'DELETE' });
  loadTemplates(sidebar);
}

async function publishTemplate(id, sidebar) {
  if (!confirm('Auto-post this template to Facebook Marketplace now?')) return;
  showToast('Queuing publish job…');
  const res = await api('/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateId: id }),
  });
  if (!res.ok) return; // api() already showed the offline message
  if (res.data && res.data.error) { showToast('Error: ' + res.data.error); return; }
  showToast('Job queued! FB will open and post automatically.');
  // Ask the background worker to process the queue immediately.
  try { chrome.runtime.sendMessage({ type: 'PUBLISH_NOW' }); } catch (_) {}
}

function openNewTemplateForm(sidebar) {
  const list = sidebar.querySelector('#fbm-template-list');
  list.innerHTML = `
    <div id="fbm-new-tmpl-form">
      <input id="ftitle"    placeholder="Title" />
      <input id="fprice"    placeholder="Price (numbers only)" type="number" />
      <input id="flocation" placeholder="ZIP or city" />
      <input id="fcategory" placeholder="Category (e.g. Electronics)" />
      <textarea id="fdesc"  placeholder="Description" rows="4"></textarea>
      <div class="fbm-row">
        <button id="fbm-save-tmpl">Save</button>
        <button id="fbm-cancel-tmpl">Cancel</button>
      </div>
    </div>
  `;
  sidebar.querySelector('#fbm-cancel-tmpl').onclick = () => loadTemplates(sidebar);
  sidebar.querySelector('#fbm-save-tmpl').onclick = () => saveNewTemplate(sidebar).catch(reportErr);
}

// Copy the current Facebook listing page into a reusable template (incl. photos).
async function saveListingAsTemplate(sidebar) {
  if (!location.href.includes('/marketplace/item/')) {
    showToast('Open one of your listings first, then click this.');
    return;
  }
  const data = window.FBMScraper.scrapeListingForTemplate();
  if (!data.title) { showToast('Could not read this listing. Scroll so the title/photos are visible, then retry.'); return; }
  showToast(`Saving "${data.title}" (${data.photoUrls.length} photo(s))…`);
  const res = await api('/api/templates/from-listing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) return;
  showToast(`Template saved with ${res.data?.photosSaved ?? 0} photo(s)!`);
  loadTemplates(sidebar);
}

async function saveNewTemplate(sidebar) {
  const body = {
    title:       document.getElementById('ftitle').value,
    price:       document.getElementById('fprice').value,
    location:    document.getElementById('flocation').value,
    category:    document.getElementById('fcategory').value,
    description: document.getElementById('fdesc').value,
  };
  if (!body.title) { showToast('Title is required'); return; }
  const res = await api('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return;
  showToast('Template saved!');
  loadTemplates(sidebar);
}

// ── Listings ──────────────────────────────────────────────────────────────────

async function scanAndReportListings(sidebar) {
  const listings = window.FBMScraper.scrapeListingCards();
  const list = sidebar.querySelector('#fbm-listing-list');
  if (!listings.length) {
    list.innerHTML = '<p class="fbm-dim">No listings found on this page.</p>';
    return;
  }
  await api('/api/listings/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(listings),
  }, { quiet: true });

  list.innerHTML = listings.map(l => `
    <div class="fbm-card">
      <strong>${escHtml(l.title)}</strong>
      <span class="fbm-price">${escHtml(l.price)}</span>
      <span class="fbm-id">ID: ${escHtml(l.id)}</span>
    </div>
  `).join('');
}

// ── Competitors ───────────────────────────────────────────────────────────────

async function scanAndReportCompetitors(sidebar) {
  const comps = window.FBMScraper.scrapeCompetitors();
  const list = sidebar.querySelector('#fbm-competitor-list');
  if (!comps.length) {
    list.innerHTML = '<p class="fbm-dim">No competitor listings found. Browse a category first.</p>';
    return;
  }
  await api('/api/competitors/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(comps),
  }, { quiet: true });

  list.innerHTML = comps.map(c => `
    <div class="fbm-card">
      <strong>${escHtml(c.title)}</strong>
      <span class="fbm-price">${escHtml(c.price)}</span>
      <span class="fbm-dim">${escHtml(c.location)}</span>
    </div>
  `).join('');
}

// ── Backend Reporting ─────────────────────────────────────────────────────────

async function reportPageToBackend() {
  const listing = window.FBMScraper.scrapeCurrentListing();
  if (!listing) return;
  await api('/api/listings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(listing),
  }, { quiet: true });
}

// ── Message listener (from background.js) ────────────────────────────────────

function listenForMessages() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'FILL_TEMPLATE') {
      window.FBMAutofill.fill(msg.template).then(sendResponse);
      return true;
    }
    if (msg.type === 'FILL_AND_PUBLISH') {
      window.FBMAutofill.fillAndPublish(msg.template).then(sendResponse);
      return true;
    }
    if (msg.type === 'SCRAPE_LISTINGS') {
      sendResponse(window.FBMScraper.scrapeListingCards());
    }
    if (msg.type === 'SCRAPE_CURRENT') {
      sendResponse(window.FBMScraper.scrapeCurrentListing());
    }
    if (msg.type === 'SCRAPE_COMPETITORS') {
      sendResponse(window.FBMScraper.scrapeCompetitors());
    }
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function reportErr(err) {
  console.warn('[FBM] action failed:', err);
  showToast('Something went wrong — see the backend window / dashboard Logs.');
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'fbm-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
