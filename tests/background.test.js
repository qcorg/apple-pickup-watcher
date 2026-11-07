// Runs the real service worker against a fake chrome.* and fake Apple answers (the saved fixtures), end to end:
// install, settings, a check, a hit, its notification, Bark push and click, a block, Check now and a test notification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8');
const answer = (text, status = 200) => ({ status, path: '/shop/retail/pickup-message', type: 'application/json', text });

function event() {
  const listeners = [];
  return { addListener: (f) => listeners.push(f), fire: (...args) => listeners.map((f) => f(...args)) };
}

const local = {};
const session = {};
const alarms = {};
const tabs = [];
const requests = [];
const shown = [];
const pushed = [];
const opened = [];
let next = answer(fixture('01-unavailable'));
let clock = new Date(2026, 9, 24, 12).getTime();

const pick = (obj, keys) => structuredClone(keys == null ? obj : Object.fromEntries([keys].flat().filter((k) => k in obj).map((k) => [k, obj[k]])));
const onChanged = event();
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => pick(local, keys),
      set: async (items) => {
        const changes = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: local[k], newValue: v };
          local[k] = structuredClone(v);
        }
        onChanged.fire(changes, 'local');
      },
      remove: async (keys) => { for (const k of [keys].flat()) delete local[k]; },
      getKeys: async () => Object.keys(local),
    },
    session: { get: async (keys) => pick(session, keys), set: async (items) => Object.assign(session, items) },
    onChanged,
  },
  alarms: {
    create: async (name, info) => { alarms[name] = info; },
    clearAll: async () => { for (const k of Object.keys(alarms)) delete alarms[k]; },
    get: async (name) => alarms[name],
    onAlarm: event(),
  },
  runtime: {
    onInstalled: event(), onStartup: event(), onMessage: event(),
    openOptionsPage: () => opened.push('options'),
    getURL: (p) => `chrome-extension://test/${p}`,
  },
  tabs: {
    get: async (id) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      return tab;
    },
    create: async (props) => {
      const tab = { id: tabs.length + 1, status: 'complete', windowId: 1, ...props };
      tabs.push(tab);
      if (props.active) opened.push(props.url);
      return tab;
    },
    update: async (id, props) => Object.assign(tabs.find((t) => t.id === id), props),
    query: async ({ url, pinned }) => tabs.filter((t) => t.pinned === pinned && t.url.startsWith(url.replace(/\*$/, ''))),
    reload: async () => {},
  },
  windows: { getAll: async () => [{ id: 1 }], getLastFocused: async () => ({ id: 1 }), update: async () => {} },
  scripting: { executeScript: async ({ args: [path] }) => { requests.push(path); return [{ result: next }]; } },
  notifications: { create: async (id, options) => { shown.push({ id, ...options }); }, clear: () => {}, onClicked: event() },
  action: { onClicked: event() },
  permissions: { request: async () => true },
};
globalThis.fetch = async (url, init) => { pushed.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
Date.now = () => clock;

async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const settle = () => new Promise((r) => setTimeout(r, 50));
const send = (cmd) => new Promise((reply) => chrome.runtime.onMessage.fire({ cmd }, {}, reply));

await import('../extension/background.js');

test('the service worker, end to end against fake Apple answers', async () => {
  chrome.runtime.onInstalled.fire({ reason: 'install' });
  await until(() => alarms.poll, 'the poll alarm');
  await settle();
  assert.deepEqual(opened, ['options'], 'a fresh install opens the settings');
  assert.equal(requests.length, 0, 'nothing is checked before it is set up');

  await chrome.storage.local.set({
    settings: {
      location: '98101',
      products: [{ part: 'MK1H4LL/A', label: '512GB Night Sky' }, { part: 'MK1F4LL/A', label: '256GB Night Sky', url: 'https://www.apple.com/shop/buy-iphone/x' }],
      jitterSeconds: 0,
      notify: { chrome: true, bark: { enabled: true, key: 'my-key' } },
    },
  });
  await until(() => requests.length === 1, 'the first check');
  await until(() => local.state?.stores, 'the first answer to be stored');
  assert.equal(requests[0], '/shop/retail/pickup-message?pl=true&parts.0=MK1H4LL%2FA&parts.1=MK1F4LL%2FA&location=98101');
  assert.deepEqual([tabs[0].url, tabs[0].pinned, tabs[0].active], ['https://www.apple.com/shop/buy-iphone', true, false]);
  assert.equal(Object.keys(local.state.stores).length, 6, 'no stores listed: all of them');
  assert.equal(alarms.poll.periodInMinutes, 75 / 60);
  assert.equal(shown.length, 0);

  clock += 75_000;
  next = answer(fixture('02-bellevue-256-night-sky'));
  chrome.alarms.onAlarm.fire({ name: 'poll' });
  await until(() => shown.length === 1, 'the hit notification');
  assert.deepEqual([shown[0].title, shown[0].message, shown[0].requireInteraction], ['In stock for pickup: 256GB Night Sky', 'Bellevue Square: Available Today', true]);
  await until(() => pushed.length === 1, 'the Bark push');
  assert.deepEqual([pushed[0].url, pushed[0].body.device_key, pushed[0].body.level], ['https://api.day.app/push', 'my-key', 'active']);
  assert.equal(requests.length, 2, 'the host tab is reused');
  assert.equal(tabs.length, 1);

  // After a Chrome restart the stored tab id is gone; the restored pinned tab is found by its address, not opened again.
  tabs[0].id = 99;
  clock += 60_000;
  next = answer(fixture('03-bellevue-still-available'));
  chrome.alarms.onAlarm.fire({ name: 'poll' });
  await until(() => requests.length === 3, 'a check after the restart');
  await until(() => local.state.hostTabId === 99, 'the restored tab to be adopted');
  assert.equal(tabs.length, 1);

  await Promise.all(chrome.notifications.onClicked.fire(shown[0].id));
  assert.equal(opened.at(-1), 'https://www.apple.com/shop/buy-iphone/x', 'clicking opens the product page');

  clock += 75_000;
  next = answer('', 541);
  chrome.alarms.onAlarm.fire({ name: 'poll' });
  await until(() => shown.length === 2, 'the block notification');
  assert.equal(shown[1].title, 'Apple is pushing back, pausing 10 min');
  assert.equal(local.state.backoff.until, clock + 10 * 60_000);

  clock += 75_000;
  chrome.alarms.onAlarm.fire({ name: 'poll' });
  await settle();
  assert.equal(requests.length, 4, 'no check during the pause');

  local['polls:2026-01-01'] = [{ t: 0 }];
  chrome.alarms.onAlarm.fire({ name: 'prune' });
  await until(() => !local['polls:2026-01-01'], 'old logs to be pruned');
  assert.ok(Object.keys(local).some((k) => k.startsWith('polls:2026-10')), 'this week\'s logs stay');

  clock += 10_000;
  next = answer(fixture('03-bellevue-still-available'));
  assert.deepEqual(await send('pollNow'), { ok: true, note: undefined });
  assert.equal(requests.length, 5, 'Check now goes through a pause');
  assert.equal(shown.at(-1).title, 'Checks are working again');

  clock += 10_000;
  assert.deepEqual(await send('pollNow'), { ok: true, note: 'the last check was less than 30 s ago' });
  assert.equal(requests.length, 5);

  assert.deepEqual(await send('testNotify'), { ok: true, note: 'chrome, bark' });
  assert.equal(shown.at(-1).title, '[test] Pickup Watcher test');
});
