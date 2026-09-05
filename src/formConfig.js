// @ts-check
// Which Google Form the log view writes through, and how to address it.
//
// POSTing to a form's /formResponse endpoint is exactly what the form's own
// page does, so Forms stays the writer: the sheet keeps its Timestamp column
// and everything downstream (fillForward, the audits, the CSV export) sees
// rows it already understands. Only the UI is ours.
//
// The configuration is PER USER, stored beside the data URL, with no default
// baked into the bundle. That is not a preference: this site is deployed
// publicly and anyone can point it at their own sheet, so a hardcoded form id
// would mean every visitor's entries landing in one person's spreadsheet while
// their own log stayed empty. A form belongs to whoever configured the sheet
// it feeds.
import { FIELDS } from './logEntry.js';

/**
 * @typedef {object} FormConfig
 * @property {string} formId
 * @property {Record<string, string>} entry - log field name -> "entry.NNN"
 */

const STORAGE_KEY = 'quartetlog_form';

/** @param {string} formId */
export function formAction(formId) {
    return `https://docs.google.com/forms/d/e/${formId}/formResponse`;
}

// Composer and Which Part are multiple-choice questions, and every value for
// them is sent through Forms' "Other" escape: the entry carries a sentinel and
// the real text rides on a companion field. Forms stores an Other response as
// plain text in the response-sheet column, so a value that IS one of the
// options lands in the same cell either way — the only visible difference is
// the Form's own built-in response summary, which nothing here reads.
//
// ALWAYS, rather than only for values outside the list, because there is no
// list to be outside of: another user's options can't be read cross-origin.
// This used to hold the reference form's seven composers and send anything
// else through the escape, which meant a form whose Composer question was
// built as SHORT ANSWER wrote those seven correctly and corrupted the other
// thirteen the catalog knows — the worst shape a failure can take here, since
// the opaque response says "Logged" either way and the damage only starts on
// whichever piece first uses an unlisted composer. Requiring Other is a
// condition we can state up front (md/howto.md section 1) instead of a guess we
// re-make on every submit, and a form that does not meet it now fails on the
// first piece rather than the eighth.
const OTHER_FIELDS = new Set(['composer', 'part']);
const OTHER_OPTION = '__other_option__';

/**
 * Read a Google Forms "pre-filled link" into a config, or say why it can't be.
 *
 * This is the only way to learn a user's entry ids from the browser: the form's
 * own page carries them in a FB_PUBLIC_LOAD_DATA_ blob, but it is cross-origin
 * and unfetchable, while a pre-filled link is a URL they can copy out of the
 * form editor in one step.
 *
 * Ids map to columns POSITIONALLY, which is correct by construction rather
 * than by luck: Forms builds the response sheet's columns from the questions
 * in order, so the Nth question is the Nth column. It breaks only if questions
 * were reordered after the sheet already existed, which is why the caller
 * shows the mapping back for confirmation.
 *
 * Returns a reason rather than a bare null because the two failures need
 * different fixes: a wrong link is a copy-paste problem, while the wrong
 * NUMBER of fields means the form doesn't match the sheet this app requires
 * (processRow demands all ten columns), and no amount of re-pasting helps.
 *
 * @param {string} link
 * @returns {{ config: FormConfig } | { config: null, reason: 'empty'|'not-a-form-link'|'field-count', found?: number }}
 */
export function readPrefilledLink(link) {
    const text = (link ?? '').trim();
    if (!text) return { config: null, reason: 'empty' };

    let url;
    try { url = new URL(text); } catch { return { config: null, reason: 'not-a-form-link' }; }
    // The id is interpolated into the URL formAction builds, so it has to be
    // an id and not arbitrary path text. Anchored at the segment end so an
    // unexpected shape is REJECTED rather than silently truncated into a
    // different form's address.
    // The dot boundary matters: `endsWith('google.com')` also accepts
    // `evilgoogle.com`. Nothing downstream takes the HOST from the link today
    // (formAction hardcodes docs.google.com), so the containment is real but
    // incidental — a check that reads as if it validated the host should
    // actually do it, or the next change inherits an open redirect.
    const host = url.hostname;
    const formId = (host === 'google.com' || host.endsWith('.google.com'))
        ? url.pathname.match(/\/forms\/d\/e\/([\w-]+)(?:\/|$)/)?.[1] : null;
    if (!formId) return { config: null, reason: 'not-a-form-link' };

    // Order matters, so read the query in order. Forms repeats an id for
    // checkbox questions; the log has none, and de-duplicating keeps a stray
    // repeat from shifting every column one cell over.
    const ids = [];
    for (const [key] of url.searchParams) {
        if (/^entry\.\d+$/.test(key) && !ids.includes(key)) ids.push(key);
    }
    if (ids.length !== FIELDS.length) {
        return { config: null, reason: 'field-count', found: ids.length };
    }
    return { config: { formId, entry: Object.fromEntries(FIELDS.map((f, i) => [f, ids[i]])) } };
}

/**
 * The predicate view of readPrefilledLink, for callers that only need the
 * config. One parser, two views — a second copy of the parse is exactly the
 * drift the audits keep finding.
 * @param {string} link
 * @returns {FormConfig|null}
 */
export function parsePrefilledLink(link) {
    return readPrefilledLink(link).config;
}

/** @returns {FormConfig|null} */
export function getFormConfig() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        // A shape check, not decoration: a half-written config would submit
        // rows with missing columns and no visible failure (see postEntry).
        return parsed?.formId && FIELDS.every(f => parsed.entry?.[f]) ? parsed : null;
    } catch { return null; }
}

/** @param {FormConfig} config @returns {boolean} */
export function setFormConfig(config) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); return true; }
    catch { return false; }
}

export function clearFormConfig() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing to clear */ }
}

/**
 * @param {Record<string, string>} entry
 * @param {FormConfig} config
 * @returns {URLSearchParams}
 */
export function toFormBody(entry, config) {
    if (!config) throw new TypeError('toFormBody: pass a form config');
    const body = new URLSearchParams();
    for (const field of FIELDS) {
        const value = (entry[field] ?? '').trim();
        // An omitted entry and an empty one produce the same empty cell, and
        // an empty cell is a ditto mark (see logEntry.carriedForward) — so
        // skipping keeps the request small without changing what lands.
        if (!value) continue;
        const id = config.entry[field];
        if (OTHER_FIELDS.has(field)) {
            body.set(id, OTHER_OPTION);
            body.set(`${id}.other_option_response`, value);
        } else {
            body.set(id, value);
        }
    }
    return body;
}

// Fire-and-forget by necessity: Forms sends no CORS headers, so the response
// is opaque and an accepted submission is indistinguishable from a rejected
// one. Resolving means the request left the device, which is the only fact
// available — hence the client-side required-field check in logEntry, and the
// sheet itself as the real confirmation on the next refresh. A rejection is
// therefore a TRANSPORT failure, which is exactly the signal the queue wants.
// URLSearchParams keeps the content type CORS-safelisted, so there is no
// preflight to be blocked.
/** @param {Record<string, string>} entry @param {FormConfig} config */
export async function postEntry(entry, config) {
    await fetch(formAction(config.formId), {
        method: 'POST', mode: 'no-cors', body: toFormBody(entry, config),
    });
}

/**
 * Cross-device setup, mirroring urlConfig's ?data= link: if the page URL has
 * ?form=<pre-filled link>, read it and strip the param.
 *
 * It is returned as a PROPOSAL for the user to accept, never applied. A URL is
 * not a choice, and this config alone decides where every logged row is sent:
 * a link someone sends you would otherwise point your log at their spreadsheet
 * in one click, and the form would go on saying "Logged" while your own sheet
 * quietly stopped growing. That holds just as much for a device with no form
 * yet — which is every existing user the day this ships, and every new visitor
 * — as for one being re-pointed, so there is no silent-adopt branch at all.
 * The cross-device flow this exists for costs one tap.
 *
 * The single exception is a link naming the form already configured, which
 * asks for nothing and is left silent (re-opening your own setup link).
 *
 * @returns {FormConfig|null} a config awaiting the user's decision
 */
export function consumeFormParam() {
    const params = new URLSearchParams(window.location.search);
    const link = params.get('form');
    if (!link) return null;

    const config = parsePrefilledLink(link);
    // Strip ?form= however it turns out, so a declined proposal can't return
    // on reload and a bad one doesn't linger in history.
    params.delete('form');
    const search = params.toString();
    window.history.replaceState(null, '',
        window.location.pathname + (search ? '?' + search : '') + window.location.hash);

    if (!config) return null;
    return config.formId === getFormConfig()?.formId ? null : config;
}

/**
 * The inverse of parsePrefilledLink: a link that round-trips this config, for
 * the ?form= setup link. Values are left empty — only the ids and their order
 * carry information.
 * @param {FormConfig} config
 * @returns {string}
 */
export function buildPrefilledLink(config) {
    const params = new URLSearchParams({ usp: 'pp_url' });
    for (const field of FIELDS) params.set(config.entry[field], '');
    return `https://docs.google.com/forms/d/e/${config.formId}/viewform?${params}`;
}
