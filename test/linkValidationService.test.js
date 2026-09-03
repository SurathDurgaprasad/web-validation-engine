const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestServer } = require('./helpers/testServer');
const LinkValidationService = require('../crawler/LinkValidationService');

function makeConfig(overrides = {}) {
  return {
    allowedDomains: ['127.0.0.1'],
    timeout: 1000,
    ignoreFragments: true,
    validateSoft404: true,
    soft404Keywords: [],
    retryEnabled: true,
    retryCount: 3,
    validateBrowserFallback: false,
    validationConcurrency: 2,
    ...overrides
  };
}

test('LinkValidationService retry behavior', async (t) => {
  const fixture = createTestServer();
  const port = await fixture.start();
  const base = `http://127.0.0.1:${port}`;

  await t.test('retries a transient 503 and records the successful attempt', async () => {
    const service = new LinkValidationService(makeConfig());
    const result = await service.validateHttpWithRetry(`${base}/flaky?id=retry-success`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.isBroken, false);
    assert.equal(result.retryAttempts, 2); // 1st attempt 503, 2nd attempt 200
  });

  await t.test('does not retry a deterministic 404 — one attempt only', async () => {
    const service = new LinkValidationService(makeConfig());
    const result = await service.validateHttpWithRetry(`${base}/missing`);
    assert.equal(result.statusCode, 404);
    assert.equal(result.isBroken, true);
    assert.equal(result.retryAttempts, 1);
  });

  await t.test('retry is skipped entirely when validation.retry is disabled', async () => {
    const service = new LinkValidationService(makeConfig({ retryEnabled: false }));
    const result = await service.validateHttpWithRetry(`${base}/flaky?id=retry-disabled`);
    // Still 503 because retry never happened for this fresh key.
    assert.equal(result.statusCode, 503);
    assert.equal(result.retryAttempts, 1);
  });

  await fixture.stop();
});
