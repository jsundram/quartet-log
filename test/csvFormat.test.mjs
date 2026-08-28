import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    CSV_HEADERS,
    escapeField,
    formatTimestamp,
    serializeRows,
} from '../src/csvFormat.js';
import { normalizePlayerNames, processRow } from '../src/dataProcessor.js';

// Minimal RFC-4180 parser (same shape as the one in scripts/fetch_processed.mjs,
// which can't be imported here because that script has top-level side effects).
// Returns an array of {header: value} objects, like d3.csv.
function parseCSV(text) {
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
    const headers = rows[0];
    return rows.slice(1)
        .filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''))
        .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

// A processed row (processRow output shape). Placeholder names only — never
// real names from PLAYER_ALIASES (they'd canonicalize and break assertions).
function processedRow(overrides = {}) {
    return {
        timestamp: new Date('2024-01-15T10:30:00'),
        composer: 'Haydn',
        work: { title: '76#2', incomplete: false, catalog: 76, number: 2 },
        part: 'V1',
        player1: 'Alice',
        player2: 'Bob',
        player3: 'Carol',
        others: '',
        location: 'Home',
        comments: '',
        ...overrides,
    };
}

describe('escapeField', () => {
    it('passes plain values through unquoted', () => {
        assert.equal(escapeField('Alice'), 'Alice');
        assert.equal(escapeField(42), '42');
    });

    it('quotes fields containing commas, quotes, or newlines', () => {
        assert.equal(escapeField('a,b'), '"a,b"');
        assert.equal(escapeField('say "hi"'), '"say ""hi"""');
        assert.equal(escapeField('two\nlines'), '"two\nlines"');
    });

    it('serializes null/undefined as the empty string', () => {
        assert.equal(escapeField(null), '');
        assert.equal(escapeField(undefined), '');
    });
});

describe('formatTimestamp', () => {
    it('formats "M/D/YYYY H:mm:ss" local time, unpadded month/day/hour', () => {
        assert.equal(formatTimestamp(new Date('2024-01-15T09:05:07')), '1/15/2024 9:05:07');
        assert.equal(formatTimestamp(new Date('2024-11-03T22:00:00')), '11/3/2024 22:00:00');
    });
});

describe('serializeRows', () => {
    it('emits the reader\'s "Others?" header, not the drifted "Others"', () => {
        const headerLine = serializeRows([]).split('\n')[0];
        assert.equal(headerLine.split(',')[7], 'Others?');
        assert.ok(CSV_HEADERS.includes('Others?'));
        assert.ok(!CSV_HEADERS.includes('Others'));
    });

    it('round-trips through processRow with identical field values', () => {
        const rows = [
            processedRow({
                // Paren-comma in Others?, quote + newline in comments —
                // exercises the quoting path end to end.
                others: 'Dave (v1, shadowing on II, III); Eve (vc)',
                comments: 'said "bravo",\nthen tea',
            }),
            processedRow({
                timestamp: new Date('2024-02-01T19:00:00'),
                work: { title: 'K465', incomplete: false, catalog: 465, number: null },
                composer: 'Mozart',
                part: 'VA',
                location: 'Church, downtown',
            }),
        ];

        const reingested = parseCSV(serializeRows(rows)).map(processRow);

        assert.equal(reingested.length, rows.length);
        rows.forEach((orig, i) => {
            const back = reingested[i];
            assert.equal(back.timestamp.getTime(), orig.timestamp.getTime());
            assert.equal(back.composer, orig.composer);
            assert.equal(back.work.title, orig.work.title);
            assert.equal(back.part, orig.part);
            assert.equal(back.player1, orig.player1);
            assert.equal(back.player2, orig.player2);
            assert.equal(back.player3, orig.player3);
            assert.equal(back.others, orig.others);
            assert.equal(back.location, orig.location);
            assert.equal(back.comments, orig.comments);
        });
    });

    it('carries a slot\'s "(instrument)" annotation through the round trip', () => {
        // normalizePlayerNames splits the annotation off the name; writing
        // only the name would make an annotated pianist indistinguishable
        // from a violinist on re-read (and invisible to audit_ensembles).
        const rows = normalizePlayerNames([processedRow({
            player1: 'Alice Hart (p)', player2: 'Bob', player3: 'Carol',
        })], {});

        const line = serializeRows(rows).split('\n')[1];
        assert.ok(line.includes('Alice Hart (p)'), line);

        const back = normalizePlayerNames(parseCSV(serializeRows(rows)).map(processRow), {});
        assert.equal(back[0].player1, 'Alice Hart');
        assert.deepEqual(back[0].playerInstruments, ['p', null, null]);
    });
});

describe('processRow Others-header tolerance', () => {
    const fields = {
        'Timestamp': '1/15/2024 10:30:00',
        'Composer': 'Haydn',
        'Work Title': '76#2',
        'Which Part': 'V1',
        'Player 1': 'Alice',
        'Player 2': 'Bob',
        'Player 3': 'Carol',
        'Location': 'Home',
        'Comments': '',
    };

    it('reads the canonical "Others?" header', () => {
        assert.equal(processRow({ ...fields, 'Others?': 'Dave (vc)' }).others, 'Dave (vc)');
    });

    it('reads the legacy "Others" header from pre-fix exports', () => {
        assert.equal(processRow({ ...fields, 'Others': 'Dave (vc)' }).others, 'Dave (vc)');
    });

    it('prefers "Others?" when both are present', () => {
        const d = { ...fields, 'Others?': 'canonical', 'Others': 'legacy' };
        assert.equal(processRow(d).others, 'canonical');
    });

    it('throws a clear error when neither spelling is present', () => {
        assert.throws(() => processRow({ ...fields }), /missing expected column.*Others\?/);
    });
});
