const { isInternalUrl } = require('./urlUtils');

// Schemes that are legitimate links but are never fetched by this tool —
// there is nothing to validate over HTTP.
const IGNORED_SCHEMES = new Set(['mailto', 'tel', 'sms']);

// Schemes that must never be handed to axios or Playwright's page.goto().
// javascript:/data:/file:/blob: in particular are excluded deliberately for
// safety (arbitrary script execution, local filesystem access, huge/binary
// payloads, or URLs that are only meaningful inside the originating page).
const UNSUPPORTED_SCHEMES = new Set(['javascript', 'data', 'file', 'blob', 'ftp', 'ws', 'wss']);

function stripTrailingSlash(pathname) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/**
 * True when `targetParsed` points at the same document as `sourceUrl` and
 * only differs by a fragment — i.e. it's an in-page anchor link, not a
 * navigable link to a different resource.
 */
function isSameDocument(sourceUrl, targetParsed) {
  try {
    const src = new URL(sourceUrl);
    return src.origin === targetParsed.origin &&
      stripTrailingSlash(src.pathname) === stripTrailingSlash(targetParsed.pathname) &&
      src.search === targetParsed.search;
  } catch (e) {
    return false;
  }
}

/**
 * Classifies a discovered link so callers know what's safe/meaningful to do
 * with it, without ad-hoc scheme checks scattered through the crawler.
 *
 * category:
 *   'internal' — http(s), same allowed domain as the target — crawlable + validatable
 *   'external' — http(s), different domain — validatable only, never queued for crawling
 *   'anchor'   — same-document fragment link (href="#section") — resolved via
 *                a page-level AnchorValidator pass, never HTTP-fetched
 *   'ignored'  — mailto/tel/sms — a real link, deliberately not checked
 *   'unsupported' — javascript:/data:/file:/blob:/unparsable — never fetched
 */
function classifyUrl(targetUrl, sourceUrl, config) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return { scheme: 'unknown', category: 'unsupported', isInternal: false };
  }

  const scheme = parsed.protocol.replace(':', '').toLowerCase();

  if (IGNORED_SCHEMES.has(scheme)) {
    return { scheme, category: 'ignored', isInternal: false };
  }

  if (UNSUPPORTED_SCHEMES.has(scheme)) {
    return { scheme, category: 'unsupported', isInternal: false };
  }

  if (scheme !== 'http' && scheme !== 'https') {
    return { scheme, category: 'unsupported', isInternal: false };
  }

  if (sourceUrl && parsed.hash && isSameDocument(sourceUrl, parsed)) {
    return { scheme, category: 'anchor', isInternal: true, targetId: parsed.hash.substring(1) };
  }

  const isInternal = isInternalUrl(targetUrl, (config && config.allowedDomains) || []);
  return { scheme, category: isInternal ? 'internal' : 'external', isInternal };
}

/**
 * Two distinct dedup semantics live side by side in this crawler, and
 * conflating them was the root cause of a real bug (see
 * FINAL_HARDENING_REPORT.md): crawl identity (has this *page* been visited?)
 * is fragment-insensitive by design — `/page#a` and `/page#b` are the same
 * page to crawl once. Link-validation identity is not — `#a` and `#b` are
 * two different anchor targets that must be validated independently.
 *
 * `normalizedTarget` here is expected to already have fragments stripped
 * (via urlUtils.normalizeUrl with ignoreFragments), which is exactly right
 * for crawlable/validatable http(s) links. For an "anchor" category link,
 * using that same fragment-stripped value as the per-link dedup key would
 * collapse every distinct "#section" on a page into one — so anchor links
 * are deduped on their raw (fragment-preserving) target instead.
 */
function getDedupeKey(rawTarget, normalizedTarget, classification) {
  return classification.category === 'anchor' ? rawTarget : normalizedTarget;
}

module.exports = { classifyUrl, getDedupeKey };
