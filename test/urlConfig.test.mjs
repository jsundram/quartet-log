// The setup box takes two things that look identical to a user: the published
// CSV URL, and a setup link carrying one. Only the first was ever accepted,
// and the second — the link the app itself generates — was refused as
// "Invalid URL", which is the most confusing possible answer to a link this
// app made. readSetupLink is the parse that closes that gap.
//
// Pure: no localStorage, no window. Everything else in urlConfig reads them,
// and is covered by test/dataService.test.mjs alongside the cache clearing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSetupLink } from '../src/urlConfig.js';

const SHEET = 'https://docs.google.com/spreadsheets/d/e/2PACX-fixture/pub?gid=0&single=true&output=csv';
const FORM_LINK = 'https://docs.google.com/forms/d/e/1FAIpQLSfixture/viewform?usp=pp_url&entry.201=';
const link = (params) => 'https://log.quartetroulette.com/?' + params;

test('a setup link yields the sheet URL it carries', () => {
    const got = readSetupLink(link('data=' + encodeURIComponent(SHEET)));
    assert.deepEqual(got, { dataUrl: SHEET, formLink: null });
});

test('the form half rides along, unparsed — the caller proposes it', () => {
    const got = readSetupLink(
        link('data=' + encodeURIComponent(SHEET) + '&form=' + encodeURIComponent(FORM_LINK)));
    assert.deepEqual(got, { dataUrl: SHEET, formLink: FORM_LINK });
});

test('surrounding whitespace survives a paste', () => {
    assert.equal(readSetupLink('  ' + link('data=' + encodeURIComponent(SHEET)) + '\n')?.dataUrl, SHEET);
});

test('the data URL is validated exactly as the address-bar route validates it', () => {
    // Not a sheet, and a sheet URL that would not export CSV: a link is not a
    // licence to configure the app with anything at all.
    assert.equal(readSetupLink(link('data=' + encodeURIComponent('https://evil.example/steal'))), null);
    assert.equal(
        readSetupLink(link('data=' + encodeURIComponent('https://docs.google.com/spreadsheets/d/e/x/pub'))),
        null);
});

test('a link with no data param, a bare sheet URL, and junk are all refused', () => {
    // A bare sheet URL is the OTHER accepted paste, handled by
    // isValidGoogleSheetsUrl — this parser must not claim it.
    assert.equal(readSetupLink(link('form=' + encodeURIComponent(FORM_LINK))), null);
    assert.equal(readSetupLink(SHEET), null);
    assert.equal(readSetupLink('not a url'), null);
    assert.equal(readSetupLink(''), null);
});
