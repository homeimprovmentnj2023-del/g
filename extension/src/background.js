// Background service worker — monitors listing status, fires notifications,
// and processes the auto-publish queue.

const BACKEND = 'http://localhost:3333';
const CHECK_INTERVAL_MINUTES  = 30;
const QUEUE_POLL_SECONDS       = 20;

let publishTabId = null; // track the tab we opened for publishing

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('checkListings', { periodInMinutes: CHECK_INTERVAL_MINUTES });
  chrome.alarms.create('pollQueue',     { periodInMinutes: QUEUE_POLL_SECONDS / 60 });
  chrome.alarms.create('heartbeat',     { periodInMinutes: 3 });
  chrome.alarms.create('syncListings',  { delayInMinutes: 2, periodInMinutes: 60 });
  chrome.alarms.create('mpChatTick',    { periodInMinutes: 0.5 });
  console.log('[FBM] Installed. Monitoring every', CHECK_INTERVAL_MINUTES, 'min. Queue polled every', QUEUE_POLL_SECONDS, 's.');
});
// Also (re)create alarms whenever the service worker starts, so a reloaded
// extension always has them even without an explicit install event.
chrome.alarms.create('heartbeat', { periodInMinutes: 3 });
chrome.alarms.create('syncListings', { delayInMinutes: 2, periodInMinutes: 60 });
chrome.alarms.create('mpChatTick', { periodInMinutes: 0.5 });

// ── Alarms ────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'checkListings') await checkStaleListings();
  if (alarm.name === 'pollQueue')     await processNextQueueJob();
  if (alarm.name === 'heartbeat')     await sendHeartbeat();
  if (alarm.name === 'syncListings')  await syncListings();
  if (alarm.name === 'mpChatTick')    await mpChatTick();
});

// Drive the Marketplace chat bridge from the SERVICE WORKER. Page timers in
// background/hidden tabs are throttled to ~1/min or frozen entirely (and Memory
// Saver can discard the page), so the bridge's own loops only run while the user
// is LOOKING at the tab. Alarms are not throttled by tab visibility: every tick
// we ping each Marketplace inbox tab — an ack proves the content script is alive
// and lets it run a sweep; no ack means the tab is discarded/stuck, so we reload
// it to revive the bridge.
async function mpChatTick() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['*://*.facebook.com/marketplace/inbox*', '*://*.facebook.com/marketplace/t/*'] }); } catch (e) { return; }
  for (const tab of tabs) {
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (_) {}   // Memory Saver must not kill it
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'MP_TICK' });
      if (!resp || !resp.ok) throw new Error('no ack');
    } catch (_) {
      // Content script dead (tab discarded/stuck) → reload the tab to revive it.
      try { await chrome.tabs.reload(tab.id); } catch (_) {}
    }
  }
}

// Open this profile's "Your Listings" page, scrape every listing (id/title/status),
// and sync to the backend so coverage + keep-alive know what's actually live.
async function syncListings() {
  if (publishTabId !== null) return;            // don't interfere with a publish
  const { fbmAccountId } = await chrome.storage.local.get('fbmAccountId');
  if (!fbmAccountId) return;                     // only for a profile bound to an account
  let tab;
  try {
    tab = await chrome.tabs.create({ url: 'https://www.facebook.com/marketplace/you/selling', active: false });
    await waitForTabLoad(tab.id, 20000);
    await sleep(3000);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/selectors.js', 'src/scraper.js'] });
    const scraped = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        for (let i = 0; i < 4; i++) { window.scrollTo(0, document.body.scrollHeight); await new Promise(r => setTimeout(r, 900)); }
        try { return window.FBMScraper.scrapeListingCards(); } catch (_) { return []; }
      },
    });
    const cards = scraped?.[0]?.result || [];
    if (cards.length) {
      await fetch(`${BACKEND}/api/listings/sync`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: fbmAccountId, cards }),
      }).catch(() => {});
    }
  } catch (_) { /* best effort */ }
  finally { if (tab) chrome.tabs.remove(tab.id).catch(() => {}); }
}

// Tell the backend this profile is alive (so it can alert if a profile goes dark).
async function sendHeartbeat() {
  try {
    const { fbmAccountId } = await chrome.storage.local.get('fbmAccountId');
    await fetch(`${BACKEND}/api/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: fbmAccountId || null }),
    });
  } catch (_) { /* backend down/unreachable — nothing to do here */ }
}

// ── Listing Monitor ───────────────────────────────────────────────────────────

async function checkStaleListings() {
  let stale;
  try {
    const res = await fetch(`${BACKEND}/api/listings/stale`);
    stale = await res.json();
  } catch (_) { return; }
  for (const listing of stale) await verifyListingInTab(listing);
}

async function verifyListingInTab(listing) {
  try {
    const tab = await chrome.tabs.create({ url: listing.url, active: false });
    await waitForTabLoad(tab.id, 12000);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const body = document.body?.innerText || '';
        const gone = /this listing is no longer available|sold|expired|removed/i.test(body)
          || document.title?.includes('Page Not Found')
          || body.includes('page not found');
        return { removed: gone };
      },
    });

    chrome.tabs.remove(tab.id);
    const status = results?.[0]?.result?.removed ? 'inactive' : 'active';

    await fetch(`${BACKEND}/api/listings/${listing.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });

    if (status === 'inactive') {
      chrome.notifications.create(`removed-${listing.id}`, {
        type: 'basic',
        iconUrl: '../icons/icon48.png',
        title: 'Listing Removed',
        message: `"${listing.title || listing.id}" is no longer active.`,
      });
    }
  } catch (err) {
    console.warn('[FBM] Verify failed for', listing.id, err.message);
  }
}

// ── Auto-Publish Queue ────────────────────────────────────────────────────────

async function processNextQueueJob() {
  // Don't start a new job if we're already publishing
  if (publishTabId !== null) return;

  let job;
  try {
    // This Chrome profile's assigned Facebook account (set in the popup). Only
    // jobs routed to this account (or unassigned) are picked up here.
    const { fbmAccountId } = await chrome.storage.local.get('fbmAccountId');
    const q = fbmAccountId ? `?accountId=${encodeURIComponent(fbmAccountId)}` : '';
    const res = await fetch(`${BACKEND}/api/publish/next${q}`);
    if (res.status === 204) return; // no pending jobs
    job = await res.json();
  } catch (_) { return; }

  console.log('[FBM] Starting publish job', job.id, 'for template', job.template_id);

  // Mark running
  await patchJob(job.id, { status: 'running' });

  try {
    const result = await runPublishJob(job);

    // Map the automation outcome to a job status.
    let status = 'failed';
    if (result.ok) status = 'done';
    else if (result.blocked) status = 'blocked';          // Facebook hard-stopped — do not retry
    else if (result.needsPhoto) status = 'needs_photo';   // template has no usable image
    else if (result.needsHuman) status = 'needs_human';   // a required field needs the user
    await patchJob(job.id, { status, result: JSON.stringify(result) });

    if (status === 'needs_human' || status === 'blocked' || status === 'needs_photo') {
      chrome.notifications.create(`publish-attn-${job.id}`, {
        type: 'basic', iconUrl: '../icons/icon48.png',
        title: status === 'blocked' ? 'Facebook Blocked Listing'
             : status === 'needs_photo' ? 'Add a Photo' : 'Action Needed',
        message: `"${job.title}": ${result.error || 'needs your attention'}`,
      });
    } else if (result.ok && result.deletedOnly) {
      chrome.notifications.create(`deleted-${job.id}`, {
        type: 'basic', iconUrl: '../icons/icon48.png',
        title: 'Listing Deleted', message: 'Removed a suspended/old listing.',
      });
    } else if (result.ok) {
      // Save the new listing to backend (only when we captured its real id).
      if (result.listingId) {
        await fetch(`${BACKEND}/api/listings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id:          result.listingId,
            title:       job.title,
            price:       job.price,
            description: job.description,
            status:      'active',
            url:         result.url,
            template_id: job.template_id,
            account_id:  job.account_id,   // so the sync reconciler can track/replace it
          }),
        });
      }

      chrome.notifications.create(`publish-${job.id}`, {
        type: 'basic',
        iconUrl: '../icons/icon48.png',
        title: 'Listing Published!',
        message: `"${job.title}" was posted successfully.`,
      });
    } else {
      chrome.notifications.create(`publish-fail-${job.id}`, {
        type: 'basic',
        iconUrl: '../icons/icon48.png',
        title: 'Publish Failed',
        message: `"${job.title}" failed: ${result.error}`,
      });
    }
  } catch (err) {
    await patchJob(job.id, { status: 'failed', result: JSON.stringify({ error: err.message }) });
  }
}

async function runPublishJob(job) {
  const CREATE_URL = 'https://www.facebook.com/marketplace/create/item';

  return new Promise(async (resolve) => {
    try {
      // Delete-only cleanup job: open the listing, delete it, and DON'T post.
      if (job.delete_only && job.delete_url) {
        try {
          const dTab = await chrome.tabs.create({ url: job.delete_url, active: true });
          await waitForTabLoad(dTab.id, 20000);
          await sleep(2500);
          await chrome.scripting.executeScript({ target: { tabId: dTab.id }, files: ['src/selectors.js'] });
          await chrome.scripting.executeScript({ target: { tabId: dTab.id }, files: ['src/autofill.js'] });
          await sleep(500);
          const dres = await chrome.scripting.executeScript({ target: { tabId: dTab.id }, func: async () => await window.FBMAutofill.deleteListing() });
          await sleep(1200);
          chrome.tabs.remove(dTab.id).catch(() => {});
          return resolve({ ok: true, deletedOnly: true, result: dres?.[0]?.result || {} });
        } catch (e) {
          return resolve({ ok: false, error: 'delete failed: ' + e.message });
        }
      }

      // Step A — if this is a repost, delete the old listing first so Facebook
      // doesn't reject the new one as a duplicate (same photo/title).
      if (job.delete_url) {
        try {
          const delTab = await chrome.tabs.create({ url: job.delete_url, active: true });
          await waitForTabLoad(delTab.id, 20000);
          await sleep(2500);
          await chrome.scripting.executeScript({ target: { tabId: delTab.id }, files: ['src/selectors.js'] });
          await chrome.scripting.executeScript({ target: { tabId: delTab.id }, files: ['src/autofill.js'] });
          await sleep(500);
          await chrome.scripting.executeScript({
            target: { tabId: delTab.id },
            func: async () => await window.FBMAutofill.deleteListing(),
          });
          await sleep(1500);
          chrome.tabs.remove(delTab.id).catch(() => {});
        } catch (e) {
          console.warn('[FBM] delete-before-repost failed (continuing):', e.message);
        }
      }

      const tab = await chrome.tabs.create({ url: CREATE_URL, active: true });
      publishTabId = tab.id;

      // Wait for page load
      await waitForTabLoad(tab.id, 20000);
      await sleep(2000); // let React hydrate

      // Inject our scripts in case the content script hasn't run yet
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/selectors.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/autofill.js'] });
      await sleep(500);

      // Pre-fetch photos HERE in the service worker (which can always reach the
      // backend) and pass them to the page as data: URLs. The Facebook page never
      // fetches localhost, so this works even on profiles whose page context can't
      // reach the backend (the cause of Account B's "can't add photo" failures).
      let photosForPage = job.photos || '[]';
      try {
        const urls = JSON.parse(job.photos || '[]');
        const dataUrls = [];
        for (const u of urls.slice(0, 3)) {
          try {
            const resp = await fetch(u);
            if (!resp.ok) continue;
            const dataUrl = await blobToDataUrl(await resp.blob());
            if (dataUrl) dataUrls.push(dataUrl);
          } catch (_) { /* skip this one */ }
        }
        if (dataUrls.length) photosForPage = JSON.stringify(dataUrls);
      } catch (_) {}

      // Build template object from job fields
      const template = {
        __jobId:     job.id,           // correlate automation logs with this job
        title:       job.title,
        price:       job.price,
        description: job.description,
        location:    job.location,
        location_city:  job.location_city || '',   // authoritative place for this ZIP
        location_state: job.location_state || '',
        location_full:  job.location_full || '',
        category:    job.category,
        condition:   job.condition,
        photos:      photosForPage,
      };

      // Drive the form via message to content script
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (tmpl) => {
          return await window.FBMAutofill.fillAndPublish(tmpl);
        },
        args: [template],
      });

      const result = results?.[0]?.result || { ok: false, error: 'No result from content script' };

      // Keep the tab OPEN on any non-success so the user can read the on-page
      // banner explaining what happened. On success, close after a short pause.
      if (result.ok) {
        setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 4000);
      } else {
        chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      }
      publishTabId = null;

      resolve(result);
    } catch (err) {
      if (publishTabId !== null) {
        chrome.tabs.remove(publishTabId).catch(() => {});
        publishTabId = null;
      }
      resolve({ ok: false, error: err.message });
    }
  });
}

async function patchJob(id, body) {
  await fetch(`${BACKEND}/api/publish/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// ── Message relay (popup → content script) ───────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'RELAY_TO_TAB') {
    chrome.tabs.query({ url: 'https://www.facebook.com/marketplace*', active: true, currentWindow: true }, tabs => {
      if (!tabs.length) { sendResponse({ error: 'No active marketplace tab' }); return; }
      chrome.tabs.sendMessage(tabs[0].id, msg.payload, sendResponse);
    });
    return true;
  }

  // Popup can trigger immediate publish
  if (msg.type === 'PUBLISH_NOW') {
    processNextQueueJob().then(() => sendResponse({ ok: true }));
    return true;
  }

  // Throttle-immune sleep for content scripts: page timers in hidden tabs are
  // throttled to ~1/min, but the service worker's are not — so the chat bridge
  // awaits its delays HERE and stays accurately paced even in background tabs.
  if (msg.type === 'BG_SLEEP') {
    setTimeout(() => sendResponse({ ok: true }), Math.min(Number(msg.ms) || 0, 25000));
    return true;
  }

  // Backend fetch relay: content scripts (chat bridge, etc.) call the backend
  // THROUGH the service worker, which can always reach localhost — so profiles
  // whose page context can't reach the backend still work.
  if (msg.type === 'BG_FETCH') {
    (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), msg.timeoutMs || 35000);
      try {
        const res = await fetch(`${BACKEND}${msg.path}`, {
          method: msg.method || 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: msg.body != null ? JSON.stringify(msg.body) : undefined,
          signal: ctrl.signal,
        });
        let data = null; try { data = await res.json(); } catch (_) {}
        sendResponse({ ok: res.ok, status: res.status, data });
      } catch (e) {
        sendResponse({ ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch failed') });
      } finally { clearTimeout(timer); }
    })();
    return true; // async response
  }
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function waitForTabLoad(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tab load timeout')), timeout);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Convert an image blob to a data: URL. Service-worker safe (no FileReader):
// arrayBuffer → chunked base64 → data URL.
async function blobToDataUrl(blob) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return `data:${blob.type || 'image/jpeg'};base64,${btoa(bin)}`;
  } catch (_) { return null; }
}
