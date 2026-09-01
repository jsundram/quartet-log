// @ts-check
// Canonical CSV export format, shared by the in-app "Download Data" button
// (src/app.js downloadCSV) and scripts/fetch_processed.mjs so the two writers
// cannot drift apart again. That drift already happened once: both writers
// emitted an `Others` header while the readers (processRow, the audit
// scripts) expected the sheet's `Others?`, so the whole column was silently
// dropped on re-ingestion. The readers still accept both spellings so pre-fix
// exports load; everything written from here on uses these headers verbatim.
// Pure module — no DOM, no d3 — so it stays unit-testable under node:test.

export const CSV_HEADERS = [
    'Timestamp', 'Composer', 'Work Title', 'Which Part',
    'Player 1', 'Player 2', 'Player 3', 'Others?', 'Location', 'Comments',
];

// RFC-4180 field quoting: wrap in double quotes when the value contains a
// comma, quote, or newline; embedded quotes double. null/undefined → ''.
/**
 * @param {unknown} field
 * @returns {string}
 */
export function escapeField(field) {
    if (field === null || field === undefined) return '';
    const s = String(field);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// "M/D/YYYY H:mm:ss" in local time — the same shape the Google Form writes
// into the sheet's Timestamp column, so exported rows round-trip through
// processRow's `new Date(...)` unchanged.
/** @param {number} n */
const pad2 = n => String(n).padStart(2, '0');
/**
 * @param {Date} d
 * @returns {string}
 */
export function formatTimestamp(d) {
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ` +
        `${d.getHours()}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Re-attach a slot's "(instrument)" annotation to the canonical name.
// normalizePlayerNames splits them apart (stripParens on the name,
// instrumentFromSlot into playerInstruments); writing only the name would
// make the export lossy in exactly the way that matters — an annotated
// pianist is indistinguishable from a violinist in the re-read file, so
// scripts/audit_ensembles.mjs could never see one. Re-reading this restores
// the same annotation, since instrumentFromSlot parses what we write here.
/**
 * @param {string|null} name
 * @param {string|null|undefined} instrument
 * @returns {string|null}
 */
function withInstrument(name, instrument) {
    return name && instrument ? `${name} (${instrument})` : name;
}

// One processed row (the processRow output shape) → raw field values in
// CSV_HEADERS order.
/**
 * @param {import('./dataProcessor.js').Row} d
 * @returns {(string|null)[]}
 */
export function rowToFields(d) {
    const annotations = d.playerInstruments ?? [];
    return [
        // Exported rows always come from the sheet, so timestamp is a real
        // Date (nulls exist only on createEmptyRow placeholders, which are
        // never serialized).
        formatTimestamp(/** @type {Date} */ (d.timestamp)),
        d.composer,
        d.work.title,
        d.part,
        withInstrument(d.player1, annotations[0]),
        withInstrument(d.player2, annotations[1]),
        withInstrument(d.player3, annotations[2]),
        d.others,
        d.location,
        d.comments,
    ];
}

// Serialize processed rows to full CSV text: header line + one line per row,
// '\n'-separated, no trailing newline.
/**
 * @param {import('./dataProcessor.js').Row[]} data
 * @returns {string}
 */
export function serializeRows(data) {
    return [CSV_HEADERS, ...data.map(rowToFields)]
        .map(fields => fields.map(escapeField).join(','))
        .join('\n');
}
