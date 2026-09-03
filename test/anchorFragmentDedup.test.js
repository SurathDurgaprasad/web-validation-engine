const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyUrl, getDedupeKey } = require('../utils/urlClassifier');
const { normalizeUrl } = require('../utils/urlUtils');

// Regression coverage for a real bug found during integration hardening:
// PageCrawler deduped every discovered link on a page using
// normalizeUrl()'s output, which strips URL fragments by design (that's
// what makes *crawl-queue* dedup correct — /page#a and /page#b are the same
// page to visit once). Applied to *link-validation* dedup as well, that
// collapsed every distinct "#section" anchor link on a page into just the
// first one seen: on a real page with #section1/#section2/#section3, only
// #section1 ever got recorded — the rest silently vanished before
// validation even ran.

const config = { allowedDomains: ['example.com'], ignoreFragments: true };
const pageUrl = 'https://example.com/docs/page';

test('Anchor fragment deduplication', async (t) => {
  await t.test('two different fragments on the same page produce two different dedupe keys', () => {
    const targetA = 'https://example.com/docs/page#section1';
    const targetB = 'https://example.com/docs/page#section2';

    const classA = classifyUrl(targetA, pageUrl, config);
    const classB = classifyUrl(targetB, pageUrl, config);
    assert.equal(classA.category, 'anchor');
    assert.equal(classB.category, 'anchor');

    const keyA = getDedupeKey(targetA, normalizeUrl(targetA, config), classA);
    const keyB = getDedupeKey(targetB, normalizeUrl(targetB, config), classB);

    assert.notEqual(keyA, keyB, '#section1 and #section2 must remain distinct validation targets');
  });

  await t.test('the same fragment linked twice on one page does dedupe', () => {
    const target = 'https://example.com/docs/page#section1';
    const classification = classifyUrl(target, pageUrl, config);
    const normalized = normalizeUrl(target, config);

    const keyFirst = getDedupeKey(target, normalized, classification);
    const keySecond = getDedupeKey(target, normalized, classification);

    assert.equal(keyFirst, keySecond, 'identical anchor hrefs should still collapse to one entry');
  });

  await t.test('a full page-scan simulation: 3 distinct anchors + 1 duplicate yields exactly 3 entries', () => {
    const hrefs = [
      'https://example.com/docs/page#section1',
      'https://example.com/docs/page#section2',
      'https://example.com/docs/page#section3',
      'https://example.com/docs/page#section1' // duplicate of the first
    ];

    const seen = new Set();
    const kept = [];
    for (const target of hrefs) {
      const classification = classifyUrl(target, pageUrl, config);
      const normalized = normalizeUrl(target, config);
      const key = getDedupeKey(target, normalized, classification);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(target);
    }

    assert.equal(kept.length, 3, 'expected 3 distinct anchor targets after dedup, not 1 (collapsed) or 4 (undeduped)');
    assert.deepEqual(kept, [
      'https://example.com/docs/page#section1',
      'https://example.com/docs/page#section2',
      'https://example.com/docs/page#section3'
    ]);
  });

  await t.test('non-anchor links still dedupe on the fragment-stripped normalized URL (unaffected by the fix)', () => {
    const targetA = 'https://example.com/docs/other-page';
    const targetB = 'https://example.com/docs/other-page/'; // trailing slash — same resource
    const classA = classifyUrl(targetA, pageUrl, config);
    const classB = classifyUrl(targetB, pageUrl, config);
    assert.equal(classA.category, 'internal');

    const keyA = getDedupeKey(targetA, normalizeUrl(targetA, config), classA);
    const keyB = getDedupeKey(targetB, normalizeUrl(targetB, config), classB);

    assert.equal(keyA, keyB, 'ordinary links should still dedupe via normalization, unaffected by the anchor fix');
  });

  await t.test('crawl identity (page visited-tracking) and link-validation identity are deliberately different', () => {
    // The page itself is identified by its fragment-stripped normalized URL
    // — this is what StateManager.hasVisited()/markVisited() key off of, and
    // it is correct for that to collapse #section1/#section2/#section3 down
    // to one page. What must NOT happen is that same collapsing rule being
    // reused for per-link validation identity — proven above.
    const pageWithFragment1 = normalizeUrl('https://example.com/docs/page#section1', config);
    const pageWithFragment2 = normalizeUrl('https://example.com/docs/page#section2', config);
    const pageNoFragment = normalizeUrl('https://example.com/docs/page', config);

    assert.equal(pageWithFragment1, pageNoFragment, 'crawl identity must ignore fragments');
    assert.equal(pageWithFragment2, pageNoFragment, 'crawl identity must ignore fragments');

    // ...yet those same two fragment URLs are classified as anchors with
    // distinct targetIds, which is what keeps their *validation* identity
    // separate (proven in the first test above).
    const classA = classifyUrl('https://example.com/docs/page#section1', pageUrl, config);
    const classB = classifyUrl('https://example.com/docs/page#section2', pageUrl, config);
    assert.notEqual(classA.targetId, classB.targetId);
  });
});
