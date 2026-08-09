// The Home view's filter pipeline, pure and testable. app.js orchestrates
// WHEN to filter; this module says WHAT matches.
import { checkPlayersMatch } from './dataProcessor.js';

// Apply the three Home filters in sequence. Returns both stages because the
// Player dropdown is populated from the date+part stage (so it lists the
// players present in the current window, not just the current selection).
export function filterRows(data, { part, start, end, players }) {
    const datePartFiltered = data.filter(d => {
        const partMatch = ["ANY", d.part].includes(part);
        const dateMatch = start <= d.timestamp && d.timestamp <= end;
        return partMatch && dateMatch;
    });
    const filtered = datePartFiltered.filter(d => checkPlayersMatch(d, players));
    return { datePartFiltered, filtered };
}
