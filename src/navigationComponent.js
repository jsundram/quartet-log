import { BEGIN, PART_COLORS } from './config';

export class NavigationComponent {
    constructor(onFilterChange) {
        this.onFilterChange = onFilterChange;
        this.stop2date = null;
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

    getSelectedPlayer() {
        const selectElement = d3.select("#playerSelect").node();
        return selectElement ? selectElement.value : "ANY";
    }

    populatePlayerDropdown(players) {
        const select = d3.select("#playerSelect");
        const currentValue = select.node().value;

        // Keep currently selected player in list even if not in players array
        if (currentValue !== "ANY" && !players.includes(currentValue)) {
            players = [...players, currentValue].sort();
        }

        // Remove existing options except "ANY"
        select.selectAll("option").filter((d, i) => i > 0).remove();

        // Add all player options
        players.forEach(player => {
            select.append("option")
                .attr("value", player)
                .text(player);
        });

        // Restore previous selection if it still exists, otherwise reset to "ANY"
        if (players.includes(currentValue)) {
            select.node().value = currentValue;
        } else {
            select.node().value = "ANY";
        }

        // Add change listener
        select.on("change", () => this.onFilterChange("player"));
    }
}