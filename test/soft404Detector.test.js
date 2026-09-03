const test = require('node:test');
const assert = require('node:assert/strict');
const Soft404Detector = require('../validators/Soft404Detector');

test('Soft404Detector', async (t) => {
  await t.test('a normal, substantial page is not flagged', () => {
    const html = `<html><body><main><h1>Welcome</h1><p>${'Real content. '.repeat(50)}</p></main></body></html>`;
    assert.equal(Soft404Detector.detect(html, ['page not found']), false);
  });

  await t.test('content matching a configured soft-404 keyword is flagged', () => {
    const html = '<html><body><h1>Page Not Found</h1><p>Sorry, we could not find that page.</p></body></html>';
    assert.equal(Soft404Detector.detect(html, ['page not found']), true);
  });

  await t.test('very short content is flagged even without a keyword match', () => {
    assert.equal(Soft404Detector.detect('<html><body><p>Hi</p></body></html>', []), true);
  });

  await t.test('non-string content (e.g. no body was fetched) is treated as not detected, not as a false positive', () => {
    assert.equal(Soft404Detector.detect(null, ['404']), false);
    assert.equal(Soft404Detector.detect(undefined, ['404']), false);
  });
});
