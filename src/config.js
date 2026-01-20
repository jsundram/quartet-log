// Global configuration constants

// BEGIN is computed from data - first day of month containing earliest data point
let _begin = null;

export function getBegin() {
    if (!_begin) {
        throw new Error('BEGIN not initialized - call setBegin() with data first');
    }
    return _begin;
}

export function setBegin(earliestDate) {
    // Set to first day of the month containing the earliest date
    _begin = new Date(earliestDate.getFullYear(), earliestDate.getMonth(), 1);
}

// Color configurations
export const PART_COLORS = {
    "V1": "#1ceaf9",
    "V2": "#01c472",
    "VA": "#007961"
};

// Regular player mappings
export const PLAYER_ABBREVIATIONS = {
    "I": "Isaac",
    "E": "Elaine",
    "S": "Shay",
    "J": "Josh"
};

// Calendar configurations
export const CALENDAR_CONFIG = {
    width: 1000,  // Extra width for day-of-week totals column
    cellSize: 17,
    height: 17 * 10  // Extra row for weekly totals
};
