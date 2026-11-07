// Pickup Watcher service worker. About every pollSeconds it asks Apple for pickup availability from a pinned
// apple.com tab in this Chrome profile, the same request apple.com makes when you check a store, and notifies you
// on a hit. What to do with each answer is decided in lib/logic.js.
import { texts } from './lib/i18n.js';
import { classify, dayKey, decide, initialState, labelOf, parsePickup, pickupPath, signature } from './lib/logic.js';
import { pushRequests, sendPushes } from './lib/notify.js';
import { MIN_GAP_SECONDS, appleBase, hostUrl, missing, normalize } from './lib/settings.js';

const MIN = 60_000;
const LOG_PREFIXES = ['polls', 'changes', 'raw'];
const LOG_DAYS = 7;
const HOST_RELOAD_MINUTES = 30;
const TIMEOUT_MS = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One job at a time, so two requests to Apple are never in flight together.
let chain = Promise.resolve();
const serial = (job) => (chain = chain.then(job).catch((e) => console.error('[pickup-watcher]', e)));

// ---------- storage ----------

const loadSettings = async () => normalize((await chrome.storage.local.get('settings')).settings);

async function loadState() {
  const { state } = await chrome.storage.local.get('state');
  return { ...initialState(), paused: false, hostTabId: null, hostLoadedAt: 0, ...state };
}

const saveState = (state) => chrome.storage.local.set({ state });

async function appendLog(prefix, entry) {
  const key = dayKey(entry.t, prefix);
  const { [key]: list = [] } = await chrome.storage.local.get(key);
  list.push(entry);
  await chrome.storage.local.set({ [key]: list });
}

async function pruneLogs(now) {
  const keep = new Set();
  for (let i = 0; i < LOG_DAYS; i++) for (const p of LOG_PREFIXES) keep.add(dayKey(now - i * 1440 * MIN, p));
  const keys = await chrome.storage.local.getKeys();
  const stale = keys.filter((k) => LOG_PREFIXES.some((p) => k.startsWith(`${p}:`)) && !keep.has(k));
  if (stale.length) await chrome.storage.local.remove(stale);
}

// ---------- the host tab ----------

async function waitForLoad(tabId) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && !tab.discarded) return tab;
    await sleep(500);
  }
  throw new Error('host tab did not finish loading');
}

// The tab this extension pinned, on this country's store; it is reopened if you close it. Tab ids change when Chrome
// restarts, so a restored tab is found again by its address.
async function hostTab(state, cfg) {
  const base = appleBase(cfg);
  let tab = state.hostTabId != null ? await chrome.tabs.get(state.hostTabId).catch(() => null) : null;
  if (!tab) {
    [tab] = await chrome.tabs.query({ url: `${hostUrl(cfg)}*`, pinned: true });
    if (tab) state.hostTabId = tab.id;
  }
  if (tab && !(tab.url ?? tab.pendingUrl ?? '').startsWith(`${base}/`)) {
    await chrome.tabs.update(tab.id, { url: hostUrl(cfg) });
    state.hostLoadedAt = Date.now();
  } else if (!tab) {
    // With every window of this profile closed, tabs.create fails ("No current window"): open a minimized one instead.
    const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] });
    tab = win
      ? await chrome.tabs.create({ url: hostUrl(cfg), active: false, pinned: true, windowId: win.id })
      : await chrome.windows.create({ url: hostUrl(cfg), state: 'minimized' }).then((w) => chrome.tabs.update(w.tabs[0].id, { pinned: true }));
    state.hostTabId = tab.id;
    state.hostLoadedAt = Date.now();
  } else if (tab.discarded || Date.now() - state.hostLoadedAt > HOST_RELOAD_MINUTES * MIN) {
    await chrome.tabs.reload(tab.id);
    await sleep(1000);
    state.hostLoadedAt = Date.now();
  }
  await chrome.tabs.update(tab.id, { autoDiscardable: false });
  return waitForLoad(tab.id);
}

async function fetchInTab(tabId, path) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [path, TIMEOUT_MS],
    func: async (path, timeoutMs) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetch(path, { credentials: 'include', signal: ctl.signal });
        return { status: r.status, path: new URL(r.url).pathname, type: r.headers.get('content-type') ?? '', text: await r.text() };
      } catch (e) {
        return { error: e.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : String(e) };
      } finally {
        clearTimeout(timer);
      }
    },
  });
  return result;
}

// ---------- notifications ----------

async function chromeNotify(m, cfg, test) {
  const id = `pw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (m.click) await chrome.storage.session.set({ [id]: m.click });
  await chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/128.png',
    title: (test ? texts(cfg.language).testPrefix : '') + m.title,
    message: m.message,
    priority: m.priority >= 5 ? 2 : m.priority <= 2 ? -1 : 0,
    requireInteraction: m.priority >= 5,
  });
}

// -> [{ channel, ok, error? }], one per channel tried.
async function notify(m, cfg, test = false) {
  const results = [];
  if (cfg.notify.chrome) {
    results.push(await chromeNotify(m, cfg, test).then(() => ({ channel: 'chrome', ok: true }), (e) => ({ channel: 'chrome', ok: false, error: String(e?.message ?? e) })));
  }
  results.push(...await sendPushes(pushRequests(cfg, m, test)));
  for (const r of results) if (!r.ok) console.error('[pickup-watcher] notification failed:', r.channel, r.error);
  return results;
}

async function openPage(url) {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const tab = await chrome.tabs.create({ url, active: true, ...(win ? { windowId: win.id } : {}) });
  await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
}

async function runActions(actions, cfg) {
  for (const a of actions) {
    try {
      if (a.type === 'notify') await notify(a, cfg);
      else if (a.type === 'open') await openPage(a.url);
    } catch (e) {
      console.error('[pickup-watcher] action failed:', a.type, e);
    }
  }
}

// ---------- jobs ----------

// -> a reason it did not check, or undefined after a check.
async function poll({ force = false } = {}) {
  const now = Date.now();
  const cfg = await loadSettings();
  const state = await loadState();
  if (missing(cfg).length) return 'not set up yet';
  if (!force && (state.paused || now < state.backoff.until)) return 'paused';
  if (now - state.lastCheckAt < MIN_GAP_SECONDS * 1000) return `the last check was less than ${MIN_GAP_SECONDS} s ago`;
  state.lastCheckAt = now;

  let res;
  try {
    const tab = await hostTab(state, cfg);
    res = await fetchInTab(tab.id, pickupPath(cfg));
  } catch (e) {
    res = { error: String(e?.message ?? e) };
  }
  const ms = Date.now() - now;
  let outcome = classify(res);
  if (outcome.ok) {
    try {
      outcome = { ok: true, json: outcome.json, stores: parsePickup(outcome.json, cfg) };
    } catch (e) {
      outcome = { ok: false, blocked: false, detail: e.message };
    }
  }

  const decided = decide(state, outcome, now, cfg);
  await saveState(decided.state);
  await runActions(decided.actions, cfg); // notifications go out before any logging

  await appendLog('polls', { t: now, status: res.status ?? 0, ms, ...(outcome.ok ? { sig: signature(outcome.stores, cfg) } : { err: outcome.detail }) });
  if (decided.changes.length) {
    await appendLog('changes', { t: now, changes: decided.changes });
    await appendLog('raw', { t: now, json: outcome.json });
  }
  return undefined;
}

async function heartbeat() {
  const now = Date.now();
  const cfg = await loadSettings();
  const state = await loadState();
  const t = texts(cfg.language);
  const keys = [dayKey(now, 'polls'), dayKey(now - 1440 * MIN, 'polls')];
  const logs = await chrome.storage.local.get(keys);
  const polls = keys.flatMap((k) => logs[k] ?? []).filter((p) => now - p.t < 1440 * MIN);
  await notify(t.heartbeat({
    total: polls.length,
    ok: polls.filter((p) => p.sig != null).length,
    hit: state.hit ? t.inStockAt(state.hit.store, labelOf(cfg, state.hit.part)) : t.nothingInStock,
    paused: state.paused,
    interval: cfg.pollSeconds,
  }), cfg);
}

async function testNotify() {
  const cfg = await loadSettings();
  const results = await notify(texts(cfg.language).test(), cfg, true);
  if (!results.length) throw new Error('no notification channel is turned on');
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error(failed.map((r) => `${r.channel}: ${r.error}`).join('; '));
  return results.map((r) => r.channel).join(', ');
}

// Runs a made-up hit (first product, first store) through the real path, marked [test].
async function simulateHit() {
  const cfg = await loadSettings();
  const state = await loadState();
  const product = cfg.products[0];
  if (!product) throw new Error('add a product first');
  const stores = structuredClone(state.stores ?? {});
  const name = cfg.stores[0] ?? Object.keys(stores)[0] ?? 'Apple Store';
  stores[name] ??= { distance: 0, parts: {} };
  stores[name].parts[product.part] = { display: 'available', quote: 'Available Today (simulated)' };
  const { actions } = decide({ ...state, hit: null }, { ok: true, stores }, Date.now(), cfg);
  for (const a of actions) if (a.type === 'notify') await notify(a, cfg, true);
}

async function setPaused(paused) {
  const state = await loadState();
  state.paused = paused;
  await saveState(state);
}

// ---------- wiring ----------

async function scheduleAlarms() {
  const cfg = await loadSettings();
  await chrome.alarms.clearAll();
  await chrome.alarms.create('poll', { periodInMinutes: cfg.pollSeconds / 60 });
  await chrome.alarms.create('prune', { delayInMinutes: 1, periodInMinutes: 24 * 60 });
  if (cfg.heartbeatHour >= 0) {
    const at = new Date();
    at.setHours(cfg.heartbeatHour, 0, 0, 0);
    if (at <= new Date()) at.setDate(at.getDate() + 1);
    await chrome.alarms.create('heartbeat', { when: at.getTime(), periodInMinutes: 24 * 60 });
  }
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
  // A reload (reason 'update' for an unpacked extension) ends any pause, so it checks now.
  if (reason !== 'chrome_update') await saveState({ ...(await loadState()), backoff: { level: 0, until: 0 } });
  await scheduleAlarms();
  serial(() => poll());
});

chrome.runtime.onStartup.addListener(async () => {
  if (!(await chrome.alarms.get('poll'))) await scheduleAlarms();
});

// New settings: forget what was seen under the old ones, reschedule, and check with them.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  serial(async () => {
    await saveState({ ...(await loadState()), stores: null, hit: null, backoff: { level: 0, until: 0 } });
    await scheduleAlarms();
    await poll();
  });
});

chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === 'poll') {
    serial(async () => {
      const { jitterSeconds } = await loadSettings();
      await sleep(Math.random() * jitterSeconds * 1000);
      await poll();
    });
  }
  if (name === 'heartbeat') serial(heartbeat);
  if (name === 'prune') serial(() => pruneLogs(Date.now()));
});

chrome.notifications.onClicked.addListener(async (id) => {
  const { [id]: url } = await chrome.storage.session.get(id);
  if (url) await openPage(url);
  chrome.notifications.clear(id);
});

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('status.html') }));

const COMMANDS = {
  pollNow: () => poll({ force: true }),
  pause: () => setPaused(true),
  resume: () => setPaused(false),
  testNotify,
  simulateHit,
};

chrome.runtime.onMessage.addListener(({ cmd }, _sender, reply) => {
  const job = COMMANDS[cmd];
  if (!job) return false;
  serial(async () => {
    try {
      reply({ ok: true, note: await job() });
    } catch (e) {
      reply({ ok: false, error: String(e?.message ?? e) });
    }
  });
  return true;
});
