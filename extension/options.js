import { extraOrigins, isHttpsUrl, normalize } from './lib/settings.js';

const form = document.querySelector('#form');
const f = form.elements;
const $ = (sel) => document.querySelector(sel);
const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

for (const h of [-1, ...Array.from({ length: 24 }, (_, i) => i)]) {
  f.heartbeatHour.append(new Option(h < 0 ? 'Off' : `${String(h).padStart(2, '0')}:00`, String(h)));
}

function fill(cfg) {
  f.location.value = cfg.location;
  f.country.value = cfg.country;
  f.maxDistance.value = cfg.maxDistance;
  f.products.value = cfg.products.map((p) => [p.part, p.label === p.part ? '' : p.label, p.url].join(' | ').replace(/( \| )+$/, '')).join('\n');
  f.stores.value = cfg.stores.join('\n');
  f.pollSeconds.value = cfg.pollSeconds;
  f.heartbeatHour.value = String(cfg.heartbeatHour);
  f.openOnHit.checked = cfg.openOnHit;
  f.language.value = cfg.language;
  f.chrome.checked = cfg.notify.chrome;
  f.barkEnabled.checked = cfg.notify.bark.enabled;
  f.barkKey.value = cfg.notify.bark.key;
  f.barkServer.value = cfg.notify.bark.server;
  f.barkCritical.checked = cfg.notify.bark.critical;
  [f.quietFrom.value, f.quietTo.value] = cfg.notify.bark.quietHours;
}

// Keeps settings the form does not show (pace details, reminders) as they were.
function read(saved) {
  return normalize({
    ...saved,
    location: f.location.value,
    country: f.country.value,
    maxDistance: f.maxDistance.value,
    products: lines(f.products.value).map((l) => {
      const [part, label, url] = l.split('|').map((s) => s.trim());
      return { part, label, url };
    }),
    stores: lines(f.stores.value),
    pollSeconds: f.pollSeconds.value,
    heartbeatHour: f.heartbeatHour.value,
    openOnHit: f.openOnHit.checked,
    language: f.language.value,
    notify: {
      chrome: f.chrome.checked,
      bark: {
        ...saved.notify?.bark,
        enabled: f.barkEnabled.checked, key: f.barkKey.value, server: f.barkServer.value,
        critical: f.barkCritical.checked, quietHours: [f.quietFrom.value, f.quietTo.value],
      },
    },
  });
}

let saved = {};

// permissions.request needs the click itself, so it runs before anything else is awaited.
async function save() {
  const cfg = read(saved);
  if (cfg.notify.bark.enabled && !isHttpsUrl(cfg.notify.bark.server)) throw new Error('the Bark server has to be an https:// address.');
  const origins = extraOrigins(cfg);
  if (origins.length && !(await chrome.permissions.request({ origins }))) {
    throw new Error(`Chrome needs permission to reach ${origins.join(', ')} to send notifications there.`);
  }
  await chrome.storage.local.set({ settings: cfg });
  saved = cfg;
  fill(cfg);
  return cfg;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await save();
    $('#result').textContent = 'Saved. See Status for the next check.';
  } catch (err) {
    $('#result').textContent = `Not saved: ${err.message}`;
  }
});

$('#test').addEventListener('click', async () => {
  try {
    await save();
    $('#result').textContent = 'Saved. Sending…';
    const r = await chrome.runtime.sendMessage({ cmd: 'testNotify' });
    $('#result').textContent = r?.ok ? `Test sent to: ${r.note}.` : `Test failed: ${r?.error ?? 'no response'}`;
  } catch (err) {
    $('#result').textContent = `Not saved: ${err.message}`;
  }
});

// Store names from the last answer, to click into the list.
function showKnownStores(state) {
  const names = Object.entries(state?.stores ?? {}).sort(([, a], [, b]) => a.distance - b.distance);
  const known = $('#known');
  known.replaceChildren();
  if (!names.length) return;
  known.append('Stores in Apple’s last answer (click to add): ');
  for (const [name, s] of names) {
    const chip = Object.assign(document.createElement('span'), { className: 'chip', textContent: `${name} · ${s.distance}` });
    chip.addEventListener('click', () => {
      if (!lines(f.stores.value).includes(name)) f.stores.value = [...lines(f.stores.value), name].join('\n');
    });
    known.append(chip);
  }
}

const got = await chrome.storage.local.get(['settings', 'state']);
saved = normalize(got.settings);
fill(saved);
showKnownStores(got.state);
