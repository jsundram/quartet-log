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

test('an unconfigured visitor gets the setup panel, not someone else\'s form', async ({ page }) => {
    // The whole point of per-user config: this site is public, so a visitor
    // with their own sheet must never be handed a form that posts their rows
    // into a stranger's spreadsheet.
    await page.evaluate(() => { window.location.hash = '#log'; });
    await expect(page.locator('#logSetup')).toBeVisible();
    await expect(page.locator('#logForm')).toBeHidden();
    await expect(page.locator('#logSetupSave')).toBeDisabled();

    // A link that isn't one field per column is refused rather than guessed
    // at — a shifted mapping writes every column one cell over.
    await page.fill('#logSetupLink', `https://docs.google.com/forms/d/e/${FORM_ID}/viewform?entry.1=a`);
    await expect(page.locator('#logSetupError')).toContainText('pre-filled link');
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
});

test.describe('log form', () => {
    // Capture Forms submissions instead of sending them. The route is
    // anchored to the /forms/ path so it can't swallow the sheet stub above.
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
        await expect(page.locator('#logForm')).toBeVisible();
        // The param is stripped so it can't linger in history or re-apply.
        expect(new URL(page.url()).searchParams.get('form')).toBeNull();
    });

    test('offers every catalog composer and suggests that composer works', async ({ page }) => {
        const options = await page.locator('#logComposer option').allTextContents();
        // The Google Form's own radio lists seven; the catalog knows far more,
        // and all of them have to be reachable.
        expect(options.length).toBeGreaterThan(10);
        expect(options).toContain('Haydn');
        expect(options).toContain('Debussy');   // lives only inside the MISC tab
        expect(options.at(-1)).toBe('Other...');

        await page.selectOption('#logComposer', 'Haydn');
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

        await page.selectOption('#logComposer', 'Haydn');
        await page.fill('#logTitle', '76#1');
        await page.click('#logPart .part-btn[data-part="V1"]');
        await page.fill('#logPlayer2', 'Erin');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');

        const body = new URLSearchParams(bodies.at(-1));
        expect(body.get(COMPOSER_ID)).toBe('Haydn');
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
        await page.selectOption('#logComposer', 'Haydn');
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

    test('a composer outside the form option list rides the Other escape', async ({ page }) => {
        const bodies = await captureSubmits(page);
        await page.selectOption('#logComposer', 'Brahms');
        await page.fill('#logTitle', '51#1');
        await page.click('#logPart .part-btn[data-part="VA1"]');
        await page.click('#logSubmit');
        await expect(page.locator('#logStatus')).toContainText('Logged');

        const body = new URLSearchParams(bodies.at(-1));
        expect(body.get(COMPOSER_ID)).toBe('__other_option__');
        expect(body.get(`${COMPOSER_ID}.other_option_response`)).toBe('Brahms');
    });

    test('an Other composer survives the post-submit reset', async ({ page }) => {
        await captureSubmits(page);
        await page.selectOption('#logComposer', ' other');
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
        await page.selectOption('#logComposer', 'Haydn');
        await page.click('#logSubmit');
        // Forms rejects server-side and mode:'no-cors' hides the rejection, so
        // an unchecked submit would look exactly like a successful one.
        await expect(page.locator('#logStatus')).toContainText('Work Title');
        await expect(page.locator('#logStatus')).toContainText('Which Part');
        expect(bodies).toHaveLength(0);
    });

    test('queues when the network fails, and drains in order once it returns', async ({ page }) => {
        let online = false;
        const bodies = [];
        await page.route('https://docs.google.com/forms/**', route => {
            if (!online) return route.abort('internetdisconnected');
            bodies.push(route.request().postData());
            route.fulfill({ status: 200, body: '' });
        });

        await page.selectOption('#logComposer', 'Haydn');
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
});
