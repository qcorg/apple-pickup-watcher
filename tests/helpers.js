import { normalize } from '../extension/lib/settings.js';
import { parsePickup } from '../extension/lib/logic.js';

export const MIN = 60_000;
export const T0 = new Date(2026, 9, 24, 12).getTime();
export const [P512, P256] = ['MK1H4LL/A', 'MK1F4LL/A'];
export const UNWATCHED = ['MK1E4LL/A', 'MK1G4LL/A'];
export const DISTANCES = { 'University Village': 4, 'Bellevue Square': 6.04, Southcenter: 11.06, Alderwood: 15.44, 'Tacoma Mall': 28.06, 'Pioneer Place': 145.55 };

export const CFG = normalize({
  location: '98101',
  products: [
    { part: P512, label: '512GB Night Sky', url: 'https://www.apple.com/shop/buy-iphone/iphone-duo/512gb-night-sky' },
    { part: P256, label: '256GB Night Sky' },
  ],
  stores: ['Bellevue Square', 'Southcenter', 'University Village', 'Alderwood', 'Tacoma Mall'],
});

// Apple's pickup answer. overrides: { [store]: { [part]: [pickupDisplay, pickupSearchQuote] } }; nested: the
// body.content.pickupMessage shape some answers use instead of body.stores.
export function response(overrides = {}, { nested = false } = {}) {
  const stores = Object.entries(DISTANCES).map(([storeName, storedistance]) => ({
    storeName,
    storedistance,
    partsAvailability: Object.fromEntries([P512, P256, ...UNWATCHED].map((part) => {
      const [pickupDisplay, pickupSearchQuote] = overrides[storeName]?.[part] ?? ['unavailable', 'Currently unavailable'];
      return [part, { partNumber: part, pickupDisplay, pickupSearchQuote }];
    })),
  }));
  return { head: { status: '200' }, body: nested ? { content: { pickupMessage: { stores } } } : { stores } };
}

export const ok = (overrides, cfg = CFG) => ({ ok: true, stores: parsePickup(response(overrides), cfg) });
export const notes = (actions) => actions.filter((a) => a.type === 'notify');
export const TODAY = ['available', 'Today'];
