import { getBegin } from './config';
import { clearDataUrl } from './urlConfig';

export class NavigationComponent {
    constructor(onFilterChange, onDownloadCSV) {
        this.onFilterChange = onFilterChange;
        this.onDownloadCSV = onDownloadCSV;
        this.selectedPlayers = new Set();
        this.availablePlayers = [];
        this.currentRange = "1Y";
        this.startDate = null;
        this.endDate = null;

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            const multiselect = document.getElementById('playerSelect');
            if (multiselect && !multiselect.contains(e.target)) {
                this.closeDropdown();
            }
        });
    }

    createMenu() {
        const hamburgerMenu = d3.select(".hamburger-menu");
        const menuItems = d3.select(".menu-items");

        hamburgerMenu.on("click", () => {
            menuItems.style("display", 
                menuItems.style("display") === "block" ? "none" : "block"
            );
        });

        d3.selectAll(".menu-item").on("click", (event) => {
            event.preventDefault();
            const view = d3.select(event.currentTarget).attr("data-view");

            if (view === "download-csv") {
                if (this.onDownloadCSV) {
                    this.onDownloadCSV();
                }
                menuItems.style("display", "none");
                return;
            }

            if (view === "clear-data") {
                menuItems.style("display", "none");
                if (confirm("This will clear your saved data URL. You'll need to re-enter it to use the app. Continue?")) {
                    clearDataUrl();
                    window.location.reload();
                }
                return;
            }

            this.switchView(view);
        });
    }

    switchView(view) {
        if (view === "calendar") {
            d3.select("#mainContent").style("display", "none");
            d3.select("#calendar").style("display", "block");
        } else if (view === "todo") {
            window.location.href = "./TODO.html";
        } else if (view === "howto") {
            window.location.href = "./howto.html";
        } else if (view === "about") {
            window.location.href = "./about.html";
        } else {
            d3.select("#mainContent").style("display", "block");
            d3.select("#calendar").style("display", "none");
        }

        const menuItems = d3.select(".menu-items");
        menuItems.style("display", "none");
    }

    createRadioButtons() {
        const parts = ["V1", "V2", "VA", "ANY"];
        // Prepend so Part sits to the left of the existing Player widget.
        const group = d3.select("#radioButtons")
            .insert("div", ":first-child")
            .attr("class", "part-buttons")
            .attr("role", "radiogroup")
            .attr("aria-label", "Part filter");

        parts.forEach(part => {
            group.append("button")
                .attr("type", "button")
                .attr("class", `part-btn${part === "ANY" ? " active" : ""}`)
                .attr("data-part", part)
                .text(part)
                .on("click", () => this.handlePartClick(part));
        });
    }

    handlePartClick(part) {
        d3.selectAll(".part-btn").classed("active", function () {
            return d3.select(this).attr("data-part") === part;
        });
        this.onFilterChange("part");
    }

    createDateFilter() {
        // Initialize default date range (1Y)
        this.updateDatesFromRange(this.currentRange);

        const container = d3.select("#dateSlider")
            .append("div")
            .attr("class", "date-filter-container");

        // Segmented button group
        const buttonGroup = container.append("div")
            .attr("class", "date-range-buttons");

        const ranges = [
            { id: "ALL", label: "All" },
            { id: "YTD", label: "YTD" },
            { id: "1Y", label: "1Y" },
            { id: "6M", label: "6M" },
            { id: "CUSTOM", label: "Custom" }
        ];

        ranges.forEach(r => {
            buttonGroup.append("button")
                .attr("type", "button")
                .attr("class", `date-range-btn${r.id === this.currentRange ? " active" : ""}`)
                .attr("data-range", r.id)
                .text(r.label)
                .on("click", () => this.handleRangeClick(r.id));
        });

        // Custom date range inputs (hidden until Custom is selected)
        const customContainer = container.append("div")
            .attr("class", "custom-date-range")
            .style("display", "none");

        customContainer.append("input")
            .attr("type", "date")
            .attr("class", "custom-date-input")
            .attr("aria-label", "Start date")
            .attr("id", "customStart")
            .on("change", () => this.handleCustomDateChange());

        customContainer.append("span")
            .attr("class", "custom-date-sep")
            .text("→");

        customContainer.append("input")
            .attr("type", "date")
            .attr("class", "custom-date-input")
            .attr("aria-label", "End date")
            .attr("id", "customEnd")
            .on("change", () => this.handleCustomDateChange());
    }

    handleRangeClick(rangeId) {
        this.currentRange = rangeId;

        d3.selectAll(".date-range-btn").classed("active", function() {
            return d3.select(this).attr("data-range") === rangeId;
        });

        const customContainer = d3.select(".custom-date-range");

        if (rangeId === "CUSTOM") {
            // Pre-fill the date inputs with the currently active range
            const minStr = this.toDateInputValue(getBegin());
            const maxStr = this.toDateInputValue(new Date());
            d3.select("#customStart")
                .attr("min", minStr)
                .attr("max", maxStr)
                .property("value", this.toDateInputValue(this.startDate));
            d3.select("#customEnd")
                .attr("min", minStr)
                .attr("max", maxStr)
                .property("value", this.toDateInputValue(this.endDate));
            customContainer.style("display", "flex");
        } else {
            customContainer.style("display", "none");
            this.updateDatesFromRange(rangeId);
            this.onFilterChange("date");
        }
    }

    handleCustomDateChange() {
        const startStr = d3.select("#customStart").property("value");
        const endStr = d3.select("#customEnd").property("value");
        if (!startStr || !endStr) return;

        const start = this.fromDateInputValue(startStr);
        const end = this.fromDateInputValue(endStr, true);
        if (start > end) return;

        this.startDate = start;
        this.endDate = end;
        this.onFilterChange("date");
    }

    updateDatesFromRange(rangeId) {
        const now = new Date();
        let start;

        switch (rangeId) {
            case "ALL":
                start = getBegin();
                break;
            case "YTD":
                start = new Date(now.getFullYear(), 0, 1);
                break;
            case "1Y":
                start = new Date(now);
                start.setFullYear(start.getFullYear() - 1);
                break;
            case "6M":
                start = new Date(now);
                start.setMonth(start.getMonth() - 6);
                break;
            default:
                start = getBegin();
        }

        this.startDate = start;
        this.endDate = now;
    }

    toDateInputValue(date) {
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }

    fromDateInputValue(str, endOfDay = false) {
        const [y, m, d] = str.split('-').map(Number);
        return endOfDay
            ? new Date(y, m - 1, d, 23, 59, 59, 999)
            : new Date(y, m - 1, d);
    }

    getSelectedDates() {
        return [this.startDate, this.endDate];
    }

    getSelectedPart() {
        const active = d3.select(".part-btn.active").node();
        return active ? active.getAttribute("data-part") : "ANY";
    }

    getSelectedPlayers() {
        return Array.from(this.selectedPlayers);
    }

    populatePlayerDropdown(players) {
        this.availablePlayers = players;

        // Remove selected players that are no longer in the available list
        for (const selected of this.selectedPlayers) {
            if (!players.includes(selected)) {
                this.selectedPlayers.delete(selected);
            }
        }

        this.renderDropdown();
        this.updateTriggerText();
        this.sizePlayerWidget();
    }

    // Size the trigger + dropdown to the widest player name so that selecting
    // a long name (or opening the dropdown) doesn't cause a layout shift in
    // the surrounding row.
    sizePlayerWidget() {
        if (this.availablePlayers.length === 0) return;

        const trigger = document.querySelector("#playerSelect .player-select-trigger");
        const dropdown = document.querySelector("#playerSelect .player-dropdown");
        if (!trigger || !dropdown) return;

        const ctx = document.createElement("canvas").getContext("2d");
        ctx.font = window.getComputedStyle(trigger).font;

        // Every label the trigger might display
        const candidates = [
            "ANY",
            `${this.availablePlayers.length} selected`,
            ...this.availablePlayers,
        ];
        const maxText = Math.max(...candidates.map(s => ctx.measureText(s).width));

        // Trigger padding is 4px 8px → 16px horizontal.
        trigger.style.minWidth = Math.ceil(maxText + 16) + "px";
        // Dropdown options add a checkbox (~16px) and 6px gap on top of the
        // same 16px horizontal padding.
        dropdown.style.minWidth = Math.ceil(maxText + 16 + 16 + 6) + "px";
    }

    renderDropdown() {
        const dropdown = d3.select("#playerSelect .player-dropdown");
        dropdown.html("");

        // Add "Clear All" option if there are selections
        if (this.selectedPlayers.size > 0) {
            dropdown.append("div")
                .attr("class", "player-clear")
                .text("Clear All")
                .on("click", (e) => {
                    e.stopPropagation();
                    this.clearPlayerSelections();
                });
        }

        // Add player options with checkboxes
        this.availablePlayers.forEach(player => {
            const option = dropdown.append("div")
                .attr("class", "player-option");

            const checkbox = option.append("input")
                .attr("type", "checkbox")
                .attr("id", `player-${player}`)
                .attr("checked", this.selectedPlayers.has(player) ? "checked" : null)
                .on("change", (e) => {
                    e.stopPropagation();
                    this.togglePlayerSelection(player);
                });

            option.append("label")
                .attr("for", `player-${player}`)
                .text(player)
                .on("click", (e) => {
                    e.stopPropagation();
                    // Let the label's default behavior toggle the checkbox
                });
        });

        // Set up trigger click handler
        d3.select("#playerSelect .player-select-trigger")
            .on("click", (e) => {
                e.stopPropagation();
                this.toggleDropdown();
            });
    }

    togglePlayerSelection(player) {
        if (this.selectedPlayers.has(player)) {
            this.selectedPlayers.delete(player);
        } else {
            this.selectedPlayers.add(player);
        }
        this.renderDropdown();
        this.updateTriggerText();
        this.onFilterChange("player");
    }

    clearPlayerSelections() {
        this.selectedPlayers.clear();
        this.renderDropdown();
        this.updateTriggerText();
        this.onFilterChange("player");
    }

    updateTriggerText() {
        const trigger = d3.select("#playerSelect .player-select-trigger");
        const count = this.selectedPlayers.size;
        if (count === 0) {
            trigger.text("ANY");
        } else if (count === 1) {
            trigger.text(Array.from(this.selectedPlayers)[0]);
        } else {
            trigger.text(`${count} selected`);
        }
    }

    toggleDropdown() {
        const dropdown = d3.select("#playerSelect .player-dropdown");
        const isOpen = dropdown.classed("open");
        dropdown.classed("open", !isOpen);
    }

    closeDropdown() {
        d3.select("#playerSelect .player-dropdown").classed("open", false);
    }
}