#!/usr/bin/env node
// Replays saved pickup answers through the watcher's decision logic, one check apart, without talking to Apple.
//   node tools/dry-run.mjs fixtures/ --settings my-settings.json          print what it would notify
//   node tools/dry-run.mjs fixtures/ --settings my-settings.json --send   also send those through Bark, marked [test]
//   node tools/dry-run.mjs --test-notify --settings my-settings.json      send one test notification
// The settings file has the same shape the options page saves (see examples/settings.example.json).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { texts } from '../extension/lib/i18n.js';
import { decide, initialState, parsePickup } from '../extension/lib/logic.js';
import { pushRequests, sendPushes } from '../extension/lib/notify.js';
import { normalize } from '../extension/lib/settings.js';

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const settingsFile = option('--settings');
if (!settingsFile) {
  console.error('usage: node tools/dry-run.mjs <fixtures-dir> --settings <file.json> [--send] | --test-notify --settings <file.json>');
  process.exit(2);
}
const cfg = normalize(JSON.parse(await readFile(settingsFile, 'utf8')));

async function send(m) {
  const results = await sendPushes(pushRequests(cfg, m, true));
  if (!results.length) console.log('  (Bark is not turned on in the settings file)');
  for (const r of results) console.log(`  ${r.channel}: ${r.ok ? 'sent' : r.error}`);
}

if (args.includes('--test-notify')) {
  await send(texts(cfg.language).test());
  process.exit(0);
}

const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--settings');
const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
let state = initialState();
let now = Date.now();
for (const file of files) {
  const json = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
  const r = decide(state, { ok: true, stores: parsePickup(json, cfg) }, now, cfg);
  state = r.state;
  console.log(`${file}: ${r.changes.length} change(s)`);
  for (const a of r.actions) {
    if (a.type === 'open') console.log(`  open    ${a.url}`);
    else {
      console.log(`  notify  p${a.priority}  ${a.title} | ${a.message.replaceAll('\n', ' / ')}`);
      if (args.includes('--send')) await send(a);
    }
  }
  now += cfg.pollSeconds * 1000;
}
