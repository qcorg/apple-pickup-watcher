// Pickup Watcher service worker. About every pollSeconds it asks Apple for pickup availability from a pinned
// apple.com tab in this Chrome profile, the same request apple.com makes when you check a store, and notifies you
// on a hit. What to do with each answer is decided in lib/logic.js.
import { texts } from './lib/i18n.js';
import { classify, dayKey, daysAgo, decide, initialState, labelOf, parsePickup, pickupPath, signature } from './lib/logic.js';
import { pushRequests, sendPushes } from './lib/notify.js';
import { MIN_GAP_SECONDS, MIN_POLL_SECONDS, appleBase, hostUrl, isHttpsUrl, missing, normalize, watchScope } from './lib/settings.js';

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

// entries: [[prefix, entry]], written with one read and one write.
async function appendLogs(entries) {
  const keys = entries.map(([prefix, entry]) => dayKey(entry.t, prefix));
  const logs = await chrome.storage.local.get(keys);
  entries.forEach(([, entry], i) => (logs[keys[i]] ??= []).push(entry));
  await chrome.storage.local.set(logs);
}

async function pruneLogs(now) {
  const keep = new Set();
  for (let i = 0; i < LOG_DAYS; i++) for (const p of LOG_PREFIXES) keep.add(dayKey(daysAgo(now, i), p));
  const keys = await chrome.storage.local.getKeys();
  const stale = keys.filter((k) => LOG_PREFIXES.some((p) => k.startsWith(`${p}:`)) && !keep.has(k));
  if (stale.length) await chrome.storage.local.remove(stale);
}

// ---------- the host tab ----------

// Waits up to 20 s for the store page itself. Right after a navigation the tab can still report the old page as
// complete, so it has to be on the store; after a reload (same address) it has to have been seen loading, or 3 s passed.
async function waitForLoad(tabId, base, reloaded = false) {
  let started = !reloaded;
  for (let i = 0; i < 80; i++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'complete' || i >= 12) started = true;
    if (started && tab.status === 'complete' && !tab.discarded && (tab.url ?? '').startsWith(`${base}/`)) return tab;
    await sleep(250);
  }
  throw new Error('host tab did not finish loading the Apple Store page');
}

// The tab this extension pinned, on this country's store; it is reopened if you close it. Tab ids start over when
// Chrome restarts (onStartup forgets the old one), so a restored tab is found again by its address.
async function hostTab(state, cfg) {
  const base = appleBase(cfg);
  let tab = state.hostTabId != null ? await chrome.tabs.get(state.hostTabId).catch(() => null) : null;
  let reloaded = false;
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
  } else if (tab.discarded || tab.status === 'unloaded' || Date.now() - state.hostLoadedAt > HOST_RELOAD_MINUTES * MIN) {
    await chrome.tabs.reload(tab.id);
    reloaded = true;
    state.hostLoadedAt = Date.now();
  }
  await chrome.tabs.update(tab.id, { autoDiscardable: false });
  return waitForLoad(tab.id, base, reloaded);
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
  const b = cfg.notify.bark;
  if (b.enabled && b.key && !isHttpsUrl(b.server)) results.push({ channel: 'bark', ok: false, error: 'its server is not an https:// address' });
  results.push(...await sendPushes(pushRequests(cfg, m, test)));
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.error('[pickup-watcher] notification failed:', r.channel, r.error);
  // The status page shows the last failure until a notification gets through everywhere again.
  await chrome.storage.local.set({ notifyError: failed.length ? { t: Date.now(), errors: failed.map((r) => `${r.channel}: ${r.error}`) } : null });
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

// Apple's pause, unless the clock went back since it was set (it would then last longer than any pause can).
const pauseEnd = (state, cfg, now) => (state.backoff.until - now > Math.max(...cfg.backoffMinutes) * MIN ? now : state.backoff.until);

// -> a reason it did not check, or undefined after a check. force ("Check now") skips your own pause and checks
// sooner than the schedule would, but never during Apple's pause.
async function poll({ force = false } = {}) {
  const now = Date.now();
  const cfg = await loadSettings();
  const state = await loadState();
  if (missing(cfg).length) return 'not set up yet';
  if (now < pauseEnd(state, cfg, now)) return `Apple asked for a pause; checks resume at ${new Date(state.backoff.until).toLocaleTimeString()}`;
  if (state.paused && !force) return 'paused';
  const gap = force ? MIN_GAP_SECONDS : MIN_POLL_SECONDS;
  // A last check "in the future" means the clock went back; it does not hold checks up.
  if (state.lastCheckAt <= now && now - state.lastCheckAt < gap * 1000) return `the last check was less than ${gap} s ago`;
  state.lastCheckAt = now;
  await saveState(state); // before the request, so a check that never finishes still counts for the gap

  let res;
  try {
    const tab = await hostTab(state, cfg);
    res = (await fetchInTab(tab.id, pickupPath(cfg))) ?? { error: 'no result from the tab (it navigated or closed)' };
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

  const entries = [['polls', { t: now, status: res.status ?? 0, ms, ...(outcome.ok ? { sig: signature(outcome.stores, cfg) } : { err: outcome.detail }) }]];
  if (decided.changes.length) entries.push(['changes', { t: now, changes: decided.changes }], ['raw', { t: now, json: outcome.json }]);
  await appendLogs(entries);
  return undefined;
}

async function heartbeat() {
  const now = Date.now();
  const cfg = await loadSettings();
  const state = await loadState();
  const t = texts(cfg.language);
  const keys = [dayKey(now, 'polls'), dayKey(daysAgo(now, 1), 'polls')];
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

// Runs a made-up hit (first product, first store) through the real decision, marked [test]. It starts from a clean
// state, so a pause or failure count does not add other notifications, and nothing is saved.
async function simulateHit() {
  const cfg = await loadSettings();
  const state = await loadState();
  const product = cfg.products[0];
  if (!product) throw new Error('add a product first');
  const stores = structuredClone(state.stores ?? {});
  const name = cfg.stores[0] ?? Object.keys(stores)[0] ?? 'Apple Store';
  stores[name] ??= { distance: 0, parts: {} };
  stores[name].parts[product.part] = { display: 'available', quote: 'Available Today (simulated)' };
  const { actions } = decide({ ...initialState(), stores: state.stores }, { ok: true, stores }, Date.now(), cfg);
  for (const a of actions) {
    if (a.type === 'notify') await notify(a, cfg, true);
    else if (a.type === 'open') await openPage(a.url);
  }
}

async function setPaused(paused) {
  const state = await loadState();
  state.paused = paused;
  await saveState(state);
}

// ---------- wiring ----------

// One 'poll' alarm per check, set after each one: pollSeconds plus 0–jitterSeconds after the last check, not before
// Apple's pause ends, and at least MIN_GAP_SECONDS from now. Nothing sleeps in the service worker, which Chrome
// stops after 30 s idle.
async function scheduleNextPoll() {
  const now = Date.now();
  const cfg = await loadSettings();
  const state = await loadState();
  const last = state.lastCheckAt <= now ? state.lastCheckAt : 0;
  const due = Math.max(last + cfg.pollSeconds * 1000, pauseEnd(state, cfg, now), now + MIN_GAP_SECONDS * 1000);
  await chrome.alarms.create('poll', { when: due + Math.random() * cfg.jitterSeconds * 1000 });
}

// The other alarms are only replaced when missing or changed, so a settings save never drops today's summary.
async function scheduleAlarms() {
  const cfg = await loadSettings();
  await scheduleNextPoll();
  // Restarts the chain of poll alarms if it ever breaks, e.g. the worker stopped in the middle of a check.
  if (!(await chrome.alarms.get('watchdog'))) await chrome.alarms.create('watchdog', { periodInMinutes: 5 });
  if (!(await chrome.alarms.get('prune'))) await chrome.alarms.create('prune', { delayInMinutes: 1, periodInMinutes: 24 * 60 });
  const heartbeat = await chrome.alarms.get('heartbeat');
  if (cfg.heartbeatHour < 0) await chrome.alarms.clear('heartbeat');
  else if (!heartbeat || new Date(heartbeat.scheduledTime).getHours() !== cfg.heartbeatHour) {
    const at = new Date();
    at.setHours(cfg.heartbeatHour, 0, 0, 0);
    if (at <= new Date()) at.setDate(at.getDate() + 1);
    await chrome.alarms.create('heartbeat', { when: at.getTime(), periodInMinutes: 24 * 60 });
  }
}

// Checks now if it may (poll() says why not), then sets the alarms from the time of the last check.
const pollAndSchedule = (doPoll = true) =>
  serial(async () => {
    try {
      if (doPoll) await poll();
    } finally {
      await scheduleAlarms();
    }
  });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
  pollAndSchedule();
});

chrome.runtime.onStartup.addListener(() => {
  serial(async () => {
    await saveState({ ...(await loadState()), hostTabId: null });
    if (!(await chrome.alarms.get('poll'))) await scheduleAlarms();
  });
});

// New settings are rescheduled. If they change what is watched, what was seen before is forgotten and a check runs
// now; a new label, pace or Bark key keeps the current hit, so it is not announced again. Apple's pause holds either way.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const rescoped = watchScope(normalize(changes.settings.oldValue)) !== watchScope(normalize(changes.settings.newValue));
  if (rescoped) serial(async () => saveState({ ...(await loadState()), stores: null, hit: null }));
  pollAndSchedule(rescoped);
});

chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === 'poll') {
    serial(async () => {
      try {
        await poll();
      } finally {
        await scheduleNextPoll();
      }
    });
  }
  if (name === 'watchdog') serial(async () => { if (!(await chrome.alarms.get('poll'))) await scheduleNextPoll(); });
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
