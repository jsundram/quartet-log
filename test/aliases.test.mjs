import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as stub from '../src/aliases.stub.js';
// config.js re-exports the tables from the resolved src/aliases.js
// (materialized from the stub by the npm "pretest" hook when absent).
import { PLAYER_ALIASES, PLAYER_ABBREVIATIONS } from '../src/config.js';

// Validate the instrument-class-keyed alias shape:
//   { "Short": { upper: "Full Name", cello: "Other Full Name" } }
function assertAliasesShape(aliases) {
    assert.equal(typeof aliases, 'object');
    for (const [short, entry] of Object.entries(aliases)) {
        assert.ok(short.length > 0, 'alias keys are non-empty strings');
        assert.ok(entry && typeof entry === 'object', `entry for ${short} is an object`);
        const classes = Object.keys(entry);
        assert.ok(classes.length > 0, `entry for ${short} has at least one class`);
        for (const cls of classes) {
            assert.ok(['upper', 'cello'].includes(cls),
                `class for ${short} is "upper" or "cello", got "${cls}"`);
            assert.equal(typeof entry[cls], 'string');
            assert.ok(entry[cls].length > 0);
        }
    }
}

// Validate the abbreviation shape: single letter → short name.
function assertAbbreviationsShape(abbrevs) {
    assert.equal(typeof abbrevs, 'object');
    for (const [letter, name] of Object.entries(abbrevs)) {
        assert.equal(letter.length, 1, `abbreviation key "${letter}" is a single letter`);
        assert.equal(typeof name, 'string');
        assert.ok(name.length > 0);
    }
}

describe('aliases.stub', () => {
    it('exports an EMPTY PLAYER_ALIASES (no real names may be checked in)', () => {
        assert.deepEqual(stub.PLAYER_ALIASES, {});
    });

    it('exports an EMPTY PLAYER_ABBREVIATIONS (no real names may be checked in)', () => {
        assert.deepEqual(stub.PLAYER_ABBREVIATIONS, {});
    });
});

describe('config.js re-exports', () => {
    it('re-exports PLAYER_ALIASES in the class-keyed shape', () => {
        assertAliasesShape(PLAYER_ALIASES);
    });

    it('re-exports PLAYER_ABBREVIATIONS in the letter → name shape', () => {
        assertAbbreviationsShape(PLAYER_ABBREVIATIONS);
    });
});
