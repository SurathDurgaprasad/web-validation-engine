const test = require('node:test');
const assert = require('node:assert/strict');
const HttpValidator = require('../validators/HttpValidator');

// Regression coverage for a real bug found during integration hardening:
// extractRedirectChain() walks an undocumented axios/follow-redirects
// internal property (`_redirectable._currentRequest`). Under the axios
// version this project resolves to, that property pointed back at the same
// object for an ordinary non-redirected request, and the original unguarded
// `while (current) { ... }` walk built a ~134-million-element array before
// JSON.stringify finally threw "Invalid string length" — silently losing
// the entire link record (the write was wrapped in a swallowing catch).
//
// These tests use small, controlled synthetic request-like objects to prove
// the fix — they deliberately do NOT attempt to reproduce the multi-hundred-
// million-element allocation itself.

function makeValidator() {
  return new HttpValidator({ allowedDomains: ['example.com'], timeout: 1000, ignoreFragments: true });
}

test('HttpValidator.extractRedirectChain', async (t) => {
  await t.test('terminates immediately on a direct self-reference instead of looping', () => {
    const validator = makeValidator();
    const req = { res: { responseUrl: 'https://example.com/a' } };
    req._redirectable = { _currentRequest: req }; // points at itself

    const start = Date.now();
    const chain = validator.extractRedirectChain(req);
    const elapsedMs = Date.now() - start;

    assert.equal(chain.length, 1, 'should record the one real hop, not loop');
    assert.deepEqual(chain, ['https://example.com/a']);
    assert.ok(elapsedMs < 100, `should return near-instantly, took ${elapsedMs}ms`);
  });

  await t.test('terminates on an indirect (multi-node) cycle, not just direct self-reference', () => {
    const validator = makeValidator();
    const a = { res: { responseUrl: 'https://example.com/a' } };
    const b = { res: { responseUrl: 'https://example.com/b' } };
    const c = { res: { responseUrl: 'https://example.com/c' } };
    a._redirectable = { _currentRequest: b };
    b._redirectable = { _currentRequest: c };
    c._redirectable = { _currentRequest: a }; // cycles back to a, not to itself

    const chain = validator.extractRedirectChain(a);

    assert.deepEqual(chain, [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c'
    ]);
  });

  await t.test('enforces a hard cap on chain length for a long (non-cyclic) structure', () => {
    const validator = makeValidator();
    // Build a 30-node linked list — longer than the internal cap — with no
    // cycle at all, to prove the cap applies independently of cycle
    // detection.
    const nodes = [];
    for (let i = 0; i < 30; i++) {
      nodes.push({ res: { responseUrl: `https://example.com/hop-${i}` } });
    }
    for (let i = 0; i < nodes.length - 1; i++) {
      nodes[i]._redirectable = { _currentRequest: nodes[i + 1] };
    }

    const chain = validator.extractRedirectChain(nodes[0]);

    assert.ok(chain.length <= 20, `expected a capped chain, got ${chain.length} entries`);
    assert.equal(chain[0], 'https://example.com/hop-0');
  });

  await t.test('the result of a pathological cyclic walk is always safely serializable', () => {
    const validator = makeValidator();
    const req = { res: { responseUrl: 'https://example.com/a' } };
    req._redirectable = { _currentRequest: req };

    const chain = validator.extractRedirectChain(req);

    assert.doesNotThrow(() => JSON.stringify(chain));
    assert.ok(JSON.stringify(chain).length < 1000, 'serialized chain should be small, not runaway');
  });

  await t.test('a normal, small, non-cyclic redirect chain is still captured accurately', () => {
    const validator = makeValidator();
    const first = { res: { responseUrl: 'https://example.com/old' } };
    const final = { res: { responseUrl: 'https://example.com/new' } };
    first._redirectable = { _currentRequest: final };
    // `final` has no further _redirectable — the walk should stop naturally.

    const chain = validator.extractRedirectChain(first);

    assert.deepEqual(chain, ['https://example.com/old', 'https://example.com/new']);
  });

  await t.test('a malformed request object (no .res) does not throw', () => {
    const validator = makeValidator();
    assert.doesNotThrow(() => validator.extractRedirectChain({}));
    assert.doesNotThrow(() => validator.extractRedirectChain(null));
    assert.doesNotThrow(() => validator.extractRedirectChain(undefined));
  });
});
