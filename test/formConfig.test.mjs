// Which form the log view writes through. The load-bearing property is that
// there is NO default: this site is deployed publicly and anyone can point it
// at their own sheet, so a baked-in form id would land every visitor's entries
// in one person's spreadsheet while their own log stayed empty.
//
// localStorage is stubbed with a Map-backed object on globalThis, per the
// dataService tests: the module reads it at call time, never at import time.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    parsePrefilledLink, buildPrefilledLink, getFormConfig, setFormConfig,
    clearFormConfig, toFormBody, formAction, CHOICES,
} from '../src/formConfig.js';
import { FIELDS, LABELS, blankEntry } from '../src/logEntry.js';
import { CSV_HEADERS } from '../src/csvFormat.js';

beforeEach(() => {
    const map = new Map();
    globalThis.localStorage = {
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: k => map.delete(k),
    };
});

const FORM_ID = '1FAIpQLSfEXAMPLEfixtureformidforthetestsuite0000000000';
const IDS = ['617761884', '1089341946', '906530431', '2047796227', '180148173',
    '1831808369', '1922346688', '1954495027', '526774847'];
const LINK = `https://docs.google.com/forms/d/e/${FORM_ID}/viewform?usp=pp_url&`
    + IDS.map((id, i) => `entry.${id}=v${i}`).join('&');

test('the field order is the sheet column order, which is what makes the mapping positional', () => {
    // parsePrefilledLink zips entry ids to FIELDS by position, and that is
    // correct by construction only because Forms builds the response sheet's
    // columns from its questions in order. If these two ever drift, every
    // configured form silently writes every column into the wrong cell.
    assert.deepEqual(FIELDS.map(f => LABELS[f]), CSV_HEADERS.slice(1));
});

test('parsePrefilledLink pulls the form id and one entry id per column, in order', () => {
    const config = parsePrefilledLink(LINK);
    assert.equal(config.formId, FORM_ID);
    assert.deepEqual(FIELDS.map(f => config.entry[f]), IDS.map(id => `entry.${id}`));
});

test('parsePrefilledLink tolerates surrounding whitespace from a paste', () => {
    assert.equal(parsePrefilledLink(`  ${LINK}\n`)?.formId, FORM_ID);
});

test('parsePrefilledLink rejects anything that is not one entry per column', () => {
    // Wrong count means the mapping would be shifted, so nothing is better
    // than a guess: every row would land one column over.
    const short = `https://docs.google.com/forms/d/e/${FORM_ID}/viewform?entry.1=a&entry.2=b`;
    assert.equal(parsePrefilledLink(short), null);
    assert.equal(parsePrefilledLink(`${LINK}&entry.999=extra`), null);
    // Not a form link at all.
    assert.equal(parsePrefilledLink('https://docs.google.com/spreadsheets/d/e/x/pub?output=csv'), null);
    assert.equal(parsePrefilledLink('https://evil.example/forms/d/e/x/viewform?entry.1=a'), null);
    assert.equal(parsePrefilledLink('not a url'), null);
    assert.equal(parsePrefilledLink(''), null);
});

test('a repeated entry id does not shift the mapping', () => {
    const dupe = `https://docs.google.com/forms/d/e/${FORM_ID}/viewform?entry.${IDS[0]}=x&`
        + IDS.map((id, i) => `entry.${id}=v${i}`).join('&');
    assert.deepEqual(FIELDS.map(f => parsePrefilledLink(dupe).entry[f]),
        IDS.map(id => `entry.${id}`));
});

test('buildPrefilledLink round-trips a config, for the ?form= setup link', () => {
    const config = parsePrefilledLink(LINK);
    assert.deepEqual(parsePrefilledLink(buildPrefilledLink(config)), config);
});

test('there is no configured form until someone configures one', () => {
    // The whole point: an unconfigured visitor gets the setup panel, never a
    // form that would post their rows into a stranger's spreadsheet.
    assert.equal(getFormConfig(), null);
    setFormConfig(parsePrefilledLink(LINK));
    assert.equal(getFormConfig().formId, FORM_ID);
    clearFormConfig();
    assert.equal(getFormConfig(), null);
});

test('a half-written or corrupt config reads as unconfigured', () => {
    // A config missing a column would submit rows with that cell silently
    // empty, and the opaque response would never say so.
    localStorage.setItem('quartetlog_form', 'not json');
    assert.equal(getFormConfig(), null);
    localStorage.setItem('quartetlog_form', JSON.stringify({ formId: FORM_ID, entry: { composer: 'entry.1' } }));
    assert.equal(getFormConfig(), null);
    localStorage.setItem('quartetlog_form', JSON.stringify({ entry: {} }));
    assert.equal(getFormConfig(), null);
});

test('formAction addresses the submit endpoint of the configured form', () => {
    assert.equal(formAction(FORM_ID),
        `https://docs.google.com/forms/d/e/${FORM_ID}/formResponse`);
});

test('toFormBody maps each field to its configured id and drops empties', () => {
    const config = parsePrefilledLink(LINK);
    const body = toFormBody(blankEntry({
        composer: 'Haydn', title: '76#3', part: 'V1', player1: 'Alice Hart',
    }), config);
    assert.equal(body.get(config.entry.composer), 'Haydn');
    assert.equal(body.get(config.entry.title), '76#3');
    assert.equal(body.get(config.entry.player1), 'Alice Hart');
    // A blank seat is a ditto mark; omitting it lands the same empty cell.
    assert.equal(body.has(config.entry.player2), false);
});

test('toFormBody routes a value outside a radio option list through Other', () => {
    const config = parsePrefilledLink(LINK);
    assert.ok(!CHOICES.composer.includes('Brahms'));
    const body = toFormBody(blankEntry({ composer: 'Brahms', title: '51#1', part: 'V1' }), config);
    // Without this the form silently rejects every composer past the original
    // seven, which is most of the catalog.
    assert.equal(body.get(config.entry.composer), '__other_option__');
    assert.equal(body.get(`${config.entry.composer}.other_option_response`), 'Brahms');
    // A listed value stays a plain option.
    assert.equal(body.get(config.entry.part), 'V1');
    assert.equal(body.has(`${config.entry.part}.other_option_response`), false);
});

test('toFormBody trims, so a stray space cannot mint a phantom name', () => {
    const config = parsePrefilledLink(LINK);
    const body = toFormBody(
        blankEntry({ composer: 'Haydn', title: ' 76#3 ', part: 'V1', player1: '   ' }), config);
    assert.equal(body.get(config.entry.title), '76#3');
    assert.equal(body.has(config.entry.player1), false);
});

test('toFormBody without a config throws instead of posting into the void', () => {
    // The config is an argument, never module state — the same reasoning as
    // the alias tables in dataProcessor: forgetting it must fail loudly.
    assert.throws(() => toFormBody(blankEntry({ composer: 'Haydn' }), null), TypeError);
});
