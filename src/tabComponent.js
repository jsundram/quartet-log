import { COMPOSERS, ALL_WORKS, ALL_TAB, generateQuartetRouletteUrl, getPetersVolume, isMiscTab, isAllTab, getComposersForTab, getWorksForTab, getComposerForWork, getOriginalWorkTitle } from './catalog';
import { getBegin, getPartColor, getCssColor } from './config';
import { createEmptyRow, computeAggregateStats } from './dataProcessor';

export class TabComponent {
    constructor(tableComponent) {
        this.tooltipDiv = d3.select("#tooltip");
        this.tableComponent = tableComponent;

        // Tap/click outside the tooltip dismisses it. Pairs with the touch-
        // friendly mouseout gating on .work-label and .play-square — without
        // a tap-outside path, touch users could only dismiss via the × button.
        // Taps on the triggering elements don't dismiss because their own
        // mouseover/click handlers re-show (or replace) the tooltip content.
        document.addEventListener('click', (e) => {
            const tooltipNode = this.tooltipDiv.node();
            if (!tooltipNode || tooltipNode.style.display === 'none') return;
            if (tooltipNode.contains(e.target)) return;
            const cls = e.target.classList;
            if (cls?.contains('work-label') || cls?.contains('play-square')) return;
            this.hideTooltip();
        });
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
        const stats = [
            { label: 'Pieces', value: agg.pieces },
            { label: 'Unique pieces', value: agg.uniquePieces },
            { label: 'Unique people', value: agg.uniquePeople },
            { label: 'Days played', value: agg.daysPlayed },
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
                .text("Random")
                .on("click", () => this.handleRandomSelection(composerDiv, composerData));

            randomButtonContainer.append("span")
                .attr("class", "random-work-display")
                .style("margin-left", "10px");
        }
    }

    handleRandomSelection(composerDiv, composerData) {
        // Use filteredPlays so the suggestion respects the current Date/Part/Player
        // filters: works never played under those filters fall back to getBegin()
        // (maxDays weight), nudging the pick toward what's least-recently played
        // in the current context.
        const { filteredPlays } = composerData;
        const now = new Date();
        const maxDays = d3.timeDay.count(getBegin(), now);

        const weighted = Array.from(filteredPlays)
            .map(([t, ps]) => [t, ps.at(-1)?.timestamp || getBegin()])
            .map(([t, ts]) => [t, d3.timeDay.count(ts, now)])

        // Select work using weighted random selection
        const total = d3.sum(weighted, d => d[1]);
        const random = Math.random() * total;

        let cumulative = 0;
        const selected = weighted.find(([t, weight]) => {
            cumulative += weight;
            return random <= cumulative;
        });

        // Update display
        if (selected) {
            const [title, daysAgo] = selected;
            const display = daysAgo < maxDays ?
                `${title} - (last played ${daysAgo} days ago)` :
                `${title} - not played in this view!`;

            composerDiv.select(".random-work-display").text(display);
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
        // tooltip). Dismissal is handled uniformly by the document click-
        // outside listener (set up in the constructor) and the × button.
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
            });
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
                // Reset hover-highlight bg; tooltip dismissal is the document
                // click-outside handler's job (see constructor).
                d3.select(event.currentTarget)
                    .style("background-color", this.getColorForPart(d.part));
            });

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

        const ts = d.timestamp ? d.timestamp.toLocaleDateString() : "Unplayed";
        const url = generateQuartetRouletteUrl(d);

        let html = `<span class="tooltip-close">&times;</span>`;
        const petersVol = d.composer === 'Haydn' ? getPetersVolume(d.work) : null;
        const petersSuffix = petersVol ? `: Peters ${petersVol}` : '';
        // target="_blank" is load-bearing on iOS homescreen webclips: without
        // it, taps on the link from inside the standalone webapp can fail to
        // navigate to quartetroulette.com. rel pairs with it for security.
        html += `<h4><a href="${url}" target="_blank" rel="noopener noreferrer">${d.composer} - ${d.work.title}</a>${petersSuffix}</h4>`;
        html += "<ul>";
        html += `<li>${ts}${d.location ? " - " + d.location : ""}</li>`;
        if (d.part) html += `<li>${d.part}</li>`;
        if (d.player1) html += `<li>${[d.player1, d.player2, d.player3].join(", ")}</li>`;
        if (d.comments?.trim()) html += `<li>${d.comments}</li>`;
        html += "</ul>";

        this.tooltipDiv
            .html(html)
            .style("display", "block");

        // Add click handler to close button
        this.tooltipDiv.select(".tooltip-close")
            .on("click", () => this.hideTooltip());

        this.positionTooltip(event);
    }

    positionTooltip(event) {
        const tooltip = this.tooltipDiv.node();
        const tRect = tooltip.getBoundingClientRect();
        const margin = 10;

        let left = event.pageX + margin;
        let top = event.pageY + margin;

        // Adjust position to keep tooltip within viewport
        if (left + tRect.width > window.innerWidth) {
            left = Math.max(margin, event.pageX - tRect.width - margin);
        }
        if (top + tRect.height > window.innerHeight) {
            top = Math.max(margin, event.pageY - tRect.height - margin);
        }

        this.tooltipDiv
            .style("left", left + "px")
            .style("top", top + "px");
    }

    hideTooltip() {
        this.tooltipDiv.style("display", "none");
    }
}
