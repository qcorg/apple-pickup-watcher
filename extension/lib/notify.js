// Builds the HTTP request that delivers a notification to Bark. Pure: the caller does the fetch,
// so the service worker and the Node tools send exactly the same thing. Chrome's own notifications are in background.js.
import { texts } from './i18n.js';
import { isHttpsUrl } from './settings.js';

const PUSH_TIMEOUT_MS = 10_000;

export const isQuietHour = ([from, to], hour) => (from > to ? hour >= from || hour < to : hour >= from && hour < to);

// Bark levels: critical rings `sound` through silent mode and Focus (only for a hit, only with `critical`, never in
// quiet hours, when the hit is an ordinary notification); passive arrives without lighting the screen.
export function barkRequest(cfg, m, test = false, date = new Date()) {
  const b = cfg.notify.bark;
  const ring = m.priority === 5 && b.critical && !isQuietHour(b.quietHours, date.getHours());
  return {
    url: `${b.server}/push`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        device_key: b.key,
        title: (test ? texts(cfg.language).testPrefix : '') + m.title,
        body: m.message,
        group: 'pickup-watcher',
        level: ring ? 'critical' : m.priority <= 2 ? 'passive' : 'active',
        ...(ring ? { sound: b.sound, volume: b.volume } : {}),
        ...(m.click ? { url: m.click } : {}),
      }),
    },
  };
}

// -> [{ channel, url, init }]: one Bark request when Bark is on with a key and an https server, else none.
export function pushRequests(cfg, m, test = false, date = new Date()) {
  const b = cfg.notify.bark;
  return b.enabled && b.key && isHttpsUrl(b.server) ? [{ channel: 'bark', ...barkRequest(cfg, m, test, date) }] : [];
}

// Sends the push requests and reports each one instead of throwing. -> [{ channel, ok, error? }]
export async function sendPushes(requests, fetchImpl = fetch) {
  return Promise.all(requests.map(async ({ channel, url, init }) => {
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
      return res.ok ? { channel, ok: true } : { channel, ok: false, error: `HTTP ${res.status}` };
    } catch (e) {
      return { channel, ok: false, error: String(e?.message ?? e) };
    }
  }));
}
