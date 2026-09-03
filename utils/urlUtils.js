function normalizeUrl(url, config) {
  try {
    const parsed = new URL(url);

    // Remove duplicate slashes
    parsed.pathname = parsed.pathname.replace(/\/+/g, '/');

    // Normalize trailing slash
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    // Remove tracking parameters
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
    trackingParams.forEach(param => {
      parsed.searchParams.delete(param);
    });

    // Remove fragments if configured
    if (config.ignoreFragments) {
      parsed.hash = '';
    }

    return parsed.href;
  } catch (error) {
    // If URL parsing fails, return as-is
    return url;
  }
}

function isInternalUrl(url, allowedDomains) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    // Exact host match or a proper subdomain of an allowed domain — NOT a
    // substring match. `.includes()` here previously meant allowedDomains
    // ["example.com"] would also treat "notexample.com",
    // "example.com.attacker.net", and "myexample.com" as internal, which
    // both breaks crawl-scope containment and widens what gets treated as
    // "safe to browser-escalate". See docs/FINAL_HARDENING_REPORT.md.
    return allowedDomains.some(domain => {
      const d = String(domain).toLowerCase();
      return hostname === d || hostname.endsWith(`.${d}`);
    });
  } catch (error) {
    return false;
  }
}

function extractDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch (error) {
    return null;
  }
}

function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch (error) {
    return false;
  }
}

function resolveUrl(baseUrl, relativeUrl) {
  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch (error) {
    return relativeUrl;
  }
}

function getUrlPath(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch (error) {
    return '';
  }
}

function getUrlQuery(url) {
  try {
    const parsed = new URL(url);
    return parsed.search;
  } catch (error) {
    return '';
  }
}

/**
 * Strips embedded HTTP Basic Auth credentials (`https://user:pass@host/...`)
 * from a URL before it is written to any report, NDJSON record, or log line.
 * Does not touch the URL actually used to perform a request — only applied
 * at output boundaries (see CrawlManager) so validation itself is unaffected.
 */
function redactCredentials(url) {
  if (typeof url !== 'string' || url.length === 0) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch (error) {
    return url;
  }
}

module.exports = {
  normalizeUrl,
  isInternalUrl,
  extractDomain,
  isValidUrl,
  resolveUrl,
  getUrlPath,
  getUrlQuery,
  redactCredentials
};