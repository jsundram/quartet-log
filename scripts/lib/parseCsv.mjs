// @ts-check
// Tiny RFC-4180-ish CSV parser, shared by every reader of a sheet export:
// scripts/fetch_processed.mjs and the audits (via lib/views.mjs). Handles
// quoted fields with embedded commas/quotes/newlines and CRLF line endings.
//
// A short line pads its missing trailing fields with '' rather than leaving
// them undefined. processRow's `=== undefined` guard would let an undefined
// through and the first .trim() would throw — one malformed line costing the
// whole file its filled view, and a third of the raw sheet is continuation
// rows that then look answerless.

/**
 * @param {string} text
 * @returns {Record<string, string>[]} one object per data line, header → cell
 */
export function parseCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    /** @type {string[][]} */
    const rows = [];
    /** @type {string[]} */
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
        // A line with no content in ANY field is not a row. Checking the
        // field COUNT instead kept ",,,,,,,,," — the shape Sheets emits for a
        // trailing formatted-but-empty row — which processRow accepts and
        // prepareRows then drops for an unparseable timestamp, putting the
        // "!! N row(s) have a timestamp that will not parse" banner on every
        // audit and sending the reader to fix a Timestamp cell on a row that
        // says nothing.
        .filter(r => r.some(f => f !== ''))
        .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}
