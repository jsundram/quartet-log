# How to Publish Your Google Sheet as CSV

This guide explains how to publish an existing Google Sheet so that Quartet Log can access the data.

## Step-by-Step Instructions

### 1. Open Your Google Sheet

Navigate to [Google Sheets](https://sheets.google.com) and open the spreadsheet containing your music log data.

### 2. Publish to the Web

1. Click **File** in the menu bar
2. Select **Share** > **Publish to web**

### 3. Configure Publication Settings

In the "Publish to the web" dialog:

1. In the first dropdown, select the specific sheet containing your data (or "Entire document" if you only have one sheet)
2. In the second dropdown, select **Comma-separated values (.csv)**
3. Click the **Publish** button
4. Click **OK** to confirm

### 4. Copy the URL

After publishing, a URL will appear. It should look something like:

```
https://docs.google.com/spreadsheets/d/e/2PACX-1vXXX.../pub?output=csv
```

Copy this entire URL.

### 5. Use the URL in Quartet Log

Paste the URL into the Quartet Log setup page and click "Load Data".

## Important Notes

- **The URL must end with `output=csv`** - this ensures the data is exported in the correct format
- **Your sheet must be published** - simply sharing the sheet is not enough; you must use "Publish to web"
- **Changes sync automatically** - once published, any updates you make to the sheet will be reflected in the published CSV (there may be a small delay)
- **Anyone with the link can view the data** - published data is accessible to anyone who has the URL

## Troubleshooting

### "Invalid URL" Error

Make sure your URL:
- Comes from Google Sheets (domain ends with `google.com`)
- Contains `/spreadsheets/` in the path
- Has `output=csv` as a query parameter

### Data Not Loading

1. Verify the sheet is published (not just shared)
2. Check that you selected CSV format when publishing
3. Try re-publishing the sheet
4. Clear your browser cache and try again

### Data Not Updating

- Published data may take a few minutes to sync after making changes
- Try clearing your browser's localStorage to force a fresh fetch

## Data Format Requirements

Your Google Sheet should have columns matching the expected format:
- **Timestamp** - Date/time of the session
- **Composer** - Composer name
- **Work Title** - Title of the piece
- **Which Part** - V1, V2, or VA
- **Player 1, Player 2, Player 3** - Names of other players
- Additional optional columns: Others, Location, Comments

[Back to Quartet Log](index.html)
