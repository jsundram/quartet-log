// The Home view's filter pipeline, pure and testable. app.js orchestrates
// WHEN to filter; this module says WHAT matches.
import { checkPlayersMatch } from './dataProcessor.js';

// One Part button's match rule. "VA" folds the rare explicit second-viola
// rows (part "VA2", logged for quintets) into the viola button — the same
// folding the dashboard applies via normalizeDashboardPart. Without the
// fold, VA2 rows would be reachable only through "ANY".
export function partMatches(selected, part) {
    if (selected === "ANY") return true;
    if (selected === "VA") return part != null && part.startsWith("VA");
    return part === selected;
}

// Apply the three Home filters in sequence. Returns both stages because the
// Player dropdown is populated from the date+part stage (so it lists the
// players present in the current window, not just the current selection).
export function filterRows(data, { part, start, end, players }) {
    const datePartFiltered = data.filter(d => {
        const partMatch = partMatches(part, d.part);
        const dateMatch = start <= d.timestamp && d.timestamp <= end;
        return partMatch && dateMatch;
    });
    const filtered = datePartFiltered.filter(d => checkPlayersMatch(d, players));
    return { datePartFiltered, filtered };
}
