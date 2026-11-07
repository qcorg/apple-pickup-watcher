import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, MIN_POLL_SECONDS, appleBase, extraOrigins, hostUrl, missing, normalize, productLink } from '../extension/lib/settings.js';

test('empty or junk settings fall back to the defaults', () => {
  for (const raw of [undefined, null, {}, 'junk']) assert.deepEqual(normalize(raw), normalize(DEFAULTS));
  assert.deepEqual(missing(normalize({})), ['needLocation', 'needProducts']);
  assert.deepEqual(missing(normalize({ location: '98101', products: [{ part: 'x' }] })), []);
});

test('checks never run faster than once a minute', () => {
  assert.equal(MIN_POLL_SECONDS, 60);
  for (const s of [0, 5, 30, -1, '45']) assert.equal(normalize({ pollSeconds: s }).pollSeconds, 60, String(s));
  assert.equal(normalize({ pollSeconds: '90' }).pollSeconds, 90);
  assert.equal(normalize({ pollSeconds: 'fast' }).pollSeconds, DEFAULTS.pollSeconds);
});

test('products: part numbers trimmed and upper-cased, duplicates dropped, label defaults to the part, only apple.com https pages kept', () => {
  const { products } = normalize({
    products: [
      { part: ' mk1h4ll/a ', label: ' 512GB ', url: 'https://www.apple.com/shop/buy-iphone/x' },
      { part: 'MK1H4LL/A', label: 'duplicate' },
      { part: 'MK1F4LL/A', url: 'https://evil.example/apple.com' },
      { part: 'MX1', url: 'http://www.apple.com/shop' },
      { part: '' },
    ],
  });
  assert.deepEqual(products, [
    { part: 'MK1H4LL/A', label: '512GB', url: 'https://www.apple.com/shop/buy-iphone/x' },
    { part: 'MK1F4LL/A', label: 'MK1F4LL/A', url: '' },
    { part: 'MX1', label: 'MX1', url: '' },
  ]);
  assert.equal(normalize({ products: Array.from({ length: 15 }, (_, i) => ({ part: `P${i}` })) }).products.length, 10);
});

test('country store paths and the links built on them', () => {
  assert.equal(normalize({ country: ' /UK/ ' }).country, 'uk');
  assert.equal(normalize({ country: 'hk/en' }).country, 'hk/en');
  assert.equal(normalize({ country: '../x?y' }).country, 'xy', 'only letters, digits, - and / survive');
  const us = normalize({});
  const uk = normalize({ country: 'uk' });
  assert.equal(appleBase(us), 'https://www.apple.com');
  assert.equal(hostUrl(uk), 'https://www.apple.com/uk/shop/buy-iphone');
  assert.equal(productLink(uk, { url: '' }), 'https://www.apple.com/uk/shop');
  assert.equal(productLink(uk, { url: 'https://www.apple.com/uk/shop/x' }), 'https://www.apple.com/uk/shop/x');
});

test('notification settings: defaults, https servers only, and permissions for servers outside the manifest', () => {
  const d = normalize({});
  assert.deepEqual([d.notify.chrome, d.notify.bark.enabled, d.notify.bark.critical], [true, false, false]);
  const cfg = normalize({ notify: { bark: { enabled: true, key: ' abc ', server: 'https://bark.example.com/' } } });
  assert.equal(cfg.notify.bark.key, 'abc');
  assert.equal(cfg.notify.bark.server, 'https://bark.example.com');
  assert.equal(normalize({ notify: { bark: { server: 'http://insecure.example' } } }).notify.bark.server, 'https://api.day.app', 'plain http falls back to the default');
  assert.deepEqual(extraOrigins(cfg), ['https://bark.example.com/*']);
  assert.deepEqual(extraOrigins(normalize({ notify: { bark: { enabled: true, key: 'k' } } })), [], 'api.day.app is in the manifest');
  assert.deepEqual(extraOrigins(normalize({ notify: { bark: { enabled: false, server: 'https://bark.example.com' } } })), []);
});

test('backoff, heartbeat and language are kept in range', () => {
  assert.deepEqual(normalize({ backoffMinutes: [0, 'x', 5] }).backoffMinutes, [5]);
  assert.deepEqual(normalize({ backoffMinutes: [] }).backoffMinutes, DEFAULTS.backoffMinutes);
  assert.equal(normalize({ heartbeatHour: 30 }).heartbeatHour, 23);
  assert.equal(normalize({ heartbeatHour: '-5' }).heartbeatHour, -1);
  assert.equal(normalize({ language: 'fr' }).language, 'en');
  assert.equal(normalize({ language: 'zh' }).language, 'zh');
});
