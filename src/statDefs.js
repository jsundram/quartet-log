// The six aggregate stat definitions (label, short label, value, tooltip
// title + explainer), single-sourced. Three renderers show them — the ALL
// tab's stats row, the Dashboard's KPI tiles, and the Calendar's "Last 365
// days" header — and before this module each carried its own verbatim copy,
// which had already begun to drift. The per-YEAR stats column keeps its own
// defs in CalendarComponent._yearStatDefs (different shape: per-year value
// functions, projections).
import { formatStreakStart } from './dataProcessor.js';

// Shared with CalendarComponent._yearStatDefs — the one per-year desc that
// isn't a year-specific rewrite, kept single-sourced so the VA2 caveat
// can't drift. `scope` lets the calendar say "this year" like its sibling
// descs (e.g. pass ' this year'; the leading space matters).
export function uniquePartsDesc(scope = '') {
    return `Distinct work + part combinations${scope}: playing the same piece on V1 and later on V2 counts twice; repeats on the same part collapse to one. Quintet/sextet second-viola (VA2) rows count separately from VA, while the VA part filter includes them — so a VA-filtered view can show more unique parts than unique pieces.`;
}

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
            label: 'Unique parts',
            short: 'Parts',
            value: agg.uniqueParts,
            title: `Unique parts ${windowPhrase}`,
            desc: uniquePartsDesc(),
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
