#!/usr/bin/env node
// Tiny dev-only reverse proxy in front of esbuild's --serve.
//
// esbuild's dev server can't set response headers (by design — its docs say
// to put a proxy in front for that), and since it sends no Cache-Control /
// ETag / Last-Modified, the browser can silently reuse a stale bundle.js
// across same-session navigations. This forwards every request to the
// esbuild upstream and stamps Cache-Control: no-store on the way back so
// dev never serves stale assets. Used only by build.sh dev mode; prod
// deploys to GitHub Pages and never runs this.
//
// Usage: node scripts/dev_proxy.mjs <upstream-port> <listen-port>
import http from 'node:http';

const [upstreamPort, listenPort] = process.argv.slice(2).map(Number);
if (!upstreamPort || !listenPort) {
    console.error('usage: dev_proxy.mjs <upstream-port> <listen-port>');
    process.exit(1);
}

const server = http.createServer((req, res) => {
    const upstream = http.request({
        host: '127.0.0.1',
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` },
    }, (up) => {
        // Pass everything through untouched except the cache policy.
        // Streaming (pipe) keeps esbuild's /esbuild SSE endpoint working.
        res.writeHead(up.statusCode, { ...up.headers, 'cache-control': 'no-store' });
        up.pipe(res);
    });
    upstream.on('error', () => {
        res.writeHead(502, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end(`esbuild upstream on :${upstreamPort} not responding\n`);
    });
    req.pipe(upstream);
});

// Listen on all interfaces so phone-on-LAN testing works, same as esbuild.
server.listen(listenPort, () => {
    console.log(`[dev-proxy] serving on :${listenPort} -> esbuild :${upstreamPort} (Cache-Control: no-store)`);
});
