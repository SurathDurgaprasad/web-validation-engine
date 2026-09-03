const axios = require('axios');
const https = require('https');
const { isInternalUrl, normalizeUrl } = require('../utils/urlUtils');
const Soft404Detector = require('./Soft404Detector');

// Maps axios/Node network error codes to a small, stable set of machine-
// readable categories. This is what the retry layer (LinkValidationService)
// and the reports key off of — not string-matching on human error messages.
const ERROR_TYPE_MAP = {
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  ECONNREFUSED: 'connection-refused',
  ETIMEDOUT: 'timeout',
  ECONNABORTED: 'timeout',
  ECONNRESET: 'connection-reset',
  ENETUNREACH: 'network',
  EHOSTUNREACH: 'network',
  CERT_HAS_EXPIRED: 'ssl',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'ssl',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'ssl',
  ERR_FR_TOO_MANY_REDIRECTS: 'redirect-loop'
};

class HttpValidator {
  constructor(config) {
    this.config = config;
    this.agent = new https.Agent({
      rejectUnauthorized: false // Allow self-signed certificates (common on internal/staging targets)
    });
  }

  async validate(url) {
    const startTime = Date.now();

    try {
      // For external URLs, do a lighter validation
      if (!isInternalUrl(url, this.config.allowedDomains)) {
        return await this.validateExternal(url, startTime);
      }

      // For internal URLs, follow redirects and get full details
      const response = await axios.get(url, {
        timeout: this.config.timeout,
        maxRedirects: 10,
        validateStatus: () => true, // Don't throw on any status
        httpsAgent: this.agent,
        headers: {
          'User-Agent': 'Enterprise Doc Validator/1.0'
        }
      });

      const responseTime = Date.now() - startTime;
      const finalUrl = (response.request && response.request.res && response.request.res.responseUrl) || url;
      const redirectChain = this.extractRedirectChain(response.request);

      // axios follows redirects itself (maxRedirects: 10), so response.status
      // is almost always the *terminal* status, not 300-399 — checking the
      // status code alone would essentially never flag a redirect. Detecting
      // "did the final URL differ from the requested one" is what actually
      // catches it.
      const isRedirect = this.wasRedirected(url, finalUrl);

      // We already have the full response body for internal GET requests —
      // reuse it to check for soft-404 content instead of issuing a second
      // request. Only meaningful on a non-error status; a real 4xx/5xx is
      // already unambiguous.
      const bodyText = typeof response.data === 'string' ? response.data : '';
      const isSoft404 = this.config.validateSoft404 !== false &&
        response.status < 400 &&
        Soft404Detector.detect(bodyText, this.config.soft404Keywords || []);

      return {
        statusCode: response.status,
        responseTime,
        finalUrl,
        redirectChain,
        errorType: null,
        errorMessage: null,
        isBroken: response.status >= 400,
        isRedirect,
        isSoft404,
        contentType: response.headers['content-type'] || '',
        contentLength: response.headers['content-length'] || 0
      };

    } catch (error) {
      return this.buildErrorResult(error, Date.now() - startTime);
    }
  }

  async validateExternal(url, startTime) {
    try {
      // For external links, just check if they're reachable. HEAD-only, so
      // there is no response body to run soft-404 content detection against
      // — that's a deliberate scope decision, not an oversight: soft-404 is
      // "does this page's own content look broken", and checking a third
      // party's content isn't this tool's job.
      const response = await axios.head(url, {
        timeout: Math.min(this.config.timeout, 5000), // Shorter timeout for external
        maxRedirects: 5,
        validateStatus: () => true,
        httpsAgent: this.agent,
        headers: {
          'User-Agent': 'Enterprise Doc Validator/1.0'
        }
      });

      const responseTime = Date.now() - startTime;
      const finalUrl = (response.request && response.request.res && response.request.res.responseUrl) || url;
      const isRedirect = this.wasRedirected(url, finalUrl);

      return {
        statusCode: response.status,
        responseTime,
        finalUrl,
        redirectChain: [],
        errorType: null,
        errorMessage: null,
        isBroken: response.status >= 400,
        isRedirect,
        isSoft404: false,
        contentType: response.headers['content-type'] || '',
        contentLength: response.headers['content-length'] || 0
      };

    } catch (error) {
      return this.buildErrorResult(error, Date.now() - startTime);
    }
  }

  buildErrorResult(error, responseTime) {
    let statusCode = null;
    let errorType = 'unknown';
    let errorMessage = error.message;

    if (error.response) {
      // Should be rare given validateStatus: () => true, but guard anyway.
      statusCode = error.response.status;
      errorType = null;
    } else if (error.code && ERROR_TYPE_MAP[error.code]) {
      errorType = ERROR_TYPE_MAP[error.code];
      errorMessage = this.describeErrorCode(error.code);
    } else if (error.code) {
      errorType = 'network';
      errorMessage = `Network error: ${error.code}`;
    }

    return {
      statusCode,
      responseTime,
      finalUrl: null,
      redirectChain: [],
      errorType,
      errorMessage,
      isBroken: true,
      isRedirect: false,
      isSoft404: false,
      contentType: '',
      contentLength: 0
    };
  }

  describeErrorCode(code) {
    switch (code) {
      case 'ENOTFOUND':
        return 'DNS resolution failed';
      case 'EAI_AGAIN':
        return 'DNS resolution temporarily failed';
      case 'ECONNREFUSED':
        return 'Connection refused';
      case 'ETIMEDOUT':
      case 'ECONNABORTED':
        return 'Request timeout';
      case 'ECONNRESET':
        return 'Connection reset';
      case 'ENETUNREACH':
      case 'EHOSTUNREACH':
        return 'Network unreachable';
      case 'CERT_HAS_EXPIRED':
        return 'SSL certificate expired';
      case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        return 'SSL certificate could not be verified';
      case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        return 'Self-signed SSL certificate';
      case 'ERR_FR_TOO_MANY_REDIRECTS':
        return 'Too many redirects';
      default:
        return `Network error: ${code}`;
    }
  }

  wasRedirected(requestedUrl, finalUrl) {
    if (!finalUrl) return false;
    try {
      return normalizeUrl(finalUrl, this.config) !== normalizeUrl(requestedUrl, this.config);
    } catch (e) {
      return finalUrl !== requestedUrl;
    }
  }

  extractRedirectChain(request) {
    const chain = [];
    const MAX_HOPS = 20;

    // This walks an *undocumented* internal property of axios's
    // follow-redirects implementation. Under the axios version this project
    // currently resolves to, `_redirectable._currentRequest` can point back
    // to the same object for a non-redirected request — an unguarded walk
    // of that chain runs effectively forever, building a multi-hundred-
    // million-element array before JSON.stringify throws "Invalid string
    // length" on it. This never surfaced before because HttpValidator was
    // never actually called. Both a hard hop cap and an explicit
    // self-reference/seen-set guard are kept here deliberately — either one
    // alone would have caught this specific case, but the internal shape
    // being walked isn't a stable contract, so both stay as defense in depth.
    try {
      let current = request;
      const seen = new Set();
      let hops = 0;

      while (current && hops < MAX_HOPS && !seen.has(current)) {
        seen.add(current);

        if (current.res && current.res.responseUrl) {
          chain.push(current.res.responseUrl);
        }

        const next = current._redirectable && current._redirectable._currentRequest;
        if (next === current) break;
        current = next;
        hops++;
      }
    } catch (error) {
      // Ignore redirect chain extraction errors
    }

    return chain;
  }
}

module.exports = HttpValidator;