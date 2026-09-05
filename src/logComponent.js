import * as d3 from "d3";
import { composerWorkIndex } from './catalog.js';
import {
    CHOICES, postEntry, readPrefilledLink, getFormConfig, setFormConfig,
    clearFormConfig,
} from './formConfig.js';
import * as store from './logStore.js';
import {
    blankEntry, carriedForward, resolveCarry, othersReminder, missingFields,
    warnings, knownPlayers, knownLocations, nextInSession, frequentComposers,
    FIELDS, LABELS,
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
    others: '#logOthers',
    location: '#logLocation',
    comments: '#logComments',
};

const CARRIED_INPUTS = ['player1', 'player2', 'player3', 'location'];

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
            this.renderOthersChip();
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
            });
    }

    wireFields() {
        for (const [field, sel] of Object.entries(TEXT_INPUTS)) {
            d3.select(sel).on('input', (e) => {
                this.entry[field] = e.target.value;
                if (field === 'others') this.renderOthersChip();
                this.clearMissing();
            });
        }
        d3.select('#logOthersRepeat').on('click', () => {
            this.entry.others = d3.select('#logOthersRepeat').attr('data-value');
            d3.select('#logOthers').property('value', this.entry.others);
            this.renderOthersChip();
        });
    }

    // The row the sheet will read this one against. A submission this device
    // made minutes ago beats the fetched data, which lags by however long the
    // published CSV takes to catch up.
    carrySource() {
        const last = this.rows.at(-1) ?? null;
        return store.recent(last) ?? last;
    }

    refresh() {
        this.renderFields();
        this.renderPlaceholders();
        this.buildPartButtons();
        this.renderWorkOptions();
        this.renderSuggestions();
        this.renderOthersChip();
        this.renderMode();
    }

    renderFields() {
        for (const [field, sel] of Object.entries(TEXT_INPUTS)) {
            d3.select(sel).property('value', this.entry[field]);
        }
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

    renderSuggestions() {
        d3.select('#logPlayers').selectAll('option')
            .data(knownPlayers(this.rows)).join('option').attr('value', d => d);
        d3.select('#logLocations').selectAll('option')
            .data(knownLocations(this.rows)).join('option').attr('value', d => d);
    }

    renderOthersChip() {
        const repeat = othersReminder(this.entry, this.carrySource());
        d3.select('#logOthersRepeat')
            .property('hidden', !repeat)
            .attr('data-value', repeat)
            .text(repeat ? `Still playing? ${repeat}` : '');
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
        const entry = { ...this.entry };
        // Resolve the blanks against what they ditto BEFORE advancing, so the
        // next piece of this session carries forward from what this row will
        // hold rather than from the row above it.
        const resolved = resolveCarry(entry, carriedForward(this.carrySource()));

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
