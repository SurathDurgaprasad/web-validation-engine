const fs = require('fs-extra');
const path = require('path');
const BrowserManager = require('./BrowserManager');
const PageCrawler = require('./PageCrawler');
const StateManager = require('./StateManager');
const QueueManager = require('./QueueManager');
const LinkValidationService = require('./LinkValidationService');
const HtmlReporter = require('../reporters/HtmlReporter');
const ExcelReporter = require('../reporters/ExcelReporter');
const JsonReporter = require('../reporters/JsonReporter');
const SitemapParser = require('../extractors/SitemapParser');
const RobotsManager = require('../utils/robotsManager');
const { normalizeUrl, redactCredentials } = require('../utils/urlUtils');
const { generateRunId } = require('../utils/runId');
const logger = require('../utils/logger');
const MetricsCollector = require('../utils/metrics');

class CrawlManager {
  constructor(config) {
    this.config = config;
    this.browserManager = null;
    this.state = null;
    this.queue = null;
    this.sitemapParser = null;
    this.robotsManager = null;
    this.linkValidationService = null;
    this.results = [];
    this.anchorIssues = [];
    this.metrics = new MetricsCollector();
    this.pagesSinceLastReport = 0;
    this.aborting = false;

    // Counts pages *reserved* for crawling, incremented synchronously
    // (before any `await`) at the point a page is committed to. Gating on
    // this instead of metrics.crawledPages (which only increments after a
    // full async crawl() completes) closes a race where, under concurrency
    // > 1, several in-flight pages can all pass a "have we hit maxPages?"
    // check before any of them finishes and increments the completed count
    // — overrunning maxPages by up to (concurrency - 1) pages.
    this.pagesStarted = 0;

    // Every run writes into its own timestamped directory under
    // outputDirectory/runs/ so a fresh crawl never silently merges its
    // results with a previous run's NDJSON/reports.
    this.runId = generateRunId();
    this.runOutputDirectory = path.join(this.config.outputDirectory, 'runs', this.runId);
  }

  async initialize() {
    logger.info(`Run ${this.runId} — target: ${this.config.targetName || 'unnamed'} (${this.config.targetEnvironment || 'unspecified'}), concurrency: ${this.config.concurrency}`);

    // Ensure output directories exist. stateDirectory in particular was
    // previously never created — StateManager.save() would silently fail
    // to persist the visited-URL set on any target whose state directory
    // didn't already happen to exist on disk (masked in the original repo
    // because ./state was already present from the historical crawl).
    await fs.ensureDir(this.runOutputDirectory);
    await fs.ensureDir(this.config.screenshotDirectory);
    await fs.ensureDir(this.config.stateDirectory);
    await fs.ensureDir(path.dirname(this.config.logFile || './logs/crawl.log'));

    // Initialize components
    this.browserManager = new BrowserManager(this.config);
    await this.browserManager.initialize();

    this.state = new StateManager(this.config);
    await this.state.load();

    this.queue = new QueueManager(this.config.concurrency);
    this.sitemapParser = new SitemapParser(this.config);
    this.robotsManager = new RobotsManager(this.config);

    // One shared validation service for the whole run (reuses its HTTPS
    // agent, RetryManager and concurrency limiter across every page).
    this.linkValidationService = new LinkValidationService(this.config);

    // Prepare NDJSON results stream for incremental writes — scoped to this
    // run's own directory, so it never appends onto a previous run's data.
    this.resultsStreamPath = path.join(this.runOutputDirectory, 'results.ndjson');
    try {
      this.resultsStream = fs.createWriteStream(this.resultsStreamPath, { flags: 'a' });
    } catch (e) {
      logger.error('Failed to open results.ndjson for append: ' + e.message);
      this.resultsStream = null;
    }

    await this.writeRunManifest('started');

    // Load robots.txt for each seed domain
    if (this.config.followRobots) {
      for (const seedUrl of this.config.seedUrls) {
        await this.robotsManager.loadForUrl(seedUrl);
      }
    }

    logger.info('Crawl manager initialized');
  }

  async writeRunManifest(status) {
    try {
      const manifestPath = path.join(this.runOutputDirectory, 'run-manifest.json');
      await fs.writeJson(manifestPath, {
        runId: this.runId,
        status,
        target: {
          name: this.config.targetName,
          environment: this.config.targetEnvironment,
          baseUrl: this.config.targetBaseUrl,
          seedUrls: this.config.seedUrls,
          allowedDomains: this.config.allowedDomains
        },
        crawl: {
          maxDepth: this.config.maxDepth,
          maxPages: this.config.maxPages,
          concurrency: this.config.concurrency
        },
        validation: {
          http: this.config.validateHttp,
          browserFallback: this.config.validateBrowserFallback,
          anchors: this.config.validateAnchors,
          soft404: this.config.validateSoft404,
          retry: this.config.retryEnabled
        },
        updatedAt: new Date().toISOString()
      }, { spaces: 2 });
    } catch (e) {
      logger.error('Failed to write run manifest: ' + e.message);
    }
  }

  async start() {
    logger.info('Starting crawl...');

    await this.initialize();

    // Everything from here on is wrapped so the browser and state are
    // always cleaned up — including if report generation or an unexpected
    // error partway through throws — instead of leaking an orphaned
    // Chromium process whenever anything after browser launch fails.
    try {
      // Ensure sensible defaults
      this.config.reportIntervalPages = this.config.reportIntervalPages || 20;

      for (const seedUrl of this.config.seedUrls) {
        const normalized = normalizeUrl(seedUrl, this.config);
        logger.info(`Seed: ${seedUrl} -> ${normalized}`);
        if (!this.state.hasVisited(normalized)) {
          this.queue.add(async () => {
            await this.processPage(normalized, 0);
          });
        }
      }

      if (this.config.followSitemaps) {
        for (const seedUrl of this.config.seedUrls) {
          const sitemapUrls = await this.sitemapParser.parse(seedUrl);
          for (const sitemapUrl of sitemapUrls) {
            const normalized = normalizeUrl(sitemapUrl, this.config);
            if (!this.state.hasVisited(normalized)) {
              this.queue.add(async () => {
                await this.processPage(normalized, 0);
              });
            }
          }
        }
      }

      await this.queue.waitForIdle();

      // Close the NDJSON stream before the final report generation reads it
      // back. generateReports() happened to still work without this (the
      // writes were flushed by the time it ran, in practice), but relying
      // on that instead of an explicit close/flush left the file handle
      // open longer than necessary and wasn't a guarantee, only an
      // observation — matching what gracefulShutdown() already did
      // correctly on the interrupted-run path.
      await this.closeResultsStream();

      this.metrics.finalize();

      logger.info('Generating reports');

      await this.generateReports();
      await this.writeRunManifest('completed');
    } finally {
      await this.browserManager.close();
      await this.state.finalize();
    }

    logger.info(`Crawl completed — run output: ${this.runOutputDirectory}`);
  }

  async processPage(url, depth) {
    try {
      if (this.state.hasVisited(url)) {
        return;
      }

      if (depth > this.config.maxDepth) {
        return;
      }

      if (this.pagesStarted >= this.config.maxPages) {
        return;
      }

      if (this.config.followRobots && !this.robotsManager.isAllowed(url)) {
        logger.info(`Skipping disallowed by robots.txt: ${url}`);
        this.state.markVisited(url);
        return;
      }

      this.state.markVisited(url);
      // Synchronous reservation — everything above this line and this
      // increment itself run without an `await`, so no other queued task
      // can observe a stale pagesStarted count in between.
      this.pagesStarted++;

      logger.info(`Crawling ${url} (depth: ${depth})`);

      const crawler = new PageCrawler(
        this.config,
        this.browserManager,
        this.state,
        this.linkValidationService
      );

      const result = await crawler.crawl(url, depth);

      // Persist discovered links to NDJSON immediately to avoid memory growth
      if (result && Array.isArray(result.links) && result.links.length > 0 && this.resultsStream) {
        for (const entry of result.links) {
          try {
            // Redact any embedded Basic Auth credentials before this record
            // ever touches disk — validation has already completed by this
            // point, so this only affects what gets reported, not what was
            // fetched.
            const safeEntry = {
              ...entry,
              sourcePage: redactCredentials(entry.sourcePage),
              targetUrl: redactCredentials(entry.targetUrl),
              normalizedTarget: redactCredentials(entry.normalizedTarget),
              finalUrl: entry.finalUrl ? redactCredentials(entry.finalUrl) : entry.finalUrl
            };
            this.resultsStream.write(JSON.stringify(safeEntry) + '\n');
          } catch (e) {
            // Logged rather than silently ignored: a serialization failure
            // here previously discarded the entry with no trace at all,
            // which is exactly how the redirect-chain bug (see
            // HttpValidator.extractRedirectChain) went unnoticed.
            logger.error(`Failed to write result for ${entry.targetUrl}: ${e.message}`);
          }
        }
      }

      this.metrics.recordPageCrawled();
      this.pagesSinceLastReport++;
      // Generate intermediate reports so cancelling still leaves useful output
      if (this.pagesSinceLastReport >= this.config.reportIntervalPages) {
        try {
          logger.info(`Generating intermediate report (after ${this.pagesSinceLastReport} pages)`);
          this.metrics.finalize();
          await this.generateReports();
        } catch (e) {
          logger.error('Intermediate report failed: ' + e.message);
        }
        this.pagesSinceLastReport = 0;
      }
      this.metrics.recordLinksDiscovered(result.links.length);

      if (result.anchorResults) {
        this.anchorIssues.push(...result.anchorResults.results);
        this.metrics.recordAnchorMetrics(result.anchorResults.totalAnchors, result.anchorResults.brokenAnchors);
      }

      if (result.pageIsSoft404) {
        this.metrics.recordPageSoft404();
      }

      for (const link of result.links) {
        if (link.validationStatus === 'not_checked') {
          this.metrics.recordNotChecked();
        }

        if (link.isBroken) {
          this.metrics.recordBrokenLink();
        }

        if (link.isRedirect) {
          this.metrics.recordRedirect();
        }

        if (link.isSoft404) {
          this.metrics.recordSoft404();
        }

        if (link.isInternal && link.urlCategory === 'internal' && !this.state.hasVisited(link.normalizedTarget) && this.pagesStarted < this.config.maxPages) {
          this.queue.add(async () => {
            await this.processPage(link.normalizedTarget, depth + 1);
          });
        }
      }

      if (this.config.crawlDelay > 0) {
        await this.delay(this.config.crawlDelay);
      }

      if (global.gc) global.gc();
    } catch (error) {
      logger.error(`Failed page ${url}: ${error.message}`);
      this.metrics.recordError(error);
      this.metrics.recordFailedPage();
    }
  }

  async gracefulShutdown() {
    if (this.aborting) return;
    this.aborting = true;
    logger.info('Graceful shutdown requested — generating final report');
    try {
      // Ensure stream is flushed
      await this.closeResultsStream();

      this.metrics.finalize();
      await this.generateReports();
      await this.writeRunManifest('interrupted');
    } catch (e) {
      logger.error('Error generating report during shutdown: ' + e.message);
    }
    try {
      if (this.browserManager) await this.browserManager.close();
    } catch (e) {
      // ignore
    }
    try {
      if (this.state) await this.state.finalize();
    } catch (e) {
      // ignore
    }
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async closeResultsStream() {
    if (!this.resultsStream || this.resultsStream.destroyed || this.resultsStream.closed) return;
    await new Promise(resolve => this.resultsStream.end(resolve));
  }

  async generateReports() {
    const metricsSummary = this.metrics.getSummary();

    // Read results from NDJSON if present, falling back to in-memory array
    let resultsForReport = this.results || [];
    if (await fs.pathExists(this.resultsStreamPath)) {
      resultsForReport = [];
      const readline = require('readline');
      const inStream = fs.createReadStream(this.resultsStreamPath);
      const rl = readline.createInterface({ input: inStream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line || !line.trim()) continue;
        try {
          resultsForReport.push(JSON.parse(line));
        } catch (e) {
          // ignore parse errors
        }
      }
    }

    // Reporters read config.outputDirectory directly; point that at this
    // run's own directory without touching the reporter classes themselves.
    const runConfig = { ...this.config, outputDirectory: this.runOutputDirectory };

    if (this.config.reportHtml !== false) {
      await new HtmlReporter(runConfig).generate(resultsForReport, metricsSummary);
    }
    if (this.config.reportExcel !== false) {
      await new ExcelReporter(runConfig).generate(resultsForReport, metricsSummary);
    }
    if (this.config.reportJson !== false) {
      await new JsonReporter(runConfig).generate(resultsForReport, metricsSummary);
    }
  }
}

module.exports = CrawlManager;