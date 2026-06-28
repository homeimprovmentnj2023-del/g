const status = document.getElementById('status');

function relay(payload) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'RELAY_TO_TAB', payload }, res => {
      resolve(res);
    });
  });
}

function setStatus(msg) { status.textContent = msg; }

// ── Account selector (which Facebook account this Chrome profile posts as) ─────
const accountSelect = document.getElementById('account-select');

async function loadAccounts() {
  let accounts = [];
  try {
    const res = await fetch('http://localhost:3333/api/accounts');
    accounts = await res.json();
  } catch (_) { setStatus('Backend offline — start it to load accounts.'); }

  const { fbmAccountId } = await chrome.storage.local.get('fbmAccountId');
  accountSelect.innerHTML = '<option value="">(All / single account)</option>' +
    accounts.map(a => `<option value="${a.id}">${a.name} (${(a.zips || []).length} ZIPs)</option>`).join('');
  accountSelect.value = fbmAccountId || '';
}

accountSelect.onchange = async () => {
  await chrome.storage.local.set({ fbmAccountId: accountSelect.value });
  setStatus(accountSelect.value ? 'This profile now posts as the selected account.' : 'Posting unassigned jobs.');
};

loadAccounts();

document.getElementById('btn-open-sidebar').onclick = async () => {
  const [tab] = await chrome.tabs.query({ url: 'https://www.facebook.com/marketplace*', currentWindow: true });
  if (!tab) {
    await chrome.tabs.create({ url: 'https://www.facebook.com/marketplace' });
    setStatus('Opened Marketplace.');
  } else {
    chrome.tabs.update(tab.id, { active: true });
    setStatus('Switched to Marketplace tab.');
  }
};

document.getElementById('btn-scan').onclick = async () => {
  setStatus('Scanning…');
  const res = await relay({ type: 'SCRAPE_LISTINGS' });
  if (res?.error) { setStatus(res.error); return; }
  setStatus(`Found ${res?.length ?? 0} listing(s). Sent to backend.`);
};

document.getElementById('btn-scan-comp').onclick = async () => {
  setStatus('Scanning competitors…');
  const res = await relay({ type: 'SCRAPE_COMPETITORS' });
  if (res?.error) { setStatus(res.error); return; }
  setStatus(`Found ${res?.length ?? 0} competitor listing(s).`);
};
