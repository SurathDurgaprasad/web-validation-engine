const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { createTestServer } = require('./helpers/testServer');
const ConfigLoader = require('../config/ConfigLoader');
const CrawlManager = require('../crawler/CrawlManager');

// Full-pipeline integration test: a real Playwright browser crawls a real
// (local, ephemeral) HTTP server through CrawlManager -> PageCrawler ->
// LinkExtractor -> urlClassifier -> LinkValidationService -> NDJSON ->
// reports, exercising every link category in one page: a valid internal
// link, a broken link, a redirect, a soft-404 (escalated to
// BrowserValidator), a valid anchor, a second *distinct* valid anchor, a
// duplicate anchor (must dedupe), a broken anchor, mailto, tel, and
// javascript:. Local, deterministic, no external network access.
//
// This also doubles as the fuller regression proof for the anchor-fragment
// dedup bug (test/anchorFragmentDedup.test.js covers the dedup logic in
// isolation; this proves it holds through the real Playwright + validation
// pipeline).

test('End-to-end: local fixture crawl through the real pipeline', async (t) => {
  const fixture = createTestServer();
  const port = await fixture.start();
  const baseUrl = `http://127.0.0.1:${port}/e2e-home`;

  const tmpRoot = path.join(os.tmpdir(), `e2e-crawl-test-${Date.now()}`);
  const outputDirectory = path.join(tmpRoot, 'output');
  const stateDirectory = path.join(tmpRoot, 'state');
  const screenshotDirectory = path.join(tmpRoot, 'screenshots');

  t.after(async () => {
    await fixture.stop();
    await fs.remove(tmpRoot);
  });

  const config = ConfigLoader.load({
    target: { name: 'E2E Fixture', baseUrl, environment: 'development' },
    crawl: {
      maxDepth: 0, // only the home page itself is crawled as a *page*;
                   // its outbound links are still validated regardless.
      maxPages: 5,
      concurrency: 2,
      crawlDelayMs: 0,
      respectRobotsTxt: false,
      followSitemaps: false,
      captureScreenshots: false
    },
    validation: {
      http: true,
      browserFallback: true,
      anchors: true,
      soft404: true,
      retry: true,
      retryCount: 2,
      concurrency: 5
    },
    scope: { allowedDomains: ['127.0.0.1'], excludedPaths: [] },
    reporting: { html: true, excel: true, json: true },
    outputDirectory,
    stateDirectory,
    screenshotDirectory,
    resumePreviousCrawl: false
  });

  const crawler = new CrawlManager(config);
  await crawler.start();

  const runDir = crawler.runOutputDirectory;

  await t.test('run output directory was created and isolated under output/runs/<timestamp>/', () => {
    assert.ok(fs.existsSync(runDir));
    assert.match(runDir, /runs[\\/]/);
  });

  const ndjsonPath = path.join(runDir, 'results.ndjson');
  const lines = (await fs.readFile(ndjsonPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const byTarget = (suffix) => lines.find(l => l.targetUrl.endsWith(suffix));

  await t.test('exactly 10 unique link records were persisted (11 hrefs on the page, one duplicate anchor deduped)', () => {
    assert.equal(lines.length, 10, `expected 10 deduped entries, got ${lines.length}: ${lines.map(l => l.targetUrl).join(', ')}`);
  });

  await t.test('a valid internal link is reported as genuinely valid', () => {
    const entry = byTarget('/e2e-ok');
    assert.equal(entry.validationMethod, 'http');
    assert.equal(entry.validationStatus, 'valid');
    assert.equal(entry.statusCode, 200);
    assert.equal(entry.isBroken, false);
  });

  await t.test('a broken internal link is reported broken with a real status code', () => {
    const entry = byTarget('/missing');
    assert.equal(entry.validationStatus, 'broken');
    assert.equal(entry.statusCode, 404);
    assert.equal(entry.isBroken, true);
  });

  await t.test('a redirect is detected and marked accordingly', () => {
    const entry = byTarget('/redirect');
    assert.equal(entry.validationStatus, 'redirect');
    assert.equal(entry.isRedirect, true);
  });

  await t.test('a soft-404 candidate is escalated to the browser and confirmed broken', () => {
    const entry = byTarget('/soft404');
    assert.equal(entry.validationMethod, 'browser');
    assert.equal(entry.validationStatus, 'broken');
    assert.equal(entry.isSoft404, true);
    assert.ok(entry.browserValidation, 'browserValidation detail should be populated');
  });

  await t.test('two distinct anchors on the same page are both recorded and valid — the dedup regression', () => {
    const section1 = lines.find(l => l.targetUrl.endsWith('#section1'));
    const section2 = lines.find(l => l.targetUrl.endsWith('#section2'));

    assert.ok(section1, '#section1 must be present (not silently dropped)');
    assert.ok(section2, '#section2 must be present — this is the fragment-dedup bug regression check');
    assert.equal(section1.validationMethod, 'anchor');
    assert.equal(section2.validationMethod, 'anchor');
    assert.equal(section1.validationStatus, 'valid');
    assert.equal(section2.validationStatus, 'valid');

    const duplicateSection1Count = lines.filter(l => l.targetUrl.endsWith('#section1')).length;
    assert.equal(duplicateSection1Count, 1, 'the duplicate #section1 link should have been deduped to one entry');
  });

  await t.test('a broken anchor (no matching id) is reported broken with a specific error type', () => {
    const entry = byTarget('#missing-anchor');
    assert.equal(entry.validationMethod, 'anchor');
    assert.equal(entry.validationStatus, 'broken');
    assert.equal(entry.errorType, 'missing-anchor');
  });

  await t.test('mailto and tel links are explicitly not_checked, never silently "valid"', () => {
    const mail = lines.find(l => l.targetUrl.startsWith('mailto:'));
    const tel = lines.find(l => l.targetUrl.startsWith('tel:'));
    assert.equal(mail.validationStatus, 'not_checked');
    assert.equal(mail.isBroken, false); // structurally false, but validationStatus is the source of truth
    assert.equal(tel.validationStatus, 'not_checked');
  });

  await t.test('a javascript: link is never fetched and is marked unsupported', () => {
    const entry = lines.find(l => l.targetUrl.startsWith('javascript:'));
    assert.equal(entry.urlCategory, 'unsupported');
    assert.equal(entry.validationStatus, 'not_checked');
    assert.equal(entry.errorType, 'unsupported-scheme');
  });

  await t.test('metrics and the JSON report reflect the same real numbers as the NDJSON', async () => {
    const report = await fs.readJson(path.join(runDir, 'report.json'));
    assert.equal(report.results.length, 10);
    assert.equal(report.metrics.crawledPages, 1);
    assert.ok(report.metrics.brokenLinks >= 2, 'missing link + broken anchor should both count as broken');
    assert.ok(report.metrics.notCheckedLinks >= 3, 'mailto + tel + javascript should all count as not checked');
  });

  await t.test('HTML and Excel reports were generated in the same run directory', async () => {
    assert.ok(await fs.pathExists(path.join(runDir, 'report.html')));
    assert.ok(await fs.pathExists(path.join(runDir, 'report.xlsx')));
  });

  await t.test('run-manifest.json records the target and completed status', async () => {
    const manifest = await fs.readJson(path.join(runDir, 'run-manifest.json'));
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.target.name, 'E2E Fixture');
    assert.equal(manifest.target.environment, 'development');
  });
});
