const test = require('node:test');
const assert = require('node:assert/strict');
const { isInternalUrl, redactCredentials, normalizeUrl } = require('../utils/urlUtils');

test('isInternalUrl', async (t) => {
  const allowedDomains = ['example.com'];

  await t.test('exact host match is internal', () => {
    assert.equal(isInternalUrl('https://example.com/page', allowedDomains), true);
  });

  await t.test('a proper subdomain is internal', () => {
    assert.equal(isInternalUrl('https://docs.example.com/page', allowedDomains), true);
  });

  await t.test('is case-insensitive', () => {
    assert.equal(isInternalUrl('https://EXAMPLE.com/page', allowedDomains), true);
  });

  // Regression coverage: `.includes()` previously matched *any* substring
  // position, not just a proper suffix — so allowedDomains ["example.com"]
  // would incorrectly treat any of these as "internal", widening both crawl
  // scope and what gets browser-escalated.
  await t.test('a domain that merely contains the allowed domain as a substring is NOT internal', () => {
    assert.equal(isInternalUrl('https://notexample.com/page', allowedDomains), false);
    assert.equal(isInternalUrl('https://myexample.com/page', allowedDomains), false);
  });

  await t.test('a lookalike domain with the allowed domain appended is NOT internal', () => {
    assert.equal(isInternalUrl('https://example.com.attacker.net/page', allowedDomains), false);
  });

  await t.test('an unrelated domain is not internal', () => {
    assert.equal(isInternalUrl('https://other-site.test/page', allowedDomains), false);
  });

  await t.test('an unparsable URL is not internal (and does not throw)', () => {
    assert.equal(isInternalUrl('not a url', allowedDomains), false);
  });
});

test('redactCredentials', async (t) => {
  await t.test('strips embedded Basic Auth credentials from a URL', () => {
    const redacted = redactCredentials('https://admin:secret123@internal.example.com/panel');
    assert.ok(!redacted.includes('admin'));
    assert.ok(!redacted.includes('secret123'));
    assert.equal(redacted, 'https://internal.example.com/panel');
  });

  await t.test('leaves a URL with no credentials unchanged', () => {
    const url = 'https://example.com/page?x=1';
    assert.equal(redactCredentials(url), url);
  });

  await t.test('does not throw on an unparsable value', () => {
    assert.equal(redactCredentials('not a url'), 'not a url');
    assert.equal(redactCredentials(null), null);
    assert.equal(redactCredentials(undefined), undefined);
  });
});

test('normalizeUrl', async (t) => {
  await t.test('strips fragments when ignoreFragments is set', () => {
    assert.equal(
      normalizeUrl('https://example.com/page#section', { ignoreFragments: true }),
      'https://example.com/page'
    );
  });

  await t.test('preserves fragments when ignoreFragments is false', () => {
    assert.equal(
      normalizeUrl('https://example.com/page#section', { ignoreFragments: false }),
      'https://example.com/page#section'
    );
  });

  await t.test('an unparsable URL is returned unchanged rather than throwing', () => {
    assert.equal(normalizeUrl('not a url', { ignoreFragments: true }), 'not a url');
  });
});
