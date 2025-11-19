import { COMPOSERS, DEFAULT_COMPOSER, loadWorkCatalog } from './catalog';
import { DataService } from './dataService';
import { extractUniquePlayers } from './dataProcessor';
import { NavigationComponent } from './navigationComponent';
import { TabComponent } from './tabComponent';
import { CalendarComponent } from './calendarComponent';
import { TableComponent } from './tableComponent';

export class App {
    constructor() {
        this.dataService = new DataService();
        this.navigationComponent = new NavigationComponent(() => this.filterData());
        this.tableComponent = new TableComponent();
        this.tabComponent = new TabComponent(this.tableComponent);
        this.calendarComponent = new CalendarComponent();
        this.data = null;
    }

    async initializeData() {
        // Fetch and process data
        const result = await this.dataService.fetchCSV();
        this.data = this.dataService.processData(result.parsed);
        return result;
    }

    async initializeUI() {
        // Initialize navigation components
        this.navigationComponent.createMenu();
        this.navigationComponent.createRadioButtons();
        this.navigationComponent.createDateSlider(0);
        this.navigationComponent.createDateSlider(1);

        // Populate player dropdown
        const players = extractUniquePlayers(this.data);
        this.navigationComponent.populatePlayerDropdown(players);

        // Initialize tabs
        this.tabComponent.createTabs();
        this.tabComponent.showTab(DEFAULT_COMPOSER);

        // Initialize calendar view
        this.calendarComponent.createCalendar(this.data);

        // Initial data filter
        this.filterData();
    }

    async initialize() {
        try {
            this.showLoadingState();

            // Wait for catalog to load first
            await loadWorkCatalog();

            // Then load data
            const { timestamp, source } = await this.initializeData();

            // Initialize UI components
            await this.initializeUI();

            // Update data status display
            this.updateDataStatus(timestamp, source);
        } catch (error) {
            console.error('Error initializing application:', error);
            this.handleError(error);
        }
    }

    showLoadingState() {
        d3.select('#update')
            .text('Loading data...')
            .style("margin-left", "10px")
            .style("color", "gray");
    }

    updateDataStatus(timestamp, source) {
        const lastSession = this.dataService.formatTimeSince(
            this.data[this.data.length-1].timestamp
        );

        const updateText = source === 'cache'
            ? `Data Loaded from cache. Age: ${this.dataService.formatTimeSince(timestamp).replace("ago", "old")}`
            : `Data updated ${this.dataService.formatTimeSince(timestamp)}`;

        d3.select('#update')
            .text(`${updateText}; last session ${lastSession}`)
            .style("margin-left", "10px")
            .style("color", source === 'cache' ? "#E63946" : "gray");
    }

    filterData() {
        const dates = this.navigationComponent.getSelectedDates();
        const start = dates[0];
        const end = dates[1];
        const part = this.navigationComponent.getSelectedPart();
        const player = this.navigationComponent.getSelectedPlayer();

        const filteredData = this.data.filter(d => {
            const partMatch = ["ANY", d.part].includes(part);
            const dateMatch = start <= d.timestamp && d.timestamp <= end;
            const playerMatch = this.checkPlayerMatch(d, player);

            return partMatch && dateMatch && playerMatch;
        });

        // Update all composer tabs with filtered data
        COMPOSERS.forEach(composer => {
            this.tabComponent.updateTabContent(composer, part, filteredData, this.data);
        });
    }

    checkPlayerMatch(d, selectedPlayer) {
        if (selectedPlayer === "ANY") return true;

        // Extract player name and instrument from selection (e.g., "John.v1")
        const parts = selectedPlayer.split(".");
        if (parts.length !== 2) return false;

        const [playerName, instrument] = parts;

        // Check if this player played this instrument in this record
        if (instrument === "v1") {
            return (d.part === "V2" && d.player1 === playerName) ||
                   (d.part === "VA" && d.player1 === playerName);
        } else if (instrument === "v2") {
            return (d.part === "V1" && d.player1 === playerName) ||
                   (d.part === "VA" && d.player2 === playerName);
        } else if (instrument === "va") {
            return (d.part === "V1" && d.player2 === playerName) ||
                   (d.part === "V2" && d.player2 === playerName);
        } else if (instrument === "vc") {
            return d.player3 === playerName;
        }

        return false;
    }

    handleError(error) {
        // Add error handling UI
        d3.select('#update')
            .text(`Error loading data: ${error.message}`)
            .style("margin-left", "10px")
            .style("color", "#E63946");
    }
}

// Initialize the application
const app = new App();
document.addEventListener('DOMContentLoaded', () => app.initialize());
