const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestServer } = require('./helpers/testServer');
const HttpValidator = require('../validators/HttpValidator');

test('HttpValidator', async (t) => {
  const fixture = createTestServer();
  const port = await fixture.start();
  const base = `http://127.0.0.1:${port}`;

  const config = {
    allowedDomains: ['127.0.0.1'],
    timeout: 1000,
    ignoreFragments: true,
    validateSoft404: true,
    soft404Keywords: ['page not found', 'could not find']
  };
  const validator = new HttpValidator(config);

  await t.test('200 OK is reported as valid — real statusCode, not a hard-coded default', async () => {
    const result = await validator.validate(`${base}/ok`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.isBroken, false);
    assert.equal(result.isRedirect, false);
    assert.equal(result.isSoft404, false);
  });

  await t.test('404 is reported broken with the real status code', async () => {
    const result = await validator.validate(`${base}/missing`);
    assert.equal(result.statusCode, 404);
    assert.equal(result.isBroken, true);
  });

  await t.test('a redirect is detected by comparing final vs requested URL, not by status code', async () => {
    // axios auto-follows redirects, so the terminal response.status here is
    // 200 — this is exactly the case the original implementation got wrong
    // (checking status>=300&&<400 would never fire once axios has followed
    // the redirect). See docs/ENGINEERING_REPORT.md.
    const result = await validator.validate(`${base}/redirect`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.isRedirect, true);
    assert.match(result.finalUrl, /\/ok$/);
  });

  await t.test('soft-404 content on a 200 response is flagged via isSoft404, isBroken stays false', async () => {
    const result = await validator.validate(`${base}/soft404`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.isBroken, false);
    assert.equal(result.isSoft404, true);
  });

  await t.test('a network timeout is classified with errorType "timeout"', async () => {
    const shortTimeoutValidator = new HttpValidator({ ...config, timeout: 200 });
    const result = await shortTimeoutValidator.validate(`${base}/slow`);
    assert.equal(result.statusCode, null);
    assert.equal(result.isBroken, true);
    assert.equal(result.errorType, 'timeout');
  });

  await t.test('a genuine redirect loop is reported broken with errorType "redirect-loop", not hung', async () => {
    const start = Date.now();
    const result = await validator.validate(`${base}/redirect-loop`);
    const elapsedMs = Date.now() - start;

    assert.ok(elapsedMs < 5000, `should fail fast once axios's redirect cap is hit, took ${elapsedMs}ms`);
    assert.equal(result.isBroken, true);
    assert.equal(result.errorType, 'redirect-loop');
  });

  await fixture.stop();
});
