const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyUrl } = require('../utils/urlClassifier');

const config = { allowedDomains: ['example.com'] };

test('URL classification', async (t) => {
  await t.test('http(s) link on an allowed domain is internal', () => {
    const r = classifyUrl('https://example.com/docs/page', 'https://example.com/docs/', config);
    assert.equal(r.scheme, 'https');
    assert.equal(r.category, 'internal');
    assert.equal(r.isInternal, true);
  });

  await t.test('http(s) link on a different domain is external', () => {
    const r = classifyUrl('https://other-site.test/page', 'https://example.com/docs/', config);
    assert.equal(r.category, 'external');
    assert.equal(r.isInternal, false);
  });

  await t.test('mailto: is a real link but is never fetched — "ignored"', () => {
    const r = classifyUrl('mailto:person@example.com', 'https://example.com/', config);
    assert.equal(r.scheme, 'mailto');
    assert.equal(r.category, 'ignored');
  });

  await t.test('tel: is ignored', () => {
    const r = classifyUrl('tel:+15551234567', 'https://example.com/', config);
    assert.equal(r.scheme, 'tel');
    assert.equal(r.category, 'ignored');
  });

  await t.test('javascript: is unsupported — must never reach HTTP or browser validation', () => {
    const r = classifyUrl('javascript:doSomething()', 'https://example.com/', config);
    assert.equal(r.scheme, 'javascript');
    assert.equal(r.category, 'unsupported');
  });

  await t.test('data: is unsupported', () => {
    const r = classifyUrl('data:text/plain;base64,SGVsbG8=', 'https://example.com/', config);
    assert.equal(r.scheme, 'data');
    assert.equal(r.category, 'unsupported');
  });

  await t.test('file: is unsupported — no local filesystem access', () => {
    const r = classifyUrl('file:///etc/passwd', 'https://example.com/', config);
    assert.equal(r.scheme, 'file');
    assert.equal(r.category, 'unsupported');
  });

  await t.test('blob: is unsupported', () => {
    const r = classifyUrl('blob:https://example.com/uuid-here', 'https://example.com/', config);
    assert.equal(r.category, 'unsupported');
  });

  await t.test('an unresolvable/relative string (no base to resolve against) is unsupported, not crawlable', () => {
    const r = classifyUrl('/relative/path', null, config);
    assert.equal(r.scheme, 'unknown');
    assert.equal(r.category, 'unsupported');
  });

  await t.test('a same-document fragment link is "anchor" — resolved via page-level anchor scan, not HTTP-fetched', () => {
    const r = classifyUrl('https://example.com/docs/page#section-2', 'https://example.com/docs/page', config);
    assert.equal(r.category, 'anchor');
    assert.equal(r.targetId, 'section-2');
    assert.equal(r.isInternal, true);
  });

  await t.test('a fragment link to a *different* page is internal, not an anchor', () => {
    const r = classifyUrl('https://example.com/docs/other#section-2', 'https://example.com/docs/page', config);
    assert.equal(r.category, 'internal');
  });
});
