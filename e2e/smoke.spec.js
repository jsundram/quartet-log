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
    `${day(8, '19:00:00')},Haydn,76#3,V2,Dave,Erin,Frank,Grace (piano),Hall,`,
    `${day(7, '19:00:00')},Beethoven,18#4,VA,Alice,Dave,Carol,,Home,`,
    `${day(7, '19:30:00')},Haydn,64#5:I,VA,,,,,Home,partial movement — must be filtered`,
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
    // Exactly one Part button group.
    await expect(page.locator('.part-buttons')).toHaveCount(1);
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
