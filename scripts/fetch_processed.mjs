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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const URL_FILE = resolve(REPO_ROOT, '.dev-data-url');
const OUT_FILE = resolve(REPO_ROOT, 'archive', 'data.csv');

if (!existsSync(URL_FILE)) {
    console.error(`Missing ${URL_FILE} - create it with a single line containing the published Google Sheets CSV URL.`);
    process.exit(1);
}
const dataUrl = readFileSync(URL_FILE, 'utf8').trim();

// Tiny RFC-4180-ish CSV parser. Handles quoted fields with embedded
// commas/quotes/newlines and CRLF line endings.
function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += c;
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field); field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            rows.push(row); row = [];
        } else {
            field += c;
        }
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const headers = rows[0];
    return rows.slice(1)
        .filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''))
        .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

console.error(`Fetching ${dataUrl}`);
const response = await fetch(dataUrl);
if (!response.ok) {
    console.error(`HTTP ${response.status}: ${response.statusText}`);
    process.exit(1);
}
const rawRows = parseCSV(await response.text());
// Same pipeline as DataService.processData: sort + drop invalid timestamps,
// fillForward, normalize names, drop partial-movement rows.
const { rows: processed, dropped } = prepareRows(rawRows.map(processRow));
if (dropped) console.error(`Warning: dropped ${dropped} row(s) with unparseable timestamps`);
fillForward(processed);
normalizePlayerNames(processed);
const data = processed.filter(d => !d.work.incomplete);

// Headers, field order, timestamp format, and escaping come from the shared
// csvFormat module — the same code path as the in-app "Download Data" button
// (src/app.js downloadCSV), so the two writers can't drift apart.
writeFileSync(OUT_FILE, serializeRows(data) + '\n');
console.error(`Wrote ${data.length} rows to ${OUT_FILE}`);
