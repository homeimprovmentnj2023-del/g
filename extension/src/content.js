// Main content script — runs on every facebook.com/marketplace page.
// Injects the sidebar and wires up scraper / autofill / backend communication.

const BACKEND = 'http://localhost:3333';

(function init() {
  injectSidebar();
  reportPageToBackend();
  listenForMessages();
})();

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

  // Listings scan
  sidebar.querySelector('#fbm-scan-listings').onclick = () => scanAndReportListings(sidebar);

  // Competitors scan
  sidebar.querySelector('#fbm-scan-competitors').onclick = () => scanAndReportCompetitors(sidebar);

  // New template
  sidebar.querySelector('#fbm-new-template').onclick = () => openNewTemplateForm(sidebar);

  loadTemplates(sidebar);
}

// ── Templates ─────────────────────────────────────────────────────────────────

async function loadTemplates(sidebar) {
  const list = sidebar.querySelector('#fbm-template-list');
  list.innerHTML = '<p class="fbm-dim">Loading…</p>';
  try {
    const res = await fetch(`${BACKEND}/api/templates`);
    const templates = await res.json();
    if (!templates.length) {
      list.innerHTML = '<p class="fbm-dim">No templates yet. Create one above.</p>';
      return;
    }
    list.innerHTML = templates.map(t => `
      <div class="fbm-card">
        <strong>${escHtml(t.title)}</strong>
        <span class="fbm-price">$${t.price}</span>
        <div class="fbm-card-actions">
          <button class="fbm-btn-fill" data-id="${t.id}">Fill Form</button>
          <button class="fbm-btn-del" data-id="${t.id}">Delete</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.fbm-btn-fill').forEach(btn => {
      btn.onclick = () => fillFromTemplate(btn.dataset.id, sidebar);
    });
    list.querySelectorAll('.fbm-btn-del').forEach(btn => {
      btn.onclick = () => deleteTemplate(btn.dataset.id, sidebar);
    });
  } catch (_) {
    list.innerHTML = '<p class="fbm-dim">Backend offline. Start it with: cd backend && node src/server.js</p>';
  }
}

async function fillFromTemplate(id, sidebar) {
  const res = await fetch(`${BACKEND}/api/templates/${id}`);
  const template = await res.json();
  const result = await window.FBMAutofill.fill(template);
  showToast(result.ok ? 'Form filled!' : `Error: ${result.error}`);
}

async function deleteTemplate(id, sidebar) {
  if (!confirm('Delete this template?')) return;
  await fetch(`${BACKEND}/api/templates/${id}`, { method: 'DELETE' });
  loadTemplates(sidebar);
}

function openNewTemplateForm(sidebar) {
  const list = sidebar.querySelector('#fbm-template-list');
  list.innerHTML = `
    <div id="fbm-new-tmpl-form">
      <input id="ftitle" placeholder="Title" />
      <input id="fprice" placeholder="Price (numbers only)" type="number" />
      <input id="flocation" placeholder="ZIP or city" />
      <textarea id="fdesc" placeholder="Description" rows="4"></textarea>
      <div class="fbm-row">
        <button id="fbm-save-tmpl">Save</button>
        <button id="fbm-cancel-tmpl">Cancel</button>
      </div>
    </div>
  `;
  sidebar.querySelector('#fbm-cancel-tmpl').onclick = () => loadTemplates(sidebar);
  sidebar.querySelector('#fbm-save-tmpl').onclick = async () => {
    const body = {
      title: document.getElementById('ftitle').value,
      price: document.getElementById('fprice').value,
      location: document.getElementById('flocation').value,
      description: document.getElementById('fdesc').value,
    };
    if (!body.title) { showToast('Title is required'); return; }
    await fetch(`${BACKEND}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    loadTemplates(sidebar);
  };
}

// ── Listings ──────────────────────────────────────────────────────────────────

async function scanAndReportListings(sidebar) {
  const listings = window.FBMScraper.scrapeListingCards();
  const list = sidebar.querySelector('#fbm-listing-list');
  if (!listings.length) {
    list.innerHTML = '<p class="fbm-dim">No listings found on this page.</p>';
    return;
  }
  // Send to backend
  await fetch(`${BACKEND}/api/listings/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(listings),
  }).catch(() => {});

  list.innerHTML = listings.map(l => `
    <div class="fbm-card">
      <strong>${escHtml(l.title)}</strong>
      <span class="fbm-price">${escHtml(l.price)}</span>
      <span class="fbm-id">ID: ${l.id}</span>
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
  await fetch(`${BACKEND}/api/competitors/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(comps),
  }).catch(() => {});

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
  await fetch(`${BACKEND}/api/listings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(listing),
  }).catch(() => {});
}

// ── Message listener (from background.js) ────────────────────────────────────

function listenForMessages() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'FILL_TEMPLATE') {
      window.FBMAutofill.fill(msg.template).then(sendResponse);
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
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'fbm-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
