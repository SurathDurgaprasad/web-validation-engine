const { DEFAULT_CONFIG } = require('../utils/constants');
const { extractDomain } = require('../utils/urlUtils');

const ALLOWED_TARGET_SCHEMES = new Set(['http:', 'https:']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates and returns a required-or-optional HTTP(S) URL field. Throws a
 * clear, field-identified error rather than silently falling back — an
 * invalid target must fail the run early, not produce a config that quietly
 * points nowhere useful (or somewhere unsafe, like `file://`).
 */
function validateHttpUrl(value, fieldName, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(
        `Configuration error: "${fieldName}" is required — it is the URL of the ` +
        `application/site to crawl and validate (e.g. "https://example.com/").`
      );
    }
    return undefined;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Configuration error: "${fieldName}" must be a non-empty string URL (got ${JSON.stringify(value)}).`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (e) {
    throw new Error(`Configuration error: "${fieldName}" is not a valid URL: ${JSON.stringify(value)}`);
  }

  if (!ALLOWED_TARGET_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `Configuration error: "${fieldName}" must use http or https (got "${parsed.protocol}" from ${JSON.stringify(value)}). ` +
      `This tool crawls web targets — other URL schemes are never valid here.`
    );
  }

  return value;
}

function validateHttpUrlArray(value, fieldName) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Configuration error: "${fieldName}" must be a non-empty array of URLs.`);
  }
  value.forEach((v, i) => validateHttpUrl(v, `${fieldName}[${i}]`, { required: true }));
  return value;
}

function validateStringArray(value, fieldName) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
    throw new Error(`Configuration error: "${fieldName}" must be an array of strings (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/**
 * Validates an optional integer field. Returns `fallback` only when the
 * field was omitted entirely — a *present but invalid* value (wrong type,
 * non-integer, out of range) always throws, per the requirement that
 * dangerous/nonsensical values must never be silently normalized away.
 */
function validateInt(value, fieldName, { min = null, fallback } = {}) {
  if (value === undefined || value === null) return fallback;

  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`Configuration error: "${fieldName}" must be an integer (got ${JSON.stringify(value)}).`);
  }
  if (min !== null && value < min) {
    throw new Error(`Configuration error: "${fieldName}" must be >= ${min} (got ${value}).`);
  }
  return value;
}

function validateBool(value, fieldName, { fallback } = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Configuration error: "${fieldName}" must be a boolean (got ${JSON.stringify(value)}).`);
  }
  return value;
}

function validateSection(value, fieldName) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    throw new Error(`Configuration error: "${fieldName}" must be an object (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/**
 * Normalizes the generic, nested target-configuration schema:
 *
 *   { target: {...}, crawl: {...}, validation: {...}, scope: {...}, reporting: {...} }
 *
 * into the flat internal config shape the crawler/validators/reporters consume.
 * The only thing that identifies *what* gets crawled is `target.baseUrl` —
 * nothing in this file, or anywhere it feeds into, names a specific product
 * or website. See config/config.json for the generic default and
 * config/examples/ for sample targets (including the historical Eggplant
 * Software documentation run referenced in PROJECT_AUDIT.md).
 *
 * Every field here either falls back to a documented default when omitted,
 * or throws a specific, field-identified error when present but invalid.
 * Nothing is silently coerced into "probably what you meant."
 */
function normalizeNestedConfig(raw) {
  const target = validateSection(raw.target, 'target');
  const crawl = validateSection(raw.crawl, 'crawl');
  const validation = validateSection(raw.validation, 'validation');
  const scope = validateSection(raw.scope, 'scope');
  const reporting = validateSection(raw.reporting, 'reporting');

  validateHttpUrl(target.baseUrl, 'target.baseUrl', { required: true });
  const baseDomain = extractDomain(target.baseUrl);
  // Unreachable in practice — validateHttpUrl already rejects anything
  // extractDomain would fail on — but kept as a defensive guard rather than
  // assuming that will always remain true.
  if (!baseDomain) {
    throw new Error(`Configuration error: "target.baseUrl" is not a valid URL: ${JSON.stringify(target.baseUrl)}`);
  }

  const seedUrls = validateHttpUrlArray(target.seedUrls, 'target.seedUrls') || [target.baseUrl];
  const allowedDomains = validateStringArray(scope.allowedDomains, 'scope.allowedDomains');
  const excludedPaths = validateStringArray(scope.excludedPaths, 'scope.excludedPaths');
  const soft404Keywords = validateStringArray(validation.soft404Keywords, 'validation.soft404Keywords');

  if (target.name !== undefined && typeof target.name !== 'string') {
    throw new Error(`Configuration error: "target.name" must be a string (got ${JSON.stringify(target.name)}).`);
  }
  if (target.environment !== undefined && typeof target.environment !== 'string') {
    throw new Error(`Configuration error: "target.environment" must be a string (got ${JSON.stringify(target.environment)}).`);
  }

  return {
    // Metadata only — never used for branching logic in the crawl/validation engine.
    targetName: target.name || baseDomain,
    targetEnvironment: target.environment || 'unspecified',
    targetBaseUrl: target.baseUrl,

    seedUrls,
    allowedDomains: allowedDomains && allowedDomains.length > 0 ? allowedDomains : [baseDomain],
    excludedPaths: excludedPaths || DEFAULT_CONFIG.excludedPaths,

    maxDepth: validateInt(crawl.maxDepth, 'crawl.maxDepth', { min: 0, fallback: DEFAULT_CONFIG.maxDepth }),
    maxPages: validateInt(crawl.maxPages, 'crawl.maxPages', { min: 1, fallback: DEFAULT_CONFIG.maxPages }),
    maxLinksPerPage: validateInt(crawl.maxLinksPerPage, 'crawl.maxLinksPerPage', { min: 1, fallback: DEFAULT_CONFIG.maxLinksPerPage }),
    concurrency: validateInt(crawl.concurrency, 'crawl.concurrency', { min: 1, fallback: DEFAULT_CONFIG.concurrency }),
    timeout: validateInt(crawl.timeout, 'crawl.timeout', { min: 1, fallback: DEFAULT_CONFIG.timeout }),
    crawlDelay: validateInt(crawl.crawlDelayMs, 'crawl.crawlDelayMs', { min: 0, fallback: DEFAULT_CONFIG.crawlDelay }),
    followRobots: validateBool(crawl.respectRobotsTxt, 'crawl.respectRobotsTxt', { fallback: DEFAULT_CONFIG.followRobots }),
    followSitemaps: validateBool(crawl.followSitemaps, 'crawl.followSitemaps', { fallback: DEFAULT_CONFIG.followSitemaps }),
    captureScreenshots: validateBool(crawl.captureScreenshots, 'crawl.captureScreenshots', { fallback: DEFAULT_CONFIG.captureScreenshots }),
    ignoreFragments: validateBool(crawl.ignoreFragments, 'crawl.ignoreFragments', { fallback: DEFAULT_CONFIG.ignoreFragments }),

    validateHttp: validateBool(validation.http, 'validation.http', { fallback: DEFAULT_CONFIG.validateHttp }),
    validateBrowserFallback: validateBool(validation.browserFallback, 'validation.browserFallback', { fallback: DEFAULT_CONFIG.validateBrowserFallback }),
    validateAnchors: validateBool(validation.anchors, 'validation.anchors', { fallback: DEFAULT_CONFIG.validateAnchors }),
    validateSoft404: validateBool(validation.soft404, 'validation.soft404', { fallback: DEFAULT_CONFIG.validateSoft404 }),
    retryEnabled: validateBool(validation.retry, 'validation.retry', { fallback: DEFAULT_CONFIG.retryEnabled }),
    retryCount: validateInt(validation.retryCount, 'validation.retryCount', { min: 1, fallback: DEFAULT_CONFIG.retryCount }),
    validationConcurrency: validateInt(validation.concurrency, 'validation.concurrency', { min: 1, fallback: DEFAULT_CONFIG.validationConcurrency }),
    soft404Keywords: soft404Keywords || DEFAULT_CONFIG.soft404Keywords,

    reportHtml: validateBool(reporting.html, 'reporting.html', { fallback: DEFAULT_CONFIG.reportHtml }),
    reportExcel: validateBool(reporting.excel, 'reporting.excel', { fallback: DEFAULT_CONFIG.reportExcel }),
    reportJson: validateBool(reporting.json, 'reporting.json', { fallback: DEFAULT_CONFIG.reportJson }),

    outputDirectory: raw.outputDirectory || DEFAULT_CONFIG.outputDirectory,
    screenshotDirectory: raw.screenshotDirectory || DEFAULT_CONFIG.screenshotDirectory,
    stateDirectory: raw.stateDirectory || DEFAULT_CONFIG.stateDirectory,
    resumePreviousCrawl: validateBool(raw.resumePreviousCrawl, 'resumePreviousCrawl', { fallback: false }),
    reportIntervalPages: validateInt(raw.reportIntervalPages, 'reportIntervalPages', { min: 1, fallback: 20 })
  };
}

/**
 * Back-compat path for the old flat config shape (no "target" key) used
 * before the generic target model existed. Not the recommended format —
 * logs a warning so callers know to migrate — but keeps old config files
 * from hard-failing. Only the target URL itself is validated here; the
 * looser legacy shape doesn't get the full field-by-field validation the
 * current schema does.
 */
function normalizeLegacyFlatConfig(raw) {
  console.warn(
    'Config warning: this file uses the legacy flat schema (no "target" section). ' +
    'It still works, but the current schema is { target, crawl, validation, scope, reporting }. ' +
    'See config/config.json for the current format.'
  );

  if (!Array.isArray(raw.seedUrls) || raw.seedUrls.length === 0) {
    throw new Error('Configuration error: legacy config must define a non-empty "seedUrls" array.');
  }
  raw.seedUrls.forEach((v, i) => validateHttpUrl(v, `seedUrls[${i}]`, { required: true }));

  return {
    targetName: raw.targetName || extractDomain(raw.seedUrls[0]) || 'unknown-target',
    targetEnvironment: raw.targetEnvironment || 'unspecified',
    targetBaseUrl: raw.seedUrls[0],
    ...DEFAULT_CONFIG,
    ...raw
  };
}

function load(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Configuration error: config file did not contain a JSON object.');
  }

  return raw.target
    ? normalizeNestedConfig(raw)
    : normalizeLegacyFlatConfig(raw);
}

module.exports = { load, normalizeNestedConfig, normalizeLegacyFlatConfig };
