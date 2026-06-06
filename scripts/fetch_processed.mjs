#!/usr/bin/env node
// Fetch the music-log Google Sheets CSV, run the same processing pipeline as
// the in-browser "Download Data" button (fillForward + normalizePlayerNames +
// drop partial-movement rows), and write archive/data.csv. Source URL is read
// from .dev-data-url (single line, gitignored). For the raw sheet, use
// fetch_raw.sh.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { processRow, fillForward, normalizePlayerNames } from '../src/dataProcessor.js';

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
const processed = rawRows.map(processRow);
fillForward(processed);
normalizePlayerNames(processed);
const data = processed.filter(d => !d.work.incomplete);

// Match the UI download format from src/app.js#downloadCSV: "M/D/YYYY H:mm:ss"
// in local time, headers in the same order.
const headers = ['Timestamp', 'Composer', 'Work Title', 'Which Part', 'Player 1', 'Player 2', 'Player 3', 'Others', 'Location', 'Comments'];
const pad2 = n => String(n).padStart(2, '0');
const formatTimestamp = d =>
    `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${d.getHours()}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const escapeField = f => {
    if (f === null || f === undefined) return '';
    const s = String(f);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const lines = [headers.map(escapeField).join(',')];
for (const d of data) {
    lines.push([
        formatTimestamp(d.timestamp),
        d.composer,
        d.work.title,
        d.part,
        d.player1,
        d.player2,
        d.player3,
        d.others,
        d.location,
        d.comments,
    ].map(escapeField).join(','));
}

writeFileSync(OUT_FILE, lines.join('\n') + '\n');
console.error(`Wrote ${data.length} rows to ${OUT_FILE}`);
