// Background service worker — monitors listing status and fires notifications.

const BACKEND = 'http://localhost:3333';
const CHECK_INTERVAL_MINUTES = 30;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('checkListings', { periodInMinutes: CHECK_INTERVAL_MINUTES });
  console.log('[FBM] Background worker installed. Checking listings every', CHECK_INTERVAL_MINUTES, 'min.');
});

// Periodic health check — asks backend for listings that need status verification.
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'checkListings') return;

  let stale;
  try {
    const res = await fetch(`${BACKEND}/api/listings/stale`);
    stale = await res.json();
  } catch (_) {
    // Backend offline — skip silently
    return;
  }

  for (const listing of stale) {
    await verifyListingInTab(listing);
  }
});

// Opens a background tab to the listing URL, scrapes status, closes tab.
async function verifyListingInTab(listing) {
  try {
    const tab = await chrome.tabs.create({ url: listing.url, active: false });
    await waitForTabLoad(tab.id, 10000);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Detect common "listing unavailable" signals
        const body = document.body?.innerText || '';
        const removed = /this listing is no longer available|sold|expired|removed/i.test(body);
        const notFound = document.title?.includes('Page Not Found') || body.includes('page not found');
        return { removed: removed || notFound };
      },
    });

    chrome.tabs.remove(tab.id);

    const status = results?.[0]?.result?.removed ? 'inactive' : 'active';

    // Report status back to backend
    await fetch(`${BACKEND}/api/listings/${listing.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });

    if (status === 'inactive') {
      chrome.notifications.create(`listing-${listing.id}`, {
        type: 'basic',
        iconUrl: '../icons/icon48.png',
        title: 'Listing Inactive',
        message: `"${listing.title || listing.id}" appears to be removed or expired.`,
      });
    }
  } catch (err) {
    console.warn('[FBM] Could not verify listing', listing.id, err.message);
  }
}

function waitForTabLoad(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tab load timeout')), timeout);
    chrome.tabs.onUpdated.addListener(function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

// Relay messages from popup to active marketplace tab
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'RELAY_TO_TAB') {
    chrome.tabs.query({ url: 'https://www.facebook.com/marketplace*', active: true, currentWindow: true }, tabs => {
      if (!tabs.length) {
        sendResponse({ error: 'No active marketplace tab' });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, msg.payload, sendResponse);
    });
    return true;
  }
});
