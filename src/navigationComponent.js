import { BEGIN, PART_COLORS } from './config';
import { clearDataUrl } from './urlConfig';

export class NavigationComponent {
    constructor(onFilterChange, onDownloadCSV) {
        this.onFilterChange = onFilterChange;
        this.onDownloadCSV = onDownloadCSV;
        this.stop2date = null;
        this.selectedPlayers = new Set();
        this.availablePlayers = [];

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
        const container = d3.select("#radioButtons");

        parts.forEach(part => {
            const radioButtonContainer = container.append("div")
                .style("display", "flex")
                .style("align-items", "center")
                .style("margin-right", "10px");

            radioButtonContainer.append("input")
                .attr("type", "radio")
                .attr("name", "part")
                .attr("value", part)
                .attr("id", part)
                .attr("checked", part === "ANY" ? "true" : null)
                .on("change", () => this.onFilterChange("part"));

            radioButtonContainer.append("label")
                .attr("for", part)
                .text(part);

            if (part !== "ANY") {
                radioButtonContainer.append("div")
                    .style("width", "10px")
                    .style("height", "10px")
                    .style("background-color", PART_COLORS[part])
                    .style("margin-left", "5px");
            }
        });
    }

    createDateSlider(endpoint) {
        const now = new Date();
        let stops = d3.timeMonth.range(BEGIN, now);
        stops.push(now);

        const container = d3.select("#dateSlider")
            .append("div")
            .style("display", "flex")
            .style("align-items", "center")
            .style("margin-bottom", "10px");

        container.append("span")
            .text(endpoint === 0 ? "Start" : "End")
            .style("margin-right", "10px")
            .style("margin-left", "20px");

        this.stop2date = v => v < stops.length ? stops[v] : stops[stops.length - 1];
        const v2d = v => this.stop2date(v).toLocaleDateString();

        const slider = container.append("input")
            .attr("id", `range-${endpoint}`)
            .attr("type", "range")
            .attr("min", 0)
            .attr("max", stops.length)
            .attr("step", 1)
            .attr("value", endpoint == 0 ? stops.length - 14 : stops.length)
            .style("margin-right", "10px")
            .on("input", () => {
                const value = d3.select(`#range-${endpoint}`).node().value;
                sliderValueDisplay.text(v2d(value));
                this.onFilterChange("date");
            });

        const sliderValueDisplay = container.append("span")
            .text(v2d(slider.node().value))
            .style("margin-right", "10px");
    }

    getSelectedDates() {
        let id2d = id => this.stop2date(parseInt(d3.select(id).node().value));
        return [id2d("#range-0"), id2d("#range-1")];
    }

    getSelectedPart() {
        return d3.select('input[name="part"]:checked').node().value;
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