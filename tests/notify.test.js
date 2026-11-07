import { test } from 'node:test';
import assert from 'node:assert/strict';
import { texts } from '../extension/lib/i18n.js';
import { barkRequest, isQuietHour, pushRequests, sendPushes } from '../extension/lib/notify.js';
import { normalize } from '../extension/lib/settings.js';

const hit = texts('en').hit({ store: 'Bellevue Square', label: '256GB', quote: 'Available Today', link: 'https://www.apple.com/shop' }, []);
const body = (req) => JSON.parse(req.init.body);
const cfgWith = (notify) => normalize({ notify });

test('quiet hours can wrap past midnight', () => {
  assert.deepEqual([22, 23, 0, 7, 8, 12].map((h) => isQuietHour([23, 8], h)), [false, true, true, true, false, false]);
  assert.deepEqual([12, 13, 14].map((h) => isQuietHour([13, 14], h)), [false, true, false]);
});

test('Bark: a hit is an ordinary notification unless critical is on; then it rings, except in quiet hours, when it is ordinary again', () => {
  const at = (cfg, h, m = hit) => body(barkRequest(cfg, m, false, new Date(2026, 9, 25, h)));
  const plain = cfgWith({ bark: { enabled: true, key: 'k' } });
  assert.deepEqual([at(plain, 12).level, at(plain, 12).sound], ['active', undefined]);

  const loud = cfgWith({ bark: { enabled: true, key: 'k', critical: true } });
  for (const h of [8, 12, 22]) assert.deepEqual([at(loud, h).level, at(loud, h).sound, at(loud, h).volume], ['critical', 'alarm', 10], `${h}:00`);
  for (const h of [23, 2, 7]) assert.deepEqual([at(loud, h).level, at(loud, h).sound], ['active', undefined], `${h}:00`);

  assert.equal(at(loud, 12, texts('en').heartbeat({ total: 1, ok: 1, hit: '-', interval: 75 })).level, 'passive');
  assert.equal(at(loud, 12, texts('en').failing(5, 'x')).level, 'active');
  const req = barkRequest(plain, hit);
  assert.equal(req.url, 'https://api.day.app/push');
  assert.deepEqual([body(req).device_key, body(req).url, body(req).title], ['k', 'https://www.apple.com/shop', 'In stock for pickup: 256GB']);
});

test('pushRequests sends to Bark only when it is on and has a key, and marks tests', () => {
  const channels = (notify) => pushRequests(cfgWith(notify), hit).map((r) => r.channel);
  assert.deepEqual(channels({}), []);
  assert.deepEqual(channels({ bark: { enabled: true, key: '' } }), []);
  assert.deepEqual(channels({ bark: { enabled: false, key: 'k' } }), []);
  assert.deepEqual(channels({ bark: { enabled: true, key: 'k' } }), ['bark']);
  assert.deepEqual(channels({ bark: { enabled: true, key: 'k', server: 'http://bark.lan:8080' } }), [], 'never to a server that is not https, nor to api.day.app instead');
  assert.equal(body(pushRequests(cfgWith({ bark: { enabled: true, key: 'k' } }), hit, true)[0]).title, '[test] In stock for pickup: 256GB');
});

test('sendPushes reports a failure instead of throwing, and gives up on a server that does not answer', async () => {
  const reqs = pushRequests(cfgWith({ bark: { enabled: true, key: 'k' } }), hit);
  const signals = [];
  await sendPushes(reqs, async (url, init) => { signals.push(init.signal instanceof AbortSignal); return { ok: true }; });
  assert.deepEqual(signals, [true]);
  const offline = async () => { throw new Error('offline'); };
  const throttled = async () => ({ ok: false, status: 429 });
  const fine = async () => ({ ok: true, status: 200 });
  assert.deepEqual(await sendPushes(reqs, offline), [{ channel: 'bark', ok: false, error: 'offline' }]);
  assert.deepEqual(await sendPushes(reqs, throttled), [{ channel: 'bark', ok: false, error: 'HTTP 429' }]);
  assert.deepEqual(await sendPushes(reqs, fine), [{ channel: 'bark', ok: true }]);
});
