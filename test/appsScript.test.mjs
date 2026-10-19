// apps-script/Code.gs runs on Google's servers, so it runs here inside a vm
// against a fake sheet, lock and property store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CSV_HEADERS } from '../src/csvFormat.js';

const SOURCE = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

function load({ headers = CSV_HEADERS } = {}) {
    const rows = [headers];
    const props = new Map();
    const locks = { held: 0 };
    const sheet = {
        getFormUrl: () => 'https://docs.google.com/forms/d/x/edit',
        getLastColumn: () => rows[0].length,
        getLastRow: () => rows.length,
        getRange: (r, c, h, w) => ({
            getValues: () => rows.slice(r - 1, r - 1 + h).map(x => x.slice(c - 1, c - 1 + w)),
            copyTo: () => {},
        }),
        appendRow: row => rows.push(row),
    };
    const ctx = vm.createContext({
        SpreadsheetApp: {
            getActiveSpreadsheet: () => ({ getSheets: () => [{ getFormUrl: () => null }, sheet] }),
            flush: () => {},
            CopyPasteType: { PASTE_FORMAT: 'format' },
        },
        LockService: { getScriptLock: () => ({ waitLock: () => locks.held++, releaseLock: () => locks.held-- }) },
        PropertiesService: { getScriptProperties: () => ({
            getProperty: k => props.get(k) ?? null,
            setProperty: (k, v) => props.set(k, v),
            getProperties: () => Object.fromEntries(props),
            deleteProperty: k => props.delete(k),
        }) },
        ContentService: {
            createTextOutput: s => ({ setMimeType: () => JSON.parse(s) }),
            MimeType: { JSON: 'json' },
        },
    });
    vm.runInContext(SOURCE, ctx);
    const post = body => ctx.doPost({ postData: { contents: JSON.stringify(body) } });
    return { ctx, rows, props, locks, post };
}

const ROW = { Composer: 'Haydn', 'Work Title': '76#1', 'Which Part': 'V1', 'Player 1': 'Alice' };

test('a piece is written once, however many times it arrives', () => {
    const { rows, post, locks } = load();
    assert.deepEqual(post({ id: 'a', row: ROW }), { ok: true, duplicate: false });
    assert.deepEqual(post({ id: 'a', row: ROW }), { ok: true, duplicate: true });
    assert.equal(rows.length, 2);
    assert.equal(locks.held, 0);
});

test('cells go by header, into the tab the form writes to, stamped on arrival', () => {
    const headers = [...CSV_HEADERS];
    [headers[1], headers[2]] = [headers[2], headers[1]];
    const { rows, post } = load({ headers });
    post({ id: 'a', row: ROW });
    const written = rows[1];
    assert.equal(Object.prototype.toString.call(written[0]), '[object Date]');
    assert.equal(written[1], '76#1');
    assert.equal(written[2], 'Haydn');
    assert.equal(written[headers.indexOf('Comments')], '');
});

test('a row naming a column the sheet lacks is refused, and its id stays free', () => {
    const { rows, props, post } = load();
    const r = post({ id: 'a', row: { ...ROW, Instrument: 'viola' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /Instrument/);
    assert.equal(rows.length, 1);
    assert.equal(props.has('a'), false);
});

test('a malformed request is refused', () => {
    const { ctx, post } = load();
    assert.equal(post({ row: ROW }).ok, false);
    assert.equal(ctx.doPost({ postData: { contents: '{' } }).ok, false);
});

test('ids older than the retention window are forgotten', () => {
    const { props, post } = load();
    props.set('old', String(Date.now() - 91 * 86400000));
    post({ id: 'a', row: ROW });
    assert.equal(props.has('old'), false);
    assert.equal(props.has('a'), true);
});

test('a GET identifies the script', () => {
    assert.deepEqual(load().ctx.doGet(), { ok: true, app: 'quartet-log' });
});
