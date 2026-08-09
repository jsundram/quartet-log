// Player-name tables — STUB (no real data).
//
// The real tables map short names in the sheet to ~40 real people's full
// names, which must not live in this public repo. Mechanism:
//
//   - src/aliases.js (gitignored, personal) holds the REAL tables with the
//     exact same exported shape as this stub. Everything imports the tables
//     from src/config.js, which re-exports them from src/aliases.js.
//   - scripts/ensure_aliases.mjs copies this stub to src/aliases.js when
//     that file is missing (fresh clone, CI). build.sh and the npm
//     "pretest" script both run it, so dev, prod, and test entry points
//     all work without the personal file — names just pass through
//     un-normalized (the site shows the sheet's raw short names).
//   - The deploy workflow materializes the real src/aliases.js from the
//     PLAYER_ALIASES_JS GitHub Actions secret (the file's full contents);
//     if the secret is unset it warns loudly and ships the stub.
//
// Never add real names to THIS file — it is tracked.

/**
 * Per-instrument-class alias entry. A short name may resolve to different
 * people depending on instrument class:
 *   - "upper": violin/viola slots (V1, V2, VA, VLA) — alias as one person
 *   - "cello": VC — never aliases with upper
 * Piano/other instruments are treated as "upper" for alias purposes.
 * @typedef {{ upper?: string, cello?: string }} AliasEntry
 */

/**
 * Short name → per-class canonical full name, e.g.
 *   { "Short": { upper: "Full Name", cello: "Other Full Name" } }
 * Applied at ingestion by normalizePlayerNames (src/dataProcessor.js).
 * @type {Record<string, AliasEntry>}
 */
export const PLAYER_ALIASES = {};

/**
 * Single-letter abbreviation → short name, e.g. { "A": "Ann" }.
 * Expanded by fillForward (src/dataProcessor.js) before aliasing.
 * @type {Record<string, string>}
 */
export const PLAYER_ABBREVIATIONS = {};
