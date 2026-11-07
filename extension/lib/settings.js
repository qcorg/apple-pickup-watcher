// Settings: the defaults, and normalize(), which fills in anything missing and clamps unsafe values.
// The options page saves settings to chrome.storage.local; everything else reads them through normalize().
// Nothing in this file touches chrome.* or the network, so Node tools and tests share it.

// Apple answered HTTP 541 (its throttle) within an hour when checked every 30 s; every 60–75 s ran for days.
export const MIN_POLL_SECONDS = 60;
// Even "Check now" and a settings change wait this long after the previous request.
export const MIN_GAP_SECONDS = 30;
export const MAX_PRODUCTS = 10;

export const DEFAULTS = {
  // The part of your country's Apple Store URL after apple.com/, e.g. 'uk' or 'ca'. Empty for the US.
  country: '',
  // ZIP or postcode, as you would type it in Apple's "pickup near" search.
  location: '',
  // In order of preference: { part: 'MK1H4LL/A', label: 'iPhone 512GB Night Sky', url: 'https://www.apple.com/shop/...' }.
  products: [],
  // Store names in order of preference, as Apple spells them. Empty: every store Apple returns for the location, nearest first.
  stores: [],
  // Ignore stores farther than this, in the unit Apple uses for your country (miles in the US). 0: no limit.
  maxDistance: 0,
  pollSeconds: 75,
  jitterSeconds: 15,
  // Pause after Apple pushes back (HTTP 541/403/429), longer each time it happens again before a check succeeds.
  backoffMinutes: [10, 30, 60],
  reminderMinutes: 5,
  maxReminders: 3,
  failureAlertAfter: 5,
  // Local hour for a daily summary notification, or -1 for none.
  heartbeatHour: -1,
  // Also open the product page in Chrome when something comes into stock.
  openOnHit: false,
  language: 'en',
  notify: {
    chrome: true,
    // Bark (iOS): key is the part after api.day.app/ in the app's push URL. critical rings `sound` through silent
    // mode and Focus, except in quietHours [from, to] (local hours); otherwise a hit is an ordinary notification.
    bark: { enabled: false, server: 'https://api.day.app', key: '', critical: false, sound: 'alarm', volume: 10, quietHours: [23, 8] },
  },
};

const num = (v, fallback, min = -Infinity, max = Infinity) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const httpsUrl = (v, fallback) => {
  try {
    const u = new URL(str(v));
    return u.protocol === 'https:' ? u.href.replace(/\/+$/, '') : fallback;
  } catch {
    return fallback;
  }
};
const appleUrl = (v) => {
  try {
    const u = new URL(str(v));
    return u.protocol === 'https:' && /(^|\.)apple\.com$/.test(u.hostname) ? u.href : '';
  } catch {
    return '';
  }
};

export function normalize(raw = {}) {
  const d = DEFAULTS;
  const r = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const products = (Array.isArray(r.products) ? r.products : [])
    .map((p) => ({ part: str(p?.part).toUpperCase(), label: str(p?.label), url: appleUrl(p?.url) }))
    .filter((p) => p.part && !seen.has(p.part) && seen.add(p.part))
    .slice(0, MAX_PRODUCTS)
    .map((p) => ({ ...p, label: p.label || p.part }));
  const backoff = (Array.isArray(r.backoffMinutes) ? r.backoffMinutes : []).map((m) => num(m, 0, 0, 24 * 60)).filter((m) => m >= 1);
  const n = r.notify ?? {};
  const bark = { ...d.notify.bark, ...n.bark };
  const quiet = Array.isArray(bark.quietHours) && bark.quietHours.length === 2 ? bark.quietHours.map((h) => num(h, 0, 0, 23)) : d.notify.bark.quietHours;
  return {
    country: str(r.country).toLowerCase().replace(/[^a-z0-9/-]/g, '').replace(/^\/+|\/+$/g, ''),
    location: str(r.location),
    products,
    stores: [...new Set((Array.isArray(r.stores) ? r.stores : []).map(str).filter(Boolean))],
    maxDistance: num(r.maxDistance, d.maxDistance, 0),
    pollSeconds: Math.round(num(r.pollSeconds, d.pollSeconds, MIN_POLL_SECONDS, 3600)),
    jitterSeconds: Math.round(num(r.jitterSeconds, d.jitterSeconds, 0, 60)),
    backoffMinutes: backoff.length ? backoff : d.backoffMinutes,
    reminderMinutes: num(r.reminderMinutes, d.reminderMinutes, 1, 60),
    maxReminders: Math.round(num(r.maxReminders, d.maxReminders, 0, 10)),
    failureAlertAfter: Math.round(num(r.failureAlertAfter, d.failureAlertAfter, 1, 100)),
    heartbeatHour: Math.round(num(r.heartbeatHour, d.heartbeatHour, -1, 23)),
    openOnHit: bool(r.openOnHit, d.openOnHit),
    language: ['en', 'zh'].includes(r.language) ? r.language : d.language,
    notify: {
      chrome: bool(n.chrome, d.notify.chrome),
      bark: {
        enabled: bool(bark.enabled, false),
        server: httpsUrl(bark.server, d.notify.bark.server),
        key: str(bark.key),
        critical: bool(bark.critical, false),
        sound: str(bark.sound) || d.notify.bark.sound,
        volume: num(bark.volume, d.notify.bark.volume, 0, 10),
        quietHours: quiet,
      },
    },
  };
}

// What still has to be filled in before checks can start, as message keys (see i18n.js).
export function missing(cfg) {
  const out = [];
  if (!cfg.location) out.push('needLocation');
  if (!cfg.products.length) out.push('needProducts');
  return out;
}

export const appleBase = (cfg) => `https://www.apple.com${cfg.country ? `/${cfg.country}` : ''}`;

// The pinned tab every request runs in. Any apple.com page works; this one exists in every country's store.
export const hostUrl = (cfg) => `${appleBase(cfg)}/shop/buy-iphone`;

// Where a notification for a product leads: its own page if you gave one, else the store's front page.
export const productLink = (cfg, product) => product?.url || `${appleBase(cfg)}/shop`;

// A self-hosted Bark server is outside the manifest's host_permissions, so it needs an optional permission, granted on the options page.
export const BUILT_IN_ORIGINS = ['https://api.day.app'];
export function extraOrigins(cfg) {
  if (!cfg.notify.bark.enabled) return [];
  const origin = new URL(cfg.notify.bark.server).origin;
  return BUILT_IN_ORIGINS.includes(origin) ? [] : [`${origin}/*`];
}
