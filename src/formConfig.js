// @ts-check
// The Google Form behind the sheet, addressed as a submit target.
//
// POSTing to /formResponse is exactly what the form's own page does, so Forms
// stays the writer: the sheet keeps its Timestamp column and everything
// downstream (fillForward, the audits, the CSV export) sees rows it already
// understands. Only the UI is ours, which is the whole point — the form can't
// see the log, and the app can.
//
// The ids come from the form's own FB_PUBLIC_LOAD_DATA_ blob. They are stable
// for the life of the form and are re-minted if it is ever rebuilt, which is
// why they live here alone: one file to re-derive rather than nine call sites.
// The form itself keeps working untouched, so it stays the fallback.

export const FORM_ID = '1FAIpQLSfClydp6ACsHewe7-kJHsl7lrgUS9HCFUvnHFQB5XGa7N41Ow';
export const FORM_ACTION = `https://docs.google.com/forms/d/e/${FORM_ID}/formResponse`;
export const FORM_VIEW = `https://docs.google.com/forms/d/e/${FORM_ID}/viewform`;

// One entry id per sheet column, keyed by Entry's field names.
export const ENTRY = {
    composer: 'entry.617761884',
    title:    'entry.1089341946',
    part:     'entry.906530431',
    player1:  'entry.2047796227',
    player2:  'entry.180148173',
    player3:  'entry.1831808369',
    others:   'entry.1922346688',
    location: 'entry.1954495027',
    comments: 'entry.526774847',
};

// Composer and Which Part are radio questions, so a value outside the option
// list has to arrive through Forms' "Other" escape: the entry carries a
// sentinel and the real text rides on a companion field. Every composer past
// the original seven — the catalog knows twenty — reaches the sheet this way,
// so these lists are the form's vocabulary, NOT a limit on what can be logged.
export const CHOICES = {
    composer: ['Bartok', 'Beethoven', 'Boccherini', 'Haydn', 'Mendelssohn', 'Mozart', 'Shostakovich'],
    part: ['V1', 'V2', 'VA1', 'VA2'],
};
const OTHER_OPTION = '__other_option__';

// The form's own required questions. Forms enforces them server-side and the
// opaque response means a rejection is invisible, so the client has to mirror
// them — see logEntry.missingFields.
export const REQUIRED_FIELDS = /** @type {const} */ (['composer', 'title', 'part']);

/**
 * @param {Record<string, string>} entry
 * @returns {URLSearchParams}
 */
export function toFormBody(entry) {
    const body = new URLSearchParams();
    for (const [field, id] of Object.entries(ENTRY)) {
        const value = (entry[field] ?? '').trim();
        // An omitted entry and an empty one produce the same empty cell, and
        // an empty cell is a ditto mark (see logEntry.carriedForward) — so
        // skipping keeps the request small without changing what lands.
        if (!value) continue;
        const choices = /** @type {Record<string, string[]>} */ (CHOICES)[field];
        if (choices && !choices.includes(value)) {
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
// URLSearchParams keeps the content type CORS-safelisted, so there's no
// preflight to be blocked.
/** @param {Record<string, string>} entry */
export async function postEntry(entry) {
    await fetch(FORM_ACTION, { method: 'POST', mode: 'no-cors', body: toFormBody(entry) });
}
