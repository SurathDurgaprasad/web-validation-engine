const test = require('node:test');
const assert = require('node:assert/strict');
const ConfigLoader = require('../config/ConfigLoader');

test('ConfigLoader', async (t) => {
  await t.test('rejects a config with no target.baseUrl', () => {
    assert.throws(() => ConfigLoader.load({ target: {} }), /target\.baseUrl.*required/);
  });

  await t.test('normalizes the nested schema into the flat internal shape', () => {
    const config = ConfigLoader.load({
      target: { name: 'My App', baseUrl: 'https://app.example.com/', environment: 'staging' },
      crawl: { maxDepth: 2, maxPages: 50, concurrency: 4, crawlDelayMs: 250 },
      validation: { http: true, browserFallback: false, retry: true, retryCount: 5 },
      scope: { excludedPaths: ['/logout'] },
      reporting: { excel: false }
    });

    assert.equal(config.targetName, 'My App');
    assert.equal(config.targetEnvironment, 'staging');
    assert.deepEqual(config.seedUrls, ['https://app.example.com/']);
    assert.deepEqual(config.allowedDomains, ['app.example.com']);
    assert.equal(config.maxDepth, 2);
    assert.equal(config.crawlDelay, 250);
    assert.equal(config.validateBrowserFallback, false);
    assert.equal(config.retryCount, 5);
    assert.deepEqual(config.excludedPaths, ['/logout']);
    assert.equal(config.reportExcel, false);
    assert.equal(config.reportHtml, true); // untouched -> default
  });

  await t.test('scope.allowedDomains overrides the domain derived from target.baseUrl', () => {
    const config = ConfigLoader.load({
      target: { baseUrl: 'https://app.example.com/' },
      scope: { allowedDomains: ['app.example.com', 'cdn.example.com'] }
    });
    assert.deepEqual(config.allowedDomains, ['app.example.com', 'cdn.example.com']);
  });

  await t.test('legacy flat config (no "target" key) still loads', () => {
    const config = ConfigLoader.load({
      seedUrls: ['https://legacy.example.com/'],
      allowedDomains: ['legacy.example.com'],
      maxDepth: 3
    });
    assert.equal(config.maxDepth, 3);
    assert.deepEqual(config.seedUrls, ['https://legacy.example.com/']);
  });

  // --- Malformed configuration: must fail early with an actionable,
  // field-identified message — never silently normalize to a default. ---

  await t.test('rejects a config with an empty target object', () => {
    assert.throws(() => ConfigLoader.load({ target: {} }), /target\.baseUrl.*required/);
  });

  await t.test('rejects a syntactically invalid baseUrl', () => {
    assert.throws(
      () => ConfigLoader.load({ target: { baseUrl: 'not-a-url' } }),
      /target\.baseUrl.*not a valid URL/
    );
  });

  await t.test('rejects an unsupported baseUrl scheme (file://)', () => {
    assert.throws(
      () => ConfigLoader.load({ target: { baseUrl: 'file:///etc/passwd' } }),
      /target\.baseUrl.*must use http or https/
    );
  });

  await t.test('rejects an unsupported baseUrl scheme (javascript:)', () => {
    assert.throws(
      () => ConfigLoader.load({ target: { baseUrl: 'javascript:alert(1)' } }),
      /target\.baseUrl.*must use http or https/
    );
  });

  await t.test('rejects a negative maxPages instead of silently accepting it', () => {
    assert.throws(
      () => ConfigLoader.load({ target: { baseUrl: 'https://example.com/' }, crawl: { maxPages: -5 } }),
      /crawl\.maxPages.*>= 1/
    );
  });

  await t.test('rejects zero maxPages (a crawl that can never crawl anything is not a valid limit)', () => {
    assert.throws(
      () => ConfigLoader.load({ target: { baseUrl: 'https://example.com/' }, crawl: { maxPages: 0 } }),
      /crawl\.maxPages.*>= 1/
    );
  });

  await t.test('rejects a negative concurrency', () => {
    assert.throws(
      () => ConfigLoader.load({ target: { baseUrl: 'https://example.com/' }, crawl: { concurrency: -1 } }),
      /crawl\.concurrency.*>= 1/
    );
  });

  await t.test('accepts maxDepth: 0 (seeds only, not an error)', () => {
    const config = ConfigLoader.load({ target: { baseUrl: 'https://example.com/' }, crawl: { maxDepth: 0 } });
    assert.equal(config.maxDepth, 0);
  });

  await t.test('rejects a non-numeric timeout instead of silently falling back to the default', () => {
    assert.throws(
      () => ConfigLoader.load({ target: { baseUrl: 'https://example.com/' }, crawl: { timeout: '30000' } }),
      /crawl\.timeout.*must be an integer/
    );
  });

  await t.test('rejects a zero retryCount', () => {
    assert.throws(
      () => ConfigLoader.load({ target: { baseUrl: 'https://example.com/' }, validation: { retryCount: 0 } }),
      /validation\.retryCount.*>= 1/
    );
  });

  await t.test('rejects a non-boolean value for a boolean field', () => {
    assert.throws(
      () => ConfigLoader.load({ target: { baseUrl: 'https://example.com/' }, validation: { http: 'yes' } }),
      /validation\.http.*must be a boolean/
    );
  });

  await t.test('rejects a malformed (non-object) nested section', () => {
    assert.throws(
      () => ConfigLoader.load({ target: { baseUrl: 'https://example.com/' }, crawl: 'not an object' }),
      /"crawl".*must be an object/
    );
  });

  await t.test('rejects a malformed (array) nested section', () => {
    assert.throws(
      () => ConfigLoader.load({ target: { baseUrl: 'https://example.com/' }, validation: [1, 2, 3] }),
      /"validation".*must be an object/
    );
  });

  await t.test('rejects a non-string-array scope.allowedDomains', () => {
    assert.throws(
      () => ConfigLoader.load({ target: { baseUrl: 'https://example.com/' }, scope: { allowedDomains: [123] } }),
      /scope\.allowedDomains.*array of strings/
    );
  });

  await t.test('rejects an invalid seed URL inside target.seedUrls', () => {
    assert.throws(
      () => ConfigLoader.load({
        target: { baseUrl: 'https://example.com/', seedUrls: ['https://example.com/', 'ftp://example.com/'] }
      }),
      /target\.seedUrls\[1\].*must use http or https/
    );
  });
});
