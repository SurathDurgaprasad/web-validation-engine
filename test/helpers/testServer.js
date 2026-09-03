const http = require('http');

/**
 * Tiny local HTTP fixture server used by the validator tests instead of
 * hitting any real website (including the historical Eggplant Software
 * target). No mocking library, no new dependencies — just node:http.
 */
function createTestServer() {
  const state = { attempts: {} };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === '/ok') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body><main><h1>Welcome</h1><p>${'Real content. '.repeat(50)}</p></main></body></html>`);
      return;
    }

    if (pathname === '/soft404') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Page Not Found</h1><p>Sorry, we could not find that page.</p></body></html>');
      return;
    }

    if (pathname === '/missing') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    if (pathname === '/redirect') {
      res.writeHead(302, { Location: '/ok' });
      res.end();
      return;
    }

    if (pathname === '/slow') {
      setTimeout(() => {
        res.writeHead(200);
        res.end('slow ok');
      }, 2000);
      return;
    }

    if (pathname === '/flaky') {
      // Fails once (503), then succeeds — exercises transient-error retry.
      const key = url.searchParams.get('id') || 'default';
      state.attempts[key] = (state.attempts[key] || 0) + 1;
      if (state.attempts[key] < 2) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Service Unavailable');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body><main><h1>Recovered</h1><p>${'Real content. '.repeat(50)}</p></main></body></html>`);
      return;
    }

    if (pathname === '/redirect-loop') {
      // Bounces between two URLs forever — exercises axios's own
      // maxRedirects guard (ERR_FR_TOO_MANY_REDIRECTS -> errorType
      // "redirect-loop"), independent of the HttpValidator-level
      // redirect-chain safety covered by redirectChainSafety.test.js.
      res.writeHead(302, { Location: '/redirect-loop-b' });
      res.end();
      return;
    }

    if (pathname === '/redirect-loop-b') {
      res.writeHead(302, { Location: '/redirect-loop' });
      res.end();
      return;
    }

    // --- End-to-end fixture: one page exercising every link category the
    // real pipeline needs to classify/validate/report on in a single pass. ---
    if (pathname === '/e2e-home') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body>
        <h1 id="top">E2E Fixture Home</h1>
        <nav>
          <a href="/e2e-ok">Valid internal link</a>
          <a href="/missing">Broken internal link</a>
          <a href="/redirect">Redirect link</a>
          <a href="/soft404">Soft-404 candidate</a>
          <a href="#section1">Anchor 1 (valid)</a>
          <a href="#section2">Anchor 2 (valid, distinct from section1)</a>
          <a href="#section1">Anchor 1 duplicate (should dedupe with the first)</a>
          <a href="#missing-anchor">Anchor (broken — no matching id)</a>
          <a href="mailto:test@example.com">Mail</a>
          <a href="tel:+15551234567">Tel</a>
          <a href="javascript:void(0)">JS no-op</a>
        </nav>
        <p>${'Filler paragraph content. '.repeat(30)}</p>
        <h2 id="section1">Section 1</h2>
        <h2 id="section2">Section 2</h2>
      </body></html>`);
      return;
    }

    // Sitemap-index fixture: /sitemap.xml deliberately references itself
    // (a real-world-plausible misconfiguration) as well as a genuine
    // sub-sitemap, to exercise both cycle-safety and correct sub-sitemap
    // resolution.
    if (pathname === '/sitemap.xml') {
      const origin = `http://${req.headers.host}`;
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>${origin}/sitemap.xml</loc></sitemap>
          <sitemap><loc>${origin}/sitemap-a.xml</loc></sitemap>
        </sitemapindex>`);
      return;
    }

    if (pathname === '/sitemap-a.xml') {
      const origin = `http://${req.headers.host}`;
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>${origin}/page-a</loc></url>
          <url><loc>${origin}/page-b</loc></url>
        </urlset>`);
      return;
    }

    if (pathname === '/e2e-ok') {
      // Content must clear Soft404Detector's short-content heuristic
      // (>= 500 chars) so this stays a clean "http, valid, no escalation"
      // case rather than incidentally tripping the soft-404 path.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body><main><h1>E2E OK page</h1><p>${'Real content. '.repeat(60)}</p></main></body></html>`);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  return {
    server,
    state,
    start() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    stop() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createTestServer };
