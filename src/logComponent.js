import * as d3 from "d3";
import { composerWorkIndex } from './catalog.js';
import {
    CHOICES, postEntry, readPrefilledLink, getFormConfig, setFormConfig,
    clearFormConfig,
} from './formConfig.js';
import * as store from './logStore.js';
import {
    blankEntry, carriedForward, resolveCarry, missingFields,
    warnings, knownPlayers, knownLocations, nextInSession, frequentComposers,
    impliedSlotParts, defaultSlotParts, slotCell, SLOT_PARTS, FIELDS, LABELS,
    splitOthersCell, mergeOthersCell, sessionPeople, sessionRows, slotPartKey,
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

// The name half of a cell that may carry an "(instrument)" annotation.
const stripAnnotation = (/** @type {string} */ cell) =>
    (cell ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();

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

// Enough of a form id to tell two apart without printing the whole thing.
const shortId = (/** @type {string} */ id) => `...${id.slice(-6)}`;

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
        // One editable row per Others? entry. The cell text is derived from
        // these (syncOthers), never the other way round while editing.
        this.otherRows = [];
        this.othersFree = '';
        this._otherId = 0;
        // A ?form= link that would replace this.config, awaiting a decision.
        this.proposed = null;
        this.mounted = false;
    }

    // Called on every data change (boot, revalidate). The form never depends
    // on this: with no cached data the datalists are empty and every field
    // still works, which is what a first launch offline gets.
    setData(rows) {
        this.rows = rows ?? [];
        // Deliberately NOT a full refresh: a background revalidate lands every
        // five minutes and writing the entry back into the inputs would move
        // the caret out from under whoever is mid-name. Only the parts driven
        // by the data are redrawn.
        if (this.mounted) {
            this.renderSuggestions();
            this.renderPlaceholders();
            this.renderSlotParts();
            this.renderSessionPeople();
        }
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
            // Coming back from a dead zone is the moment the queue can drain.
            window.addEventListener('online', () => this.flushQueue());
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
            d3.select('#logSetupLink').property('value', '');
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

    // Exactly one of: the pending-proposal prompt, the form, the setup panel.
    // A proposal outranks both, so where entries go can't be changed — or
    // logged against — until it has been answered.
    renderMode() {
        const deciding = !!this.proposed;
        d3.select('#logProposal').property('hidden', !deciding);
        if (deciding) this.renderProposal();
        d3.select('#logForm').property('hidden', deciding || !this.config);
        d3.select('#logSetup').property('hidden', deciding || !!this.config);
        d3.select('#logFormId').text(this.config ? shortId(this.config.formId) : '');
        this.renderPending();
    }

    // The view just became visible: retry anything queued.
    notifyShown() {
        if (this.mounted) this.flushQueue();
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
        const chips = frequentComposers(this.rows);
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
        select.selectAll('option').remove();
        select.append('option').attr('value', '').text('Composer...');
        select.selectAll('option.log-composer-option')
            .data(Object.keys(this.works).sort())
            .join('option')
            .attr('class', 'log-composer-option')
            .attr('value', d => d)
            .text(d => d);
        select.append('option').attr('value', OTHER_COMPOSER).text('Other...');

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
            this.renderComposerChips();
            this.renderWorkOptions();
        });
        d3.select('#logComposerOther').on('input', (e) => {
            this.entry.composer = e.target.value;
            this.renderWorkOptions();
        });
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
            .data(CHOICES.part)
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
        const defaults = defaultSlotParts(carriedForward(this.carrySource()), this.entry.part);
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

    // The session, as this device knows it: the fetched rows plus whatever was
    // submitted here since. Without the local half, the people from the piece
    // you logged two minutes ago would not be offered back until the published
    // CSV caught up -- which is precisely the window a session happens in.
    sessionSource() {
        // Every submission this device remembers, not just the newest: a
        // sitting logs several pieces inside the window the published CSV
        // takes to catch up, and someone who left after the second piece
        // should still be offered back for the fourth.
        return [...this.rows, ...store.recentAll().map(({ at, entry }) => ({
            // The real save time, not now: a submission from this morning is
            // not part of this afternoon's sitting.
            timestamp: new Date(at),
            player1: stripAnnotation(entry.player1),
            player2: stripAnnotation(entry.player2),
            player3: stripAnnotation(entry.player3),
            others: entry.others,
            othersList: splitOthersCell(entry.others).rows
                .map(r => ({ name: r.name, instrument: r.instrument })),
        }))];
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
        return sessionRows(this.sessionSource()).at(-1)?.others ?? '';
    }

    // The row the sheet will read this one against. A submission this device
    // made minutes ago beats the fetched data, which lags by however long the
    // published CSV takes to catch up.
    carrySource() {
        const last = this.rows.at(-1) ?? null;
        return store.recent(last)?.entry ?? last;
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
        const onAChip = frequentComposers(this.rows).includes(this.entry.composer);
        const showPicker = this.expandComposer || (!!this.entry.composer && !onAChip);
        // A composer the catalog doesn't list is held in the Other input, and
        // the select has to show that rather than silently falling back to its
        // blank option while the name sits visible underneath it.
        const listed = this.entry.composer in this.works;
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
        const carried = carriedForward(this.carrySource());
        for (const field of CARRIED_INPUTS) {
            d3.select(TEXT_INPUTS[field]).attr('placeholder', carried[field] || 'nobody yet');
        }
    }

    // Two situations, two sentences. Connecting a first form and replacing a
    // working one carry different risk, and "Keep mine" is nonsense when there
    // is nothing to keep. Set as text, never markup.
    renderProposal() {
        const id = shortId(this.proposed.formId);
        const replacing = !!this.config;
        d3.select('#logProposalText').text(replacing
            ? `This link points your log at a different Google Form, ${id}, replacing `
                + `${shortId(this.config.formId)}. Everything you log would go to that `
                + `form's spreadsheet instead of yours.`
            : `This link would connect your log to Google Form ${id}. Everything you log `
                + `goes to that form's spreadsheet, so only accept it if the form is yours.`);
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
        const carried = carriedForward(this.carrySource());
        const taken = new Set([
            ...SEATS.map(f => stripAnnotation(this.entry[f].trim() || carried[f])),
            ...this.otherRows.map(r => r.name.trim()),
            ...splitOthersCell(this.othersFree).rows.map(r => r.name),
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
        store.saveDraft({
            entry: this.entry,
            slotPartOverrides: this.slotPartOverrides,
            otherRows: this.otherRows,
            othersFree: this.othersFree,
            expandComposer: this.expandComposer,
        });
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
                    .on('click', (_, d) => { store.drop(d.id); this.renderPending(); });
                return row;
            })
            .select('.log-pending-what')
            .text(d => `${d.entry.composer} ${d.entry.title} - ${ago(Date.now() - d.at)}`);
    }

    status(text, kind = '') {
        d3.select('#logStatus').text(text).attr('class', `log-status ${kind}`);
    }

    async flushQueue() {
        // Nothing can be sent without knowing where to; the entries keep.
        if (!this.config || !store.pending().length) return;
        const { sent, remaining } = await store.flush(e => postEntry(e, this.config));
        this.renderPending();
        if (sent) this.status(remaining ? `Sent ${sent}; ${remaining} still waiting.` : `Sent ${sent}.`, 'ok');
    }

    async submit() {
        if (!this.config) return;   // the form is hidden without one
        const missing = missingFields(this.entry);
        if (missing.length) {
            this.status(`Still needs: ${missing.map(f => LABELS[f]).join(', ')}.`, 'error');
            this.markMissing(missing);
            return;
        }
        const carried = carriedForward(this.carrySource());
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
        store.enqueue(entry);
        const button = d3.select('#logSubmit').property('disabled', true);
        const { remaining } = await store.flush(e => postEntry(e, this.config));
        button.property('disabled', false);

        store.setRecent(resolved);
        this.entry = nextInSession(entry);
        // The parts the row just set become the next row's defaults, via the
        // carried cell — an override kept here would shadow them.
        this.slotPartOverrides = [null, null, null];
        store.clearDraft();
        this.seedOthers();
        this.refresh();
        // Straight to the next piece: composer, part and the seats all carry,
        // so the work title is the only thing left to type.
        d3.select('#logTitle').node()?.focus();

        // Name what went in. The response is opaque, so this line is the only
        // acknowledgement a submit ever gets, and "Logged." alone cannot be
        // told apart from the previous piece's "Logged."
        const what = `${entry.composer} ${entry.title}`;
        const notes = warnings(entry).join(' ');
        this.status(remaining
            ? `${what} saved. ${remaining} waiting for a network. ${notes}`.trim()
            : `Logged ${what}. It reaches the app within a few minutes. ${notes}`.trim(),
        remaining ? '' : 'ok');
    }
}
