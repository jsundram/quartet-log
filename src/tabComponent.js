import * as d3 from "d3";
import { COMPOSERS, ALL_WORKS, ALL_TAB, generateQuartetRouletteUrl, getPetersVolume, isMiscTab, isAllTab, getComposersForTab, getWorksForTab, getComposerForWork, getOriginalWorkTitle } from './catalog.js';
import { getBegin, getPartColor, getCssColor } from './config.js';
import { createEmptyRow, computeAggregateStats, formatStreakStart } from './dataProcessor.js';
import { escapeHtml } from './escapeHtml.js';
import { tooltip } from './tooltip.js';

// Body of a work tooltip. Pure and exported for tests: every sheet-derived
// value (composer, title, location, part, players, comments) is escaped —
// comments especially are free-form user text.
export function buildWorkTooltipHtml(d) {
    const ts = d.timestamp ? d.timestamp.toLocaleDateString() : "Unplayed";
    const url = generateQuartetRouletteUrl(d);

    const petersVol = d.composer === 'Haydn' ? getPetersVolume(d.work) : null;
    const petersSuffix = petersVol ? `: Peters ${escapeHtml(petersVol)}` : '';
    // target="_blank" is load-bearing on iOS homescreen webclips: without
    // it, taps on the link from inside the standalone webapp can fail to
    // navigate to quartetroulette.com. rel pairs with it for security.
    let html = `<h4><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.composer)} - ${escapeHtml(d.work.title)}</a>${petersSuffix}</h4>`;
    html += "<ul>";
    html += `<li>${ts}${d.location ? " - " + escapeHtml(d.location) : ""}</li>`;
    if (d.part) html += `<li>${escapeHtml(d.part)}</li>`;
    if (d.player1) html += `<li>${escapeHtml([d.player1, d.player2, d.player3].join(", "))}</li>`;
    if (d.comments?.trim()) html += `<li>${escapeHtml(d.comments)}</li>`;
    html += "</ul>";
    return html;
}

// Weighted random suggestion over a tab's works: weight = days since the
// work's last play in the current filtered view (never-played falls back to
// `begin`, i.e. the maximum weight), so the pick leans toward what's
// least-recently played. Pure — `random` in [0, 1) is injected so tests are
// deterministic. Returns { title, daysAgo, display } or null for an empty pool.
export function pickRandomWork(filteredPlays, now, begin, random) {
    const maxDays = d3.timeDay.count(begin, now);
    const weighted = Array.from(filteredPlays)
        .map(([t, ps]) => [t, ps.at(-1)?.timestamp || begin])
        .map(([t, ts]) => [t, d3.timeDay.count(ts, now)]);

    const total = d3.sum(weighted, d => d[1]);
    const r = random * total;

    let cumulative = 0;
    const selected = weighted.find(([, weight]) => {
        cumulative += weight;
        return r <= cumulative;
    });
    if (!selected) return null;

    const [title, daysAgo] = selected;
    const display = daysAgo < maxDays
        ? `${title} - (last played ${daysAgo} days ago)`
        : `${title} - not played in this view!`;
    return { title, daysAgo, display };
}

export class TabComponent {
    constructor(tableComponent) {
        this.tableComponent = tableComponent;
    }

    createTabs() {
        const makeTab = (name) => {
            d3.select("#tabs").append("button")
                .attr("data-composer", name)
                .text(name)
                .on("click", () => this.showTab(name));
            d3.select("#tabContent").append("div")
                .attr("class", "tab")
                .attr("id", name);
        };
        COMPOSERS.forEach(makeTab);
        // ALL goes last — special aggregate-stats + flat-table view.
        makeTab(ALL_TAB);
    }

    showTab(composer) {
        // Hide all tabs and remove active class from all tab buttons
        d3.selectAll(".tab").classed("active-tab", false);
        d3.selectAll("#tabs button").classed("active-tab-button", false);

        // Show selected tab and add active class to the tab button
        d3.select(`#${composer}`).classed("active-tab", true);
        d3.select(`#tabs button[data-composer='${composer}']`).classed("active-tab-button", true);

        // Scroll the active tab button into view
        const activeTabButton = d3.select(`#tabs button[data-composer='${composer}']`).node();
        if (activeTabButton) {
            activeTabButton.scrollIntoView({ inline: "center", behavior: "smooth" });
        }
    }

    updateTabContent(composer, part, filteredData, fullData) {
        const composerDiv = d3.select("#" + composer);

        // ALL tab has no works / random button / catalog completeness line —
        // just aggregate stats + a flat data table over the filtered slice.
        if (isAllTab(composer)) {
            this.updateAllTabContent(composerDiv, filteredData);
            return;
        }

        // Process data for this composer
        const composerData = this.processComposerData(composer, filteredData, fullData);

        // Update the UI
        this.updateRandomButton(composerDiv, composerData);
        this.updateWorkRows(composerDiv, composerData, part);
        this.updateTotalCount(composerDiv, composerData);
        this.updateDataTable(composerDiv, composerData);

    }

    updateAllTabContent(composerDiv, filteredData) {
        const agg = computeAggregateStats(filteredData);
        const streakStart = formatStreakStart(agg.maxStreakInfo);
        // Same explainer copy as the dashboard's KPI tiles — both describe
        // the slice matching the current filters.
        const stats = [
            {
                label: 'Pieces',
                value: agg.pieces,
                title: 'Pieces in the current filter',
                desc: "Total quartets logged in this window. Partial-movement entries don't count — only whole pieces.",
            },
            {
                label: 'Unique pieces',
                value: agg.uniquePieces,
                title: 'Unique pieces in the current filter',
                desc: 'Distinct works (composer + title). Repeats of the same piece collapse to one.',
            },
            {
                label: 'Unique people',
                value: agg.uniquePeople,
                title: 'People played with in the current filter',
                desc: 'Distinct people logged in Player 1/2/3 and the Others? column, after alias normalization. Short names are resolved per-instrument via PLAYER_ALIASES.',
            },
            {
                label: 'Days played',
                value: agg.daysPlayed,
                title: 'Playing days in the current filter',
                desc: 'Distinct days with at least one whole piece logged.',
            },
            {
                label: 'Max streak',
                value: agg.maxStreak,
                title: 'Longest streak in the current filter',
                desc: 'Longest run of consecutive days with at least one whole piece logged, within the current filter.'
                    + (streakStart ? `<br><br>Started: ${streakStart}` : ''),
            },
        ];

        const wrap = composerDiv.selectAll('.all-stats')
            .data([1])
            .join('div')
            .attr('class', 'all-stats');

        const row = wrap.selectAll('.all-stats-row')
            .data([1])
            .join('div')
            .attr('class', 'all-stats-row');

        const cells = row.selectAll('.all-stat')
            .data(stats, d => d.label)
            .join(enter => {
                const cell = enter.append('div').attr('class', 'all-stat');
                cell.append('span').attr('class', 'all-stat-label');
                cell.append('span').attr('class', 'all-stat-value');
                return cell;
            });
        cells.select('.all-stat-label').text(d => `${d.label}:`);
        cells.select('.all-stat-value').text(d => d.value);
        // Explainer tooltip; stat titles/descriptions are app-authored
        // constants (no sheet data).
        tooltip.attach(cells, (event, d) => `<h4>${d.title}</h4><p>${d.desc}</p>`,
            { maxWidth: '320px' });

        // Reuse the existing data table by wrapping the flat array in the
        // shape updateDataTable expects.
        const composerData = {
            filteredPlays: new Map([['__all__', filteredData]]),
            allPlays: new Map([['__all__', filteredData]]),
        };
        this.updateDataTable(composerDiv, composerData);
    }

    processComposerData(composer, filteredData, fullData) {
        const composers = getComposersForTab(composer);
        const works = getWorksForTab(composer);

        // For MISC tab, transform work titles to include composer prefix
        const transformTitle = isMiscTab(composer)
            ? d => `${d.composer}-${d.work.title}`
            : d => d.work.title;

        // group by title (with optional transformation)
        // Filter to only include works in the catalog for this tab
        const m = D => new Map(d3.groups(
            D.filter(d => {
                const title = transformTitle(d);
                return composers.includes(d.composer) && works.includes(title);
            }),
            d => transformTitle(d)
        ));
        // make sure every title is present, fill in with [] if not.
        const fm = M => new Map(works.map(t => [t, M.get(t) || []]));

        const filteredPlays = fm(m(filteredData));
        const allPlays = fm(m(fullData));

        return { filteredPlays, allPlays };
    }

    updateRandomButton(composerDiv, composerData) {
        const randomButtonContainer = composerDiv.selectAll(".random-button-container")
            .data([1])
            .join("div")
            .attr("class", "random-button-container")
            .style("display", "flex")
            .style("align-items", "center");

        // Only create button and display span if they don't exist
        if (!randomButtonContainer.select("button").size()) {
            randomButtonContainer.append("button")
                .attr("class", "random-button")
                .text("Random");

            randomButtonContainer.append("span")
                .attr("class", "random-work-display")
                .style("margin-left", "10px");
        }

        // (Re)bind on EVERY update, not just at creation — d3's .on replaces
        // the previous listener, so the handler always reads the composerData
        // from the latest updateTabContent call. Binding only at creation
        // froze the first render's data in the closure, so the suggestion
        // ignored every later filter change.
        randomButtonContainer.select("button")
            .on("click", () => this.handleRandomSelection(composerDiv, composerData));
    }

    handleRandomSelection(composerDiv, composerData) {
        // Use filteredPlays so the suggestion respects the current Date/Part/Player
        // filters: works never played under those filters fall back to getBegin()
        // (maxDays weight), nudging the pick toward what's least-recently played
        // in the current context.
        const selected = pickRandomWork(composerData.filteredPlays, new Date(), getBegin(), Math.random());
        if (selected) {
            composerDiv.select(".random-work-display").text(selected.display);
        }
    }

    updateWorkRows(composerDiv, composerData, part) {
        const { filteredPlays, allPlays } = composerData;
        const rows = composerDiv.selectAll(".work-row")
            .data(filteredPlays, d => d[0])
            .join("div")
            .attr("class", "work-row");

        rows.each((group, i, nodes) => {
            const row = d3.select(nodes[i]);
            const [label, entries] = group;
            const composer = composerDiv.attr("id");

            this.updateWorkLabel(row, label, composerData, composer, part);
            this.updatePlaySquares(row, entries);
        });
    }

    updateWorkLabel(row, label, composerData, composer, part) {
        const { filteredPlays, allPlays } = composerData;
        const labelContainer = row.selectAll(".work-label-container")
            .data([label])
            .join("div")
            .attr("class", "work-label-container");

        // No mouseout/mouseleave handler: auto-dismissing on cursor-leaves-
        // label kills the path to clicking the link inside the tooltip
        // (mouseout fires when the cursor moves from .work-label into the
        // tooltip). Dismissal is the tooltip module's click-outside listener
        // and the × button; own() below registers the labels as triggers.
        labelContainer.selectAll(".work-label")
            .data([label])
            .join("div")
            .attr("class", "work-label")
            .text(d => d)
            .on("mouseover", (event, d) => {
                // Want to find the last time that this piece was played on this part
                // before the filter start date and set that as a tooltip for the
                // piece label.
                const all = allPlays.get(d).filter(d => ["ANY", d.part].includes(part));
                const ts = filteredPlays.get(d).at(0)?.timestamp;
                let index = -1;
                if (ts !== undefined) {
                    index = all.findIndex(d => d.timestamp === ts);
                    // if filtered includes everything, just use the first one.
                    index = index === 0 ? index : (index - 1);
                }

                // For MISC tab, extract the real composer and original work title
                const realComposer = all?.at(0)?.composer || getComposerForWork(composer, label);
                const originalTitle = getOriginalWorkTitle(composer, label);

                this.showTooltip(event, all?.at(index) || createEmptyRow(realComposer, originalTitle));
            })
            .call(sel => tooltip.own(sel));
    }

    updatePlaySquares(row, entries) {
        const squaresContainer = row.selectAll(".squares-container")
            .data([entries])
            .join("div")
            .attr("class", "squares-container");

        // Update play squares
        const squares = squaresContainer.selectAll(".play-square")
            .data(d => d, d => d.timestamp);

        squares.enter()
            .append("div")
            .attr("class", "play-square")
            .merge(squares)
            .style("background-color", d => this.getColorForPart(d.part))
            .on("mouseover", (event, d) => {
                d3.select(event.currentTarget)
                    .style("background-color", this.getColorForPart(d.part, true));
                this.showTooltip(event, d);
            })
            .on("mouseout", (event, d) => {
                // Reset hover-highlight bg; tooltip dismissal is the tooltip
                // module's click-outside listener (squares are own()ed below).
                d3.select(event.currentTarget)
                    .style("background-color", this.getColorForPart(d.part));
            })
            .call(sel => tooltip.own(sel));

        squares.exit().remove();

        // Update count display
        squaresContainer.selectAll(".count-display").remove();
        if (entries.length >= 4) {
            squaresContainer.append("span")
                .attr("class", "count-display")
                .text(` (${entries.length})`)
                .style("margin-left", "5px")
                .style("color", "var(--color-text-tertiary)");
        }
    }

    updateTotalCount(composerDiv, composerData) {
        const { filteredPlays, allPlays } = composerData;
        const tabName = composerDiv.attr("id");

        const count = Array.from(filteredPlays.values()).flat().length;
        const totalWorks = filteredPlays.size;
        const uniqueWorks = Array.from(filteredPlays.values()).filter(plays => plays.length > 0).length;
        const percent = totalWorks > 0 ? Math.round((uniqueWorks / totalWorks) * 100) : 0;
        const rawData = Array.from(allPlays.values()).flat();

        // Composer never played at all (allPlays empty across every catalog
        // entry). Show a stripped-down line — there's no "latest piece" to
        // anchor the days-since count. This is the common case for fresh
        // users who only have entries from a handful of composers.
        if (rawData.length === 0) {
            composerDiv.selectAll("p")
                .data([{ count, uniqueWorks, totalWorks }])
                .join("p")
                .text(d => `Total: ${d.count}; Unique: ${d.uniqueWorks} of ${d.totalWorks} (0%); never played.`)
                .style("color", "var(--color-text-tertiary)");
            return;
        }

        const latest_ix = d3.maxIndex(rawData, d => d.timestamp);
        const latestEntry = rawData[latest_ix];
        const latest = latestEntry.timestamp;
        const days = d3.timeDay.count(latest, Date.now());

        // For MISC tab, use "MISC" as composer name and show prefixed work title
        const composerName = isMiscTab(tabName) ? tabName : (latestEntry.composer || "played");
        const piece = isMiscTab(tabName)
            ? `${latestEntry.composer}-${latestEntry.work.title}`
            : latestEntry.work.title;

        composerDiv.selectAll("p")
            .data([{ count, uniqueWorks, totalWorks, percent, days, piece}])
            .join("p")
            .text(d => `Total: ${d.count}; Unique: ${d.uniqueWorks} of ${d.totalWorks} (${d.percent}%); Days since last ${composerName}: ${d.days} (${d.piece}).`)
            .style("color", "var(--color-text-tertiary)");
    }

    updateDataTable(composerDiv, composerData){
        const composer = composerDiv.attr("id");
        composerDiv.selectAll(".table-container")
            .data([composerData])  // This will update the bound data on the container
            .join(
                enter => {
                    const container = enter.append("div")
                        .attr("class", "table-container");
                    this.tableComponent.createTable(container.node(), composer);
                    return container;
                },
                update => update  // Existing containers keep their structure but get new data
            )
            .call(container => this.tableComponent.updateTable(composerData, container));
    }

    getColorForPart(part, highlight = false) {
        if (highlight) return getCssColor('--color-highlight');
        return getPartColor(part);
    }

    showTooltip(event, d) {
        if (!d) return;
        // Wide tooltip: no max-width cap — the CSS viewport clamp governs.
        tooltip.show(event, buildWorkTooltipHtml(d));
    }

    hideTooltip() {
        tooltip.hide();
    }
}
