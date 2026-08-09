// The "Download Data" menu action. Split out of app.js. Headers, field
// order, timestamp format, and escaping all come from the shared csvFormat
// module (also used by scripts/fetch_processed.mjs) so the written header is
// the reader's "Others?" and the two writers can't drift apart.
import { serializeRows } from './csvFormat.js';

export function downloadCSV(data) {
    if (!data) {
        console.error('No data available to download');
        return;
    }

    const csvContent = serializeRows(data);

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
