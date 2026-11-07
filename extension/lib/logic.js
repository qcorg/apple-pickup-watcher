// Decision logic: what Apple's answer means and what to do about it. Shared by the extension's service worker
// and the Node tools/tests; nothing in this file touches chrome.* or the network.
import { texts } from './i18n.js';
import { productLink } from './settings.js';

const MIN = 60_000;
const UNAVAILABLE = [/^currently unavailable/i, /^check back for availability/i, /^not available/i, /^unavailable/i];

export const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export const labelOf = (cfg, part) => cfg.products.find((p) => p.part === part)?.label ?? part;

export function dayKey(t, prefix) {
  const d = new Date(t);
  const ymd = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')];
  return `${prefix}:${ymd.join('-')}`;
}

// Noon, local time, n calendar days before t: subtracting 24 h would skip a day after a 23-hour (DST) day.
export function daysAgo(t, n) {
  const d = new Date(t);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
}

// The call apple.com's own "check availability" makes. One request covers every product and every nearby store.
export const pickupPath = (cfg) => {
  const parts = cfg.products.map((p, i) => `parts.${i}=${encodeURIComponent(p.part)}`).join('&');
  return `${cfg.country ? `/${cfg.country}` : ''}/shop/retail/pickup-message?pl=true&${parts}&location=${encodeURIComponent(cfg.location)}`;
};

// -> { [storeName]: { distance, parts: { [part]: { display, quote } } } }: the watched stores (all of them when
// cfg.stores is empty) within cfg.maxDistance. Some answers nest the stores under body.content.pickupMessage.
export function parsePickup(json, cfg) {
  const stores = json?.body?.content?.pickupMessage?.stores ?? json?.body?.stores;
  if (!Array.isArray(stores)) throw new Error('pickup response has no stores');
  const out = {};
  for (const s of stores) {
    const distance = Number(s.storedistance) || 0;
    if (cfg.stores.length && !cfg.stores.includes(s.storeName)) continue;
    if (cfg.maxDistance && distance > cfg.maxDistance) continue;
    const parts = {};
    for (const { part } of cfg.products) {
      const v = s.partsAvailability?.[part];
      if (!v) continue;
      parts[part] = {
        display: v.pickupDisplay ?? '',
        quote: stripHtml(v.pickupSearchQuote || v.messageTypes?.regular?.storePickupQuote),
      };
    }
    out[s.storeName] = { distance, parts };
  }
  return out;
}

// Stores in order of preference: the order of cfg.stores if you listed any, otherwise nearest first.
export function storeOrder(stores, cfg) {
  const names = Object.keys(stores);
  if (cfg.stores.length) return cfg.stores.filter((n) => names.includes(n));
  return names.sort((a, b) => stores[a].distance - stores[b].distance);
}

// res: what the tab's fetch returned, { status, path, type, text } | { error }.
// 403/429/541 (Apple's throttle), a non-JSON body or a sign-in/challenge redirect means Apple is pushing back: back off.
// Any other 5xx may be a passing server error, so decide() backs off only if the check before it failed too.
export function classify(res) {
  if (res.error) return { ok: false, blocked: false, detail: res.error };
  const { status, path, type, text } = res;
  if (status === 403 || status === 429 || status === 541) return { ok: false, blocked: true, detail: `HTTP ${status}` };
  if (status >= 500) return { ok: false, blocked: false, serverError: true, detail: `HTTP ${status}` };
  if (/sign|login|challenge|captcha/i.test(path)) return { ok: false, blocked: true, detail: `redirected to ${path}` };
  if (status !== 200) return { ok: false, blocked: false, detail: `HTTP ${status}` };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, blocked: true, detail: `not JSON (${type || 'no content-type'})` };
  }
}

// pickupDisplay is Apple's own flag; the quote text only decides when the flag is missing or a new value.
export function isAvailable(cell) {
  if (!cell) return false;
  if (cell.display === 'available') return true;
  if (cell.display === 'unavailable' || cell.display === 'ineligible') return false;
  return cell.quote !== '' && !UNAVAILABLE.some((re) => re.test(cell.quote));
}

// The first product (in order of preference) that is in stock anywhere, at the most preferred store that has it.
export function pickTarget(stores, cfg) {
  const order = storeOrder(stores, cfg);
  for (const p of cfg.products) {
    const store = order.find((name) => isAvailable(stores[name].parts[p.part]));
    if (store) return { part: p.part, label: p.label, link: productLink(cfg, p), store, quote: stores[store].parts[p.part].quote };
  }
  return null;
}

export function diffStores(prev, next) {
  const changes = [];
  for (const [store, s] of Object.entries(next)) {
    for (const [part, cell] of Object.entries(s.parts)) {
      const before = prev[store]?.parts[part] ?? null;
      if (!before || before.display !== cell.display || before.quote !== cell.quote) {
        changes.push({ store, part, from: before, to: cell });
      }
    }
  }
  return changes;
}

// Compact per-check record: one character per store x product, 'A' available, '-' not, '?' no data.
export function signature(stores, cfg) {
  return storeOrder(stores, cfg)
    .map((name) => cfg.products.map(({ part }) => (!stores[name].parts[part] ? '?' : isAvailable(stores[name].parts[part]) ? 'A' : '-')).join(''))
    .join(' ');
}

export function initialState() {
  return { stores: null, hit: null, failures: 0, failureAlerted: false, backoff: { level: 0, until: 0 }, lastCheckAt: 0 };
}

// outcome: { ok: true, stores } | { ok: false, blocked, serverError?, detail }
// -> { state, actions: [{ type: 'notify', ...message } | { type: 'open', url }], changes }
export function decide(prev, outcome, now, cfg) {
  const state = structuredClone(prev);
  const t = texts(cfg.language);
  const actions = [];
  const notify = (m) => actions.push({ type: 'notify', ...m });

  if (!outcome.ok) {
    if (outcome.blocked || (outcome.serverError && state.failures > 0)) {
      const mins = cfg.backoffMinutes[Math.min(state.backoff.level, cfg.backoffMinutes.length - 1)];
      if (state.backoff.level === 0) notify(t.blocked(mins, outcome.detail));
      state.backoff = { level: state.backoff.level + 1, until: now + mins * MIN };
    } else if (++state.failures === cfg.failureAlertAfter) {
      notify(t.failing(state.failures, outcome.detail));
      state.failureAlerted = true;
    }
    return { state, actions, changes: [] };
  }

  if (state.failureAlerted || state.backoff.level > 0) notify(t.recovered());
  Object.assign(state, { failures: 0, failureAlerted: false, backoff: { level: 0, until: 0 } });

  const next = outcome.stores;
  const changes = prev.stores ? diffStores(prev.stores, next) : [];
  state.stores = next;

  const target = pickTarget(next, cfg);
  const same = target && state.hit?.part === target.part && state.hit?.store === target.store;
  if (target && !same) {
    const order = storeOrder(next, cfg);
    const others = cfg.products
      .flatMap(({ part, label }) => order.filter((store) => isAvailable(next[store].parts[part])).map((store) => ({ store, part, label })))
      .filter((o) => o.store !== target.store || o.part !== target.part)
      .slice(0, 4)
      .map((o) => t.inStockAt(o.store, o.label));
    notify(t.hit(target, others));
    if (cfg.openOnHit) actions.push({ type: 'open', url: target.link });
    state.hit = { part: target.part, store: target.store, since: now, lastPushAt: now, reminders: 0 };
  } else if (same && state.hit.reminders < cfg.maxReminders && now - state.hit.lastPushAt >= cfg.reminderMinutes * MIN) {
    state.hit.reminders += 1;
    state.hit.lastPushAt = now;
    notify(t.reminder(target, state.hit.reminders, cfg.maxReminders));
  } else if (!target && state.hit) {
    notify(t.gone(state.hit.store, labelOf(cfg, state.hit.part), next[state.hit.store]?.parts[state.hit.part]?.quote));
    state.hit = null;
  }

  // Text changes that are not a hit appearing or disappearing, e.g. a new "Check back on ..." date.
  const other = changes.filter((c) => c.from && !isAvailable(c.from) && !isAvailable(c.to));
  if (other.length) notify(t.changed(other.map((c) => `${c.store} ${labelOf(cfg, c.part)}: ${c.to.quote || c.to.display}`)));

  return { state, actions, changes };
}
