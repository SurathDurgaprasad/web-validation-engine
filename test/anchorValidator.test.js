const test = require('node:test');
const assert = require('node:assert/strict');
const AnchorValidator = require('../validators/AnchorValidator');

function makeAnchor(href, text) {
  return {
    getAttribute: async () => href,
    textContent: async () => text
  };
}

function makeThrowingAnchor() {
  return {
    getAttribute: async () => {
      throw new Error('element detached from DOM');
    },
    textContent: async () => ''
  };
}

function makeMockPage({ anchors, existingIds }) {
  return {
    $$: async (selector) => (selector === 'a[href^="#"]' ? anchors : []),
    $: async (selector) => (existingIds.has(selector.slice(1)) ? {} : null)
  };
}

test('AnchorValidator', async (t) => {
  await t.test('an anchor whose target id exists on the page is valid', async () => {
    const page = makeMockPage({
      anchors: [makeAnchor('#intro', 'Jump to intro')],
      existingIds: new Set(['intro'])
    });
    const validator = new AnchorValidator({});
    const result = await validator.validate(page, 'https://example.com/docs');

    assert.equal(result.totalAnchors, 1);
    assert.equal(result.brokenAnchors, 0);
    assert.equal(result.results[0].status, 'valid');
    assert.equal(result.results[0].isBroken, false);
    assert.equal(result.results[0].targetId, 'intro');
  });

  await t.test('an anchor whose target id does not exist is reported missing', async () => {
    const page = makeMockPage({
      anchors: [makeAnchor('#does-not-exist', 'Broken anchor')],
      existingIds: new Set()
    });
    const validator = new AnchorValidator({});
    const result = await validator.validate(page, 'https://example.com/docs');

    assert.equal(result.brokenAnchors, 1);
    assert.equal(result.results[0].status, 'missing');
    assert.equal(result.results[0].isBroken, true);
  });

  await t.test('a DOM error on one anchor is caught and reported as a validation error, not thrown', async () => {
    // Regression test for the reference-before-assignment bug found in the
    // audit: the catch block used to reference `href` before it was ever
    // declared, so a failure here would throw a ReferenceError instead of
    // producing a result.
    const page = makeMockPage({
      anchors: [makeThrowingAnchor()],
      existingIds: new Set()
    });
    const validator = new AnchorValidator({});

    const result = await validator.validate(page, 'https://example.com/docs');

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].status, 'error');
    assert.equal(result.results[0].isBroken, true);
    assert.match(result.results[0].error, /detached from DOM/);
  });

  await t.test('href="#" alone is skipped, not counted as broken', async () => {
    const page = makeMockPage({
      anchors: [makeAnchor('#', 'Back to top')],
      existingIds: new Set()
    });
    const validator = new AnchorValidator({});
    const result = await validator.validate(page, 'https://example.com/docs');

    assert.equal(result.totalAnchors, 0);
  });
});
