// The five aggregate stat definitions (label, short label, value, tooltip
// title + explainer), single-sourced. Three renderers show them — the ALL
// tab's stats row, the Dashboard's KPI tiles, and the Calendar's "Last 365
// days" header — and before this module each carried its own verbatim copy,
// which had already begun to drift. The per-YEAR stats column keeps its own
// defs in CalendarComponent._yearStatDefs (different shape: per-year value
// functions, projections).
import { formatStreakStart } from './dataProcessor.js';

// `agg` is computeAggregateStats() output; `windowPhrase` names the slice in
// the tooltip titles ("in the current filter", "in the last 365 days", …).
// desc strings are app-authored constants — safe for .html() sinks.
export function buildAggregateStatDefs(agg, windowPhrase = 'in the current filter') {
    const streakStart = formatStreakStart(agg.maxStreakInfo);
    return [
        {
            label: 'Pieces',
            short: 'Pieces',
            value: agg.pieces,
            title: `Pieces ${windowPhrase}`,
            desc: "Total quartets logged in this window. Partial-movement entries don't count — only whole pieces.",
        },
        {
            label: 'Unique pieces',
            short: 'Unique',
            value: agg.uniquePieces,
            title: `Unique pieces ${windowPhrase}`,
            desc: 'Distinct works (composer + title). Repeats of the same piece collapse to one.',
        },
        {
            label: 'Unique people',
            short: 'People',
            value: agg.uniquePeople,
            title: `People played with ${windowPhrase}`,
            desc: 'Distinct people logged in Player 1/2/3 and the Others? column, after alias normalization. Short names are resolved per-instrument via PLAYER_ALIASES.',
        },
        {
            label: 'Days played',
            short: 'Days',
            value: agg.daysPlayed,
            title: `Playing days ${windowPhrase}`,
            desc: 'Distinct days with at least one whole piece logged.',
        },
        {
            label: 'Max streak',
            short: 'Streak',
            value: agg.maxStreak,
            title: `Longest streak ${windowPhrase}`,
            desc: 'Longest run of consecutive days with at least one whole piece logged, within this window.'
                + (streakStart ? `<br><br>Started: ${streakStart}` : ''),
        },
    ];
}
