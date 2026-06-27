// Background service worker — monitors listing status, fires notifications,
// and processes the auto-publish queue.

const BACKEND = 'http://localhost:3333';
const CHECK_INTERVAL_MINUTES  = 30;
const QUEUE_POLL_SECONDS       = 20;

let publishTabId = null; // track the tab we opened for publishing

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('checkListings', { periodInMinutes: CHECK_INTERVAL_MINUTES });
  chrome.alarms.create('pollQueue',     { periodInMinutes: QUEUE_POLL_SECONDS / 60 });
  console.log('[FBM] Installed. Monitoring every', CHECK_INTERVAL_MINUTES, 'min. Queue polled every', QUEUE_POLL_SECONDS, 's.');
});

// ── Alarms ────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'checkListings') await checkStaleListings();
  if (alarm.name === 'pollQueue')     await processNextQueueJob();
});

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
    const res = await fetch(`${BACKEND}/api/publish/next`);
    if (res.status === 204) return; // no pending jobs
    job = await res.json();
  } catch (_) { return; }

  console.log('[FBM] Starting publish job', job.id, 'for template', job.template_id);

  // Mark running
  await patchJob(job.id, { status: 'running' });

  try {
    const result = await runPublishJob(job);
    await patchJob(job.id, { status: result.ok ? 'done' : 'failed', result: JSON.stringify(result) });

    if (result.ok) {
      // Save the new listing to backend
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
        }),
      });

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
      const tab = await chrome.tabs.create({ url: CREATE_URL, active: true });
      publishTabId = tab.id;

      // Wait for page load
      await waitForTabLoad(tab.id, 20000);
      await sleep(2000); // let React hydrate

      // Inject our scripts in case the content script hasn't run yet
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/selectors.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/autofill.js'] });
      await sleep(500);

      // Build template object from job fields
      const template = {
        title:       job.title,
        price:       job.price,
        description: job.description,
        location:    job.location,
        category:    job.category,
        photos:      job.photos || '[]',
      };

      // Drive the form via message to content script
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (tmpl) => {
          return await window.FBMAutofill.fillAndPublish(tmpl);
        },
        args: [template],
      });

      chrome.tabs.remove(tab.id);
      publishTabId = null;

      resolve(results?.[0]?.result || { ok: false, error: 'No result from content script' });
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
