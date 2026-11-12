// A plain forwarding hop between the test web server and the BOS API, for the end-to-end tests only.
//
//   browser -> next dev :3200 (rewrite /api/v1/*) -> this relay :5180 -> BOS API :5100
//
// Why: with `next dev`'s rewrite proxy talking straight to the API's Werkzeug development server,
// about one page load in a hundred on the development PC had its GET /api/v1/me sent by the
// browser and never answered (the API was idle and answers in milliseconds; no database waits),
// which left the page on "Checking your session..." and failed a story. With a plain Node hop in
// between, 500 page loads and every full run were clean. The exact fault inside that pairing was
// not pinned down. In production a reverse proxy forwards /api/v1, so this changes nothing the app
// does: requests and answers pass through unchanged (status, headers, body), and an API error or
// an API that is down still reaches the page (502 when unreachable).
//
// Usage: node e2e/api-relay.mjs <listen port> <API port>. Binds to 127.0.0.1 only.

import http from "node:http";

const [listenPort, apiPort] = process.argv.slice(2).map(Number);
if (!listenPort || !apiPort) {
  console.error("usage: node e2e/api-relay.mjs <listen port> <API port>");
  process.exit(2);
}

const upstream = new http.Agent({ keepAlive: true });

const server = http.createServer((req, res) => {
  const forward = http.request(
    { host: "127.0.0.1", port: apiPort, method: req.method, path: req.url, headers: req.headers, agent: upstream },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.rawHeaders);
      answer.pipe(res);
    },
  );
  forward.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "internal_error", message: "API unreachable (e2e relay)" } }));
  });
  // The caller gave up (for example a request the page aborted): stop the forwarded one too.
  res.on("close", () => {
    if (!res.writableFinished) forward.destroy();
  });
  req.pipe(forward);
});

server.keepAliveTimeout = 60_000;
server.listen(listenPort, "127.0.0.1", () => {
  console.log(`e2e API relay on http://127.0.0.1:${listenPort} -> 127.0.0.1:${apiPort}`);
});
