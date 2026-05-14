import { clearDataUrl } from './urlConfig';
import { DateFilterWidget } from './dateFilterWidget';

export class NavigationComponent {
    constructor(onFilterChange, onDownloadCSV, onViewChange = null) {
        this.onFilterChange = onFilterChange;
        this.onDownloadCSV = onDownloadCSV;
        this.onViewChange = onViewChange;
        this.selectedPlayers = new Set();
        this.availablePlayers = [];
        this.dateFilter = new DateFilterWidget('#dateSlider', () => this.onFilterChange('date'));

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
        if (view === "todo") return (window.location.href = "./TODO.html");
        if (view === "howto") return (window.location.href = "./howto.html");
        if (view === "about") return (window.location.href = "./about.html");

        const VIEW_TO_SELECTOR = {
            main: "#mainContent",
            calendar: "#calendar",
            dashboard: "#dashboard",
        };

        // Hide every known view container, then show the target (default main).
        Object.values(VIEW_TO_SELECTOR).forEach(sel => {
            d3.select(sel).style("display", "none");
        });
        const target = VIEW_TO_SELECTOR[view] || VIEW_TO_SELECTOR.main;
        d3.select(target).style("display", "block");

        d3.select(".menu-items").style("display", "none");

        if (this.onViewChange) this.onViewChange(view);
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
        this.dateFilter.render();
    }

    getSelectedDates() {
        return this.dateFilter.getRange();
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