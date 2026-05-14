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

// Color reads. Colors live in CSS custom properties on :root (see
// static/css/viz.css). `getCssColor` reads a token by name; `getPartColor`
// is the part-specific convenience that callers used to import as
// PART_COLORS. Memoized after first read.
const _colorCache = new Map();

export function getCssColor(token) {
    if (_colorCache.has(token)) return _colorCache.get(token);
    const value = getComputedStyle(document.documentElement)
        .getPropertyValue(token)
        .trim();
    _colorCache.set(token, value);
    return value;
}

export function getPartColor(part) {
    const token = {
        V1: '--color-part-v1',
        V2: '--color-part-v2',
        VA: '--color-part-va',
    }[part];
    return token ? getCssColor(token) : getCssColor('--color-part-fallback');
}

// Regular player mappings
export const PLAYER_ABBREVIATIONS = {
    "I": "Isaac",
    "E": "Elaine",
    "S": "Shay",
    "J": "Josh"
};

// Player-name aliases. Aliases are scoped by instrument class because
// "Jen" on violin (Jen Hsiao) is a different person from "Jen" on cello
// (Jen Minnich). Classes:
//   - "upper": V1, V2, VA, VLA — violin/viola alias as one person
//   - "cello": VC — never aliases with upper
// Anyone played on piano or other instruments is treated as "upper" for
// alias purposes (rare; revisit if it causes collisions).
export const PLAYER_ALIASES = {
    "Aaron": { upper: "Aaron Johnson" },
    "Al": { upper: "Al Leisinger" },
    "Ari": { upper: "Ari Le" },
    "Brian": { upper: "Brian Clague" },
    "Byron": { upper: "Byron Chow" },
    "Clayton": { upper: "Clayton Bullock" },
    "Cyrus": { cello: "Cyrus Behroozi" },
    "David": { upper: "David Sanders" },
    "Eiko": { upper: "Eiko Ogiso" },
    "Eran": { cello: "Eran Marcus" },
    "Hans": { cello: "Hans Brightbill" },
    "Helen": { upper: "Helen Kim" },
    "Henry": { upper: "Henry Weinberger" },
    "Isaac": { upper: "Isaac Krauss" },
    "Jen": { upper: "Jen Hsiao", cello: "Jen Minnich" },
    "Jennifer Minnich": { cello: "Jen Minnich" },
    "Jess": { upper: "Jess Lin" },
    "Josie": { upper: "Josie Stein" },
    "Joyce": { upper: "Joyce Pan" },
    "Julie": { cello: "Julie Simpson" },
    "Justin": { upper: "Justin Ouellet" },
    "Kass": { upper: "Philip Kass" },
    "Katie": { upper: "Katie Behroozi" },
    "Laura": { upper: "Laura Krauss" },
    "Lauren": { upper: "Lauren Alter" },
    "Louisa": { cello: "Louisa Krauss" },
    "Marie": { upper: "Marie Ihnen" },
    "Matthew": { upper: "Matthew Liebendorfer" },
    "Melissa": { cello: "Melissa Chu" },
    "Paul": { cello: "Paul Mattal" },
    "Peter": { upper: "Peter Ouyang" },
    "Peter O": { upper: "Peter Ouyang" },
    "Phil": { upper: "Philip Kass" },
    "Phil Kass": { upper: "Philip Kass" },
    "Pisco": { upper: "Ayrton Pisco" },
    "Sarah": { upper: "Sarah Emmert" },
    "Shanalyn": { cello: "Shanalyn Abate" },
    "Scott": { upper: "Scott Kuldell" },
    "Susie": { upper: "Susie Ikeda" },
    "Will": { upper: "Will Davis" },
    // Re-run scripts/audit_aliases.py against an updated CSV to surface new variants.
};

// Calendar configurations
export const CALENDAR_CONFIG = {
    width: 1000,  // Extra width for day-of-week totals column
    cellSize: 17,
    height: 17 * 10  // Extra row for weekly totals
};
