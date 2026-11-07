import { texts } from './lib/i18n.js';
import { dayKey, daysAgo, isAvailable, labelOf, storeOrder } from './lib/logic.js';
import { isHttpsUrl, missing, normalize } from './lib/settings.js';

const $ = (sel) => document.querySelector(sel);
const time = (t) => (t ? new Date(t).toLocaleString() : '—');

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function render() {
  const now = Date.now();
  const keys = ['settings', 'state', dayKey(now, 'polls'), dayKey(daysAgo(now, 1), 'changes'), dayKey(now, 'changes'), 'notifyError'];
  const got = await chrome.storage.local.get(keys);
  const cfg = normalize(got.settings);
  const state = got.state ?? {};
  const polls = got[keys[2]] ?? [];
  const last = polls.at(-1);
  const backedOff = state.backoff?.until > now;

  const todo = missing(cfg);
  $('#setup').hidden = !todo.length;
  $('#setup').textContent = todo.length ? `Not checking yet. ${todo.map((k) => texts('en')[k]).join(' ')} Open Settings.` : '';

  const failed = got.notifyError;
  const badServer = cfg.notify.bark.enabled && !isHttpsUrl(cfg.notify.bark.server);
  $('#notifyError').hidden = !failed && !badServer;
  $('#notifyError').textContent = badServer
    ? 'Bark is on, but its server is not an https:// address, so nothing goes to your phone. Fix it in Settings.'
    : failed ? `The last notification did not get through (${time(failed.t)}: ${failed.errors.join('; ')}). Check Settings, then send a test notification.` : '';

  const mode = $('#mode');
  mode.textContent = todo.length ? 'Not set up' : backedOff ? `Paused by Apple’s throttle until ${time(state.backoff.until)}` : state.paused ? 'Paused' : 'Running';
  mode.className = todo.length || state.paused || backedOff ? 'stopped' : 'running';
  $('#toggle').textContent = state.paused ? 'Resume' : 'Pause';
  $('#toggle').dataset.cmd = state.paused ? 'resume' : 'pause';

  const lastText = !last ? 'no checks yet' : last.sig != null ? `HTTP ${last.status}, ${last.ms} ms` : `failed: ${last.err}`;
  $('#summary').textContent = `Every ${cfg.pollSeconds} s near ${cfg.location || '—'} · last check ${time(last?.t)} (${lastText}) · ${polls.length} checks today · ${state.failures ?? 0} failures in a row`;

  const grid = $('#grid');
  grid.replaceChildren();
  const head = el('tr');
  head.append(el('th', 'Store'), ...cfg.products.map((p) => el('th', p.label)));
  grid.append(head);
  const stores = state.stores ?? {};
  const names = cfg.stores.length ? cfg.stores : storeOrder(stores, cfg);
  for (const name of names) {
    const row = el('tr');
    const store = stores[name];
    row.append(el('th', store ? `${name} (${store.distance})` : name));
    for (const { part } of cfg.products) {
      const cell = store?.parts[part];
      row.append(el('td', !state.stores ? '—' : !store ? 'Not in Apple’s answer' : cell?.quote || cell?.display || '—', isAvailable(cell) ? 'hit' : ''));
    }
    grid.append(row);
  }
  if (!names.length) grid.append(Object.assign(el('tr'), { innerHTML: '<td class="muted">No answer from Apple yet.</td>' }));

  const changes = [...(got[keys[3]] ?? []), ...(got[keys[4]] ?? [])]
    .flatMap((entry) => entry.changes.map((c) => ({ t: entry.t, ...c })))
    .reverse()
    .slice(0, 20);
  $('#changes').replaceChildren(...(changes.length
    ? changes.map((c) => el('li', `${time(c.t)} · ${c.store} ${labelOf(cfg, c.part)}: ${c.from?.quote ?? '—'} → ${c.to.quote || c.to.display}`))
    : [el('li', 'None in the last two days', 'muted')]));
}

document.addEventListener('click', async (e) => {
  const cmd = e.target.dataset?.cmd;
  if (!cmd) return;
  $('#result').textContent = 'Working…';
  const r = await chrome.runtime.sendMessage({ cmd });
  $('#result').textContent = r?.ok ? `Done: ${e.target.textContent}${r.note ? ` (${r.note})` : ''}` : `Failed: ${r?.error ?? 'no response'}`;
  render();
});

$('#download').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  // Logs only: the settings hold your push keys.
  delete all.settings;
  const url = URL.createObjectURL(new Blob([JSON.stringify(all, null, 1)], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: `pickup-watcher-logs-${new Date().toISOString().slice(0, 10)}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

chrome.storage.onChanged.addListener(() => render());
render();
