// @ts-check
// HTML-escaping for every sink that interpolates sheet-derived strings into
// .html(...). The Google Sheet is user-authored — work titles, player names,
// locations, and especially free-form comments — and the "Copy setup link"
// feature hands a ?data=<sheet-url> link to other people, so an unescaped
// tooltip isn't just self-XSS: it's a delivery vector. Escapes quotes too so
// escaped values are safe in attribute position (e.g. href="...").
/**
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
