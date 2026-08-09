// The first-run / re-configure screen where the user pastes their published
// Google Sheets CSV URL. Split out of app.js: owns everything under
// #setupView plus the show/hide of the main chrome around it.
import * as d3 from "d3";
import { setDataUrl, isValidGoogleSheetsUrl, buildMobileSetupLink } from './urlConfig.js';

// Briefly swap a selection's text, then restore it. Re-entrancy-safe: rapid
// re-clicks keep the true original (not the flashed text) and reset the
// timer, so the label never gets stuck on "Copied!". Exported because the
// menu's "Copy setup link" flash uses it too.
export function flashLabel(sel, msg) {
    if (sel.empty()) return;
    const node = sel.node();
    if (node._flashOriginal === undefined) node._flashOriginal = sel.text();
    clearTimeout(node._flashTimer);
    sel.text(msg);
    node._flashTimer = setTimeout(() => {
        sel.text(node._flashOriginal);
        node._flashOriginal = undefined;
        node._flashTimer = undefined;
    }, 1500);
}

export class SetupView {
    // `onSubmit` receives nothing — the URL is already persisted via
    // setDataUrl when it fires; the app just re-runs its initialize path.
    constructor({ onSubmit }) {
        this.onSubmit = onSubmit;
    }

    show(prefillUrl = '') {
        // Hide main content areas
        d3.select('#mainContent').style('display', 'none');
        d3.select('#calendar').style('display', 'none');
        d3.select('#dashboard').style('display', 'none');
        d3.select('#menu').style('display', 'none');
        d3.select('#update').style('display', 'none');

        // Show setup view
        const setupView = d3.select('#setupView');
        setupView.style('display', 'flex');

        // Pre-fill URL if provided
        const input = setupView.select('#dataUrlInput');
        if (prefillUrl) {
            input.property('value', prefillUrl);
        }

        // Clear any previous error
        setupView.select('#setupError').text('').style('display', 'none');

        // (Re)bind handlers — d3 .on replaces, so showing the view twice
        // never stacks listeners.
        setupView.select('#setupForm').on('submit', (event) => {
            event.preventDefault();
            this.handleUrlSubmit();
        });

        // "Copy mobile setup link" — generates a pre-configured URL from
        // whatever's in the data URL input and copies it to the clipboard.
        // The user then sends that link to their other device (AirDrop,
        // iMessage, email, etc.) so they don't have to retype the URL.
        setupView.select('#copyMobileLink').on('click', (event) => {
            event.preventDefault();
            this.handleCopyMobileLink();
        });
    }

    hide() {
        d3.select('#setupView').style('display', 'none');
        d3.select('#mainContent').style('display', 'block');
        d3.select('#menu').style('display', 'block');
        d3.select('#update').style('display', 'block');
    }

    handleUrlSubmit() {
        const input = d3.select('#dataUrlInput');
        const url = input.property('value').trim();
        const errorEl = d3.select('#setupError');

        if (!url) {
            errorEl.text('Please enter a URL').style('display', 'block');
            return;
        }
        if (!isValidGoogleSheetsUrl(url)) {
            errorEl.text('Invalid URL. Please enter a Google Sheets CSV export URL (must contain "output=csv")').style('display', 'block');
            return;
        }

        setDataUrl(url);
        this.hide();
        this.onSubmit();
    }

    handleCopyMobileLink() {
        const input = d3.select('#dataUrlInput');
        const url = input.property('value').trim();
        const errorEl = d3.select('#setupError');

        if (!url) {
            errorEl.html('Enter your CSV URL first, then click Copy. <a href="setup.html">How do I get this URL?</a>')
                .style('display', 'block');
            return;
        }
        if (!isValidGoogleSheetsUrl(url)) {
            errorEl.text('Invalid URL. Please enter a valid Google Sheets CSV export URL (must contain "output=csv") before copying.')
                .style('display', 'block');
            return;
        }

        const mobileLink = buildMobileSetupLink(url);
        navigator.clipboard.writeText(mobileLink).then(
            () => {
                flashLabel(d3.select('#copyMobileLink'), 'Copied!');
                errorEl.text('').style('display', 'none');
            },
            (err) => {
                errorEl.text('Could not copy to clipboard: ' + (err.message || err))
                    .style('display', 'block');
            },
        );
    }
}
