import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../extension/lib/settings.js';
import { classify, decide, initialState, isAvailable, parsePickup, pickTarget, pickupPath, signature } from '../extension/lib/logic.js';
import { CFG, MIN, P256, P512, T0, TODAY, UNWATCHED, notes, ok, response } from './helpers.js';

test('pickupPath asks for every product in one call, under the country store if there is one', () => {
  assert.equal(pickupPath(CFG), '/shop/retail/pickup-message?pl=true&parts.0=MK1H4LL%2FA&parts.1=MK1F4LL%2FA&location=98101');
  assert.equal(pickupPath(normalize({ ...CFG, country: 'uk', location: 'SW1A 1AA' })),
    '/uk/shop/retail/pickup-message?pl=true&parts.0=MK1H4LL%2FA&parts.1=MK1F4LL%2FA&location=SW1A%201AA');
});

test('parsePickup reads both answer shapes and strips HTML from quotes', () => {
  for (const nested of [false, true]) {
    const stores = parsePickup(response({ 'Bellevue Square': { [P256]: ['available', 'Available<br/>Today'] } }, { nested }), CFG);
    assert.deepEqual(Object.keys(stores).sort(), [...CFG.stores].sort());
    assert.deepEqual(stores['Bellevue Square'].parts[P256], { display: 'available', quote: 'Available Today' });
    assert.equal(stores['Bellevue Square'].parts['MK1G4LL/A'], undefined, 'unwatched parts are dropped');
  }
  assert.throws(() => parsePickup({ body: {} }, CFG), /no stores/);
});

test('with no stores listed, every store Apple returns is watched, within maxDistance', () => {
  const all = normalize({ ...CFG, stores: [] });
  assert.equal(Object.keys(parsePickup(response(), all)).length, 6);
  assert.deepEqual(Object.keys(parsePickup(response(), { ...all, maxDistance: 12 })).sort(), ['Bellevue Square', 'Southcenter', 'University Village']);
});

test('isAvailable trusts pickupDisplay and falls back to the quote text', () => {
  assert.equal(isAvailable({ display: 'available', quote: 'Today' }), true);
  assert.equal(isAvailable({ display: 'unavailable', quote: 'Something new' }), false);
  assert.equal(isAvailable({ display: 'ineligible', quote: '' }), false);
  assert.equal(isAvailable({ display: '', quote: 'Currently unavailable' }), false);
  assert.equal(isAvailable({ display: '', quote: 'Check back for availability on 10.31' }), false);
  assert.equal(isAvailable({ display: '', quote: 'Available Tomorrow' }), true);
  assert.equal(isAvailable(undefined), false);
});

test('pickTarget follows product preference first, then the listed store order', () => {
  const pick = (overrides, cfg = CFG) => {
    const t = pickTarget(parsePickup(response(overrides), cfg), cfg);
    return [t.part, t.store];
  };
  assert.deepEqual(pick({ 'Bellevue Square': { [P256]: TODAY }, 'Tacoma Mall': { [P512]: TODAY } }), [P512, 'Tacoma Mall']);
  assert.deepEqual(pick({ 'University Village': { [P512]: TODAY }, Southcenter: { [P512]: TODAY }, 'Bellevue Square': { [P512]: TODAY } }), [P512, 'Bellevue Square']);
  assert.deepEqual(pick({ 'University Village': { [P256]: TODAY }, Southcenter: { [P256]: TODAY } }), [P256, 'Southcenter']);
  // With no stores listed, the nearest store wins.
  assert.deepEqual(pick({ Southcenter: { [P512]: TODAY }, 'University Village': { [P512]: TODAY } }, normalize({ ...CFG, stores: [] })), [P512, 'University Village']);
});

test('parts not in the settings never count, wherever they are in stock', () => {
  const stores = parsePickup(response({ 'University Village': Object.fromEntries(UNWATCHED.map((part) => [part, TODAY])) }), CFG);
  assert.equal(pickTarget(stores, CFG), null);
});

test('a hit sends one high-priority notification linking to the product page, reminds 3 times, then reports it gone', () => {
  let r = decide(initialState(), ok(), T0, CFG);
  assert.equal(r.actions.length, 0, 'the first check only sets the baseline');

  const hit = { 'Bellevue Square': { [P512]: ['available', 'Available<br/>Today'] } };
  r = decide(r.state, ok(hit), T0 + MIN, CFG);
  assert.equal(notes(r.actions).length, 1);
  const [n] = notes(r.actions);
  assert.deepEqual([n.priority, n.title, n.message, n.click], [5, 'In stock for pickup: 512GB Night Sky', 'Bellevue Square: Available Today', CFG.products[0].url]);
  assert.equal(r.actions.filter((a) => a.type === 'open').length, 0, 'openOnHit is off by default');

  r = decide(r.state, ok(hit), T0 + 2 * MIN, CFG);
  assert.equal(r.actions.length, 0, 'no repeat within 5 minutes');

  let reminders = 0;
  for (let t = T0 + 3 * MIN; t < T0 + 40 * MIN; t += MIN) {
    r = decide(r.state, ok(hit), t, CFG);
    reminders += notes(r.actions).length;
  }
  assert.equal(reminders, 3);

  r = decide(r.state, ok(), T0 + 41 * MIN, CFG);
  assert.equal(notes(r.actions).length, 1);
  assert.match(notes(r.actions)[0].title, /No longer available/);
  assert.equal(r.state.hit, null);
});

test('a product without a page links to the country store; openOnHit opens it', () => {
  const cfg = normalize({ ...CFG, country: 'ca', openOnHit: true });
  const r = decide(initialState(), ok({ Alderwood: { [P256]: TODAY } }, cfg), T0, cfg);
  assert.equal(notes(r.actions)[0].click, 'https://www.apple.com/ca/shop');
  assert.deepEqual(r.actions.filter((a) => a.type === 'open').map((a) => a.url), ['https://www.apple.com/ca/shop']);
});

test('a better product appearing during a hit is a new hit, and lists the other one', () => {
  let r = decide(initialState(), ok({ Alderwood: { [P256]: TODAY } }), T0, CFG);
  r = decide(r.state, ok({ Alderwood: { [P256]: TODAY }, Southcenter: { [P512]: TODAY } }), T0 + MIN, CFG);
  const [n] = notes(r.actions);
  assert.equal(n.title, 'In stock for pickup: 512GB Night Sky');
  assert.equal(n.message, 'Southcenter: Today\nAlso: 256GB Night Sky at Alderwood');
});

test('Chinese notifications', () => {
  const cfg = normalize({ ...CFG, language: 'zh' });
  const r = decide(initialState(), ok({ Southcenter: { [P512]: TODAY }, Alderwood: { [P256]: TODAY } }, cfg), T0, cfg);
  assert.equal(notes(r.actions)[0].title, '可以取货了：512GB Night Sky');
  assert.equal(notes(r.actions)[0].message, 'Southcenter：Today\n另有：Alderwood 256GB Night Sky 可取货');
});

test('a text change that is not a hit sends a normal notification; a store newly in the answer does not', () => {
  let r = decide(initialState(), ok(), T0, CFG);
  r = decide(r.state, ok({ 'Tacoma Mall': { [P256]: ['unavailable', 'Check back for availability on 10.31'] } }), T0 + MIN, CFG);
  assert.deepEqual(r.actions.map((a) => [a.type, a.priority]), [['notify', 3]]);

  const all = normalize({ ...CFG, stores: [], maxDistance: 12 });
  r = decide(initialState(), ok({}, all), T0, all);
  r = decide(r.state, ok({}, { ...all, maxDistance: 20 }), T0 + MIN, all);
  assert.equal(r.actions.length, 0);
});

test('signature has one character per store and product, in store order', () => {
  assert.equal(signature(ok({ Southcenter: { [P512]: TODAY } }).stores, CFG), '-- A- -- -- --');
});

test('blocks pause 10, 30, then 60 minutes with one notification, and recovery is reported', () => {
  let r = { state: initialState() };
  const until = [];
  let sent = 0;
  for (let i = 0; i < 4; i++) {
    r = decide(r.state, { ok: false, blocked: true, detail: 'HTTP 541' }, T0, CFG);
    until.push((r.state.backoff.until - T0) / MIN);
    sent += r.actions.length;
  }
  assert.deepEqual(until, [10, 30, 60, 60]);
  assert.equal(sent, 1);
  r = decide(r.state, ok(), T0 + 3 * 60 * MIN, CFG);
  assert.deepEqual(r.actions.map((a) => a.title), ['Checks are working again']);
  assert.equal(r.state.backoff.until, 0);
});

test('541, 403 and 429 are blocks; another 5xx is a server error; a sign-in redirect or non-JSON body is a block', () => {
  const res = (status, extra = {}) => classify({ status, path: '/shop/retail/pickup-message', type: 'application/json', text: '{}', ...extra });
  for (const s of [541, 403, 429]) assert.equal(res(s).blocked, true, `HTTP ${s}`);
  for (const s of [500, 502, 503, 504]) assert.deepEqual([res(s).blocked, res(s).serverError], [false, true], `HTTP ${s}`);
  assert.equal(res(200, { path: '/shop/signIn' }).blocked, true);
  assert.equal(res(200, { type: 'text/html', text: '<html>' }).blocked, true);
  assert.equal(res(404).blocked, false);
  assert.equal(res(200).ok, true);
  assert.equal(classify({ error: 'timeout after 15000 ms' }).detail, 'timeout after 15000 ms');
});

test('a lone 503 is retried at the normal pace; a second failure in a row backs off', () => {
  const http503 = classify({ status: 503, path: '/', type: 'text/html', text: '' });
  let r = decide(initialState(), ok(), T0, CFG);
  r = decide(r.state, http503, T0 + 2 * MIN, CFG);
  assert.deepEqual([r.actions.length, r.state.backoff.until], [0, 0]);
  r = decide(r.state, ok(), T0 + 4 * MIN, CFG);
  assert.equal(r.actions.length, 0, 'nothing to report after a lone 503');

  r = decide(r.state, http503, T0 + 6 * MIN, CFG);
  r = decide(r.state, http503, T0 + 8 * MIN, CFG);
  assert.equal((r.state.backoff.until - T0) / MIN, 18);
  assert.equal(notes(r.actions)[0].title, 'Apple is pushing back, pausing 10 min');
});

test('network failures notify once on the 5th in a row, without backing off', () => {
  let r = { state: initialState() };
  const sent = [];
  for (let i = 0; i < 8; i++) {
    r = decide(r.state, { ok: false, blocked: false, detail: 'timeout after 15000 ms' }, T0 + i * MIN, CFG);
    sent.push(r.actions.length);
  }
  assert.deepEqual(sent, [0, 0, 0, 0, 1, 0, 0, 0]);
  assert.equal(r.state.backoff.until, 0);
});
