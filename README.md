# Enterprise Web/Application Link Validation & Recursive Crawl Tool

A Node.js CLI tool for recursively crawling **any target web application or site** — public, internal, dev, QA/test, UAT, staging, or production, subject to network access and authorization — validating its links, and generating comprehensive reports.

This tool is target-agnostic: point `config/config.json` at any `baseUrl` (see `config/examples/` for sample targets). It was originally built and manually validated against a single real-world target — Eggplant Software's public documentation — which is preserved as a historical/example configuration only (`config/examples/eggplant-docs.historical.config.json`), not a product assumption. See `PROJECT_AUDIT.md` and `ENGINEERING_REPORT.md` for that history.

## Features

- **Recursive Crawling**: Automatically discovers and crawls all reachable internal pages of the target
- **Real HTTP Link Validation**: Every discovered link is actually checked (status code, redirect detection, retry on transient failures) — not just extracted and assumed fine
- **Bounded Browser Escalation**: Uses Playwright to re-check the specific, narrow case where a link returns HTTP 200 but its content looks like a soft-404 — not for every link (see `ENGINEERING_REPORT.md` for the escalation policy)
- **Anchor Validation**: Verifies same-page `#section` links resolve to a real element
- **Soft 404 Detection**: Identifies pages that return 200 but are actually broken
- **Multiple Report Formats**: HTML dashboard, Excel spreadsheet, and JSON export — all three consistently distinguish valid / broken / redirect / soft-404 / not-checked / error, never collapsing "not checked" into "OK"
- **Concurrency Control**: Safe parallel processing with configurable limits, at both the page-crawl and per-link-validation level
- **Per-Run Output Isolation**: Each run writes into its own `output/runs/<timestamp>/` directory
- **State Persistence**: Resume interrupted crawls
- **Generic Target**: Works against any accessible `http(s)://` target — public, dev, QA, UAT, staging, or production — via config, CLI flags, or both

Screenshot capture is **not** implemented (the report schema reserves a field for it as a documented future enhancement — see `ENGINEERING_REPORT.md` / `FINAL_HARDENING_REPORT.md`).

## Prerequisites

- Node.js 18+ (the test suite uses the built-in `node:test` runner)
- npm
- Playwright browsers (installed automatically via `npx playwright install`)

## Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Install Playwright browsers:
   ```bash
   npx playwright install
   ```

## Configuration

Edit `config/config.json` (or point `--config` at your own file — see `config/examples/` for sample targets, including an internal/staging example and the historical Eggplant Software crawl):

```json
{
  "target": {
    "name": "My Application",
    "baseUrl": "https://app.example.com/",
    "environment": "staging"
  },
  "crawl": {
    "maxDepth": 4,
    "maxPages": 1000,
    "concurrency": 3,
    "crawlDelayMs": 500,
    "respectRobotsTxt": true,
    "followSitemaps": true,
    "captureScreenshots": false
  },
  "validation": {
    "http": true,
    "browserFallback": true,
    "anchors": true,
    "soft404": true,
    "retry": true,
    "retryCount": 3,
    "concurrency": 5
  },
  "scope": {
    "allowedDomains": [],
    "excludedPaths": ["/search", "/login"]
  },
  "reporting": {
    "html": true,
    "excel": true,
    "json": true
  },
  "outputDirectory": "./output",
  "stateDirectory": "./state",
  "resumePreviousCrawl": false
}
```

`target.baseUrl` is the only required field — everything else falls back to sensible defaults. `allowedDomains`/`seedUrls` are derived from it automatically unless you override them. `target.environment` is metadata only (shown in reports and `run-manifest.json`) — the crawl/validation engine never branches on it; network reachability of the target is entirely the responsibility of the environment you run this tool in (VPN, internal DNS, etc.).

### Configuration Options

| Section.Option | Description | Default |
|---|---|---|
| `target.baseUrl` | The application/site to crawl (**required**) | — |
| `target.name` / `target.environment` | Metadata only — labels reports and `run-manifest.json` | domain / `"unspecified"` |
| `target.seedUrls` | Override the starting URL(s) (defaults to `[target.baseUrl]`) | `[target.baseUrl]` |
| `crawl.maxDepth` / `crawl.maxPages` / `crawl.concurrency` | Crawl limits | 10 / 1000 / 5 |
| `crawl.crawlDelayMs` | Delay between page crawls (ms) | 100 |
| `crawl.respectRobotsTxt` / `crawl.followSitemaps` | Discovery behavior | true / true |
| `crawl.captureScreenshots` | Reserved — not yet implemented (see `ENGINEERING_REPORT.md`) | false |
| `validation.http` | Enable HTTP link validation | true |
| `validation.browserFallback` | Enable the bounded browser-escalation for ambiguous soft-404 candidates | true |
| `validation.anchors` | Enable page-level `#section` anchor validation | true |
| `validation.soft404` | Enable soft-404 content detection | true |
| `validation.retry` / `validation.retryCount` | Retry transient HTTP failures (429/5xx/timeout/reset) | true / 3 |
| `validation.concurrency` | Max concurrent link validations per page | 5 |
| `scope.allowedDomains` | Domains treated as "internal" (crawlable); defaults to the `target.baseUrl` domain | `[<baseUrl domain>]` |
| `scope.excludedPaths` | Path substrings to skip | `["/search", "/login", "/admin"]` |
| `reporting.html` / `reporting.excel` / `reporting.json` | Which report formats to generate | all true |
| `outputDirectory` | Base directory for run output (each run gets its own `runs/<timestamp>/` subdirectory) | `"./output"` |
| `stateDirectory` | Where the visited-URL set is persisted for `resumePreviousCrawl` | `"./state"` |

## Testing

```bash
npm test
```

Runs the full suite via Node's built-in `node:test` runner — no test framework dependency. Covers HTTP validation, URL classification, anchor validation, soft-404 detection, config validation, redirect-chain safety, anchor-fragment deduplication, report-output consistency, sitemap-index parsing, and one full end-to-end crawl against a local fixture server (real Playwright browser, no external network access). See `FINAL_HARDENING_REPORT.md` for what's covered and what isn't.

## Usage

### Basic Crawl

```bash
npm run crawl
```

### Custom Configuration

```bash
node crawler.js --config=path/to/config.json
```

### CLI Overrides

A config file is still required (it supplies crawl/validation/scope/reporting defaults), but its target can be overridden without editing it — useful for pointing the same base config at a different environment on the fly:

```bash
node crawler.js --url https://staging.example.com/ --environment staging
node crawler.js --url https://example.com/ --max-pages 10 --max-depth 1
node crawler.js --config config/examples/internal-staging.config.json --output ./output-run2
```

| Flag | Overrides |
|---|---|
| `--url <url>` | `target.baseUrl` |
| `--environment <name>` | `target.environment` (metadata only) |
| `--max-pages <n>` | `crawl.maxPages` |
| `--max-depth <n>` | `crawl.maxDepth` |
| `--output <dir>` | `outputDirectory` |

An invalid `--url` (bad syntax, or a non-http(s) scheme like `file://`) is rejected immediately with the same clear error a bad config file would produce — it goes through the identical validation.

### Programmatic Usage

```javascript
const CrawlManager = require('./crawler/CrawlManager');
const ConfigLoader = require('./config/ConfigLoader');

const config = ConfigLoader.load({
  target: { baseUrl: 'https://app.example.com/', environment: 'staging' },
  crawl: { maxDepth: 3, maxPages: 200 }
});

const crawler = new CrawlManager(config);
await crawler.start();
```

## How It Works

1. **Initialization**: Loads configuration and initializes browser and state management
2. **Seed Processing**: Starts crawling from configured seed URLs
3. **Recursive Discovery**: Extracts links from each page and adds internal URLs to crawl queue
4. **Link Validation**: Validates each discovered link over HTTP (with retry on transient failures); a link escalates to a real browser check only in the narrow case of an HTTP 200 whose content looks like a soft-404
5. **Report Generation**: Creates HTML dashboard, Excel spreadsheet, and JSON export

### Crawling Algorithm

```
For each seed URL:
  Add to crawl queue

While queue is not empty and limits not reached:
  Get next URL from queue
  If not visited:
    Mark as visited
    Crawl page with Playwright
    Extract all links
    Validate each link
    Add internal links to queue
    Generate reports
```

## Validation States

Every discovered link is reported in exactly one of these states — reflected consistently across NDJSON, JSON, HTML, and Excel output:

| State | Meaning |
|---|---|
| `valid` | Checked and working |
| `broken` | Checked and failed (bad status code, missing anchor target, or browser-confirmed broken) |
| `redirect` | Checked and resolves via a redirect (destination is recorded) |
| `soft404` | HTTP layer flagged possible soft-404 content on a 200 response, and browser escalation is disabled or inconclusive |
| `not_checked` | Deliberately never validated — `mailto:`/`tel:`/`sms:` links (nothing to fetch), or `javascript:`/`data:`/`file:`/`blob:`/unparsable links (never safe or meaningful to fetch), or validation was turned off in config |
| `error` | Validation was attempted but could not complete (e.g. a browser escalation crashed) — distinct from `broken`, which means the check *did* complete and found a real problem |

A link that was never checked is never reported as `valid`, `OK`, or "Healthy" — a report that did so would be actively misleading. See `ENGINEERING_REPORT.md` and `FINAL_HARDENING_REPORT.md` for how this is enforced across all three reporters.

## Output Files

Each run writes into its own timestamped directory so a new crawl never silently merges with a previous run's data:

- `output/runs/<timestamp>/report.html` - Interactive HTML dashboard
- `output/runs/<timestamp>/report.xlsx` - Excel spreadsheet with all data
- `output/runs/<timestamp>/report.json` - JSON export for programmatic access
- `output/runs/<timestamp>/results.ndjson` - Raw per-link records, streamed incrementally
- `output/runs/<timestamp>/run-manifest.json` - Target/config summary for that run
- `state/crawl-state.json` - Visited-URL set, shared across runs (used by `resumePreviousCrawl`; intentionally *not* per-run, since its purpose is continuity across runs)
- `screenshots/` - Reserved for a future enhancement (not currently implemented — see `ENGINEERING_REPORT.md`)

## HTML Dashboard

The HTML report provides:

- **Summary Statistics**: Total pages, links, broken links, redirects, soft 404s, and not-checked links
- **Interactive Tables**: Tabbed by state (Broken / Redirects / Soft 404s / External / Not Checked / All), each row showing category, status, validation method, and error detail
- **Page Analysis**: Pages with most issues
- **Responsive Design**: Works on desktop and mobile

## Excel Report

Contains multiple sheets:

- **Summary**: Overall statistics
- **All Links**: Complete link dataset
- **Broken Links**: Only broken/problematic links
- **Redirects**: All redirect links
- **Soft 404s**: Pages detected as soft 404s
- **External Links**: Links to external sites
- **Not Checked**: Links deliberately never validated (mailto/tel/unsupported schemes, or validation disabled)
- **Performance**: Response time analysis

## Troubleshooting

### Common Issues

**Browser Launch Failed**
```bash
npx playwright install
```

**Timeout Errors**
- Increase `crawl.timeout` in config
- Reduce `crawl.concurrency` / `validation.concurrency`
- Check network connectivity to the target

**Memory Issues**
- Reduce `crawl.concurrency`
- Increase system memory
- Use a smaller `crawl.maxPages`

**Rate Limiting**
- Increase `crawl.crawlDelayMs`
- Reduce `crawl.concurrency`
- Check if the target has its own rate limiting

### Logs

Logs are written to console and can be redirected to file:

```bash
node crawler.js > crawl.log 2>&1
```

## Architecture

```
crawler.js (CLI entry point)
├── ConfigLoader (generic target/crawl/validation/scope/reporting config → internal shape)
├── CrawlManager (orchestrates crawling; one output/runs/<timestamp>/ directory per run)
│   ├── BrowserManager (Playwright browser pool)
│   ├── StateManager (visited URL tracking, shared across runs)
│   ├── QueueManager (concurrency control)
│   ├── LinkValidationService (HTTP validation + retry + bounded browser escalation,
│   │                          one instance shared for the whole run)
│   │   ├── HttpValidator (HTTP link validation, soft-404 body check on internal GETs)
│   │   ├── BrowserValidator (browser-based re-check for ambiguous soft-404 candidates only)
│   │   └── RetryManager (backoff for transient failures)
│   └── PageCrawler (individual page processing)
│       ├── LinkExtractor (extracts links from DOM)
│       ├── urlClassifier (internal / external / anchor / ignored / unsupported)
│       ├── AnchorValidator (one page-level "#section" scan per page)
│       └── Soft404Detector (soft 404 detection — page-level and internal-link-level)
├── Reporters
│   ├── HtmlReporter (HTML dashboard)
│   ├── ExcelReporter (Excel spreadsheet)
│   └── JsonReporter (JSON export)
└── Utils
    ├── urlUtils (URL normalization)
    ├── runId (per-run timestamped directory naming)
    ├── logger (logging)
    ├── metrics (performance tracking)
    ├── retry (retry logic)
    └── fileUtils (file operations)
```

See `ENGINEERING_REPORT.md` for the full validation runtime flow and the reasoning behind the browser-escalation and soft-404 scoping decisions.

## Scaling Guidelines

### Small Sites (< 1000 pages)
- Concurrency: 3-5
- Timeout: 15000ms
- Crawl delay: 100ms

### Medium Sites (1000-5000 pages)
- Concurrency: 5-8
- Timeout: 20000ms
- Crawl delay: 200ms

### Large Sites (5000+ pages)
- Concurrency: 8-12
- Timeout: 30000ms
- Crawl delay: 500ms
- Consider running during off-peak hours

## Security Considerations

- Crawl scope (which links get *queued as pages*) is bounded to `scope.allowedDomains` — an exact host match or a proper subdomain, never a loose substring match
- `javascript:`, `data:`, `file:`, and `blob:` links are classified as unsupported and are never handed to axios or Playwright's `page.goto()` — see `utils/urlClassifier.js`
- Robots.txt is respected when `crawl.respectRobotsTxt` is enabled (off by default makes sense for internal targets that don't serve one)
- Embedded Basic Auth credentials in a URL (`https://user:pass@host/...`) are stripped before being written to any report or NDJSON record
- No authentication, cookie, or session support — a target behind a login wall will report its pages as broken/unreachable past the login boundary (see Limitations)
- Redirects (including to a different domain, `localhost`, or a private IP) are followed during *validation* like any real link-checker must, up to axios's redirect-hop limit; they do not expand *crawl* scope, since only pages already reached under `allowedDomains` are ever queued for further crawling

## Limitations

- **No authentication / login-protected targets.** Pages behind a login wall will be reported as broken or unreachable.
- **Screenshot capture is not implemented**, despite the field existing in the data model — a documented future enhancement, not a current feature.
- **SPA / heavily client-rendered behavior** is only partially handled: the soft-404 browser escalation catches "server says 200, content is a client-rendered error page," but this is not a general SPA crawler — links that only appear after client-side interaction (not present in the initial DOM) are not discovered.
- **Output size** grows with crawl size — a large crawl still produces a large NDJSON/JSON/HTML file, though per-run isolation and de-duplication of page-level data (console errors, in particular) keep this bounded per link.
- **`robots.txt` semantics for purely internal targets** haven't been verified against a real corporate proxy/auth setup — the graceful-degrade behavior (treat everything as allowed when no `robots.txt` is found) is by design, but `crawl.respectRobotsTxt: false` is the documented, explicit way to skip it entirely for internal targets.

## Performance Optimization

- **URL Deduplication**: Prevents recrawling the same page, with fragment-aware handling so distinct `#section` anchors on one page are validated independently while the page itself is only crawled once
- **Concurrent Processing**: Parallel page crawling and parallel per-page link validation, independently configurable
- **Browser Reuse**: Single browser instance with multiple contexts/pages
- **State Persistence**: Resume interrupted crawls

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes with comprehensive tests
4. Update documentation
5. Submit pull request

## License

This project is provided as-is for enterprise web/application link validation.

## Support

For issues and questions:
1. Check the troubleshooting section
2. Review configuration options
3. Examine log output
4. Test with smaller scope first

## Examples

Sample target configurations live in `config/examples/`:

- `config/examples/internal-staging.config.json` — an internal/non-public target, `robots.txt` disabled, `environment: "staging"`
- `config/examples/eggplant-docs.historical.config.json` — the real, original target this tool was built and manually validated against (565 pages, ~25,900 links — see `PROJECT_AUDIT.md`). Historical reference only, not run by any default script. Run it deliberately (`npm run crawl:example:eggplant`) rather than repeatedly, since it's a real third-party server.

### Quick Test Run

```json
{
  "target": { "baseUrl": "https://example.com/", "environment": "public" },
  "crawl": { "maxPages": 10, "concurrency": 2, "captureScreenshots": false }
}
```