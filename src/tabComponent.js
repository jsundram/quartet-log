import { COMPOSERS, ALL_WORKS, generateQuartetRouletteUrl } from './catalog';
import { BEGIN, PART_COLORS } from './config';
import { createEmptyRow } from './dataProcessor';

export class TabComponent {
    constructor() {
        this.tooltipDiv = d3.select("#tooltip");
    }

    createTabs() {
        COMPOSERS.forEach(composer => {
            // Create tab button
            d3.select("#tabs").append("button")
                .attr("data-composer", composer)
                .text(composer)
                .on("click", () => this.showTab(composer));

            // Create tab content div
            d3.select("#tabContent").append("div")
                .attr("class", "tab")
                .attr("id", composer);
        });
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

    updateTabContent(composer, filteredData, fullData) {
        // Process data for this composer
        const composerData = this.processComposerData(composer, filteredData, fullData);

        // Update the UI
        const composerDiv = d3.select("#" + composer);
        this.updateRandomButton(composerDiv, composerData);
        this.updateWorkRows(composerDiv, composerData);
        this.updateTotalCount(composerDiv, composerData);
    }

    processComposerData(composer, filteredData, fullData) {
        // group by title
        const m = D => new Map(d3.groups(D.filter(d => d.composer === composer), d => d.work.title));
        // make sure every title is present, fill in with [] if not.
        const fm = M => new Map(ALL_WORKS[composer].map(t => [t, M.get(t) || []]));

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
        const { allPlays } = composerData;
        const now = new Date();
        const maxDays = d3.timeDay.count(BEGIN, now);

        const weighted = Array.from(allPlays)
            .map(([t, ps]) => [t, ps.at(-1)?.timestamp || BEGIN])
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
                `${title} - not played in recorded history!`;

            composerDiv.select(".random-work-display").text(display);
        }
    }

    updateWorkRows(composerDiv, composerData) {
        const { filteredPlays, allPlays } = composerData;
        const rows = composerDiv.selectAll(".work-row")
            .data(filteredPlays, d => d[0])
            .join("div")
            .attr("class", "work-row");

        rows.each((group, i, nodes) => {
            const row = d3.select(nodes[i]);
            const [label, entries] = group;
            const composer = composerDiv.attr("id");

            this.updateWorkLabel(row, label, allPlays, composer);
            this.updatePlaySquares(row, entries);
        });
    }

    updateWorkLabel(row, label, allPlays, composer) {
        const labelContainer = row.selectAll(".work-label-container")
            .data([label])
            .join("div")
            .attr("class", "work-label-container");

        labelContainer.selectAll(".work-label")
            .data([label])
            .join("div")
            .attr("class", "work-label")
            .text(d => d)
            .on("mouseover", (event, d) => {
                const plays = allPlays.get(d);
                this.showTooltip(event, plays?.at(-1) || createEmptyRow(composer, label));
            })
            .on("mouseout", () => this.hideTooltip());
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
                d3.select(event.currentTarget)
                    .style("background-color", this.getColorForPart(d.part));
                this.hideTooltip();
            });

        squares.exit().remove();

        // Update count display
        squaresContainer.selectAll(".count-display").remove();
        if (entries.length >= 4) {
            squaresContainer.append("span")
                .attr("class", "count-display")
                .text(` (${entries.length})`)
                .style("margin-left", "5px")
                .style("color", "gray");
        }
    }

    updateTotalCount(composerDiv, composerData) {
        const { filteredPlays, allPlays } = composerData;

        const count = Array.from(filteredPlays.values()).flat().length;
        const rawData = Array.from(allPlays.values()).flat();
        const composer = rawData[0].composer || "played";
        const latest_ix = d3.maxIndex(rawData, d => d.timestamp);
        const latest = rawData[latest_ix].timestamp;
        const piece = rawData[latest_ix].work.title;
        const days = d3.timeDay.count(latest, Date.now())

        composerDiv.selectAll("p")
            .data([{ count, days, piece}])
            .join("p")
            .text(d => `Total: ${d.count}; Days since last ${composer}: ${d.days} (${d.piece}).`)
            .style("color", "gray");
    }

    getColorForPart(part, highlight = false) {
        if (highlight) return "#ffcc00";
        return PART_COLORS[part] || "gray";
    }

    showTooltip(event, d) {
        if (!d) return;

        const ts = d.timestamp ? d.timestamp.toLocaleDateString() : "Unplayed";
        const url = generateQuartetRouletteUrl(d);

        let html = `<h4><a href="${url}">${d.composer} - ${d.work.title}</a></h4>`;
        html += "<ul>";
        html += `<li>${ts}${d.location ? " - " + d.location : ""}</li>`;
        if (d.part) html += `<li>${d.part}</li>`;
        if (d.player1) html += `<li>${[d.player1, d.player2, d.player3].join(", ")}</li>`;
        if (d.comments?.trim()) html += `<li>${d.comments}</li>`;
        html += "</ul>";

        this.tooltipDiv
            .html(html)
            .style("display", "block");

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
