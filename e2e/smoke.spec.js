// Boot smoke test: serve the built app, intercept the published-Google-Sheet
// fetch with a fixture CSV, and assert the three views actually render.
// Fixture names are placeholders (repo convention — never real names).
import { test, expect } from '@playwright/test';

// Must satisfy urlConfig.isValidGoogleSheetsUrl; the request never leaves
// the browser (route interception below).
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/FIXTURE-E2E/pub?gid=0&single=true&output=csv';

// Raw published-sheet shape (the headers processRow expects). Dates are
// relative to "now" so every row lands inside the default 1Y date filter.
// Includes a partial movement (":I") that the pipeline must filter out.
const day = (daysAgo, time) => {
    const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${time}`;
};
const FIXTURE_CSV = [
    'Timestamp,Composer,Work Title,Which Part,Player 1,Player 2,Player 3,Others?,Location,Comments',
    // A year-old row so the calendar grid spans a real range (the calendar
    // renders from the earliest data point; the 1Y Home/Dashboard filters
    // exclude this row from the KPI counts below).
    `${day(370, '19:00:00')},Mozart,465,V1,Alice,Bob,Carol,,Home,`,
    `${day(9, '19:00:00')},Haydn,20#2,V1,Alice,Bob,Carol,,Home,fun`,
    `${day(9, '20:00:00')},Mozart,421,V1,Alice,Bob,Carol,,Home,`,
    `${day(8, '19:00:00')},Haydn,76#3,V2,Dave,Erin,Frank Vandermeer,Grace (piano),Hall,`,
    `${day(7, '19:00:00')},Beethoven,18#4,VA,Alice,Dave,Carol,,Home,`,
    `${day(7, '19:30:00')},Haydn,64#5:I,VA,,,,,Home,partial movement — must be filtered`,
    // Frank carries a surname while everyone else is a bare first name: it's
    // the one name too wide for the ranked charts' name gutter, which is what
    // the narrow-viewport test below measures. Counts are unaffected.
    // 20#2 again on a NEW part, then a REPEAT of that (work, part), so the
    // in-window Pieces (6) / Unique pieces (4) / Unique parts (5) KPIs are
    // three different numbers — a tile wired to the wrong agg field can't
    // render identically.
    `${day(6, '19:00:00')},Haydn,20#2,VA,Alice,Dave,Carol,,Home,`,
    `${day(5, '19:00:00')},Haydn,20#2,VA,Alice,Dave,Carol,,Home,`,
].join('\n');

test.beforeEach(async ({ page }) => {
    // Anchored to the sheet ORIGIN — a bare '**docs.google.com**' glob would
    // also match our own page URL, whose ?data= query contains the hostname.
    await page.route('https://docs.google.com/**', route => route.fulfill({
        contentType: 'text/csv',
        body: FIXTURE_CSV,
    }));
    await page.goto(`/?data=${encodeURIComponent(SHEET_URL)}`);
    // Boot is done when the status line reports the fetch.
    await expect(page.locator('#update')).toContainText(/Data updated/, { timeout: 15000 });
});

test('main view renders composer tabs with a singular UI', async ({ page }) => {
    const tabs = page.locator('#tabs button');
    await expect(tabs.first()).toBeVisible();
    const labels = await tabs.allTextContents();
    // Composer tabs + the ALL tab, and no duplicates (the idempotent
    // re-init contract: a rebuild must never stack a second tab strip).
    expect(labels.length).toBeGreaterThan(5);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain('ALL');
    // Exactly one Part button group on Home. Scoped to #radioButtons because
    // the log form has a part group of its own; the contract being pinned is
    // that a rebuild doesn't stack a second one HERE.
    await expect(page.locator('#radioButtons .part-buttons')).toHaveCount(1);
    // The fixture's Haydn plays show up as play squares somewhere on Home.
    await expect(page.locator('#Haydn .play-square').first()).toBeVisible();
});

test('calendar view renders the year grid', async ({ page }) => {
    await page.evaluate(() => { window.location.hash = '#calendar'; });
    await expect(page.locator('#calendar')).toBeVisible();
    // A year of day cells (300+ rects) proves the grid actually rendered.
    expect(await page.locator('#calendar svg rect').count()).toBeGreaterThan(300);
});

test('dashboard view renders KPI tiles and charts', async ({ page }) => {
    await page.evaluate(() => { window.location.hash = '#dashboard'; });
    await expect(page.locator('#dashboard')).toBeVisible();
    await expect(page.locator('#dashboardStats .stat-tile')).toHaveCount(6);
    // Whole in-window pieces only (partial movement + year-old row excluded);
    // the fixture makes the first three KPIs pairwise distinct (see its
    // comment), so each asserts its own wiring.
    const tiles = page.locator('#dashboardStats .stat-tile');
    await expect(tiles.nth(0)).toContainText('6'); // Pieces
    await expect(tiles.nth(1)).toContainText('4'); // Unique pieces
    await expect(tiles.nth(2)).toContainText('5'); // Unique parts
});

test('dashboard musician names stay inside the chart at a narrow width', async ({ page }) => {
    // The row name is right-anchored inside a fixed left margin (96px on
    // mobile) and the <svg> clips, so a name wider than the margin used to
    // run off the left edge with no indication. This also pins the wiring
    // the fix depends on: the first dashboard render happens while
    // #dashboard is still display:none, where every getComputedTextLength()
    // is 0, every name "fits" and the chart is the old overflowing one —
    // correctness rests on notifyShown() re-rendering at the real width. A
    // regression there is invisible to the unit tests, because the fallback
    // IS the pre-fix rendering.
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => { window.location.hash = '#dashboard'; });
    await expect(page.locator('#dashboard')).toBeVisible();
    const chart = page.locator('#dashboardMusicianChart');
    await expect(chart.locator('svg')).toBeVisible();

    const svgBox = await chart.locator('svg').boundingBox();
    const lefts = await chart.locator('text.ranked-name')
        .evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().left));
    expect(lefts.length).toBeGreaterThan(0);
    lefts.forEach(left => expect(left).toBeGreaterThanOrEqual(svgBox.x));

    // The one over-wide name is shortened, and keeps the full name in a
    // <title>. Reading firstChild skips that <title>'s own text.
    const labels = await chart.locator('text.ranked-name').evaluateAll(nodes =>
        nodes.map(n => ({ shown: n.firstChild?.nodeValue, full: n.querySelector('title')?.textContent })));
    expect(labels.filter(l => l.full)).toEqual([{ shown: 'Frank', full: 'Frank Vandermeer' }]);
});

// The log form. Unit tests cover the model (test/logEntry.test.mjs), the
// transport (test/formConfig.test.mjs) and the outbox
// (test/logStore.test.mjs); what only a browser can pin is the wiring between
// them and the request that actually leaves the page.
//
// Obviously-fake entry ids: nothing in the repo carries a real form's, since
// the config is per-user and there is no default (see src/formConfig.js).
const FORM_ID = 'FIXTURE-FORM-E2E';
const FORM_IDS = ['101', '102', '103', '104', '105', '106', '107', '108', '109'];
const PREFILL = `https://docs.google.com/forms/d/e/${FORM_ID}/viewform?usp=pp_url&`
    + FORM_IDS.map((id, i) => `entry.${id}=v${i}`).join('&');
const [COMPOSER_ID, TITLE_ID, PART_ID, , PLAYER2_ID] = FORM_IDS.map(id => `entry.${id}`);
const PLAYER1_ID = 'entry.104';
const PLAYER3_ID = 'entry.106';
const OTHERS_ID = 'entry.107';

test('an unconfigured visitor gets the setup panel, not someone else\'s form', async ({ page }) => {
    // The whole point of per-user config: this site is public, so a visitor
    // with their own sheet must never be handed a form that posts their rows
    // into a stranger's spreadsheet.
    await page.evaluate(() => { window.location.hash = '#log'; });
    await expect(page.locator('#logSetup')).toBeVisible();
    await expect(page.locator('#logForm')).toBeHidden();
    await expect(page.locator('#logSetupSave')).toBeDisabled();

    // The likeliest wrong paste is the sheet URL, and it gets its own sentence
    // — telling a copy-paste slip and a mismatched form the same thing sends
    // one of the two users off to re-paste forever.
    await page.fill('#logSetupLink', SHEET_URL);
    await expect(page.locator('#logSetupError')).toContainText('not a Google Forms link');
    await expect(page.locator('#logSetupSave')).toBeDisabled();

    // A link that isn't one field per column is refused rather than guessed
    // at — a shifted mapping writes every column one cell over.
    await page.fill('#logSetupLink', `https://docs.google.com/forms/d/e/${FORM_ID}/viewform?entry.1=a`);
    await expect(page.locator('#logSetupError')).toContainText('wrong number of fields');
    await expect(page.locator('#logSetupSave')).toBeDisabled();

    // A good one previews the mapping before committing to it, which is the
    // only moment a reordered-questions form can be caught.
    await page.fill('#logSetupLink', PREFILL);
    await expect(page.locator('#logSetupError')).toHaveText('');
    await expect(page.locator('.log-setup-row')).toHaveCount(9);
    await expect(page.locator('.log-setup-row').first()).toContainText('Composer');
    await expect(page.locator('.log-setup-row').first()).toContainText(COMPOSER_ID);

    await page.click('#logSetupSave');
    await expect(page.locator('#logForm')).toBeVisible();
    await expect(page.locator('#logSetup')).toBeHidden();
    await expect(page.locator('#logFormId')).toContainText('M-E2E');
    // The tail is a LINK to the form. Six characters of an id only answer "am
    // I writing to my own sheet" for someone who already knows their own id;
    // being able to open the form is what makes the footer checkable.
    const footer = page.locator('#logFormId a');
    await expect(footer).toHaveAttribute('href',
        `https://docs.google.com/forms/d/e/${FORM_ID}/viewform`);
    await expect(footer).toHaveAttribute('target', '_blank');
});

test('Change reopens an empty setup panel, not the old form mapping', async ({ page }) => {
    // Connecting hides the panel without resetting it, so Change brought it
    // back showing the DISCONNECTED form's columns under an empty box, beside
    // a Connect button that silently did nothing. Verifying that mapping is
    // the one thing this panel exists for, so a stale one is worse than none.
    await page.evaluate(() => { window.location.hash = '#log'; });
    await page.fill('#logSetupLink', PREFILL);
    await page.click('#logSetupSave');
    await expect(page.locator('#logForm')).toBeVisible();

    await page.click('#logChangeForm');
    await expect(page.locator('#logSetup')).toBeVisible();
    await expect(page.locator('#logSetupLink')).toHaveValue('');
    await expect(page.locator('.log-setup-row')).toHaveCount(0);
    await expect(page.locator('#logSetupSave')).toBeDisabled();
    await expect(page.locator('#logSetupError')).toHaveText('');
});

test('a link cannot connect a form to a fresh device without being asked', async ({ page }) => {
    // The case that matters most: a device with no form yet is every existing
    // user the day this ships. A silent-adopt branch here would leave the
    // one-click redirect open for exactly the people most likely to click it.
    const evil = `https://docs.google.com/forms/d/e/SOMEONE-ELSES-FORM/viewform?usp=pp_url&`
        + FORM_IDS.map((id, i) => `entry.${900 + i}=v${i}`).join('&');
    await page.goto(`/?data=${encodeURIComponent(SHEET_URL)}&form=${encodeURIComponent(evil)}`);
    await expect(page.locator('#update')).toContainText(/Data updated|from cache/, { timeout: 15000 });
    await page.evaluate(() => { window.location.hash = '#log'; });

    await expect(page.locator('#logProposal')).toBeVisible();
    // The copy names the risk rather than assuming a form is being replaced.
    await expect(page.locator('#logProposalText')).toContainText('only accept it if the form is yours');
    // ...and gives them the means to check, which a printed tail does not: the
    // id links to the form. In a NEW tab, because consumeFormParam has already
    // stripped ?form= from the address, so leaving this page would discard the
    // undecided proposal with no way back but the original link.
    const link = page.locator('#logProposalText a');
    await expect(link).toHaveAttribute('href',
        'https://docs.google.com/forms/d/e/SOMEONE-ELSES-FORM/viewform');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(page.locator('#logProposalReject')).toHaveText('Not now');
    await expect(page.locator('#logForm')).toBeHidden();
    await expect(page.locator('#logSetup')).toBeHidden();

    await page.click('#logProposalReject');
    // Declining leaves the device exactly as it was: unconfigured.
    await expect(page.locator('#logSetup')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('quartetlog_form'))).toBeNull();
});

test('the setup box takes a setup link, and still only proposes its form', async ({ page }) => {
    // A setup link is meant for the address bar, but it is URL-shaped and the
    // setup box is the first URL-shaped box a new device shows — so that is
    // where it gets pasted, and it used to be refused as "Invalid URL": the
    // app rejecting a link the app itself generated. The sheet half is read
    // out of it; the FORM half is still only proposed, because pasting a link
    // is no more a decision about where rows are sent than opening one is.
    const link = `/?data=${encodeURIComponent(SHEET_URL)}&form=${encodeURIComponent(PREFILL)}`;
    await page.evaluate(() => localStorage.clear());
    await page.goto('/');
    await expect(page.locator('#setupView')).toBeVisible({ timeout: 15000 });

    await page.fill('#dataUrlInput', new URL(link, page.url()).href);
    await page.click('#setupForm button[type="submit"]');
    await expect(page.locator('#update')).toContainText(/Data updated|from cache/, { timeout: 15000 });
    await expect(page.locator('#setupView')).toBeHidden();

    await page.evaluate(() => { window.location.hash = '#log'; });
    await expect(page.locator('#logProposal')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('quartetlog_form'))).toBeNull();
    await page.click('#logProposalAccept');
    await expect(page.locator('#logForm')).toBeVisible();
    await expect(page.locator('#logFormId')).toContainText('M-E2E');
});

// The chips and the picker are complements, and the set they are cut from is
// derived from the log -- so a background revalidate is the one thing that can
// move it under a form someone is filling in. setData deliberately re-renders
// neither (it never touches what the user might be typing into), which leaves
// the two views to be rebuilt together on the seams that do render. Nothing
// smaller than a real revalidate can show this, hence the fake clock: the
// poll is gated on staleness, so time has to actually pass.
test('the picker stays the chips\' complement across a background revalidate', async ({ page }) => {
    const NOW = new Date('2026-06-01T12:00:00Z');
    const on = (daysAgo) => {
        const d = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} 19:00:00`;
    };
    const plays = (composer, n, from) => Array.from({ length: n }, (_, i) =>
        `${on(from - i)},${composer},w${i},V1,Alice,Bob,Carol,,Home,`);
    // Six clear favourites, and a Debussy played once -- so it is in the
    // picker and not on a chip.
    const before = [
        'Timestamp,Composer,Work Title,Which Part,Player 1,Player 2,Player 3,Others?,Location,Comments',
        ...plays('Haydn', 5, 20), ...plays('Mozart', 4, 20), ...plays('Beethoven', 4, 20),
        ...plays('Brahms', 3, 20), ...plays('Bartok', 3, 20), ...plays('Schubert', 3, 20),
        ...plays('Debussy', 1, 20),
    ].join('\n');
    // The sitting was all Debussy: it overtakes Schubert, so one composer
    // joins the chips and one drops off them.
    const after = [before, ...plays('Debussy', 5, 10)].join('\n');

    await page.clock.install({ time: NOW });
    let body = before;
    await page.route('https://docs.google.com/**', route => route.fulfill({
        contentType: 'text/csv',
        body,
    }));
    await page.evaluate(() => localStorage.clear());
    await page.goto(`/?data=${encodeURIComponent(SHEET_URL)}&form=${encodeURIComponent(PREFILL)}`);
    await expect(page.locator('#update')).toContainText(/Data updated/, { timeout: 15000 });
    await page.evaluate(() => { window.location.hash = '#log'; });
    await page.click('#logProposalAccept');
    await expect(page.locator('#logForm')).toBeVisible();

    const chips = () => page.$$eval('#logComposerChips .log-chip-btn',
        ns => ns.map(n => n.textContent).filter(t => t !== 'More...'));
    const options = () => page.$$eval('#logComposer option',
        ns => ns.map(n => n.textContent).filter(t => t !== 'Composer...' && t !== 'Other...'));

    await page.click('#logComposerChips .log-chip-btn--more');
    const wasOnChips = await chips();
    expect(wasOnChips).toContain('Schubert');
    expect(await options()).toContain('Debussy');

    // The revalidate lands while the picker is open.
    body = after;
    await page.clock.runFor('06:00');
    await expect(page.locator('#update')).toContainText(/Data updated/, { timeout: 15000 });

    // ...and then a pick off that picker rebuilds the chips. Rebuilding only
    // those recomputes the set on one side of a complement.
    await page.selectOption('#logComposer', 'Dvorak');
    const nowOnChips = await chips();
    const nowOffered = await options();
    expect(nowOnChips).toContain('Debussy');            // promoted by the new rows
    expect(nowOffered.filter(o => nowOnChips.includes(o))).toEqual([]);
    // And the one it pushed off the chips is offered rather than stranded:
    // without the picker it would be reachable only by typing it into Other.
    expect(nowOffered).toContain('Schubert');
    expect(wasOnChips.filter(c => !nowOnChips.includes(c) && !nowOffered.includes(c))).toEqual([]);

    // The rebuild must not knock the select off the option just chosen, nor
    // off Other..., whose free-text box is open and focused behind it.
    await expect(page.locator('#logComposer')).toHaveValue('Dvorak');
    await page.selectOption('#logComposer', ' other');
    await expect(page.locator('#logComposer')).toHaveValue(' other');
    await expect(page.locator('#logComposerOther')).toBeFocused();
    await page.fill('#logComposerOther', 'Borodin');
    await expect(page.locator('#logComposerOther')).toHaveValue('Borodin');
});

test.describe('log form', () => {
    // Capture Forms submissions instead of sending them. The route is
    // anchored to the /forms/ path so it can't swallow the sheet stub above.

    // Composers this log plays are chips; anything else lives behind "More".
    // Tests should go through whichever one a person would.
    async function pickComposer(page, name) {
        const chip = page.locator('#logComposerChips .log-chip-btn')
            .filter({ hasText: new RegExp(`^${name}$`) });
        if (await chip.count()) return chip.click();
        await page.click('#logComposerChips .log-chip-btn--more');
        await page.selectOption('#logComposer', name);
    }

    async function captureSubmits(page) {
        const bodies = [];
        await page.route('https://docs.google.com/forms/**', route => {
            bodies.push(route.request().postData());
            route.fulfill({ status: 200, body: '' });
        });
        return bodies;
    }

    test.beforeEach(async ({ page }) => {
        // Configure through the setup link, which exercises consumeFormParam
        // on the way in.
        await page.goto(`/?data=${encodeURIComponent(SHEET_URL)}&form=${encodeURIComponent(PREFILL)}`);
        await expect(page.locator('#update')).toContainText(/Data updated|from cache/, { timeout: 15000 });
        await page.evaluate(() => { window.location.hash = '#log'; });
        // A link never connects itself, so setup is one tap even on a device
        // with no form yet.
        await page.click('#logProposalAccept');
        await expect(page.locator('#logForm')).toBeVisible();
        // The param is stripped so it can't linger in history or re-apply.
        expect(new URL(page.url()).searchParams.get('form')).toBeNull();
    });

    test('autofills names and places from the visitor own log', async ({ page }) => {
        // The suggestions are the reason to log from here rather than from the
        // Google Form, and they have to come from THIS user's sheet — the
        // fixture's people, nobody else's.
        const players = await page.locator('#logPlayers option').evaluateAll(
            nodes => nodes.map(n => n.value));
        expect(players).toContain('Alice');
        expect(players).toContain('Frank Vandermeer');
        // Others? entries are as retypeable as seats, so they are offered too.
        expect(players).toContain('Grace');
        // Alice is in the most rows, and a datalist renders in list order:
        // the people you play with weekly should not sit below a one-off.
        expect(players[0]).toBe('Alice');
        // "-" is an empty seat, not a person.
        expect(players).not.toContain('-');

        const places = await page.locator('#logLocations option').evaluateAll(
            nodes => nodes.map(n => n.value));
        expect(places).toEqual(['Home', 'Hall']);
    });

    test('the composers you play are one tap, the rest are behind More', async ({ page }) => {
        // The Google Form this replaces shows its handful of composers as
        // radios, so Haydn is one tap. A 22-item picker would be slower than
        // the thing being replaced.
        const chips = page.locator('#logComposerChips .log-chip-btn');
        await expect(chips).toHaveText(['Haydn', 'Mozart', 'Beethoven', 'More...']);
        await expect(page.locator('#logComposer')).toBeHidden();

        await chips.filter({ hasText: 'Haydn' }).click();
        await expect(chips.filter({ hasText: 'Haydn' })).toHaveAttribute('aria-checked', 'true');
        // Picking a chip answers the field outright: no picker, no typing.
        await expect(page.locator('#logComposer')).toBeHidden();
        const works = await page.locator('#logWorks option').evaluateAll(n => n.map(o => o.value));
        expect(works).toContain('20#2');

        // The full catalog is one tap away and includes composers never played.
        await page.click('#logComposerChips .log-chip-btn--more');
        await expect(page.locator('#logComposer')).toBeVisible();
        const options = await page.locator('#logComposer option').allTextContents();
        expect(options).toContain('Debussy');
        expect(options.at(-1)).toBe('Other...');

        // A composer with no chip keeps the picker open, so it is never set
        // but invisible.
        await page.selectOption('#logComposer', 'Debussy');
        await expect(page.locator('#logComposer')).toBeVisible();
        await expect(page.locator('#logComposer')).toHaveValue('Debussy');
        await expect(chips.filter({ hasText: 'Haydn' })).toHaveAttribute('aria-checked', 'false');
    });

    test('offers every catalog composer and suggests that composer works', async ({ page }) => {
        await page.click('#logComposerChips .log-chip-btn--more');
        const options = await page.locator('#logComposer option').allTextContents();
        const chips = await page.locator('#logComposerChips .log-chip-btn').allTextContents();
        // The Google Form's own radio lists seven; the catalog knows far more,
        // and all of them have to be reachable. Reachable is chips OR picker:
        // the two are complements, so neither alone is the offer.
        const offered = [...chips, ...options];
        expect(offered.length).toBeGreaterThan(10);
        expect(offered).toContain('Haydn');     // a chip, since the fixture plays it
        expect(offered).toContain('Debussy');   // lives only inside the MISC tab
        expect(options.at(-1)).toBe('Other...');

        await pickComposer(page, 'Haydn');
        const works = await page.locator('#logWorks option').evaluateAll(
            nodes => nodes.map(n => n.value));
        expect(works).toContain('20#2');
        expect(works).not.toContain('K421');    // Mozart's, not Haydn's
    });

    test('shows the carried-forward seats as placeholders, and submits blanks', async ({ page }) => {
        const bodies = await captureSubmits(page);
        // The fixture's newest row is Haydn 20#2 with Alice / Dave / Carol.
        await expect(page.locator('#logPlayer1')).toHaveAttribute('placeholder', 'Alice');
        await expect(page.locator('#logPlayer3')).toHaveAttribute('placeholder', 'Carol');
        await expect(page.locator('#logLocation')).toHaveAttribute('placeholder', 'Home');

        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#1');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.fill('#logPlayer2', 'Erin');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');

        const body = new URLSearchParams(bodies.at(-1));
        // Composer always rides the Other escape (its value space is unbounded
        // and the app cannot read the form's options); everything else,
        // Which Part included, is sent plainly.
        expect(body.get(`${COMPOSER_ID}.other_option_response`)).toBe('Haydn');
        expect(body.get(TITLE_ID)).toBe('76#1');
        expect(body.get(PART_ID)).toBe('V1');
        expect(body.get(PLAYER2_ID)).toBe('Erin');
        // The untouched seats submit EMPTY, not pre-filled: a blank cell is
        // the sheet's ditto mark, and writing the name back would defeat
        // fillForward's whole purpose.
        expect(body.has(PLAYER1_ID)).toBe(false);
        expect(body.has(PLAYER3_ID)).toBe(false);
    });

    test('carries forward from the row just submitted, not the stale sheet', async ({ page }) => {
        await captureSubmits(page);
        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#1');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.fill('#logPlayer2', 'Erin');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');

        // The published CSV lags by minutes, so the app's own data still ends
        // at the fixture's last row. The next piece of this session must still
        // see Erin in seat 2 — otherwise every second row of a session logs
        // the person who was replaced.
        await expect(page.locator('#logPlayer2')).toHaveAttribute('placeholder', 'Erin');
        await expect(page.locator('#logPlayer1')).toHaveAttribute('placeholder', 'Alice');
        // Composer and part stay for the next piece; the title clears.
        await expect(page.locator('#logComposer')).toHaveValue('Haydn');
        await expect(page.locator('#logPart .part-btn.active')).toHaveText('V1');
        await expect(page.locator('#logTitle')).toHaveValue('');
    });

    test('every composer rides the Other escape; Which Part never does', async ({ page }) => {
        // There is no composer option list to be outside of -- another user's
        // cannot be read cross-origin -- so the escape is the only path, and a
        // form whose Composer question is not multiple-choice-with-Other now
        // fails on the FIRST piece rather than on whichever one first used an
        // unlisted name.
        //
        // Which Part goes plainly, because the escape is not free: it requires
        // Other to be switched on, and a multiple-choice question without it
        // rejects the response silently. A fixed four-seat question is the last
        // one anyone would enable Other for.
        const bodies = await captureSubmits(page);
        for (const [composer, title] of [['Brahms', '51#1'], ['Haydn', '76#1']]) {
            await pickComposer(page, composer);
            await page.fill('#logTitle', title);
            await page.click('#logPart .part-btn[data-part="VA1"]');
            await page.click('#logSubmit');
            await expect(page.locator('#logStatus')).toContainText(`Logged ${composer}`);

            const body = new URLSearchParams(bodies.at(-1));
            expect(body.get(COMPOSER_ID)).toBe('__other_option__');
            expect(body.get(`${COMPOSER_ID}.other_option_response`)).toBe(composer);
            expect(body.get(PART_ID)).toBe('VA1');
            expect(body.has(`${PART_ID}.other_option_response`)).toBe(false);
        }
    });

    test('an Other composer survives the post-submit reset', async ({ page }) => {
        await captureSubmits(page);
        await pickComposer(page, ' other');
        await page.fill('#logComposerOther', 'Ligeti');
        await page.fill('#logTitle', '1');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        // The composer carries into the next piece like any other, so the
        // select must still read "Other..." with the name under it rather than
        // falling back to blank while "Ligeti" sits visible below.
        await expect(page.locator('#logComposerOther')).toBeVisible();
        await expect(page.locator('#logComposerOther')).toHaveValue('Ligeti');
        await expect(page.locator('#logComposer')).toHaveValue(' other');
    });

    test('names a missing required field instead of submitting into the void', async ({ page }) => {
        const bodies = await captureSubmits(page);
        await pickComposer(page, 'Haydn');
        await page.click('#logSubmit');
        // Forms rejects server-side and mode:'no-cors' hides the rejection, so
        // an unchecked submit would look exactly like a successful one.
        await expect(page.locator('#logStatus')).toContainText('Work Title');
        await expect(page.locator('#logStatus')).toContainText('Which Part');
        expect(bodies).toHaveLength(0);

        // A sentence naming them is not enough on a phone, where the empty
        // field can be off-screen: they are marked, and the first one has the
        // cursor, so the fix is to start typing.
        await expect(page.locator('#logTitle')).toHaveClass(/is-missing/);
        await expect(page.locator('#logPart')).toHaveClass(/is-missing/);
        await expect(page.locator('#logTitle')).toBeFocused();
        // Acting on any field clears the marks rather than leaving them to rot.
        await page.fill('#logTitle', '76#1');
        await expect(page.locator('#logTitle')).not.toHaveClass(/is-missing/);
        await expect(page.locator('#logPart')).not.toHaveClass(/is-missing/);
    });

    test('says what it logged, and leaves the cursor on the next piece', async ({ page }) => {
        await captureSubmits(page);
        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#1');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.click('#logSubmit');
        // The response is opaque, so this line is the only acknowledgement a
        // submit gets -- and a bare "Logged." cannot be told apart from the
        // previous piece's.
        await expect(page.locator('#logStatus')).toContainText('Logged Haydn 76#1');
        await expect(page.locator('#logStatus')).toHaveAttribute('role', 'status');
        // Composer, part and seats all carry, so the title is all that is left
        // to type for the next piece of the session.
        await expect(page.locator('#logTitle')).toBeFocused();
        await expect(page.locator('#logTitle')).toHaveValue('');
    });

    test('a link cannot redirect a configured device without being asked', async ({ page }) => {
        // Someone sends you a link; one click and everything you log goes to
        // their spreadsheet while the form still says "Logged" and your own
        // sheet quietly stops growing. Nothing may change until a human says
        // so, and until then neither the form nor the setup panel is reachable.
        const bodies = await captureSubmits(page);
        const evil = `https://docs.google.com/forms/d/e/SOMEONE-ELSES-FORM/viewform?usp=pp_url&`
            + FORM_IDS.map((id, i) => `entry.${900 + i}=v${i}`).join('&');
        await page.goto(`/?form=${encodeURIComponent(evil)}`);
        await page.evaluate(() => { window.location.hash = '#log'; });

        await expect(page.locator('#logProposal')).toBeVisible();
        // Both ends named, so the choice is informed rather than a leap.
        await expect(page.locator('#logProposal')).toContainText('...S-FORM');
        await expect(page.locator('#logProposal')).toContainText('...RM-E2E');
        // Both ends are openable, not just named: telling an incoming form
        // from the one it would replace is the whole decision, and neither
        // tail settles it on its own.
        await expect(page.locator('#logProposalText a')).toHaveCount(2);
        await expect(page.locator('#logProposalText a').first())
            .toHaveAttribute('href', 'https://docs.google.com/forms/d/e/SOMEONE-ELSES-FORM/viewform');
        await expect(page.locator('#logProposalText a').nth(1))
            .toHaveAttribute('href', `https://docs.google.com/forms/d/e/${FORM_ID}/viewform`);
        await expect(page.locator('#logForm')).toBeHidden();
        await expect(page.locator('#logSetup')).toBeHidden();

        await page.click('#logProposalReject');
        await expect(page.locator('#logForm')).toBeVisible();
        // Still the form that was there before.
        await expect(page.locator('#logFormId')).toContainText('M-E2E');

        // And a reload does not resurrect the declined proposal: the param is
        // stripped whichever way it was answered.
        await page.reload();
        await expect(page.locator('#logForm')).toBeVisible();
        await expect(page.locator('#logProposal')).toBeHidden();

        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#4');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        // The row went to the configured form, not the one the link named.
        expect(bodies.at(-1)).toContain(COMPOSER_ID);
        const posted = await page.evaluate(() => performance.getEntriesByType('resource')
            .map(r => r.name).filter(n => n.includes('/forms/d/e/')));
        expect(posted.join(' ')).not.toContain('SOMEONE-ELSES-FORM');
    });

    test('a swap is a dropdown, and the sheet gets it as a swap', async ({ page }) => {
        // The workflow this exists for: playing viola, the two violinists swap
        // between pieces. Positionally that meant retyping both names into
        // different columns -- and the seats ARE positional, so that is still
        // what the sheet has to receive. One dropdown, and the form does the
        // retyping: annotating instead ("Alice (v2), Dave (v1)") writes a row
        // whose columns contradict SLOT_TO_PART, which is what the sheet's own
        // reader and anyone reading the spreadsheet go by.
        const bodies = await captureSubmits(page);
        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#5');
        await page.click('#logPart .part-btn[data-part="VA1"]');

        // Seat 1 is V1 by the quartet layout, and says so.
        await expect(page.locator('#logSlotPart1')).toHaveValue('V1');
        await expect(page.locator('#logSlotPart1 option[value="V1"]')).toHaveText('V1 (seat)');
        await expect(page.locator('#logSlotPart3')).toHaveValue('VC');

        // Move seat 1 to V2 without touching the name field. Seat 2 was on V2,
        // so it takes the part seat 1 gave up: one tap says "these two
        // swapped", which is the thing that happened.
        await page.selectOption('#logSlotPart1', 'V2');
        await expect(page.locator('#logSlotPart2')).toHaveValue('V1');
        // What is on screen stays a true statement about who played what: each
        // seat shows the person it carries, beside the part that person is now
        // on. Previewing the MOVED name here ("Dave" against this seat's V2)
        // would state the swap backwards, Dave being what the V1 column will
        // hold -- the positional retyping is the form's business, not a thing
        // the logger should have to read off the screen.
        await expect(page.locator('#logPlayer1')).toHaveAttribute('placeholder', 'Alice');
        await expect(page.locator('#logPlayer2')).toHaveAttribute('placeholder', 'Dave');

        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');

        const body = new URLSearchParams(bodies.at(-1));
        // Both names are materialised from the carried row, because a blank is
        // a ditto mark and would repeat the order being swapped out of.
        expect(body.get(PLAYER1_ID)).toBe('Dave');
        expect(body.get(PLAYER2_ID)).toBe('Alice');
        // The cello seat was not in the swap, so it still dittos and the sheet
        // gains no needless text.
        expect(body.has(PLAYER3_ID)).toBe(false);

        // The swap sticks for the next piece the way a name does -- now by
        // being where it is, so the seats are back to meaning what they imply.
        await expect(page.locator('#logSlotPart1')).toHaveValue('V1');
        await expect(page.locator('#logPlayer1')).toHaveAttribute('placeholder', 'Dave');
        await expect(page.locator('#logPlayer2')).toHaveAttribute('placeholder', 'Alice');
    });

    test('two people typed in with their parts land in the right columns', async ({ page }) => {
        // The shape that was reported: "VA1, Bob (v2), Erin (v1)", where the
        // sheet says it as "VA1, Erin, Bob". Typed names, not carried ones,
        // and each seat set explicitly -- so nothing here depends on which
        // dropdown was touched first.
        const bodies = await captureSubmits(page);
        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '77#1');
        await page.click('#logPart .part-btn[data-part="VA1"]');
        await page.fill('#logPlayer1', 'Bob');
        await page.fill('#logPlayer2', 'Erin');
        await page.selectOption('#logSlotPart1', 'V2');
        await page.selectOption('#logSlotPart2', 'V1');
        await page.fill('#logPlayer3', '-');

        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        const body = new URLSearchParams(bodies.at(-1));
        expect(body.get(PLAYER1_ID)).toBe('Erin');
        expect(body.get(PLAYER2_ID)).toBe('Bob');
        // A trio: the empty chair is written out, since a blank would ditto
        // the cellist above.
        expect(body.get(PLAYER3_ID)).toBe('-');
    });

    test('a seat nobody touched keeps tracking the row it dittos', async ({ page }) => {
        // One dropdown says something about the seats it names and nothing
        // about the others, so only the seats that DEPART from the carried row
        // are held. Holding all three would freeze the untouched ones against
        // the row they carry from, and a carried annotation is what gets lost.
        const bodies = await captureSubmits(page);
        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#4');
        await page.click('#logPart .part-btn[data-part="VA1"]');
        // The two violinists swapped: one tap, and seat 3 is not in it.
        await page.selectOption('#logSlotPart1', 'V2');

        // The draft survives a reload (an installed PWA is evicted whenever the
        // phone decides to), and the sheet has meanwhile gained a row whose
        // cello seat carries a SECOND cellist.
        await page.route('https://docs.google.com/spreadsheets/**', route => route.fulfill({
            contentType: 'text/csv',
            body: `${FIXTURE_CSV}\n${day(0, '21:00:00')},Haydn,20#4,VA,Alice,Dave,Frank (vc2),,Home,`,
        }));
        await page.reload();
        await expect(page.locator('#logForm')).toBeVisible();
        // The swap is still held; the seat nobody touched follows the new row.
        await expect(page.locator('#logSlotPart1')).toHaveValue('V2');
        await expect(page.locator('#logSlotPart3')).toHaveValue('VC2');

        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        const body = new URLSearchParams(bodies.at(-1));
        // So it dittos, rather than writing out a bare "Frank" and demoting the
        // second cellist to the cellist.
        expect(body.has(PLAYER3_ID)).toBe(false);
        // And the swap beside it is still written AS a swap: the seat on a part
        // of its own sits out of it instead of turning the two violinists back
        // into annotations, which is how the reported shape got back in.
        expect(body.get(PLAYER1_ID)).toBe('Dave');
        expect(body.get(PLAYER2_ID)).toBe('Alice');
    });

    test('a quintet second viola goes in Others?, not in a column', async ({ page }) => {
        const bodies = await captureSubmits(page);
        await pickComposer(page, 'Mozart');
        await page.fill('#logTitle', 'K515');
        await page.click('#logPart .part-btn[data-part="V1"]');
        // The three columns ARE the quartet's parts, decided by my own part, so
        // a column cannot offer VA2 at all -- tagging one is the convention
        // this form exists to stop writing.
        await expect(page.locator('#logSlotPart2 option'))
            .toHaveText(['V2', 'VA (seat)', 'VC']);
        // Everyone past the four is an Others? entry with a tag.
        await page.click('#logOthersAdd');
        const row = page.locator('.log-other-row').first();
        await row.locator('input').fill('Erin Fry');
        await row.locator('select').selectOption('VA2');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');

        const body = new URLSearchParams(bodies.at(-1));
        // partFromInstrument folds va2 into VA for the charts, but the sheet
        // keeps the distinction -- which is the reason to write it.
        expect(body.get(OTHERS_ID)).toBe('Erin Fry (va2)');
        // And the viola column is left holding the viola, untagged.
        expect(body.has(PLAYER2_ID)).toBe(false);
    });

    test('Others? offers the octet and wind parts, and round-trips them', async ({ page }) => {
        // v3/v4 for an octet, cl/fl for the wind rep. These used to be absent
        // from the list entirely, so logging one meant typing the syntax.
        const bodies = await captureSubmits(page);
        await pickComposer(page, 'Mozart');
        await page.fill('#logTitle', 'K581');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.click('#logOthersAdd');
        const row = page.locator('.log-other-row').first();
        await row.locator('input').fill('Frank Gomez');
        await row.locator('select').selectOption('CL');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        expect(new URLSearchParams(bodies.at(-1)).get(OTHERS_ID)).toBe('Frank Gomez (cl)');
        // The next piece of the sitting carries them, and the dropdown shows
        // the option rather than the raw code as passthrough text.
        await expect(page.locator('.log-other-row').first().locator('select'))
            .toHaveValue('CL');
    });

    test('a part that belonged to a person is not handed to the next seat', async ({ page }) => {
        // The sheet's last row seats a pianist in a string seat (howto s5), so
        // that seat's dropdown comes up on Piano. Moving it to V2 is not a swap
        // with anybody: the part given up was that person's, not the chair's.
        const bodies = await captureSubmits(page);
        await page.route('https://docs.google.com/spreadsheets/**', route => route.fulfill({
            contentType: 'text/csv',
            body: `${FIXTURE_CSV}\n${day(0, '21:00:00')},Mozart,K478,VA,Grace (p),Dave,Carol,,Home,`,
        }));
        await page.reload();
        await expect(page.locator('#logForm')).toBeVisible();
        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#6');
        await page.click('#logPart .part-btn[data-part="VA1"]');
        await expect(page.locator('#logSlotPart1')).toHaveValue('P');

        await page.selectOption('#logSlotPart1', 'V2');
        // Seat 2 keeps V2 rather than being handed the piano.
        await expect(page.locator('#logSlotPart2')).toHaveValue('V2');

        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        const body = new URLSearchParams(bodies.at(-1));
        expect(body.get(PLAYER1_ID)).toBe('Grace (v2)');
        // Dave dittos, still a violinist. Handing the vacated (p) over would
        // have written him out as "Dave (p)" with his field never touched.
        expect(body.has(PLAYER2_ID)).toBe(false);
    });

    test('an Others? player gets a part without typing the syntax', async ({ page }) => {
        // Others? is where a pianist or a second cellist actually turns up, so
        // it gets the same name-plus-part pair the seats have. It still
        // serialises to the "Name (instrument)" text the cell has always held.
        const bodies = await captureSubmits(page);
        await pickComposer(page, 'Mozart');
        await page.fill('#logTitle', 'K478');
        await page.click('#logPart .part-btn[data-part="V1"]');

        await page.click('#logOthersAdd');
        const row = page.locator('.log-other-row').first();
        await row.locator('input').fill('Dana Ellis');
        await row.locator('select').selectOption('P');
        await page.click('#logOthersAdd');
        const second = page.locator('.log-other-row').nth(1);
        await second.locator('input').fill('Erin Fry');
        await second.locator('select').selectOption('VC2');

        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        const body = new URLSearchParams(bodies.at(-1));
        expect(body.get(OTHERS_ID)).toBe('Dana Ellis (p); Erin Fry (vc2)');
    });

    test('an Others? part the columns hold is offered as itself', async ({ page }) => {
        // "(vc)" reads as VC, which Others? does not offer -- Player 3 always
        // holds vc1, so a cellist is only ever an extra as vc2. The cell still
        // says vc, so the option list has to say it too; dropping it would show
        // "part?" over a part that is written down.
        const recent = new Date(Date.now() - 3600_000);
        const stamp = `${recent.getMonth() + 1}/${recent.getDate()}/${recent.getFullYear()}`
            + ` ${recent.getHours()}:${String(recent.getMinutes()).padStart(2, '0')}:00`;
        await page.route('https://docs.google.com/spreadsheets/**', route => route.fulfill({
            contentType: 'text/csv',
            body: `${FIXTURE_CSV}\n${stamp},Haydn,20#3,V1,Alice,Bob,Carol,Heidi (vc),Home,`,
        }));
        await page.reload();
        await expect(page.locator('#logForm')).toBeVisible();

        const bodies = await captureSubmits(page);
        await page.locator('#logOthersHere .log-chip-btn')
            .filter({ hasText: 'Heidi' }).click();
        const row = page.locator('.log-other-row').first();
        await expect(row.locator('select')).toHaveValue('vc');

        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#6');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        // Round-tripped, not rewritten into the nearest thing on the list.
        expect(new URLSearchParams(bodies.at(-1)).get(OTHERS_ID)).toBe('Heidi (vc)');
    });

    test('people already in the sitting are a tap, not a retype', async ({ page }) => {
        // The second sextet of an afternoon has the first one's people. The
        // fixture's newest row is days old, so give it one from an hour ago --
        // otherwise there is no sitting to be in, which is itself correct.
        const recent = new Date(Date.now() - 3600_000);
        const stamp = `${recent.getMonth() + 1}/${recent.getDate()}/${recent.getFullYear()}`
            + ` ${recent.getHours()}:${String(recent.getMinutes()).padStart(2, '0')}:00`;
        await page.route('https://docs.google.com/spreadsheets/**', route => route.fulfill({
            contentType: 'text/csv',
            body: `${FIXTURE_CSV}\n${stamp},Haydn,20#3,V1,Alice,Bob,Carol,Grace (piano),Home,`,
        }));
        await page.reload();
        await expect(page.locator('#logForm')).toBeVisible();

        const bodies = await captureSubmits(page);
        const here = page.locator('#logOthersHere .log-chip-btn');
        await expect(here.filter({ hasText: 'Grace' })).toBeVisible();
        // Nobody currently on the form is offered: they are already here.
        await expect(here.filter({ hasText: 'Alice' })).toHaveCount(0);

        await here.filter({ hasText: 'Grace' }).click();
        const row = page.locator('.log-other-row').first();
        await expect(row.locator('input')).toHaveValue('Grace');
        // The instrument they were last logged on comes along.
        await expect(row.locator('select')).toHaveValue('P');
        // And they stop being offered, since they are now on the row.
        await expect(here.filter({ hasText: 'Grace' })).toHaveCount(0);

        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#6');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        expect(new URLSearchParams(bodies.at(-1)).get(OTHERS_ID)).toBe('Grace (piano)');
    });

    test('extras stay for the rest of the sitting until the x says otherwise', async ({ page }) => {
        // Others? cannot ditto in the sheet -- every row that had a fifth
        // player has to name them again, and forgetting is the single most
        // common way a person goes missing from the log. The form carries them
        // and writes them out each time.
        const bodies = await captureSubmits(page);
        await pickComposer(page, 'Haydn');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.click('#logOthersAdd');
        await page.locator('.log-other-row').first().locator('input').fill('Dana Ellis');
        await page.locator('.log-other-row').first().locator('select').selectOption('P');
        await page.click('#logOthersAdd');
        await page.locator('.log-other-row').nth(1).locator('input').fill('Erin Fry');
        await page.locator('.log-other-row').nth(1).locator('select').selectOption('VC2');
        await page.fill('#logTitle', '76#8');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        expect(new URLSearchParams(bodies.at(-1)).get(OTHERS_ID))
            .toBe('Dana Ellis (p); Erin Fry (vc2)');

        // Next piece: both are still there, no tapping, no retyping.
        await expect(page.locator('.log-other-row')).toHaveCount(2);
        await expect(page.locator('.log-other-row').first().locator('input')).toHaveValue('Dana Ellis');
        await expect(page.locator('.log-other-row').nth(1).locator('select')).toHaveValue('VC2');
        await page.fill('#logTitle', '76#9');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        expect(new URLSearchParams(bodies.at(-1)).get(OTHERS_ID))
            .toBe('Dana Ellis (p); Erin Fry (vc2)');

        // The cellist leaves: one x, and she stops being written.
        await page.locator('.log-other-row').nth(1).locator('.log-other-drop').click();
        await page.fill('#logTitle', '76#10');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        expect(new URLSearchParams(bodies.at(-1)).get(OTHERS_ID)).toBe('Dana Ellis (p)');
        // And she stays gone on the next piece, rather than coming back.
        await expect(page.locator('.log-other-row')).toHaveCount(1);
        // She is still offered, though, since she was in the sitting.
        await expect(page.locator('#logOthersHere .log-chip-btn').filter({ hasText: 'Erin Fry' }))
            .toBeVisible();
    });

    test('revealing the catalog picker does not blow up the phone layout', async ({ page }) => {
        // The picker is the one control that is placed in the form's second
        // grid column and is hidden at rest. A hidden element is not a grid
        // item, so on a phone -- where the form is ONE column -- the damage
        // only appeared once "More..." was tapped: the placement minted an
        // implicit second column, the auto-placed column collapsed to 0px, and
        // every label, input and note in the form was crushed into it. The
        // composer being typed was in a 22px box, so the letters went nowhere
        // visible; so did the work title. Nothing above the CSS could see it,
        // which is why it is pinned here.
        await page.setViewportSize({ width: 390, height: 900 });
        await page.click('#logComposerChips .log-chip-btn--more');
        await page.selectOption('#logComposer', ' other');
        await expect(page.locator('#logComposerOther')).toBeVisible();

        const columns = await page.$eval('#logForm', el =>
            getComputedStyle(el).gridTemplateColumns.split(' ').length);
        expect(columns).toBe(1);
        // What that costs the user, measured rather than inferred: the box you
        // type a composer into is as wide as every other field, not a stub.
        const width = el => page.locator(el).evaluate(n => n.getBoundingClientRect().width);
        const title = await width('#logTitle');
        expect(title).toBeGreaterThan(300);
        expect(await width('#logComposerOther')).toBe(title);
    });

    test('the catalog picker offers what the chips do not', async ({ page }) => {
        // Both views are built from frequentComposers(), so a composer on a
        // chip listed again in the picker is dead space at the top of a phone
        // screen -- re-offering the tap already on offer, one scroll further
        // down.
        await page.click('#logComposerChips .log-chip-btn--more');
        const chips = await page.$$eval('#logComposerChips .log-chip-btn',
            ns => ns.map(n => n.textContent).filter(t => t !== 'More...'));
        const options = await page.$$eval('#logComposer option', ns => ns.map(n => n.textContent));
        expect(chips).toContain('Haydn');
        expect(options.length).toBeGreaterThan(3);
        expect(options.filter(o => chips.includes(o))).toEqual([]);
        // The escape to a composer the catalog has never heard of survives the
        // filtering, and so does the empty prompt.
        expect(options.at(0)).toBe('Composer...');
        expect(options.at(-1)).toBe('Other...');
    });

    test('an Other composer survives a reload too', async ({ page }) => {
        // The field that slipped: it updated state but never saved the draft,
        // so a name the catalog has never heard of was lost on reload.
        await pickComposer(page, ' other');
        await page.fill('#logComposerOther', 'Ligeti');
        await page.fill('#logTitle', '2');
        await page.reload();
        await expect(page.locator('#logForm')).toBeVisible();
        await expect(page.locator('#logComposerOther')).toBeVisible();
        await expect(page.locator('#logComposerOther')).toHaveValue('Ligeti');
        await expect(page.locator('#logTitle')).toHaveValue('2');
    });

    test('a draft is snapshotted when the page is hidden, not only on each keystroke', async ({ page }) => {
        // Per-handler discipline is how the Other-composer field went unsaved.
        // On iOS a backgrounded PWA is killed without warning, so the way out
        // is also a save point -- whatever any handler forgot is caught here.
        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#13');
        // Mutate state behind the handlers' backs, as a missed touch() would.
        await page.evaluate(() => localStorage.removeItem('quartetlog_draft'));
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        // Still nothing: the page is visible, so there is nothing to snapshot.
        expect(await page.evaluate(() => localStorage.getItem('quartetlog_draft'))).toBeNull();

        await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('quartetlog_draft')));
        expect(draft.entry.title).toBe('76#13');
        expect(draft.entry.composer).toBe('Haydn');
    });

    test('Log Out leaves nothing of the log behind', async ({ page }) => {
        // "Log Out before sharing your screen" has to be true: the queue, the
        // sitting and the draft all carry player names, and a form config left
        // behind would send the next person's entries to this person's sheet.
        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#14');
        await page.click('#logOthersAdd');
        await page.locator('.log-other-row').first().locator('input').fill('Dana Ellis');
        const keys = () => page.evaluate(() => Object.keys(localStorage)
            .filter(k => k.startsWith('quartetlog_')));
        expect(await keys()).toContain('quartetlog_draft');
        expect(await keys()).toContain('quartetlog_form');

        page.once('dialog', d => d.accept());
        await page.click('.hamburger-menu');
        await page.click('.menu-item[data-view="logout"]');
        await expect(page.locator('#setupView')).toBeVisible({ timeout: 15000 });
        expect(await keys()).toEqual([]);
    });

    test('nothing on screen is lost to a reload', async ({ page }) => {
        // An installed PWA is evicted from memory whenever the phone decides
        // to. A half-entered piece that lives only in a component field is one
        // the user loses by putting the phone down mid-session.
        await captureSubmits(page);
        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#11');
        await page.click('#logPart .part-btn[data-part="VA1"]');
        await page.fill('#logPlayer2', 'Erin Fry');
        await page.selectOption('#logSlotPart2', 'V1');
        await page.click('#logOthersAdd');
        await page.locator('.log-other-row').first().locator('input').fill('Dana Ellis');
        await page.locator('.log-other-row').first().locator('select').selectOption('P');
        await page.fill('#logOthersFree', 'Laura (v2, shadowing on I)');
        await page.fill('#logComments', 'lovely reading');

        await page.reload();
        await expect(page.locator('#logForm')).toBeVisible();

        await expect(page.locator('#logTitle')).toHaveValue('76#11');
        await expect(page.locator('#logPart .part-btn.active')).toHaveText('VA1');
        await expect(page.locator('#logComposerChips .log-chip-btn.active')).toHaveText('Haydn');
        await expect(page.locator('#logPlayer2')).toHaveValue('Erin Fry');
        await expect(page.locator('#logSlotPart2')).toHaveValue('V1');
        await expect(page.locator('.log-other-row').first().locator('input')).toHaveValue('Dana Ellis');
        await expect(page.locator('.log-other-row').first().locator('select')).toHaveValue('P');
        await expect(page.locator('#logOthersFree')).toHaveValue('Laura (v2, shadowing on I)');
        await expect(page.locator('#logComments')).toHaveValue('lovely reading');
    });

    test('removing an extra sticks, even if another control is touched after', async ({ page }) => {
        // Seeding the extras used to happen inside renderFields, so any
        // repaint re-seeded the cell: remove someone, tap a composer chip, and
        // they came back and were submitted.
        const bodies = await captureSubmits(page);
        await pickComposer(page, 'Haydn');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.click('#logOthersAdd');
        await page.locator('.log-other-row').first().locator('input').fill('Dana Ellis');
        await page.fill('#logTitle', '76#12');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');

        // Next piece starts with Dana carried; remove her, then touch two
        // other controls before submitting.
        await expect(page.locator('.log-other-row')).toHaveCount(1);
        await page.locator('.log-other-row').first().locator('.log-other-drop').click();
        await pickComposer(page, 'Mozart');
        await page.click('#logPart .part-btn[data-part="V2"]');
        await page.fill('#logTitle', 'K421');
        await expect(page.locator('.log-other-row')).toHaveCount(0);
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        expect(new URLSearchParams(bodies.at(-1)).has(OTHERS_ID)).toBe(false);
    });

    test('the Home part filter does not touch the log form selection', async ({ page }) => {
        // Both views use .part-btn, and the restyle used to be document-wide.
        await page.click('#logPart .part-btn[data-part="VA2"]');
        await expect(page.locator('#logPart .part-btn.active')).toHaveText('VA2');

        await page.evaluate(() => { window.location.hash = '#main'; });
        await page.click('#radioButtons .part-btn[data-part="V1"]');
        await page.evaluate(() => { window.location.hash = '#log'; });

        // Still VA2, and still what a submission would carry.
        await expect(page.locator('#logPart .part-btn.active')).toHaveText('VA2');
        await expect(page.locator('#radioButtons .part-btn.active')).toHaveText('V1');
    });

    test('freeform Others? survives the round trip and merges on write', async ({ page }) => {
        // A row is a name and a dropdown; "shadowing on I" is prose, and prose
        // needs a text field. It rejoins the same cell on write.
        const bodies = await captureSubmits(page);
        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#7');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.click('#logOthersAdd');
        await page.locator('.log-other-row').first().locator('input').fill('Dana Ellis');
        await page.locator('.log-other-row').first().locator('select').selectOption('VC2');
        await page.fill('#logOthersFree', 'Laura (v2, shadowing on I)');

        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        expect(new URLSearchParams(bodies.at(-1)).get(OTHERS_ID))
            .toBe('Dana Ellis (vc2); Laura (v2, shadowing on I)');
    });

    test('an Others? row can be removed, and a blank one says nothing', async ({ page }) => {
        const bodies = await captureSubmits(page);
        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#2');
        await page.click('#logPart .part-btn[data-part="V1"]');

        await page.click('#logOthersAdd');
        await page.locator('.log-other-row').first().locator('input').fill('Dana Ellis');
        await page.click('#logOthersAdd');          // left blank on purpose
        await page.click('#logOthersAdd');
        await page.locator('.log-other-row').nth(2).locator('input').fill('Erin Fry');
        await expect(page.locator('.log-other-row')).toHaveCount(3);
        await page.locator('.log-other-row').nth(2).locator('.log-other-drop').click();
        await expect(page.locator('.log-other-row')).toHaveCount(2);

        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        // The blank row contributes nothing -- no stray separator, no bare
        // annotation.
        expect(new URLSearchParams(bodies.at(-1)).get(OTHERS_ID)).toBe('Dana Ellis');
    });

    test('a name fixed in the sheet afterwards wins over what was typed', async ({ page }) => {
        // The established fix for a misspelling, or for a surname learned after
        // the fact, is editing the sheet. The form only ever writes, so a
        // correction has to reach everything that reads -- including the local
        // copy of the just-submitted row that keeps the placeholders honest
        // while the published CSV catches up.
        await captureSubmits(page);
        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#9');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.fill('#logPlayer1', 'Alise Hart');   // typo, as typed
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');
        // The sheet hasn't caught up, so the local copy is carrying the seats.
        await expect(page.locator('#logPlayer1')).toHaveAttribute('placeholder', 'Alise Hart');

        // Now the sheet holds that row, corrected by hand. More specific than
        // the beforeEach route so it can't swallow the form POSTs.
        await page.route('https://docs.google.com/spreadsheets/**', route => route.fulfill({
            contentType: 'text/csv',
            body: `${FIXTURE_CSV}\n${day(0, '21:00:00')},Haydn,76#9,V1,Alice Hart,Bob,Carol,,Home,`,
        }));
        await page.reload();
        await expect(page.locator('#logForm')).toBeVisible();

        // The correction wins: the placeholder shows it, and it is what a blank
        // seat will now carry forward.
        await expect(page.locator('#logPlayer1')).toHaveAttribute('placeholder', 'Alice Hart');
        // And the typo is gone from the suggestions, since those are read from
        // the sheet rather than remembered.
        const players = await page.locator('#logPlayers option').evaluateAll(
            nodes => nodes.map(n => n.value));
        expect(players).toContain('Alice Hart');
        expect(players).not.toContain('Alise Hart');
    });

    test('queues when the network fails, and drains in order once it returns', async ({ page }) => {
        let online = false;
        const bodies = [];
        await page.route('https://docs.google.com/forms/**', route => {
            if (!online) return route.abort('internetdisconnected');
            bodies.push(route.request().postData());
            route.fulfill({ status: 200, body: '' });
        });

        await pickComposer(page, 'Haydn');
        await page.click('#logPart .part-btn[data-part="V1"]');
        for (const title of ['76#1', '76#2']) {
            await page.fill('#logTitle', title);
            await page.click('#logSubmit');
            await expect(page.locator('#logStatus')).toContainText('waiting for a network');
        }
        // An invisible outbox is how a submission silently never happens.
        await expect(page.locator('#logPending')).toBeVisible();
        await expect(page.locator('.log-pending-row')).toHaveCount(2);

        online = true;
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await expect(page.locator('#logPending')).toBeHidden();

        // Order is the contract: fillForward reads each row against the one
        // above it, so 76#1 must reach the sheet before 76#2.
        expect(bodies.map(b => new URLSearchParams(b).get(TITLE_ID)))
            .toEqual(['76#1', '76#2']);
    });

    // A browser that won't write localStorage is not exotic: private-mode
    // Safari throws on every write, and this app caches the whole parsed CSV,
    // so a full quota is a state it already has a status line for. The submit
    // path runs entirely through the queue, which lives in that storage.
    const blockStorageWrites = (page) => page.evaluate(() => {
        Object.defineProperty(Storage.prototype, 'setItem', {
            configurable: true, value() { throw new Error('QuotaExceededError (simulated)'); },
        });
    });

    test('discarding a queued piece stops it steering the next one', async ({ page }) => {
        // submit() remembers every submission, including one the flush could
        // not send, so a queued piece lives in two places. The x emptied only
        // the outbox: the other copy went on driving carry-forward against a
        // row the sheet will never hold, and nothing could ever retire it,
        // since no fetched row will match its composer and title.
        const bodies = [];
        let online = false;
        await page.route('https://docs.google.com/forms/**', route => {
            if (!online) return route.abort('internetdisconnected');
            bodies.push(route.request().postData());
            route.fulfill({ status: 200, body: '' });
        });

        await pickComposer(page, 'Haydn');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.fill('#logTitle', '76#1');
        await page.fill('#logPlayer1', 'Zelda Quill');
        await page.click('#logSubmit');
        await expect(page.locator('.log-pending-row')).toHaveCount(1);
        // The queued piece is what the next one would carry from.
        await expect(page.locator('#logPlayer1')).toHaveAttribute('placeholder', 'Zelda Quill');

        await page.click('.log-pending-drop');
        await expect(page.locator('#logPending')).toBeHidden();
        // Discarded means gone: the placeholder falls back to the sheet.
        await expect(page.locator('#logPlayer1')).not.toHaveAttribute('placeholder', 'Zelda Quill');

        // And a later piece must not leave the seat blank against the phantom
        // -- a blank here is dittoed by fillForward against a different row.
        online = true;
        await page.fill('#logTitle', '76#2');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged Haydn 76#2');
        expect(new URLSearchParams(bodies.at(-1)).get(PLAYER1_ID)).not.toBe('');
    });

    test('an extra added after a reload gets a fresh row, not a used id', async ({ page }) => {
        // newOtherRow spreads the saved row last, so a restored row keeps its
        // id while the counter has only counted the rows. Remove some before
        // the eviction and the surviving ids are sparse and ahead of it: the
        // next Add person mints an id already on screen. Rows are keyed and
        // REMOVED by that id, so one x then takes two people off the row --
        // and the one that vanishes is not the one that was tapped.
        const bodies = await captureSubmits(page);
        await pickComposer(page, 'Haydn');
        await page.click('#logPart .part-btn[data-part="V1"]');
        for (const name of ['Ana', 'Blas', 'Celia', 'Danilo', 'Elena']) {
            await page.click('#logOthersAdd');
            await page.fill('.log-other-row:last-of-type input[type=text]', name);
        }
        // Drop the first three, so the two survivors carry the high ids and
        // the counter is left behind them.
        for (let i = 0; i < 3; i++) await page.click('.log-other-row:first-of-type .log-other-drop');
        await expect(page.locator('.log-other-row')).toHaveCount(2);

        await page.reload();
        await expect(page.locator('#update')).toContainText(/Data updated|from cache/, { timeout: 15000 });
        await page.evaluate(() => { window.location.hash = '#log'; });
        await expect(page.locator('.log-other-row')).toHaveCount(2);

        for (const name of ['Fabio', 'Gisela']) {
            await page.click('#logOthersAdd');
            await page.fill('.log-other-row:last-of-type input[type=text]', name);
        }
        await expect(page.locator('.log-other-row')).toHaveCount(4);

        // The x is how you say one person left. Tapping Danilo's must not
        // take Gisela with it.
        await page.click('.log-other-row:first-of-type .log-other-drop');
        await expect(page.locator('.log-other-row')).toHaveCount(3);
        await page.fill('#logTitle', '76#1');
        await page.click('#logSubmit');
        expect(new URLSearchParams(bodies.at(-1)).get(OTHERS_ID))
            .toBe('Elena; Fabio; Gisela');
    });

    test('someone in the freeform box is not offered as a chip', async ({ page }) => {
        // The box holds exactly the entries that carry a comment, and `taken`
        // was built from a view that drops those -- so the chip claimed a
        // person was not on the row they were already on, and tapping it wrote
        // them in a second time.
        const bodies = await captureSubmits(page);
        await pickComposer(page, 'Haydn');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.fill('#logTitle', '76#1');
        await page.click('#logOthersAdd');
        await page.fill('.log-other-row:last-of-type input[type=text]', 'Zelda Quill');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');

        // She is in the sitting now, and carried on to the next piece as a
        // row, so no chip -- that much always worked.
        const chip = page.locator('#logOthersHere .log-chip-btn').filter({ hasText: 'Zelda Quill' });
        await expect(chip).toHaveCount(0);

        // Move her to the freeform box, which is where an entry carrying prose
        // has to live. She is still on the row.
        await page.click('.log-other-row:first-of-type .log-other-drop');
        await page.fill('#logOthersFree', 'Zelda Quill (v2, shadowing on I)');
        await expect(chip).toHaveCount(0);

        await page.fill('#logTitle', '76#2');
        await page.click('#logSubmit');
        expect(new URLSearchParams(bodies.at(-1)).get(OTHERS_ID))
            .toBe('Zelda Quill (v2, shadowing on I)');
    });

    test('a piece still reaches the sheet when the queue cannot be stored', async ({ page }) => {
        const bodies = await captureSubmits(page);
        await blockStorageWrites(page);
        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#1');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.click('#logSubmit');

        await expect(page.locator('#logStatus')).toContainText('Logged Haydn 76#1');
        // The claim has to be true: nothing persisted, so flush had nothing to
        // send and the submit is the only thing that could have sent it.
        expect(bodies.map(b => new URLSearchParams(b).get(TITLE_ID))).toEqual(['76#1']);
    });

    test('an unstorable piece that cannot be sent is never reported as logged', async ({ page }) => {
        // The failure this closes: nothing queued, nothing posted, and a green
        // "Logged" indistinguishable from a real one. The opaque response
        // means this line is the only acknowledgement a submit ever gets.
        await page.route('https://docs.google.com/forms/**', route => route.abort('internetdisconnected'));
        await blockStorageWrites(page);
        await pickComposer(page, 'Haydn');
        await page.fill('#logTitle', '76#1');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.click('#logSubmit');

        await expect(page.locator('#logStatus')).toHaveClass(/error/);
        await expect(page.locator('#logStatus')).not.toContainText('Logged Haydn');
        // There is no outbox to hold it, so the form must: nothing on screen
        // is lost, and the piece can be submitted again.
        await expect(page.locator('#logTitle')).toHaveValue('76#1');
        await expect(page.locator('#logSubmit')).toBeEnabled();
    });
});
