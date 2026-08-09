// Canonical CSV export format, shared by the in-app "Download Data" button
// (src/app.js downloadCSV) and scripts/fetch_processed.mjs so the two writers
// cannot drift apart again. That drift already happened once: both writers
// emitted an `Others` header while the readers (processRow,
// scripts/audit_aliases.py) expected the sheet's `Others?`, so the whole
// column was silently dropped on re-ingestion. The readers still accept both
// spellings so pre-fix exports load; everything written from here on uses
// these headers verbatim. Pure module — no DOM, no d3 — so it stays
// unit-testable under node:test.

export const CSV_HEADERS = [
    'Timestamp', 'Composer', 'Work Title', 'Which Part',
    'Player 1', 'Player 2', 'Player 3', 'Others?', 'Location', 'Comments',
];

// RFC-4180 field quoting: wrap in double quotes when the value contains a
// comma, quote, or newline; embedded quotes double. null/undefined → ''.
export function escapeField(field) {
    if (field === null || field === undefined) return '';
    const s = String(field);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// "M/D/YYYY H:mm:ss" in local time — the same shape the Google Form writes
// into the sheet's Timestamp column, so exported rows round-trip through
// processRow's `new Date(...)` unchanged.
const pad2 = n => String(n).padStart(2, '0');
export function formatTimestamp(d) {
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ` +
        `${d.getHours()}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// One processed row (the processRow output shape) → raw field values in
// CSV_HEADERS order.
export function rowToFields(d) {
    return [
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
    ];
}

// Serialize processed rows to full CSV text: header line + one line per row,
// '\n'-separated, no trailing newline.
export function serializeRows(data) {
    return [CSV_HEADERS, ...data.map(rowToFields)]
        .map(fields => fields.map(escapeField).join(','))
        .join('\n');
}
