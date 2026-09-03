const pLimitModule = require('p-limit');
const pLimit = pLimitModule.default || pLimitModule;
const HttpValidator = require('../validators/HttpValidator');
const BrowserValidator = require('../validators/BrowserValidator');
const RetryManager = require('../utils/retry');
const logger = require('../utils/logger');

// Only these HttpValidator error categories are worth retrying — a real
// 404/403/DNS failure/SSL problem will not resolve itself on a second
// attempt a few seconds later.
const TRANSIENT_ERROR_TYPES = new Set(['timeout', 'connection-reset', 'network']);

function isTransientResult(result) {
  if (result.statusCode === 429) return true;
  if (typeof result.statusCode === 'number' && result.statusCode >= 500 && result.statusCode <= 599) return true;
  if (!result.statusCode && result.errorType && TRANSIENT_ERROR_TYPES.has(result.errorType)) return true;
  return false;
}

/**
 * Owns HTTP validation (with retry) and the deliberate, bounded escalation
 * to BrowserValidator for links that look ambiguous. One instance is shared
 * across an entire crawl (not recreated per page) so the underlying HTTPS
 * agent and concurrency limiter are reused.
 *
 * Escalation policy (see PROJECT_AUDIT.md / ENGINEERING_REPORT.md for the
 * reasoning): browser validation is expensive, so it only runs when ALL of
 * the following hold —
 *   - config.validateBrowserFallback is enabled
 *   - the link is internal (we don't browser-crawl third-party domains)
 *   - the plain HTTP GET came back 200 (not already a clear success/failure)
 *   - the fetched body already looks like a soft-404 by static keyword match
 * That is the one case the HTTP layer genuinely cannot resolve on its own:
 * "server says OK, but the content might be a client-rendered error page."
 * A definitive 4xx/5xx is not re-checked in a browser — it's already known.
 */
class LinkValidationService {
  constructor(config) {
    this.config = config;
    this.httpValidator = new HttpValidator(config);
    this.browserValidator = new BrowserValidator(config);
    this.retryManager = new RetryManager(config);
    this.limit = pLimit(config.validationConcurrency || 5);
  }

  async validateHttpWithRetry(url) {
    const maxAttempts = this.config.retryEnabled ? Math.max(1, this.config.retryCount || 3) : 1;
    let result;
    let attempt;

    for (attempt = 1; attempt <= maxAttempts; attempt++) {
      result = await this.httpValidator.validate(url);

      if (!isTransientResult(result) || attempt >= maxAttempts) {
        break;
      }

      const delayMs = this.retryManager.getBackoffDelay(attempt);
      logger.info(
        `Retrying ${url} (attempt ${attempt}/${maxAttempts}) after ${delayMs}ms — ` +
        `transient signal: ${result.errorType || result.statusCode}`
      );
      await this.retryManager.delay(delayMs);
    }

    result.retryAttempts = attempt > maxAttempts ? maxAttempts : attempt;
    return result;
  }

  async validateLink(entry, page) {
    const httpResult = await this.validateHttpWithRetry(entry.normalizedTarget);

    entry.statusCode = httpResult.statusCode;
    entry.responseTime = httpResult.responseTime;
    entry.finalUrl = httpResult.finalUrl;
    entry.redirectChain = httpResult.redirectChain;
    entry.errorType = httpResult.errorType || null;
    entry.errorMessage = httpResult.errorMessage;
    entry.isBroken = httpResult.isBroken;
    entry.isRedirect = httpResult.isRedirect;
    entry.isSoft404 = !!httpResult.isSoft404;
    entry.retryAttempts = httpResult.retryAttempts || 0;
    entry.validationMethod = 'http';
    entry.contentType = httpResult.contentType;

    entry.validationStatus = entry.isBroken
      ? 'broken'
      : entry.isSoft404
        ? 'soft404'
        : entry.isRedirect
          ? 'redirect'
          : 'valid';

    const shouldEscalate = this.config.validateBrowserFallback &&
      entry.isInternal &&
      page &&
      httpResult.statusCode === 200 &&
      httpResult.isSoft404;

    if (shouldEscalate) {
      try {
        const browserResult = await this.browserValidator.validate(page, entry.normalizedTarget);
        entry.validationMethod = 'browser';
        entry.browserValidation = {
          statusCode: browserResult.statusCode,
          isBroken: browserResult.isBroken,
          hasContent: browserResult.hasContent,
          errors: browserResult.errors,
          jsErrors: browserResult.jsErrors,
          failedRequests: browserResult.failedRequests,
          errorIndicators: browserResult.errorIndicators
        };
        // The browser check is the tie-breaker for the ambiguous case that
        // triggered it: it either confirms the page is genuinely broken, or
        // clears the static keyword match as a false positive.
        entry.isBroken = browserResult.isBroken;
        entry.isSoft404 = browserResult.isBroken;
        entry.validationStatus = browserResult.isBroken ? 'broken' : 'valid';
      } catch (e) {
        // The escalation itself couldn't complete (e.g. the browser context
        // was closed, a crash). Report this as "error" — validation could
        // not complete — rather than silently leaving the entry at its
        // pre-escalation "soft404" status, which would misrepresent an
        // unresolved check as a resolved (if ambiguous) one.
        logger.error(`Browser escalation failed for ${entry.normalizedTarget}: ${e.message}`);
        entry.validationMethod = 'browser';
        entry.validationStatus = 'error';
        entry.errorType = 'browser-escalation-failed';
        entry.errorMessage = `Browser escalation failed: ${e.message}`;
      }
    }

    return entry;
  }

  async validateBatch(entries, page) {
    return Promise.all(entries.map(entry => this.limit(() => this.validateLink(entry, page))));
  }
}

module.exports = LinkValidationService;
