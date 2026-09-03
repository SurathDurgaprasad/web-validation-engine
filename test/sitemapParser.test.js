const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestServer } = require('./helpers/testServer');
const SitemapParser = require('../extractors/SitemapParser');

// Regression coverage for a real bug found during hardening: sitemap-index
// sub-sitemaps were "parsed" by re-running parse()'s guess-common-locations
// logic on the sub-sitemap's URL (producing a nonsensical URL like
// ".../sitemap.xml/sitemap.xml" that always 404s), so sitemap-index support
// silently never worked. There was also no cycle guard — a sitemap index
// that references itself (a real-world-plausible misconfiguration) had
// nothing stopping unbounded recursion.

test('SitemapParser', async (t) => {
  const fixture = createTestServer();
  const port = await fixture.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await fixture.stop();
  });

  await t.test('resolves URLs from a genuine sub-sitemap referenced by a sitemap index', async () => {
    const parser = new SitemapParser({ allowedDomains: ['127.0.0.1'] });

    const start = Date.now();
    const urls = await parser.parse(baseUrl);
    const elapsedMs = Date.now() - start;

    assert.ok(elapsedMs < 5000, `should resolve quickly, not hang on the self-referencing entry (took ${elapsedMs}ms)`);
    assert.ok(urls.includes(`${baseUrl}/page-a`), `expected sub-sitemap URLs to be resolved; got: ${urls.join(', ')}`);
    assert.ok(urls.includes(`${baseUrl}/page-b`));
  });

  await t.test('a sitemap index that references itself does not cause infinite recursion', async () => {
    const parser = new SitemapParser({ allowedDomains: ['127.0.0.1'] });
    // The /sitemap.xml fixture itself contains a self-referencing <sitemap>
    // entry — parsing it directly exercises the cycle guard without relying
    // on the outer parse() location-guessing loop.
    const visited = new Set();
    const urls = await parser.fetchSubSitemap(`${baseUrl}/sitemap.xml`, visited);

    // Should terminate and still resolve the genuine sub-sitemap once,
    // without looping on the self-reference.
    assert.ok(urls.includes(`${baseUrl}/page-a`));
    assert.ok(visited.size < SitemapParser.MAX_SITEMAPS_PER_INDEX);
  });
});
