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
    parsePrefilledLink, readPrefilledLink, buildPrefilledLink, getFormConfig, setFormConfig,
    clearFormConfig, toFormBody, formAction, consumeFormParam,
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
// Obviously-fake: nothing in the repo carries a real form's ids, since the
// config is per-user and there is no default.
const IDS = ['201', '202', '203', '204', '205', '206', '207', '208', '209'];
const LINK = `https://docs.google.com/forms/d/e/${FORM_ID}/viewform?usp=pp_url&`
    + IDS.map((id, i) => `entry.${id}=v${i}`).join('&');
const OTHER_ID = 'SOMEONE-ELSES-FORM';
const OTHER_LINK = `https://docs.google.com/forms/d/e/${OTHER_ID}/viewform?usp=pp_url&`
    + IDS.map((id, i) => `entry.${900 + i}=v${i}`).join('&');

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
    // A suffix test without the dot boundary accepts this one.
    assert.equal(parsePrefilledLink(`https://evilgoogle.com/forms/d/e/${FORM_ID}/viewform?`
        + IDS.map((id, i) => `entry.${id}=v${i}`).join('&')), null);
    assert.equal(parsePrefilledLink('not a url'), null);
    assert.equal(parsePrefilledLink(''), null);
});

test('a repeated entry id does not shift the mapping', () => {
    const dupe = `https://docs.google.com/forms/d/e/${FORM_ID}/viewform?entry.${IDS[0]}=x&`
        + IDS.map((id, i) => `entry.${id}=v${i}`).join('&');
    assert.deepEqual(FIELDS.map(f => parsePrefilledLink(dupe).entry[f]),
        IDS.map(id => `entry.${id}`));
});

test('readPrefilledLink says WHICH way a link is wrong, since the fixes differ', () => {
    // A wrong link is a copy-paste slip and re-pasting fixes it. The wrong
    // NUMBER of fields means the form does not match the ten columns this app
    // requires (processRow demands them), and no amount of re-pasting helps —
    // so the panel must not tell both users the same thing.
    assert.deepEqual(readPrefilledLink(''), { config: null, reason: 'empty' });
    assert.deepEqual(readPrefilledLink('   '), { config: null, reason: 'empty' });
    assert.deepEqual(readPrefilledLink('not a url'), { config: null, reason: 'not-a-form-link' });
    assert.deepEqual(readPrefilledLink('https://evil.example/forms/d/e/x/viewform?entry.1=a'),
        { config: null, reason: 'not-a-form-link' });
    // The sheet's own URL is the likeliest wrong paste, and it is not a form.
    assert.deepEqual(readPrefilledLink('https://docs.google.com/spreadsheets/d/e/x/pub?output=csv'),
        { config: null, reason: 'not-a-form-link' });
    assert.deepEqual(
        readPrefilledLink(`https://docs.google.com/forms/d/e/${FORM_ID}/viewform?entry.1=a&entry.2=b`),
        { config: null, reason: 'field-count', found: 2 });
    assert.equal(readPrefilledLink(LINK).config.formId, FORM_ID);
});

test('parsePrefilledLink is a view of readPrefilledLink, not a second parser', () => {
    // A second copy of the parse is exactly the drift the audits keep finding.
    for (const link of ['', 'nope', LINK, `${LINK}&entry.999=x`]) {
        assert.deepEqual(parsePrefilledLink(link), readPrefilledLink(link).config);
    }
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
    assert.equal(body.get(`${config.entry.composer}.other_option_response`), 'Haydn');
    assert.equal(body.get(config.entry.title), '76#3');
    assert.equal(body.get(config.entry.player1), 'Alice Hart');
    // A blank seat is a ditto mark; omitting it lands the same empty cell.
    assert.equal(body.has(config.entry.player2), false);
});

test('composer always rides the Other escape, listed or not', () => {
    // Always, not just for unlisted values: there is no list to be outside of,
    // since another user's options cannot be read cross-origin. Forms stores an
    // Other response as plain text in the column, so a value that IS an option
    // lands in the same cell either way -- while a hardcoded list of the
    // reference form's seven composers would write those seven correctly on a
    // SHORT ANSWER form and corrupt the other thirteen, silently, starting on
    // whichever piece first used one.
    const config = parsePrefilledLink(LINK);
    for (const composer of ['Brahms', 'Haydn']) {
        const body = toFormBody(blankEntry({ composer, title: '51#1', part: 'V1' }), config);
        assert.equal(body.get(config.entry.composer), '__other_option__');
        assert.equal(body.get(`${config.entry.composer}.other_option_response`), composer);
    }
});

test('everything else is sent plainly, Which Part included', () => {
    // The escape REQUIRES "Other" to be enabled, and a multiple-choice question
    // without it rejects the whole response -- silently, since the reply is
    // opaque. Which Part is a fixed four the form must already offer, so a
    // plain value works whether the question is multiple-choice or short
    // answer and whether or not Other is on; routing it through the escape
    // would have made every submission depend on Other being switched on for
    // the one question nobody would think to enable it for.
    const config = parsePrefilledLink(LINK);
    const body = toFormBody(blankEntry({
        composer: 'Haydn', title: '76#3', part: 'VA1', location: 'Home',
    }), config);
    assert.equal(body.get(config.entry.part), 'VA1');
    assert.equal(body.has(`${config.entry.part}.other_option_response`), false);
    assert.equal(body.get(config.entry.title), '76#3');
    assert.equal(body.has(`${config.entry.title}.other_option_response`), false);
    assert.equal(body.get(config.entry.location), 'Home');
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

const withFormParam = (link) => {
    globalThis.window = {
        location: { search: `?form=${encodeURIComponent(link)}`, pathname: '/', hash: '' },
        history: { replaceState: () => {} },
    };
};

test('a ?form= link is never adopted on arrival, however the device is configured', () => {
    // The attack this closes: someone sends you a link, and one click points
    // your log at their spreadsheet. The form goes on saying "Logged" while
    // your own sheet quietly stops growing -- the same misdirected-writes
    // failure the per-user config exists to prevent, reachable by URL.
    //
    // A device with NO form yet is the case that matters most: it is every
    // existing user the day this ships and every new visitor, so a
    // silent-adopt branch for it would leave the hole open for exactly the
    // people most likely to click such a link.
    withFormParam(OTHER_LINK);
    assert.equal(consumeFormParam()?.formId, OTHER_ID);
    assert.equal(getFormConfig(), null, 'nothing is stored until a human accepts');

    withFormParam(OTHER_LINK);
    setFormConfig(parsePrefilledLink(LINK));
    assert.equal(consumeFormParam()?.formId, OTHER_ID);
    assert.equal(getFormConfig().formId, FORM_ID, 'the existing form is untouched');
});

test('re-opening your own setup link asks nothing, because it changes nothing', () => {
    withFormParam(LINK);
    setFormConfig(parsePrefilledLink(LINK));
    assert.equal(consumeFormParam(), null);
    assert.equal(getFormConfig().formId, FORM_ID);
});

test('a ?form= link that will not parse proposes nothing', () => {
    withFormParam('https://docs.google.com/spreadsheets/d/e/x/pub?output=csv');
    assert.equal(consumeFormParam(), null);
    assert.equal(getFormConfig(), null);
});

test('the form id is read as an id, not as arbitrary path text', () => {
    // formAction interpolates it into the URL it posts to, so a segment that
    // is not id-shaped is REJECTED rather than truncated: truncating would
    // silently address a different form and the opaque response would never
    // say so. Real ids are base64url, which is exactly what is accepted.
    const link = (/** @type {string} */ id) =>
        `https://docs.google.com/forms/d/e/${id}/viewform?`
        + IDS.map((eid, i) => `entry.${eid}=v${i}`).join('&');
    assert.equal(parsePrefilledLink(link('ABC-123_xyz'))?.formId, 'ABC-123_xyz');
    assert.equal(parsePrefilledLink(link('abc.def')), null);
    assert.equal(parsePrefilledLink(link('abc%2F..%2Fevil')), null);
});
