import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const GOOD_PAGE = `<!doctype html>
<html lang="en">
<head>
  <title>A perfectly reasonable page title</title>
  <meta name="description" content="This description sits comfortably inside the fifty to one hundred and sixty character window search engines prefer." />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta property="og:title" content="A perfectly reasonable page title" />
  <link rel="canonical" href="http://127.0.0.1/good" />
  <link rel="icon" href="/favicon.ico" />
  <script type="application/ld+json">{"@context":"https://schema.org"}</script>
  <script src="/app.js" defer></script>
</head>
<body>
  <h1>Only one heading of rank one</h1>
  <h2>Then a second rank</h2>
  <img src="/a.png" alt="A described image" />
  <img src="/spacer.png" alt="" />
  <label for="email">Email</label><input id="email" type="email" />
  <a href="/internal">Internal</a><a href="https://elsewhere.example">External</a>
</body>
</html>`;

export const BAD_PAGE = `<!doctype html>
<html>
<head><title>Tiny</title><script src="/blocking.js"></script></head>
<body>
  <h1>One</h1><h1>Two</h1>
  <h2>Sub</h2><h4>Skipped a level</h4>
  <img src="/a.png" /><img src="/b.png" />
  <input type="text" />
</body>
</html>`;

export interface Fixture {
  origin: string;
  close: () => Promise<void>;
  /** Number of times the origin was actually hit. Proves caching works. */
  hits: () => number;
}

export async function startFixtureServer(): Promise<Fixture> {
  let hits = 0;

  const server = http.createServer((req, res) => {
    hits++;
    const url = new URL(req.url ?? '/', 'http://localhost');

    switch (url.pathname) {
      case '/good':
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-encoding': 'identity',
          'cache-control': 'public, max-age=60',
          'strict-transport-security': 'max-age=63072000',
          'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        res.end(GOOD_PAGE);
        return;

      case '/bad':
        res.writeHead(200, { 'content-type': 'text/html', server: 'nginx/1.25.3', 'x-powered-by': 'Express' });
        res.end(BAD_PAGE);
        return;

      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"not":"html"}');
        return;

      case '/redirect':
        res.writeHead(302, { location: '/good' });
        res.end();
        return;

      case '/slow':
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html><body>late</body></html>');
        }, 3000).unref();
        return;

      case '/boom':
        res.writeHead(500, { 'content-type': 'text/html' });
        res.end('<html><head><title>Server error page here</title></head><body>500</body></html>');
        return;

      default:
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html><body>missing</body></html>');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
