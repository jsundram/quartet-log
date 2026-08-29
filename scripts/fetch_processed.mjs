#!/usr/bin/env node
// Fetch the music-log Google Sheets CSV, run the same processing pipeline as
// the in-browser "Download Data" button (fillForward + normalizePlayerNames +
// drop partial-movement rows), and write archive/data.csv. Source URL is read
// from .dev-data-url (single line, gitignored). For the raw sheet, use
// fetch_raw.sh.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { processRow, prepareRows, fillForward, normalizePlayerNames } from '../src/dataProcessor.js';
import { serializeRows } from '../src/csvFormat.js';
import { parseCsv } from './lib/parseCsv.mjs';
// dataProcessor takes the name tables as arguments; this script is a writer of
// the processed export, so it wires the same ones the app does.
import { PLAYER_ALIASES, PLAYER_ABBREVIATIONS } from '../src/config.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const URL_FILE = resolve(REPO_ROOT, '.dev-data-url');
const OUT_FILE = resolve(REPO_ROOT, 'archive', 'data.csv');

if (!existsSync(URL_FILE)) {
    console.error(`Missing ${URL_FILE} - create it with a single line containing the published Google Sheets CSV URL.`);
    process.exit(1);
}
const dataUrl = readFileSync(URL_FILE, 'utf8').trim();

console.error(`Fetching ${dataUrl}`);
const response = await fetch(dataUrl);
if (!response.ok) {
    console.error(`HTTP ${response.status}: ${response.statusText}`);
    process.exit(1);
}
const rawRows = parseCsv(await response.text());
// Same pipeline as DataService.processData: sort + drop invalid timestamps,
// fillForward, normalize names, drop partial-movement rows.
const { rows: processed, dropped } = prepareRows(rawRows.map(processRow));
if (dropped) console.error(`Warning: dropped ${dropped} row(s) with unparseable timestamps`);
fillForward(processed, PLAYER_ABBREVIATIONS);
normalizePlayerNames(processed, PLAYER_ALIASES);
const data = processed.filter(d => !d.work.incomplete);

// Headers, field order, timestamp format, and escaping come from the shared
// csvFormat module — the same code path as the in-app "Download Data" button
// (src/app.js downloadCSV), so the two writers can't drift apart.
writeFileSync(OUT_FILE, serializeRows(data) + '\n');
console.error(`Wrote ${data.length} rows to ${OUT_FILE}`);
