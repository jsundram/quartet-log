import * as d3 from "d3";
import { composerWorkIndex } from './catalog.js';
import {
    postEntry, readPrefilledLink, getFormConfig, setFormConfig, clearFormConfig,
    formViewUrl,
} from './formConfig.js';
import { stripParens, computeAggregateStats } from './dataProcessor.js';
import { buildAggregateStatDefs } from './statDefs.js';
import { tooltip } from './tooltip.js';
import * as store from './logStore.js';
import {
    blankEntry, carriedForward, resolveCarry, missingFields,
    warnings, knownPlayers, knownLocations, nextInSession, frequentComposers,
    impliedSlotParts, defaultSlotParts, slotCell, SLOT_PARTS, PART_CHOICES,
    FIELDS, LABELS,
    splitOthersCell, mergeOthersCell, parseOthersRows, canonicalOthersCell,
    sessionPeople, sessionRows, slotPartKey, sessionPieces, countNew,
} from './logEntry.js';

// The entry field each text input owns. `part` is absent: it's a segmented
// button group. `composer` is absent too — it's a <select> whose "Other..."
// reveals #logComposerOther, because a typo in the field that keys every tab
// and every quartetroulette link mints a phantom composer. It is the one
// field that isn't free text by default.
const TEXT_INPUTS = {
    title: '#logTitle',
    player1: '#logPlayer1',
    player2: '#logPlayer2',
    player3: '#logPlayer3',
    location: '#logLocation',
    comments: '#logComments',
};

const CARRIED_INPUTS = ['player1', 'player2', 'player3', 'location'];
const SEATS = ['player1', 'player2', 'player3'];


// What to mark and focus when a required field is missing. Composer resolves
// to whichever of its two controls is live.
const REQUIRED_SELECTOR = {
    composer: () => {
        if (!d3.select('#logComposerOther').property('hidden')) return '#logComposerOther';
        return d3.select('#logComposer').property('hidden') ? '#logComposerChips' : '#logComposer';
    },
    title: () => '#logTitle',
    part: () => '#logPart',
};

// Leading space: no composer name can collide with it.
const OTHER_COMPOSER = ' other';

const SETUP_ERROR = {
    'not-a-form-link': 'That is not a Google Forms link. Use Get pre-filled link in the form editor, not the form address itself.',
    'field-count': `That link has the wrong number of fields: this log needs one per sheet column (${FIELDS.length}). Fill in every field before copying the link, and check the form matches your sheet.`,
};

// Sentinel for the chip that opens the full catalog. Leading space so no
// composer name can collide with it.
const MORE_COMPOSERS = ' more';

// What the status line cannot say in a sentence. The line has to fit a phone,
// and both of these states provoke the same question — is my piece lost? — so
// the answer goes behind the (i) rather than being cut down until it stops
// answering. The normal case has no entry here: it gets the confirmation
// screen, which has room to say it in full.
const STATUS_HELP = {
    queued: 'Without a connection the piece cannot reach your form yet, so it is held on this '
        + 'device and sent as soon as you are back online. They go out in the order you logged '
        + 'them, which matters: a seat left blank means "same as the row above". Keep logging — '
        + 'they queue up, and the list below shows what is waiting.',
    lost: 'This browser is refusing to store anything — usually private browsing, or a device '
        + 'with no room left — so there is no queue holding the piece and no later attempt '
        + 'coming. It is still filled in above, so nothing has to be typed twice: try again once '
        + 'you have a connection, or fill in your Google Form directly.',
};

// The tiles that move during a sitting. buildAggregateStatDefs also carries
// Days played and Max streak, which cannot change between two pieces of the
// same evening and would be four characters of noise on every confirmation.
const DONE_TILES = 4;

const timeOfDay = (/** @type {number|Date} */ at) =>
    new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// Enough of a form id to tell two apart without printing the whole thing.
const shortId = (/** @type {string} */ id) => `...${id.slice(-6)}`;

/**
 * That tail, linked to the form itself, so "is this form mine" can be answered
 * by looking rather than by recognising six characters.
 *
 * Built as nodes and attributes, never as interpolated markup: a form id in the
 * proposal arrives from a ?form= link, which is precisely the input someone
 * else controls. `readPrefilledLink` already constrains it to [\w-]+, so this
 * is belt and braces — but the sentence around it is set as text for the same
 * reason, and one markup path would undo both.
 *
 * @param {string} formId
 * @returns {HTMLAnchorElement}
 */
function formIdLink(formId) {
    const a = document.createElement('a');
    a.href = formViewUrl(formId);
    a.textContent = shortId(formId);
    a.title = `Open this form in a new tab to check whose it is`;
    // A NEW tab, not this one. consumeFormParam has already stripped ?form=
    // from the address bar, so a proposal lives only in memory: navigating
    // away to check the form would discard the very decision being checked,
    // with no way back but re-opening the original link.
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
}

/**
 * Set a sentence built from plain strings and form ids, where each id becomes
 * a linked `<code>`. Strings go in as text nodes, so nothing here parses HTML.
 * @param {d3.Selection<any, any, any, any>} sel
 * @param {Array<string | { formId: string }>} parts
 */
function setLinkedText(sel, parts) {
    const node = sel.node();
    node.textContent = '';
    for (const part of parts) {
        if (typeof part === 'string') { node.append(part); continue; }
        const code = document.createElement('code');
        code.append(formIdLink(part.formId));
        node.append(code);
    }
}

/** @param {number} ms */
function ago(ms) {
    const min = Math.round(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    return hr < 24 ? `${hr}h ago` : `${Math.round(hr / 24)}d ago`;
}

export class LogComponent {
    constructor() {
        this.rows = [];
        this.entry = blankEntry();
        this.works = {};
        // Which form this device writes through. There is no default, so an
        // unconfigured visitor gets the setup panel rather than a form that
        // would post someone else's rows into a stranger's spreadsheet.
        this.config = null;
        // "More" was tapped, so the full-catalog picker stays open.
        this.expandComposer = false;
        // Per-seat part, only where the user has overridden the default. Kept
        // sparse so the defaults stay live as the carried row changes.
        this.slotPartOverrides = [null, null, null];
        // Set by discard(): this device has been handed back.
        this.discarded = false;
        // One editable row per Others? entry. The cell text is derived from
        // these (syncOthers), never the other way round while editing.
        this.sheetRows = [];
        this.otherRows = [];
        this.othersFree = '';
        this._otherId = 0;
        // A ?form= link that would replace this.config, awaiting a decision.
        this.proposed = null;
        // The piece just logged, while its confirmation is on screen.
        this.done = null;
        this.mounted = false;
        this.invalidateSources();
    }

    // Called on every data change (boot, revalidate). The form never depends
    // on this: with no cached data the datalists are empty and every field
    // still works, which is what a first launch offline gets.
    setData(rows, sheetRows) {
        this.rows = rows ?? [];
        // Every row the SHEET holds, partial movements included. The app hides
        // those rows, but the sheet's own fillForward still reads the next row
        // against them, so carry-forward has to. Log "Op. 59#1: I" and then
        // leave a seat blank, and the cell this form leaves empty is resolved
        // against the partial — not against the row this app would show above
        // it. store.recent() masks this inside a session; it bites when the
        // partial came from the Google Form itself or from another device.
        this.sheetRows = sheetRows ?? this.rows;
        this.invalidateSources();
        // Deliberately NOT a full refresh: a background revalidate lands every
        // five minutes and writing the entry back into the inputs would move
        // the caret out from under whoever is mid-name. Only the parts driven
        // by the data are redrawn.
        if (this.mounted) this.redrawFromData();
    }

    // Idempotent, per initializeUI's re-init contract: a second call rebuilds
    // the pickers rather than stacking a second set of part buttons.
    mount() {
        this.config = getFormConfig();
        this.buildComposerPicker();
        this.wireFields();
        this.wireSetup();
        if (!this.mounted) {
            this.mounted = true;
            d3.select('#logForm').on('submit', (e) => { e.preventDefault(); this.submit(); });
            // Back to the fields. The next piece was prepared at submit time,
            // so composer, part and the seats have all carried and the work
            // title is the only thing left to type — hence the cursor.
            d3.select('#logDoneNext').on('click', () => {
                this.done = null;
                this.renderMode();
                d3.select('#logTitle').node()?.focus();
            });
            d3.select('#logDoneCharts').on('click', () => {
                this.done = null;
                this.renderMode();
                window.location.hash = '#main';
            });
            // In place, below the line: no positioning to get wrong at any
            // width, and reachable by keyboard.
            d3.select('#logStatusInfo').on('click', () => {
                const panel = d3.select('#logStatusHelp');
                const show = panel.property('hidden');
                panel.property('hidden', !show);
                d3.select('#logStatusInfo').attr('aria-expanded', String(show));
            });
            // Coming back from a dead zone is the moment the queue can drain.
            window.addEventListener('online', () => this.flushQueue());
            // Belt and braces on the draft. Every handler calls touch(), but
            // remembering to is exactly how the Other-composer field went
            // unsaved, and on iOS a backgrounded PWA is killed without warning.
            // pagehide fires where beforeunload does not; visibilitychange
            // covers a swipe to the home screen that never unloads at all.
            window.addEventListener('pagehide', () => this.touch());
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') this.touch();
            });
        }
        this.restoreDraft();
        this.refresh();
    }

    wireSetup() {
        // Preview the mapping BEFORE saving: the ids map to columns
        // positionally, which is right by construction for a form and the
        // sheet it created, but wrong if the questions were reordered
        // afterwards. This is the only moment anyone can catch that.
        d3.select('#logSetupLink').on('input', (e) => {
            const read = readPrefilledLink(e.target.value);
            this.pendingConfig = read.config;
            d3.select('#logSetupSave').property('disabled', !read.config);
            // The two failures need different fixes, so they get different
            // sentences: a wrong link is a copy-paste slip, while the wrong
            // NUMBER of fields means the form doesn't match the ten columns
            // this app requires, and re-pasting will never help.
            d3.select('#logSetupError').text(SETUP_ERROR[read.reason] ?? '');
            this.renderSetupMap();
        });
        d3.select('#logSetupSave').on('click', () => {
            if (!this.pendingConfig) return;
            setFormConfig(this.pendingConfig);
            this.config = this.pendingConfig;
            this.pendingConfig = null;
            // Reset the panel, not just hide it: renderMode leaves the button
            // enabled and the mapping table rendered, so tapping Change would
            // reopen the panel showing the DISCONNECTED form's columns under
            // an empty box, with a Connect button that silently does nothing.
            // Verifying that mapping is the one thing this panel is for.
            d3.select('#logSetupLink').property('value', '');
            d3.select('#logSetupSave').property('disabled', true);
            d3.select('#logSetupError').text('');
            this.renderSetupMap();
            this.renderMode();
            this.status('Form connected.', 'ok');
            this.flushQueue();
        });
        d3.select('#logProposalAccept').on('click', () => {
            if (!this.proposed) return;
            setFormConfig(this.proposed);
            this.config = this.proposed;
            this.proposed = null;
            this.renderMode();
            this.status(`Now writing to form ${shortId(this.config.formId)}.`, 'ok');
        });
        d3.select('#logProposalReject').on('click', () => {
            this.proposed = null;
            this.renderMode();
        });
        d3.select('#logChangeForm').on('click', (e) => {
            e.preventDefault();
            clearFormConfig();
            this.config = null;
            this.renderMode();
        });
    }

    renderSetupMap() {
        const rows = this.pendingConfig
            ? FIELDS.map(f => ({ label: LABELS[f], id: this.pendingConfig.entry[f] }))
            : [];
        d3.select('#logSetupMap').selectAll('.log-setup-row')
            .data(rows, d => d.label)
            .join(enter => {
                const row = enter.append('div').attr('class', 'log-setup-row');
                row.append('span').attr('class', 'log-setup-col');
                row.append('code');
                return row;
            })
            .call(row => {
                row.select('.log-setup-col').text(d => d.label);
                row.select('code').text(d => d.id);
            });
    }

    // Exactly one of: the pending-proposal prompt, the confirmation screen,
    // the form, the setup panel. A proposal outranks everything, so where
    // entries go can't be changed — or logged against — until it has been
    // answered; the confirmation outranks the form because it IS the form's
    // answer, and scrolling past it is how the old status line was missed.
    renderMode() {
        const deciding = !!this.proposed;
        const confirming = !deciding && !!this.done && !!this.config;
        d3.select('#logProposal').property('hidden', !deciding);
        if (deciding) this.renderProposal();
        d3.select('#logDone').property('hidden', !confirming);
        if (confirming) this.renderDone();
        d3.select('#logForm').property('hidden', deciding || confirming || !this.config);
        d3.select('#logSetup').property('hidden', deciding || !!this.config);
        setLinkedText(d3.select('#logFormId'), this.config ? [{ formId: this.config.formId }] : []);
        this.renderPending();
    }

    // The view just became visible: retry anything queued, and put the form
    // back. Arriving at #log to find last night's receipt instead of the
    // fields would be its own small betrayal; within one visit the
    // confirmation stays until it is dismissed.
    notifyShown() {
        if (!this.mounted) return;
        if (this.done) { this.done = null; this.renderMode(); }
        this.flushQueue();
    }

    hasForm() {
        return !!this.config;
    }

    // A ?form= link asking to replace an existing connection. Held, not
    // applied: App calls this before the UI mounts, and renderMode surfaces it.
    proposeConfig(config) {
        this.proposed = config;
        if (this.mounted) this.renderMode();
    }

    // The chips are the composers this log plays; the select behind "More" is
    // the whole catalog. One state (entry.composer), two views.
    renderComposerChips() {
        const chips = this.frequentComposers();
        const group = d3.select('#logComposerChips');
        group.selectAll('.log-chip-btn')
            .data([...chips, MORE_COMPOSERS], d => d)
            .join('button')
            .attr('type', 'button')
            .attr('class', d => 'log-chip-btn'
                + (d === MORE_COMPOSERS ? ' log-chip-btn--more' : '')
                + (d === this.entry.composer ? ' active' : ''))
            .attr('role', d => (d === MORE_COMPOSERS ? null : 'radio'))
            .attr('aria-checked', d => (d === MORE_COMPOSERS ? null : String(d === this.entry.composer)))
            .text(d => (d === MORE_COMPOSERS ? 'More...' : d))
            .on('click', (_, d) => {
                if (d === MORE_COMPOSERS) {
                    this.expandComposer = true;
                } else {
                    this.entry.composer = d;
                    this.expandComposer = false;
                }
                this.clearMissing();
                this.touch();
                this.renderFields();
                this.renderWorkOptions();
                if (this.expandComposer) d3.select('#logComposer').node()?.focus();
            });
    }

    buildComposerPicker() {
        this.works = composerWorkIndex();
        const select = d3.select('#logComposer');
        select.on('change', () => {
            const value = select.property('value');
            const isOther = value === OTHER_COMPOSER;
            this.entry.composer = isOther ? '' : value;
            const other = d3.select('#logComposerOther').property('hidden', !isOther);
            if (isOther) {
                other.property('value', '');
                other.node().focus();
            }
            this.clearMissing();
            this.touch();
            // Both views, always together. A background revalidate clears the
            // frequentComposers memo without re-rendering either (setData
            // deliberately touches nothing the user might be typing into), so
            // rebuilding only the chips here recomputes the set on one side of
            // a complement: a composer the new data promotes to a chip is left
            // in the picker too — the duplication this pair exists to remove —
            // and one demoted off the chips is in neither, reachable only
            // through Other... The fix belongs on this seam and not in
            // redrawFromData, which would rewrite the option list under a
            // picker the user has open.
            this.renderComposerChips();
            this.renderComposerOptions();
            this.renderWorkOptions();
        });
        d3.select('#logComposerOther').on('input', (e) => {
            this.entry.composer = e.target.value;
            this.touch();
            this.renderWorkOptions();
        });
    }

    // The picker holds what the chips DON'T: listing the same six composers
    // twice spent the top of a phone screen re-offering the taps already on
    // offer, and the chip is the faster one. Built here rather than at mount
    // because the chip row is derived from the log and moves with it — one
    // pass, one frequentComposers() memo, so the two views cannot come to
    // disagree about which composers the chips are showing. The chosen
    // composer is kept in the list even when it has a chip, so the select has
    // something to display instead of falling blank next to its own selection.
    renderComposerOptions() {
        const onChips = new Set(this.frequentComposers());
        const rest = Object.keys(this.works).sort()
            .filter(d => !onChips.has(d) || d === this.entry.composer);
        d3.select('#logComposer').selectAll('option')
            .data(['', ...rest, OTHER_COMPOSER], d => d)
            .join('option')
            .attr('value', d => d)
            .text(d => (d === '' ? 'Composer...' : d === OTHER_COMPOSER ? 'Other...' : d))
            .order();
    }

    // Work suggestions follow the chosen composer. A datalist suggests without
    // constraining, which is what the sheet needs: titles carry "#" numbers and
    // movement notation the catalog doesn't enumerate.
    renderWorkOptions() {
        d3.select('#logWorks').selectAll('option')
            .data(this.works[this.entry.composer] ?? [])
            .join('option')
            .attr('value', d => d);
    }

    buildPartButtons() {
        const group = d3.select('#logPart');
        group.selectAll('button')
            .data(PART_CHOICES)
            .join('button')
            .attr('type', 'button')
            .attr('role', 'radio')
            .attr('class', d => `part-btn${d === this.entry.part ? ' active' : ''}`)
            .attr('aria-checked', d => String(d === this.entry.part))
            .attr('data-part', d => d)
            .text(d => d)
            .on('click', (_, part) => {
                this.entry.part = part;
                // Every seat now means something else, so an override kept
                // from the old layout would be describing a seat that moved.
                this.slotPartOverrides = [null, null, null];
                this.touch();
                // Reflect state into the DOM; never read the selection back out
                // of it (same contract as the Home part filter). aria-checked
                // rides along because the part is a required field, and an
                // unset one is one of the three things that blocks a submit.
                group.selectAll('.part-btn')
                    .classed('active', function () {
                        return d3.select(this).attr('data-part') === part;
                    })
                    .attr('aria-checked', function () {
                        return String(d3.select(this).attr('data-part') === part);
                    });
                this.clearMissing();
                this.renderSlotParts();
            });
    }

    wireFields() {
        for (const [field, sel] of Object.entries(TEXT_INPUTS)) {
            d3.select(sel).on('input', (e) => {
                this.entry[field] = e.target.value;
                this.clearMissing();
                this.touch();
            });
        }
        SEATS.forEach((_, i) => {
            d3.select(`#logSlotPart${i + 1}`).on('change', (e) => {
                this.slotPartOverrides[i] = e.target.value;
                this.touch();
            });
        });
        d3.select('#logOthersFree').on('input', (e) => {
            this.othersFree = e.target.value;
            this.syncOthers();
        });
        d3.select('#logOthersAdd').on('click', () => {
            this.setOtherRows([...this.otherRows, this.newOtherRow()]);
            const last = document.querySelector('.log-other-row:last-of-type input');
            last?.focus();
        });
    }

    // The part each seat is currently set to: what the carried row says (a
    // role sticks across a session like a name does), unless overridden here.
    slotParts() {
        const defaults = defaultSlotParts(this.carried(), this.entry.part);
        return defaults.map((d, i) => this.slotPartOverrides[i] ?? d);
    }

    renderSlotParts() {
        const chosen = this.slotParts();
        const implied = impliedSlotParts(this.entry.part);
        SEATS.forEach((_, i) => {
            const value = chosen[i];
            // An annotation the option list cannot express is offered as
            // itself, so selecting it round-trips instead of being rewritten.
            const extra = value && !SLOT_PARTS.some(p => p.key === value)
                ? [{ key: value, label: value }] : [];
            const select = d3.select(`#logSlotPart${i + 1}`);
            select.selectAll('option')
                .data([...SLOT_PARTS, ...extra], d => d.key)
                .join('option')
                .attr('value', d => d.key)
                // The seat's own part is the one you are departing from, so say
                // which that is rather than leaving the default unremarkable.
                .text(d => (d.key === implied[i] ? `${d.label} (seat)` : d.label));
            select.property('value', value ?? '');
        });
    }

    // The renders below are the ones that read the DATA rather than the entry.
    // setData runs them on every revalidate and never touches the field values,
    // since a background fetch lands every five minutes and rewriting an input
    // would move the caret out from under whoever is mid-name.
    redrawFromData() {
        this.invalidateSources();
        this.renderSuggestions();
        this.renderPlaceholders();
        this.renderSlotParts();
        this.renderSessionPeople();
        // The confirmation is made of data too, and the one thing it says that
        // nothing else can — this row is in your sheet but not yet in these
        // charts — is only true until the next revalidate proves otherwise.
        // That is the whole point of the dot: it fills in while you watch.
        if (this.done) this.renderDone();
    }

    // Both sources below are derived from `this.rows` and from localStorage,
    // and both are read several times per render — carriedForward alone is
    // asked for by renderPlaceholders, renderSlotParts and renderSessionPeople.
    // Every one of those was a synchronous getItem + JSON.parse, and
    // sessionSource additionally copied the whole log; syncOthers runs the lot
    // on every keystroke in an Others? field, which is the phone-in-a-
    // rehearsal-room path this feature exists for. They change only when the
    // data or the store does, so they are computed once and held until then.
    invalidateSources() {
        this._carry = undefined;
        this._carried = undefined;
        this._session = null;
        this._frequent = null;
    }

    // The session, as this device knows it: the fetched rows plus whatever was
    // submitted here since. Without the local half, the people from the piece
    // you logged two minutes ago would not be offered back until the published
    // CSV caught up -- which is precisely the window a session happens in.
    sessionSource() {
        if (this._session) return this._session;
        // Every submission this device remembers, not just the newest: a
        // sitting logs several pieces inside the window the published CSV
        // takes to catch up, and someone who left after the second piece
        // should still be offered back for the fourth.
        return (this._session = [...this.sheetRows, ...store.recentAll().map(({ at, entry }) => ({
            // The real save time, not now: a submission from this morning is
            // not part of this afternoon's sitting.
            timestamp: new Date(at),
            player1: stripParens(entry.player1),
            player2: stripParens(entry.player2),
            player3: stripParens(entry.player3),
            others: entry.others,
            // parseOthersRows, not splitOthersCell's `rows`: a fetched row's
            // othersList comes from dataProcessor.parseOthers, which keeps
            // every person and discards only the comment. The `rows` view
            // drops the commented entries entirely, so a local submission
            // would forget anyone the freeform box held.
            othersList: parseOthersRows(entry.others)
                .map(r => ({ name: r.name, instrument: r.instrument })),
        }))]);
    }

    /**
     * The extras to start the next piece with. `Others?` cannot ditto in the
     * sheet — every row that had a fifth player has to name them again, and
     * howto section 6 calls forgetting to the single most common way a person
     * goes missing from the log. So the form carries them instead and writes
     * them out each time; the x on a row is how you say someone left.
     *
     * Scoped to the sitting, unlike the seats: a blank seat repeats however
     * long the break, but re-adding the people from three days ago would be
     * plainly wrong.
     */
    defaultOthersCell() {
        return canonicalOthersCell(sessionRows(this.sessionSource()).at(-1));
    }

    // The row the sheet will read this one against. A submission this device
    // made minutes ago beats the fetched data, which lags by however long the
    // published CSV takes to catch up.
    carrySource() {
        if (this._carry !== undefined) return this._carry;
        const last = this.sheetRows.at(-1) ?? null;
        return (this._carry = store.recent(last)?.entry ?? last);
    }

    // What a blank cell in each carried field will become. Read three times
    // per render pass and unchanged in between, so it rides the same memo.
    carried() {
        return (this._carried ??= carriedForward(this.carrySource()));
    }

    // Two full scans of the log per render otherwise: renderComposerChips
    // builds the chip row from it and renderFields asks again to decide
    // whether the composer already has a chip.
    frequentComposers() {
        return (this._frequent ??= frequentComposers(this.rows));
    }

    refresh() {
        this.renderFields();
        this.renderPlaceholders();
        this.buildPartButtons();
        this.renderWorkOptions();
        this.renderSuggestions();
        this.renderSlotParts();
        this.renderSessionPeople();
        this.renderMode();
    }

    renderFields() {
        for (const [field, sel] of Object.entries(TEXT_INPUTS)) {
            d3.select(sel).property('value', this.entry[field]);
        }
        d3.select('#logOthersFree').property('value', this.othersFree);
        this.renderOtherRows();
        this.renderComposerChips();
        // The picker opens on request, and stays open whenever it holds the
        // answer — a composer with no chip would otherwise be set but invisible.
        const onAChip = this.frequentComposers().includes(this.entry.composer);
        const showPicker = this.expandComposer || (!!this.entry.composer && !onAChip);
        // A composer the catalog doesn't list is held in the Other input, and
        // the select has to show that rather than silently falling back to its
        // blank option while the name sits visible underneath it.
        const listed = this.entry.composer in this.works;
        // Options first: the value below can only select one that exists.
        this.renderComposerOptions();
        d3.select('#logComposer')
            .property('hidden', !showPicker)
            .property('value', listed ? this.entry.composer : (this.entry.composer ? OTHER_COMPOSER : ''));
        d3.select('#logComposerOther')
            .property('hidden', listed || !this.entry.composer)
            .property('value', listed ? '' : this.entry.composer);
    }

    // A blank seat is a ditto mark, so the placeholder shows what will arrive
    // if nothing is typed: the carry-forward made visible instead of trusted
    // (howto section 6).
    renderPlaceholders() {
        const carried = this.carried();
        for (const field of CARRIED_INPUTS) {
            d3.select(TEXT_INPUTS[field]).attr('placeholder', carried[field] || 'nobody yet');
        }
    }

    // Two situations, two sentences. Connecting a first form and replacing a
    // working one carry different risk, and "Keep mine" is nonsense when there
    // is nothing to keep. Set as text, never markup.
    renderProposal() {
        const proposed = { formId: this.proposed.formId };
        const replacing = !!this.config;
        // Both ids are links: this is the one screen that asks "is this form
        // yours", and six characters of an id someone else sent you cannot
        // answer it. Opening the form can.
        setLinkedText(d3.select('#logProposalText'), replacing
            ? ['This link points your log at a different Google Form, ', proposed,
                ', replacing ', { formId: this.config.formId },
                ". Everything you log would go to that form's spreadsheet instead of "
                + 'yours. Open it to check whose it is.']
            : ['This link would connect your log to Google Form ', proposed,
                ". Everything you log goes to that form's spreadsheet, so open it and "
                + 'only accept it if the form is yours.']);
        d3.select('#logProposalReject').text(replacing ? 'Keep mine' : 'Not now');
        d3.select('#logProposalAccept').text(replacing ? 'Use the new form' : 'Connect this form');
    }

    // Naming the missing fields in a sentence is not enough on a phone, where
    // the one that is empty may be three fields up: mark them, and put the
    // cursor in the first.
    markMissing(fields) {
        this.clearMissing();
        for (const field of fields) {
            d3.select(REQUIRED_SELECTOR[field]()).classed('is-missing', true);
        }
        const first = document.querySelector(REQUIRED_SELECTOR[fields[0]]());
        (first?.matches('input, select') ? first : first?.querySelector('button'))?.focus();
    }

    clearMissing() {
        d3.selectAll('#log .is-missing').classed('is-missing', false);
    }

    // Everyone already in this sitting who is not already on the row --
    // seats included, since a person moves between a seat and Others? as the
    // ensemble changes. Tapping one brings the instrument they were last
    // logged on, so the second sextet costs one tap per extra player.
    renderSessionPeople() {
        const carried = this.carried();
        const taken = new Set([
            ...SEATS.map(f => stripParens(this.entry[f].trim() || carried[f])),
            ...this.otherRows.map(r => r.name.trim()),
            // Every name in the freeform box, not splitOthersCell's `rows`:
            // that view drops exactly the entries carrying a comment, which
            // are the ones the box holds. sessionPeople offers those people
            // (parseOthers keeps the person and discards only the comment), so
            // a chip would claim someone is not on a row they are already on,
            // and tapping it writes them in a second time.
            ...parseOthersRows(this.othersFree).map(r => r.name),
        ].filter(Boolean));

        d3.select('#logOthersHere').selectAll('.log-chip-btn')
            .data(sessionPeople(this.sessionSource()).filter(p => !taken.has(p.name)), d => d.name)
            .join('button')
            .attr('type', 'button')
            .attr('class', 'log-chip-btn log-chip-btn--here')
            .text(d => `+ ${d.name}`)
            .on('click', (_, d) => this.setOtherRows([...this.otherRows, this.newOtherRow(d)]));
    }

    /**
     * Start a piece with the sitting's extras. A TRANSITION, not a render:
     * doing it inside renderFields meant any repaint re-seeded the cell, so
     * removing someone and then tapping a composer chip brought them back and
     * submitted them. Called only where a new piece actually begins.
     */
    // Every mutation routes through here, so the thing on screen is never more
    // than one keystroke ahead of what a reload would restore.
    touch() {
        // Log Out reloads the page, and a reload fires `pagehide` — which is
        // wired here and would write the draft straight back out after
        // discard() removed it. The e2e caught exactly that.
        if (this.discarded) return;
        store.saveDraft({
            entry: this.entry,
            slotPartOverrides: this.slotPartOverrides,
            otherRows: this.otherRows,
            othersFree: this.othersFree,
            expandComposer: this.expandComposer,
        });
    }

    /**
     * Log Out: forget everything this device holds for the form. The queue,
     * the sitting and the draft all carry player names, so leaving them would
     * make "log out before sharing your screen" untrue, and a form config left
     * behind would point the next person's entries at this person's
     * spreadsheet — the misdirected write the per-user config exists to stop.
     */
    discard() {
        this.discarded = true;
        this.done = null;
        clearFormConfig();
        store.clearAll();
    }

    /**
     * Pick the form back up where it was left, or start a fresh piece.
     * An installed PWA is evicted from memory whenever the phone decides to,
     * and a half-entered piece that lives only in a field is one the user
     * loses by putting the phone down.
     */
    restoreDraft() {
        const draft = store.readDraft();
        if (!draft) return this.seedOthers();
        this.entry = blankEntry(draft.entry);
        this.slotPartOverrides = draft.slotPartOverrides ?? [null, null, null];
        this.othersFree = draft.othersFree ?? '';
        this.expandComposer = !!draft.expandComposer;
        this.otherRows = (draft.otherRows ?? []).map(r => this.newOtherRow(r));
        // newOtherRow spreads `...row` last, so a restored row keeps its saved
        // id while the counter has only advanced once per row. Remove some
        // rows before the eviction and the saved ids are sparse and ahead of
        // it, so the next Add person mints one already on screen —
        // renderOtherRows joins on `d.id`, so that row never appears while
        // syncOthers still submits it: an invisible extra player.
        this._otherId = Math.max(this._otherId, ...this.otherRows.map(r => r.id ?? 0));
    }

    seedOthers() {
        const { rows, freeform } = splitOthersCell(this.defaultOthersCell());
        this.othersFree = freeform;
        this.setOtherRows(rows);
    }

    newOtherRow(row = {}) {
        return { id: ++this._otherId, name: '', instrument: '', comment: '', ...row };
    }

    setOtherRows(rows) {
        this.otherRows = rows.map(r => (r.id ? r : this.newOtherRow(r)));
        this.syncOthers();
        this.renderOtherRows();
    }

    // The cell is derived from the rows. Nothing writes back into them while
    // the user is typing, so a background revalidate cannot move a caret.
    syncOthers() {
        this.entry.others = mergeOthersCell(this.otherRows, this.othersFree);
        this.touch();
        this.renderSessionPeople();
    }

    renderOtherRows() {
        d3.select('#logOthersRows').selectAll('.log-other-row')
            .data(this.otherRows, d => d.id)
            .join(enter => {
                const row = enter.append('div').attr('class', 'log-other-row');
                row.append('input')
                    .attr('type', 'text').attr('list', 'logPlayers')
                    .attr('placeholder', 'Name')
                    .attr('aria-label', 'Other player')
                    // Same reason as every other name field: iOS "fixing" a
                    // surname is the failure this view exists to avoid.
                    .attr('autocapitalize', 'words').attr('autocorrect', 'off')
                    .attr('spellcheck', 'false')
                    .property('value', d => d.name)
                    .on('input', (e, d) => { d.name = e.target.value; this.syncOthers(); });
                const select = row.append('select').attr('aria-label', 'Instrument');
                // A row stores the CODE the cell will hold; the option list is
                // keyed for display. Storing keys instead would mean two
                // representations of one thing, and a re-parse turns cell text
                // back into rows on every reset.
                select.on('change', (e, d) => {
                    const key = e.target.value;
                    d.instrument = SLOT_PARTS.find(p => p.key === key)?.code ?? key;
                    this.syncOthers();
                });
                row.append('button')
                    .attr('type', 'button').attr('class', 'log-other-drop')
                    .attr('aria-label', 'Remove this person').text('x')
                    .on('click', (_, d) => this.setOtherRows(this.otherRows.filter(r => r.id !== d.id)));
                return row;
            })
            .select('select')
            .each((d, i, nodes) => {
                // An instrument the option list can't express is offered as
                // itself, so an existing "(klavier)" round-trips rather than
                // being rewritten into the nearest thing we do know.
                const key = slotPartKey(d.instrument);
                const raw = d.instrument && !key ? [{ key: d.instrument, label: d.instrument }] : [];
                d3.select(nodes[i]).selectAll('option')
                    .data([{ key: '', label: 'part?' }, ...SLOT_PARTS, ...raw], o => o.key)
                    .join('option')
                    .attr('value', o => o.key)
                    .text(o => o.label);
                nodes[i].value = key ?? d.instrument ?? '';
            });
    }

    renderSuggestions() {
        d3.select('#logPlayers').selectAll('option')
            .data(knownPlayers(this.rows)).join('option').attr('value', d => d);
        d3.select('#logLocations').selectAll('option')
            .data(knownLocations(this.rows)).join('option').attr('value', d => d);
    }

    renderPending() {
        const queued = store.pending();
        const box = d3.select('#logPending').property('hidden', queued.length === 0);
        box.selectAll('.log-pending-title').data([queued.length]).join('p')
            .attr('class', 'log-pending-title')
            .text(n => `${n} waiting to send, in this order. The sheet timestamps them on arrival.`);
        box.selectAll('.log-pending-row')
            .data(queued, d => d.id)
            .join(enter => {
                const row = enter.append('div').attr('class', 'log-pending-row');
                row.append('span').attr('class', 'log-pending-what');
                row.append('button')
                    .attr('type', 'button').attr('class', 'log-pending-drop')
                    .attr('aria-label', 'Discard this entry').text('x')
                    // Both copies, or the discarded piece goes on steering
                    // carry-forward from the sitting for 12 hours as a row the
                    // sheet will never hold.
                    .on('click', (_, d) => {
                        store.drop(d.id);
                        store.forgetRecent(d.entry);
                        this.renderPending();
                        this.redrawFromData();
                    });
                return row;
            })
            .select('.log-pending-what')
            .text(d => `${d.entry.composer} ${d.entry.title} - ${ago(Date.now() - d.at)}`);
    }

    /**
     * The line under the button, and whether it has more to say.
     * @param {string} text @param {string} [kind] @param {string} [help]
     *   a STATUS_HELP key; the (i) and its panel are hidden without one.
     */
    status(text, kind = '', help = '') {
        d3.select('#logStatus').text(text).attr('class', `log-status ${kind}`);
        // Collapsed on every new message: the open panel belongs to the state
        // that was on screen when it was opened, not to whatever replaced it.
        d3.select('#logStatusInfo')
            .property('hidden', !STATUS_HELP[help])
            .attr('aria-expanded', 'false');
        d3.select('#logStatusHelp').text(STATUS_HELP[help] ?? '').property('hidden', true);
    }

    /**
     * The confirmation screen, from the receipt taken at submit time plus the
     * data as it stands now — which is what lets a dot fill in under the
     * reader rather than only on the next visit.
     */
    renderDone() {
        const { entry, at, seats, others, warn } = this.done;
        // The queue as it stands, not as it stood at submit time: `online`
        // fires while this screen is up and drains it, and the note would go
        // on claiming the piece was held on the device after it had gone.
        const waiting = store.pending().length;
        // Written only when it changes: this is a live region, and
        // redrawFromData repaints it on every revalidate — setting the same
        // text back still replaces the node, which would re-announce the piece
        // every five minutes to the one reader who cannot dismiss it.
        const what = `${entry.composer} ${entry.title}`.trim();
        const heading = d3.select('#logDoneWhat');
        if (heading.text() !== what) heading.text(what);
        // Who was on what, as the row records it: the user's own part is
        // implicit in the sheet (no slot holds it), so it is named first.
        d3.select('#logDoneWho').text([
            `You ${entry.part}`,
            ...seats.map(p => `${p.name} ${p.part}`),
            ...others.map(o => (o.instrument ? `${o.name} ${o.instrument}` : o.name)),
        ].join(' \u00b7 '));
        d3.select('#logDoneWhere').text([entry.location, timeOfDay(at)].filter(Boolean).join(' \u00b7 '));

        const { pieces, tiles } = this.doneStats();
        // Newest first: the piece just logged is the one being confirmed, and
        // scanning down is scanning back through the evening.
        const list = [...pieces].reverse();
        d3.select('#logDoneSitting').text(list.length === 1
            ? 'First piece this sitting'
            : `${list.length} pieces this sitting`);
        d3.select('#logDoneList').selectAll('.log-done-row')
            .data(list, d => `${+d.timestamp}|${d.composer}|${d.title}|${d.part}`)
            .join(enter => {
                const row = enter.append('div');
                // App-authored constant markup, no data in it.
                row.append('span').attr('class', 'log-done-dot')
                    .html('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
                    + ' stroke-width="4" stroke-linecap="round" stroke-linejoin="round">'
                    + '<path d="M5 13l4 4L19 7"></path></svg>');
                row.append('span').attr('class', 'log-done-when');
                row.append('span').attr('class', 'log-done-piece');
                return row;
            })
            .call(row => {
                // The newest row is the subject; the rest are context.
                row.attr('class', (d, i) => `log-done-row${i ? ' log-done-row--past' : ''}`);
                // Shape as well as colour — a tick inside the filled one, an
                // empty ring otherwise — plus the label a reader hears.
                row.select('.log-done-dot')
                    .attr('class', d => `log-done-dot log-done-dot--${d.landed ? 'landed' : 'waiting'}`)
                    .attr('title', d => (d.landed ? 'Showing in your charts' : 'Not in your charts yet'))
                    .attr('aria-label', d => (d.landed ? 'Showing in your charts' : 'Not in your charts yet'));
                row.select('.log-done-when').text(d => timeOfDay(d.timestamp));
                row.select('.log-done-piece').html(null)
                    .text(d => `${d.composer} ${d.title}`.trim())
                    .append('span').attr('class', 'log-done-part').text(d => ` \u00b7 ${d.part}`);
            });

        const cells = d3.select('#logDoneTiles').selectAll('.stat-tile')
            .data(tiles, d => d.label)
            .join(enter => {
                const cell = enter.append('div').attr('class', 'stat-tile');
                const label = cell.append('span').attr('class', 'stat-tile-label');
                // Both labels, one shown per width by CSS — the same swap the
                // calendar's stats row makes, and no width read in JS.
                label.append('span').attr('class', 'stat-tile-label--long');
                label.append('span').attr('class', 'stat-tile-label--short');
                cell.append('span').attr('class', 'stat-tile-value');
                cell.append('span').attr('class', 'stat-tile-delta');
                return cell;
            });
        cells.select('.stat-tile-label--long').text(d => d.label);
        cells.select('.stat-tile-label--short').text(d => d.short);
        cells.select('.stat-tile-value').text(d => d.value);
        cells.select('.stat-tile-delta')
            .attr('class', d => `stat-tile-delta${d.delta ? '' : ' stat-tile-delta--flat'}`)
            .text(d => `+${d.delta}`);
        // The same explainer the dashboard and the ALL tab hang on these
        // tiles; "Unique parts" is not self-evident anywhere it appears.
        tooltip.attach(cells, (event, d) => `<h4>${d.title}</h4><p>${d.desc}</p>`,
            { maxWidth: '320px' });

        d3.select('#logDoneWarn').text(warn.join(' ')).property('hidden', !warn.length);
        d3.select('#logDoneNote').text(waiting
            ? `${waiting} ${waiting === 1 ? 'piece is' : 'pieces are'} held on this device, `
              + 'waiting for a connection. They are sent automatically, in the order you logged '
              + 'them, and reach your sheet then.'
            : 'It is in your Google Sheet already \u2014 this page writes through your form. The '
              + 'calendar and charts here read a published copy of that sheet, which Google '
              + 'refreshes every few minutes, so the hollow dot fills in shortly.');
    }

    /**
     * The sitting, and what it has done to the log's totals.
     *
     * Two measurements, not one. The TOTAL has to count the submissions the
     * published sheet has not caught up with, or the tiles would sit under a
     * confirmation quietly disagreeing with it for the next few minutes —
     * which is the confusion this screen exists to end. The DELTA is measured
     * against the log as it stood before the sitting began, so "Unique +1"
     * means a work that was new tonight rather than one logged twice.
     */
    doneStats() {
        const submissions = store.recentAll();
        // setRecent said no, so this piece is in neither half of the sitting.
        // It is still a piece of it, and the receipt is the only record left.
        if (this.done && !this.done.remembered) {
            submissions.push({ at: this.done.at, entry: this.done.entry });
        }
        const pieces = sessionPieces(this.rows, submissions);
        const agg = computeAggregateStats(this.rows);
        const unpublished = countNew(pieces.filter(p => !p.landed), this.rows);
        const start = pieces[0]?.timestamp;
        const before = start ? this.rows.filter(d => d.timestamp < start) : this.rows;
        const added = countNew(pieces, before);
        const totals = {
            ...agg,
            pieces: agg.pieces + unpublished.pieces,
            uniquePieces: agg.uniquePieces + unpublished.uniquePieces,
            uniqueParts: agg.uniqueParts + unpublished.uniqueParts,
            uniquePeople: agg.uniquePeople + unpublished.uniquePeople,
        };
        // The shared defs carry the label, the short label and the tooltip
        // copy, so these tiles cannot drift from the dashboard's.
        const defs = buildAggregateStatDefs(totals, 'in your whole log');
        const deltas = [added.pieces, added.uniquePieces, added.uniqueParts, added.uniquePeople];
        return {
            pieces,
            tiles: defs.slice(0, DONE_TILES).map((d, i) => ({ ...d, delta: deltas[i] })),
        };
    }

    async flushQueue() {
        // Nothing can be sent without knowing where to; the entries keep.
        if (!this.config || !store.pending().length) return;
        const { sent, remaining } = await store.flush(e => postEntry(e, this.config));
        this.renderPending();
        // The confirmation's note counts the queue, so it moves when this does.
        if (this.done) this.renderDone();
        // A queue that is still draining is the other state worth explaining:
        // what is left, why the order matters, and that nothing is lost.
        if (sent) {
            this.status(remaining ? `Sent ${sent}; ${remaining} still waiting.` : `Sent ${sent}.`,
                'ok', remaining ? 'queued' : '');
        }
    }

    async submit() {
        if (!this.config) return;   // the form is hidden without one
        const missing = missingFields(this.entry);
        if (missing.length) {
            this.status(`Still needs: ${missing.map(f => LABELS[f]).join(', ')}.`, 'error');
            this.markMissing(missing);
            return;
        }
        const carried = this.carried();
        const implied = impliedSlotParts(this.entry.part);
        const chosen = this.slotParts();
        // Names and parts are two controls; the sheet has one cell. A part
        // changed on a blank seat materialises the carried name here, which is
        // the retyping this whole control replaces.
        const entry = { ...this.entry };
        SEATS.forEach((field, i) => {
            entry[field] = slotCell({
                typed: this.entry[field], carried: carried[field],
                chosen: chosen[i], implied: implied[i],
            });
        });
        // Resolve the blanks against what they ditto BEFORE advancing, so the
        // next piece of this session carries forward from what this row will
        // hold rather than from the row above it.
        const resolved = resolveCarry(entry, carried);

        // Always through the queue, even online: anything already waiting has
        // to reach the sheet first, since fillForward reads each row against
        // the one above it and a jumped queue points a blank seat at the wrong
        // previous row.
        const queued = store.enqueue(entry);
        const button = d3.select('#logSubmit').property('disabled', true);
        await store.flush(e => postEntry(e, this.config));
        // A browser that won't write localStorage (private-mode Safari, a full
        // quota) drops the entry on the floor: flush re-reads storage, finds
        // nothing, and reports a clean run for a piece that never left the
        // device. Send it from here instead — after the flush, so anything
        // that DID persist still reaches the sheet first — and let a transport
        // failure be a failure the user is told about, since there is no queue
        // to hold it and no later attempt coming.
        let lost = false;
        if (!queued) {
            try { await postEntry(entry, this.config); }
            catch { lost = true; }
        }
        button.property('disabled', false);
        if (lost) {
            // No confirmation screen for this one: the piece is still in the
            // fields above, which is where it has to be picked up from, and
            // replacing the form would take it off the screen.
            this.status(`Couldn't send ${entry.composer} ${entry.title}, and this browser won't `
                + 'let the app keep it for later.', 'error', 'lost');
            return;
        }

        // Whether the sitting record took it. A browser refusing localStorage
        // drops it silently, and doneStats builds the whole sitting from that
        // record — so without this the confirmation would greet a successful
        // submit with "0 pieces this sitting" and an empty list.
        const remembered = store.setRecent(resolved);
        // The sitting just changed: the memoised carry and session sources
        // below feed seedOthers and refresh, and a stale one would start the
        // next piece from the row before this one.
        this.invalidateSources();
        // The receipt, as sent. Taken here rather than re-derived when it is
        // drawn: `chosen` and `implied` describe the controls that were on
        // screen for THIS piece, and one line below they start describing the
        // next one.
        this.done = {
            entry: resolved,
            at: Date.now(),
            seats: SEATS.map((field, i) => ({
                name: (stripParens(resolved[field]) ?? '').trim(),
                part: chosen[i] ?? implied[i],
            })).filter(p => p.name && p.name !== '-'),
            others: parseOthersRows(resolved.others),
            remembered,
            // The only warning there is says the sheet will keep this row and
            // this app will hide it — so it belongs on the screen that is
            // otherwise about to show a sitting the piece is missing from.
            warn: warnings(entry),
        };
        this.entry = nextInSession(entry);
        // The parts the row just set become the next row's defaults, via the
        // carried cell — an override kept here would shadow them.
        this.slotPartOverrides = [null, null, null];
        store.clearDraft();
        this.seedOthers();
        this.refresh();
        // The next piece is already prepared behind the confirmation, so the
        // cursor goes to the way back to it rather than into a hidden field.
        d3.select('#logDoneNext').node()?.focus();

        // The line under the button is behind the confirmation now, and every
        // message it would carry is on there instead. Clear it so the next
        // piece does not open under the last one's.
        this.status('');
    }
}
