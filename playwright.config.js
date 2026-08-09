// Playwright smoke-test config. One spec (e2e/smoke.spec.js) boots the BUILT
// app — run `./build.sh --prod` first; the webServer below just serves
// last_deploy/ statically (esbuild's server without --bundle is a plain
// static file server). Covers the category unit tests can't: "does the site
// actually load and render its three views."
import { defineConfig } from '@playwright/test';

const PORT = 8788;

export default defineConfig({
    testDir: './e2e',
    // The suite stubs the Google Sheet at the network layer, so runs are
    // hermetic — retries would only mask real breakage.
    retries: 0,
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
    },
    webServer: {
        command: `node_modules/.bin/esbuild --serve=${PORT} --servedir=last_deploy`,
        url: `http://127.0.0.1:${PORT}/index.html`,
        reuseExistingServer: true,
    },
});
