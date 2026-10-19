// Quartet Log's writer: adds a piece logged in the app to this sheet, once.
//
// Setup is in md/howto.md, "Send each piece exactly once". In short: from the
// sheet, Extensions > Apps Script, replace Code.gs with this file, then
// Deploy > New deployment > Web app, executing as you, with access for anyone,
// and paste the /exec URL into the app.
//
// The app resends any piece it has no answer for, because a reply lost on a
// weak connection looks the same as a request that never arrived. The id each
// piece carries is what makes a second arrival a no-op, so a timed-out send
// can be retried without a duplicate row. Ids are kept in script properties
// rather than the sheet, which keeps exactly the columns the form made.

const KEEP_IDS_DAYS = 90;

// The app checks the URL with a GET before using it, so a wrong deployment
// (access not set to anyone, or a URL from another script) fails at setup
// rather than on the first piece.
function doGet() {
  return reply({ ok: true, app: 'quartet-log' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (_) { return reply({ ok: false, error: 'not JSON' }); }
  const { id, row } = req || {};
  if (typeof id !== 'string' || !id || !row || typeof row !== 'object') {
    return reply({ ok: false, error: 'missing id or row' });
  }
  // Two sends of one piece can overlap (a retry racing the original), and both
  // would pass the id check without this.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(id)) return reply({ ok: true, duplicate: true });
    const sheet = responseSheet();
    const width = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, width).getValues()[0].map(String);
    const unknown = Object.keys(row).filter(k => !headers.includes(k));
    if (unknown.length) return reply({ ok: false, error: `no column named ${unknown.join(', ')}` });
    // By header, not position, so a column moved in the sheet still lines up.
    sheet.appendRow(headers.map(h => (h === 'Timestamp' ? new Date() : row[h] ?? '')));
    // The format of the row above, so the Timestamp publishes in the same
    // shape as the form's own and parses the same in the app.
    const last = sheet.getLastRow();
    if (last > 2) {
      sheet.getRange(last - 1, 1, 1, width).copyTo(
        sheet.getRange(last, 1, 1, width), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    }
    SpreadsheetApp.flush();
    // After the write: an id recorded for a row that failed to land would turn
    // the retry away and lose the piece, which is worse than the duplicate the
    // opposite order risks if the script dies between these two lines.
    props.setProperty(id, String(Date.now()));
    prune(props);
    return reply({ ok: true, duplicate: false });
  } finally {
    lock.releaseLock();
  }
}

// The tab the form writes to, wherever it sits; the first tab otherwise.
function responseSheet() {
  const sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  return sheets.find(s => s.getFormUrl()) || sheets[0];
}

function prune(props) {
  const cutoff = Date.now() - KEEP_IDS_DAYS * 86400000;
  for (const [k, v] of Object.entries(props.getProperties())) {
    if (Number(v) < cutoff) props.deleteProperty(k);
  }
}

function reply(body) {
  return ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
