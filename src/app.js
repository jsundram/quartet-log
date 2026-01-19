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
        this.navigationComponent = new NavigationComponent(
            (filterType) => this.filterData(filterType),
            () => this.downloadCSV()
        );
        this.tableComponent = new TableComponent();
        this.tabComponent = new TabComponent(this.tableComponent);
        this.calendarComponent = new CalendarComponent();
        this.data = null;
    }

    async initializeData() {
        // Fetch and process data
        const result = await this.dataService.fetchCSV();
        this.data = this.dataService.processData(result.parsed);
        window.data = this.data;
        return result;
    }

    async initializeUI() {
        // Initialize navigation components
        this.navigationComponent.createMenu();
        this.navigationComponent.createRadioButtons();
        this.navigationComponent.createDateSlider(0);
        this.navigationComponent.createDateSlider(1);

        // Initialize tabs
        this.tabComponent.createTabs();
        this.tabComponent.showTab(DEFAULT_COMPOSER);

        // Initialize calendar view
        this.calendarComponent.createCalendar(this.data);

        // Initial data filter
        this.filterData("date");  // need players to update
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

    filterData(filterType) {
        const dates = this.navigationComponent.getSelectedDates();
        const start = dates[0];
        const end = dates[1];
        const part = this.navigationComponent.getSelectedPart();
        const selectedPlayers = this.navigationComponent.getSelectedPlayers();

        // First filter by date and part only
        const datePartFiltered = this.data.filter(d => {
            const partMatch = ["ANY", d.part].includes(part);
            const dateMatch = start <= d.timestamp && d.timestamp <= end;
            return partMatch && dateMatch;
        });

        // Only update player dropdown if date or part changed, not player
        if (filterType === "date" || filterType === "part") {
            const players = extractUniquePlayers(datePartFiltered);
            this.navigationComponent.populatePlayerDropdown(players);
        }

        // Now apply player filter
        const filteredData = datePartFiltered.filter(d => {
            return this.checkPlayersMatch(d, selectedPlayers);
        });

        // Update all composer tabs with filtered data
        COMPOSERS.forEach(composer => {
            this.tabComponent.updateTabContent(composer, part, filteredData, this.data);
        });
    }

    checkPlayersMatch(d, selectedPlayers) {
        // If no players selected, show all (equivalent to "ANY")
        if (selectedPlayers.length === 0) return true;

        // Group selected players by base name
        // e.g., ["Isaac.v1", "Isaac.v2", "Elaine.va"]
        //    => { Isaac: ["v1", "v2"], Elaine: ["va"] }
        const playerGroups = new Map();
        for (const p of selectedPlayers) {
            const [name, instrument] = p.split(".");
            if (!playerGroups.has(name)) playerGroups.set(name, []);
            playerGroups.get(name).push(instrument);
        }

        // For each unique player name, check if ANY of their instruments match (OR)
        // All player names must match (AND)
        for (const [name, instruments] of playerGroups) {
            const anyInstrumentMatches = instruments.some(inst =>
                this.checkSinglePlayerMatch(d, name, inst)
            );
            if (!anyInstrumentMatches) return false; // AND logic fails
        }
        return true;
    }

    checkSinglePlayerMatch(d, playerName, instrument) {
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

    downloadCSV() {
        if (!this.data) {
            console.error('No data available to download');
            return;
        }

        // Format timestamp to match original format: "M/D/YYYY H:mm:ss" in local time
        const formatTimestamp = d3.timeFormat("%-m/%-d/%Y %-H:%M:%S");

        // CSV headers
        const headers = ['Timestamp', 'Composer', 'Work Title', 'Which Part', 'Player 1', 'Player 2', 'Player 3', 'Others', 'Location', 'Comments'];

        // Convert data to CSV rows
        const rows = this.data.map(d => {
            return [
                formatTimestamp(d.timestamp),
                d.composer,
                d.work.title,
                d.part,
                d.player1,
                d.player2,
                d.player3,
                d.others,
                d.location,
                d.comments
            ];
        });

        // Escape CSV fields that contain commas, quotes, or newlines
        const escapeField = (field) => {
            if (field === null || field === undefined) return '';
            const str = String(field);
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };

        // Build CSV content
        const csvContent = [
            headers.map(escapeField).join(','),
            ...rows.map(row => row.map(escapeField).join(','))
        ].join('\n');

        // Create blob and trigger download
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);

        link.setAttribute('href', url);
        link.setAttribute('download', `music-log-${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
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
