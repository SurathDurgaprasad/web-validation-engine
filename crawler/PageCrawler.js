const LinkExtractor = require('../extractors/LinkExtractor');
const AnchorValidator = require('../validators/AnchorValidator');
const Soft404Detector = require('../validators/Soft404Detector');
const { normalizeUrl } = require('../utils/urlUtils');
const { classifyUrl, getDedupeKey } = require('../utils/urlClassifier');
const logger = require('../utils/logger');

class PageCrawler {
  constructor(config, browserManager, state, linkValidationService) {
    this.config = config;
    this.browserManager = browserManager;
    this.state = state;
    this.linkValidationService = linkValidationService;
    this.anchorValidator = new AnchorValidator(config);
  }

  async crawl(url, depth) {
    const page = await this.browserManager.newPage();
    const consoleErrors = [];

    try {
      page.on('console', msg => {
        if (msg.type() === 'error') {
          consoleErrors.push({
            type: msg.type(),
            text: msg.text(),
            location: msg.location()
          });
        }
      });

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });

      const content = await page.content();

      // Soft-404 status of the *page currently being crawled*. This is
      // page-level metadata, not attached to every outbound link on the
      // page — see PageCrawler return value / docs/ENGINEERING_REPORT.md for why.
      const pageIsSoft404 = this.config.validateSoft404 !== false
        ? Soft404Detector.detect(content, this.config.soft404Keywords || [])
        : false;

      const extractor = new LinkExtractor(this.config);
      const anchorLinks = await extractor.extract(page, url, depth);
      const otherLinks = await extractor.extractOtherLinks(page, url);
      const allLinks = [...anchorLinks, ...otherLinks];

      logger.debug(`${url}: extracted ${allLinks.length} link(s) (depth ${depth})`);

      // One page-level anchor scan, reused for every same-page "#id" link
      // found below — not re-run per link.
      let anchorPageResults = null;
      if (this.config.validateAnchors !== false) {
        anchorPageResults = await this.anchorValidator.validate(page, url);
      }
      const anchorByTargetId = new Map();
      if (anchorPageResults) {
        for (const result of anchorPageResults.results) {
          if (result.targetId) anchorByTargetId.set(result.targetId, result);
        }
      }

      const seen = new Set();
      const entries = [];

      for (const link of allLinks) {
        try {
          const classification = classifyUrl(link.target, url, this.config);
          const normalized = normalizeUrl(link.target, this.config);

          // normalizeUrl strips fragments (by design — that's what makes
          // crawl-queue dedup work), which would otherwise collapse every
          // distinct "#section" anchor link on a page into just the first
          // one seen, since they'd all normalize to the same bare page URL.
          // Anchor links are deduped by their exact target instead — see
          // utils/urlClassifier.getDedupeKey for why these are two
          // deliberately different identities.
          const dedupeKey = getDedupeKey(link.target, normalized, classification);
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          entries.push({
            sourcePage: url,
            targetUrl: link.target,
            normalizedTarget: normalized,
            linkText: link.text,
            linkType: link.type,
            selector: link.selector,
            htmlSnippet: link.htmlSnippet,
            statusCode: null,
            responseTime: null,
            finalUrl: null,
            redirectChain: null,
            errorType: null,
            errorMessage: null,
            screenshotPath: '',
            isBroken: false,
            isRedirect: false,
            isSoft404: false,
            isInternal: classification.isInternal,
            urlScheme: classification.scheme,
            urlCategory: classification.category,
            depth,
            // Console errors are captured once for the whole page, not per
            // link — attaching the full array to every single link record
            // on the page (as this previously did) meant a page with, say,
            // 20 console errors and 50 links wrote that same array 50
            // times. A count is enough signal per link; see
            // docs/FINAL_HARDENING_REPORT.md.
            pageConsoleErrorCount: consoleErrors.length,
            browserValidation: null,
            validationMethod: 'none',
            validationStatus: 'not_checked',
            retryAttempts: 0,
            _classification: classification
          });
        } catch (e) {
          // skip links that fail to normalize
          continue;
        }
      }

      this.resolveAnchorLinks(entries, anchorByTargetId);
      this.markUnfetchableLinks(entries);
      await this.validateHttpLinks(entries, page);

      for (const entry of entries) delete entry._classification;

      return {
        links: entries,
        anchorResults: anchorPageResults,
        pageIsSoft404,
        pageUrl: url
      };
    } catch (error) {
      logger.error(`Error in crawl for ${url}: ${error.message}`);
      throw error;
    } finally {
      await page.close();
      if (global.gc) global.gc();
    }
  }

  /**
   * Same-document "#section" links are resolved from the single page-level
   * AnchorValidator pass done above, instead of each being independently
   * (and redundantly) re-validated.
   */
  resolveAnchorLinks(entries, anchorByTargetId) {
    for (const entry of entries) {
      if (entry._classification.category !== 'anchor') continue;

      entry.validationMethod = 'anchor';
      const match = anchorByTargetId.get(entry._classification.targetId);

      if (!match) {
        entry.validationStatus = 'error';
        entry.errorType = 'anchor-not-found-in-scan';
        entry.errorMessage = `Anchor target "#${entry._classification.targetId}" was not found during the page's anchor scan`;
        entry.isBroken = true;
        continue;
      }

      entry.isBroken = match.isBroken;
      entry.validationStatus = match.status === 'valid'
        ? 'valid'
        : match.status === 'missing'
          ? 'broken'
          : 'error';

      if (match.isBroken) {
        entry.errorType = match.status === 'error' ? 'anchor-validation-error' : 'missing-anchor';
        entry.errorMessage = match.error || `No element with id "${entry._classification.targetId}" exists on the page`;
      }
    }
  }

  /**
   * mailto:/tel: (real links we deliberately never fetch) and
   * javascript:/data:/file:/blob:/unparsable (unsafe or meaningless to
   * fetch) are marked explicitly "not checked" rather than left to default
   * to a false "isBroken: false", which would misreport them as validated.
   */
  markUnfetchableLinks(entries) {
    for (const entry of entries) {
      const category = entry._classification.category;
      if (category !== 'ignored' && category !== 'unsupported') continue;

      entry.validationMethod = 'none';
      entry.validationStatus = 'not_checked';
      if (category === 'unsupported') {
        entry.errorType = 'unsupported-scheme';
      }
    }
  }

  async validateHttpLinks(entries, page) {
    const httpEligible = entries.filter(e =>
      e._classification.category === 'internal' || e._classification.category === 'external'
    );

    if (httpEligible.length === 0) return;

    if (this.config.validateHttp === false || !this.linkValidationService) {
      // Validation explicitly disabled — stay honest about it instead of
      // leaving the pre-set "not_checked" defaults silently ambiguous.
      for (const entry of httpEligible) {
        entry.validationStatus = 'not_checked';
      }
      return;
    }

    await this.linkValidationService.validateBatch(httpEligible, page);
  }
}

module.exports = PageCrawler;
