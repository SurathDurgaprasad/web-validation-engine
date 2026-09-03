# PROJECT_AUDIT.md

**Audit date:** 2026-09-02
**Auditor:** Claude Code (static analysis + artifact inspection; no code modified)
**Repository:** `enterprise-doc-validator` (no `.git` present — evolution reconstructed from filesystem timestamps and output artifacts)

---

## 1. Executive Summary

This is a Node.js CLI tool that crawls a documentation website with a real headless browser (Playwright) and extracts every link on every page, then generates HTML/Excel/JSON reports. The crawling, extraction, and reporting pipeline **works and was proven to work** — there's a real 565-page, 25,859-link crawl of `docs.eggplantsoftware.com` sitting in `output/`.

However, the project's entire stated purpose — **link validation** — is not wired up. Four fully-written validator classes (`HttpValidator`, `BrowserValidator`, `AnchorValidator`, `Soft404Detector`) exist, are imported, and are never called from the page-processing code path. Every link in every report is hard-coded to `isBroken: false`, `isRedirect: false`, `isSoft404: false`, `statusCode: null`. The one real production run confirms this exactly: **0 broken links, 0 redirects, 0 soft 404s, 0 anchors checked out of 25,859 links** — not because the docs site is perfect, but because nothing ever checked.

This isn't a bug hiding in a corner; it's the entire product. The tool as it stands is a **link crawler/inventory tool**, not a **link validator**, despite the name and README. There are no code comments, TODOs, or stubs flagging this — the gap is structural and silent, which is the main reason it's easy to miss on a skim.

Everything else is solid, professional, idiomatic Node.js: sensible module boundaries, defensive error handling, NDJSON streaming to avoid memory blowup, graceful shutdown on Ctrl-C, resumable state. This reads like a project built competently but stopped ~1 day before the last integration step.

---

## 2. Original Project Vision

Per the README: an **"enterprise-grade recursive documentation crawler and link validator"** intended to:

- Recursively crawl large documentation sites (thousands of pages) starting from seed URLs
- Validate every link found (internal via full GET, external via lightweight HEAD) for HTTP status, redirects, and "soft 404s" (pages that return HTTP 200 but display "not found" content — common on JS-rendered doc platforms)
- Validate in-page anchor links (`href="#section"`) to catch broken same-page navigation
- Capture screenshots of broken pages for visual triage
- Produce three parallel report formats (interactive HTML dashboard, Excel workbook with 7 sheets, raw JSON) so both engineers and non-technical stakeholders can consume results
- Be resumable and safe to run against large sites unattended (state persistence, graceful shutdown, concurrency limits, crawl delay, robots.txt compliance)

## 3. Problem Statement

The implicit problem: documentation sites accumulate broken internal/external links and orphaned anchors over time as content is restructured, especially on JS-rendered platforms (Docusaurus, in this case) where a "soft 404" can silently return HTTP 200. Manual link-checking doesn't scale to thousands of pages. The tool is meant to give a documentation/DevRel/QA team a repeatable, automatable audit.

The evidence (`config/config.json` seeds) shows this was being built for a specific real target: **Eggplant Software's documentation** (`docs.eggplantsoftware.com` — EPF, DAI, SenseTalk reference, ES products), suggesting this was commissioned or self-initiated work for that specific documentation set, not a generic open-source tool from day one (the README's genericized framing looks like it was written after the fact for the "tool" narrative).

## 4. Current Architecture

The implemented architecture matches the README's diagram closely:

```
crawler.js (CLI entry, commander-based --config flag, SIGINT/SIGTERM handlers)
└── CrawlManager (orchestrator)
    ├── BrowserManager       — Playwright chromium pool (single browser/context, headless)
    ├── StateManager         — visited-URL Set, periodic snapshot to state/crawl-state.json
    ├── QueueManager         — p-limit-based concurrency control, polling waitForIdle()
    ├── SitemapParser        — sitemap.xml / sitemap_index.xml discovery + parsing
    ├── RobotsManager        — robots.txt fetch + allow/disallow rule evaluation
    ├── PageCrawler (per URL)
    │   ├── LinkExtractor    — DOM query for <a>, button[data-href/onclick], img links
    │   ├── DomClassifier    — classifies link location (header/footer/nav/toc/content/…)
    │   └── Soft404Detector.detect() — called, but result discarded (see §9)
    └── Reporters (invoked after every 20 pages AND at the end)
        ├── HtmlReporter     — single-file HTML dashboard (inlines CSS/JS)
        ├── ExcelReporter    — 7-sheet .xlsx via exceljs
        └── JsonReporter     — full JSON dump including raw config
```

**Never instantiated anywhere in the call graph:** `HttpValidator`, `BrowserValidator`, `AnchorValidator` (as a class — only `Soft404Detector.detect` static call survives, and its result is thrown away). `RetryManager` (`utils/retry.js`) is also fully built and never imported by anything.

**Data flow:** `CrawlManager.processPage()` → `PageCrawler.crawl()` returns unvalidated link objects → appended to `results.ndjson` (streamed, not held in memory) → on report generation, the whole NDJSON file is re-read line-by-line into memory and handed to all three reporters.

## 5. Technology Stack

| Layer | Technology | Version (installed) |
|---|---|---|
| Runtime | Node.js | v24.15.0 present in this environment (README asks for 16+) |
| Browser automation | Playwright (chromium) | ^1.52.0 declared, **1.60.0 installed** |
| HTTP client | axios | ^1.9.0 |
| HTML parsing | cheerio | ^1.0.0 (declared, **never imported anywhere** — dead dependency) |
| CLI parsing | commander | ^13.1.0 |
| XML parsing | xml2js | ^0.6.2 (used by SitemapParser) |
| Excel generation | exceljs | ^4.4.0 |
| Concurrency | p-limit | ^6.2.0 |
| Logging | winston | ^3.17.0 |
| Filesystem helpers | fs-extra | ^11.3.0 |
| Terminal color (declared) | chalk | ^5.4.1 (declared, **never imported anywhere** — dead dependency) |
| Database | **none** | no persistence layer beyond flat files (JSON/NDJSON) |
| External APIs/services | **none** required beyond the target website itself | — |

No `.env` file, no secrets, no API keys, no cloud services, no Docker/CI config anywhere in the repo.

## 6. Repository Structure

```
enterprise-doc-validator/
├── README.md                      generic productized README, doesn't disclose the validation gap
├── package.json / package-lock.json
├── crawler.js                     CLI entry point
├── config/config.json             real config, targets docs.eggplantsoftware.com (has a duplicate-key bug, see §13)
├── crawler/                       orchestration (5 files)
├── extractors/                    LinkExtractor, DomClassifier, SitemapParser (3 files)
├── validators/                    HttpValidator, BrowserValidator, AnchorValidator, Soft404Detector — built, disconnected (4 files)
├── reporters/                     HtmlReporter, ExcelReporter, JsonReporter + templates/ (3 files + 3 templates)
├── utils/                         urlUtils, logger, metrics, retry, robotsManager, fileUtils, constants (7 files)
├── state/crawl-state.json         35 KB — real state from the one production run (500 visited URLs)
├── output/                        real run artifacts, see §10 for sizes — NOT sample/fixture data
├── logs/                          empty (logger never configured with LOG_FILE; console-only in practice)
├── screenshots/                   empty (captureScreenshots was set to false in the actual run)
└── node_modules/                  155 packages installed, present and intact
```

No `.git` directory — this repository was never placed under version control, so there is no commit history to review. Evolution below is reconstructed entirely from file mtimes (§14) and the report metadata embedded in the output files.

## 7. Implemented Features

**Verified working** (proven by the real 565-page crawl in `output/`):
- Playwright-driven recursive crawl with depth/page/link-per-page limits
- Seed URL + sitemap.xml discovery, robots.txt fetching and disallow-rule evaluation
- Link extraction from `<a>`, `button[data-href|onclick]`, and `img` elements, with DOM-location classification (nav/header/footer/toc/etc.), CSS selector generation, and HTML snippet capture
- URL normalization (trailing slash, duplicate slashes, tracking-param stripping, fragment stripping)
- Internal/external URL classification against `allowedDomains`
- Concurrency-limited queue processing (p-limit) with idle detection
- Incremental NDJSON persistence (avoids holding 25k+ link records in memory)
- Periodic intermediate report generation (every 20 pages) so an interrupted crawl still leaves usable output
- Graceful shutdown on SIGINT/SIGTERM producing a final report before exit
- Crawl state persistence (visited-URL set saved every 100 visits)
- Console-error capture per page (browser console messages attached to link records)
- All three report generators produce well-formed, valid output files (HTML renders, XLSX has a valid ZIP/OOXML structure, JSON is well-formed)

**Likely working but not exercised by the one real run** (config had `captureScreenshots: false`):
- Screenshot capture path in `BrowserManager`/reporters (the plumbing — `screenshotPath` field — exists end-to-end, but no code path was found that actually calls `page.screenshot()` anywhere in the reviewed files; screenshots directory is empty and there is no visible screenshot-taking logic even in the validator classes). **This is actually a gap, not just untested — see §8.**

## 8. Incomplete Features

This is the core finding of the audit — **the entire validation layer is disconnected**:

1. **HTTP link validation never runs.** `HttpValidator` (axios-based GET/HEAD with redirect-chain extraction, error classification for DNS/timeout/SSL/connection-refused) is fully implemented and never instantiated by `PageCrawler` or `CrawlManager`.
2. **Browser-based validation never runs.** `BrowserValidator` (navigates each link in a real browser tab, checks console errors, failed requests, DOM error indicators, content length) is fully implemented and never called.
3. **Anchor validation never runs.** `AnchorValidator` (checks `href="#id"` links resolve to a real `id` on the page) is fully implemented; `PageCrawler.crawl()` hard-codes `anchorResults: null` instead of calling it.
4. **Soft-404 detection result is discarded.** `Soft404Detector.detect(content, keywords)` **is** called in `PageCrawler.crawl()` (line 40) against the *source page's own content*, but the boolean result (`isSoft404`) is never attached to anything or returned — it's a local variable that's computed and dropped. Every link's `isSoft404` field is hard-coded `false` at construction time.
5. **Retry logic never runs.** `utils/retry.js` (`RetryManager`, exponential backoff, non-retryable error classification) is fully implemented and not imported anywhere in `crawler/`, `validators/`, or `extractors/`. The README advertises "Link Validation: Comprehensive HTTP validation with retry mechanisms" — neither half of that claim is true in the current wiring.
6. **Screenshot capture is not implemented**, despite `screenshotPath` fields threading all the way through the data model and reports. No `page.screenshot()` call exists in any reviewed file.
7. **Every "isBroken", "isRedirect", "isSoft404" field in every report is a compile-time constant `false`.** This isn't a bug that produces wrong answers sometimes — it produces the *same* wrong answer (everything is fine) 100% of the time.
8. **`cheerio` and `chalk` are declared dependencies that are never imported** — likely intended for validation/output-formatting work that never happened.
9. **No test suite of any kind** — no `test/` directory, no test script in `package.json`, no testing framework in dependencies.
10. **No `.gitignore`** and no version control at all — the multi-hundred-megabyte `output/` artifacts (see §10) would have been committed wholesale had this ever been pushed to git, which is itself a sign the project was never taken to a "ready to share" state.

## 9. Working vs Unverified vs Broken Components

| Component | Status | Basis |
|---|---|---|
| `crawler.js` (CLI entry) | **Verified working** | Real run completed successfully end-to-end |
| `CrawlManager` orchestration | **Verified working** | Real run produced correct page/link counts, intermediate + final reports |
| `BrowserManager` (Playwright) | **Verified working** | Chromium launched, pages loaded (consoleErrors captured in real output) |
| `PageCrawler` / `LinkExtractor` / `DomClassifier` | **Verified working** | 25,859 links extracted with correct selectors, snippets, DOM-location types in real output |
| `SitemapParser`, `RobotsManager` | **Likely working** | Code is straightforward and defensive; not directly falsifiable from output alone, but the crawl behavior (500+ URLs visited beyond the 4 seeds) is consistent with sitemap-driven discovery working |
| `StateManager` | **Verified working** | `state/crawl-state.json` contains real, well-formed visited-URL data |
| `QueueManager` | **Verified working**, but architecturally fragile | Works (proven by the run), but `waitForIdle()` polls every 100ms and re-derives its "done" condition from array lengths growing during iteration — correct here only because tasks are added faster than they're compared; a subtle off-by-timing bug under different load patterns is plausible (see §13) |
| `HtmlReporter`, `ExcelReporter`, `JsonReporter` | **Verified working** (as reporters) | Real files exist, are structurally valid (XLSX has correct ZIP header, JSON parses, HTML has the expected structure) — but they faithfully report the *unvalidated* data, so "working" means "renders correctly," not "produces correct conclusions" |
| `HttpValidator` | **Unverified / dead code** | Code reads as complete and reasonable, but is never invoked — never exercised against a live target |
| `BrowserValidator` | **Unverified / dead code** | Same — includes a no-op `jsErrors` check (`window.onerror` branch is an empty/commented placeholder that always returns `[]`, a stub within a stub) |
| `AnchorValidator` | **Unverified / dead code** | Never invoked; has a latent bug (see §13, referencing `href` before it's assigned in the catch block) |
| `Soft404Detector` | **Broken (in effect)** | The static `detect()` works if called, but its output is discarded — functionally broken *in situ* even though the code itself is fine |
| `RetryManager` | **Unverified / dead code** | Never imported anywhere |
| Screenshot capture | **Broken / not implemented** | Data model and reports assume it exists; no producing code found |
| Overall "link validation" product claim | **Broken** | Confirmed by real output: 0/25,859 links flagged broken, 0 redirects, 0 soft 404s, 0/0 anchors checked — statistically impossible for a real documentation site of this size, proving no checking occurred |

## 10. Required External Dependencies

- **Network access** to the target documentation domain (`docs.eggplantsoftware.com` in the current config, and to whatever domains a future `allowedDomains` list names) — this is a live third-party site, not a fixture the user controls
- **Playwright's Chromium browser binary** — not bundled in `node_modules`; must be fetched separately via `npx playwright install`. **In this specific environment, chromium 1234 is already present** under `AppData/Local/ms-playwright` (a machine-wide cache, not project-local), so a run would work here today without that install step. On any other machine it would need to be run.
- No database, no API keys, no cloud credentials, no message queue, no external service accounts of any kind
- Disk space: a full crawl of a mid-size doc site produces **very large** local artifacts — the one real run generated a combined ~850 MB (`report.json` 447 MB + `results.ndjson` 399 MB + `report.html` 16 MB + `report.xlsx` 1.2 MB) for only 565 pages / 25,859 links. This will not scale to the advertised "10,000 pages" default without either fixing the per-link payload size (full HTML snippets + full console-error text + full redirect chains, per link, duplicated across three output formats) or changing the output strategy.

## 11. Is the Current Project Runnable?

**Yes, mechanically runnable in this environment** — `npm install` has already been run (155 packages present, no missing-module errors expected), Playwright's chromium is cached locally, `crawler.js` has no syntax errors, and there is direct proof it already ran successfully once (the `output/` and `state/` artifacts).

**But "runnable" ≠ "does what it claims."** It will crawl and produce reports; it will not validate anything. Running it again today would reproduce the same shape of result: a large, well-formatted report where every single link is reported as OK.

## 12. How to Run the Project

```bash
npm install
npx playwright install chromium
```

Then either:

```bash
npm run crawl
```
(uses `./config/config.json`, which is already configured for `docs.eggplantsoftware.com`), or:

```bash
node crawler.js --config=path/to/other-config.json
```

**Before running again**, be aware:
- The existing `config/config.json` will re-crawl the live Eggplant Software documentation site — this hits a real third-party server repeatedly (500+ requests were made in the last run); re-running should be a deliberate choice, not incidental.
- `resumePreviousCrawl` is `false`, so the run will start fresh and **overwrite** `state/crawl-state.json`. `output/results.ndjson` is opened in **append mode** (`{ flags: 'a' }` in `CrawlManager.initialize()`), so a second run will **append to, not replace**, the existing 399 MB file unless it's deleted first — this is a real footgun for anyone re-running it as-is.
- Expect several hundred MB of new output given the current per-link payload size.
- No output will contain genuine broken-link, redirect, or soft-404 findings until §8's items are fixed.

## 13. Known Issues

1. **`config/config.json` has duplicate JSON keys** (`maxDepth` and `concurrency` each appear twice, lines 11-14). JSON.parse silently keeps the last value (`maxDepth: 4`, `concurrency: 3`), so it doesn't crash, but it's evidence of a copy-paste edit that wasn't cleaned up and is silently misleading to read.
2. **`AnchorValidator.validate()` has a reference-before-assignment bug**: in the `catch` block (line 37-43), it references `href` and `text`, but those are declared with `const` *inside* the `try` block — if `anchor.getAttribute('href')` throws, the catch block itself will throw `ReferenceError: href is not defined` rather than gracefully recording the error. Moot today only because the whole class is unreachable dead code.
3. **`BrowserValidator`'s `jsErrors` check is a stub inside otherwise-real code**: the `validationPage.evaluate(() => { ... return errors; })` block has a comment admitting `"This is a simple check - in a real implementation, you'd need to set up error tracking"` and always returns an empty array. So even if this validator were wired in, its JS-error detection would never actually detect anything.
4. **`QueueManager.waitForIdle()` is a polling loop with a subtle race**: it slices `this.tasks` up to `completedTasks` and does `Promise.allSettled` on tasks *after* that slice, then sleeps 100ms and rechecks. Because `tasks.length` grows while `waitForIdle` is mid-iteration (new pages get queued from links found on the current page), the "wait for tasks after `completedTasks`" logic can miss newly-added tasks in the same tick it's checking, relying on the next 100ms loop iteration to catch them. It worked in the one real run, but it's fragile/non-obvious rather than a clean signal (e.g., a proper "no more pending and no in-flight" event).
5. **`isSoft404` computed and silently discarded** in `PageCrawler.crawl()` — dead local variable (§8.4).
6. **NDJSON results file opened in append mode with no rotation or clearing** — re-running the crawler without manually deleting `output/results.ndjson` first accumulates unbounded data across runs (§12).
7. **Massive, unbounded per-link payload**: `htmlSnippet` (up to 200 chars), full `consoleErrors` arrays (each with full ad-tech URLs sometimes exceeding 1KB per error, as seen in the sampled data), and full `redirectChain` are stored per link, and the same data is duplicated across NDJSON, JSON report, and (partially) HTML/Excel — a major driver of the ~850 MB output for a 565-page crawl.
8. **`output/report.html` is 16 MB** — a single static HTML file with the *entire* dataset inlined into JS-rendered tab content client-side; opening this in a browser for a larger crawl (the advertised 10,000-page scale) would likely be very slow or crash the tab.
9. **No `.gitignore`** — if this were ever put under version control as-is, `node_modules/`, `output/` (850 MB), `state/`, and `logs/` would all be tracked.
10. **Logs directory is empty** despite a real crawl having run** — `winston` only logs to console unless `process.env.LOG_FILE` is set, and nothing in the codebase sets that env var by default, so `logs/` will stay empty in normal usage despite `CrawlManager.initialize()` calling `fs.ensureDir(path.dirname(this.config.logFile || './logs/crawl.log'))` (which only creates the directory, not a file).
11. **Two dead npm dependencies** (`cheerio`, `chalk`) declared and installed but never imported anywhere in the source.

## 14. Technical Debt

- **The validation layer is built but not integrated** — this is the single largest piece of technical debt in the project. It's not a matter of writing new code; `HttpValidator`, `BrowserValidator`, `AnchorValidator` all exist and look reasonable. The work remaining is: decide a validation strategy (validate every link? only internal ones? sample external ones to avoid hammering third-party sites?), wire the chosen validator(s) into `PageCrawler.crawl()`'s per-link loop, thread the real result fields (`statusCode`, `isBroken`, etc.) through instead of the current hard-coded defaults, and re-run against real data to see if the validators behave sanely at scale (rate limits, timeouts, thousands of concurrent HTTP validations).
- **Retry logic (`RetryManager`) is unused** — once HTTP/browser validation is wired in, this should wrap those calls; right now a transient network blip would be recorded as a permanent broken link with no retry.
- **Output payload design needs rethinking before this can run at the advertised "10,000 pages" scale** — current per-link, per-format duplication of large text fields doesn't scale linearly and already produced ~850 MB for 565 pages.
- **No tests** at all — for a tool whose core promise is "trustworthy validation results," there's no way to verify a change to a validator doesn't silently break detection logic.
- **Timeline evidence** (file mtimes, §15) suggests the validators (`validators/`) were written in one initial session (2026-05-12, 17:15–17:22) as the *first* thing built, then the orchestration layer (`crawler/`, `crawler.js`) was written over a day later (2026-05-13, 10:16–19:38) as the *last* thing built — and the integration step connecting the two was never done before the one real run happened at 19:57–20:10 that same evening. This reads as a project that ran out of time one step before completion, not one with a design flaw.

## 15. Security Concerns

- **No secrets, credentials, or auth handling in the codebase** — nothing to leak from the source itself.
- **`rejectUnauthorized: false` in `HttpValidator`'s HTTPS agent** — SSL certificate validation is explicitly disabled for all outbound validation requests (both internal and external). This is defensible for a link-checker that needs to report "this cert is expired" as a finding rather than crash, but as written there's no way to *distinguish* "cert was invalid" from "cert was fine" in the validator's happy-path return value — that information is silently thrown away rather than surfaced as a finding. Moot today since the validator isn't called, but worth fixing when it is.
- **`--no-sandbox` / `--disable-setuid-sandbox` Chromium launch flags** in `BrowserManager` — standard for running headless Chromium in constrained/CI environments, but it does reduce browser process isolation; acceptable for crawling read-only public documentation, would be worth reconsidering if this tool were ever pointed at untrusted or adversarial content.
- **The crawler will follow and screenshot/validate arbitrary external links** discovered on the crawled site (once validation is wired in) — no allowlist/denylist beyond `excludedPaths` (path-based, not domain-based) restricts what `HttpValidator.validateExternal` will contact. Not a vulnerability in itself, but worth knowing before pointing this at a site with attacker-controllable outbound links.
- **No SSRF-style safeguards** — `HttpValidator`/`BrowserValidator` will fetch whatever URL is discovered in the DOM, including `javascript:`/`data:`/`file:`-scheme hrefs if `LinkExtractor` doesn't filter them (it doesn't — `new URL(href, sourceUrl)` will happily resolve a `javascript:` URL and pass it downstream as a "link" to potentially be fetched later). Low real-world risk for a tool crawling one's own or a vendor's public docs, but relevant if this is ever pointed at less-trusted content.
- **This specific config crawls a third party's live site** (`docs.eggplantsoftware.com`) at 3-way concurrency with a 500ms delay — polite by web-scraping norms, but worth explicit confirmation from whoever owns this project that they have standing permission/expectation to crawl that domain repeatedly, especially once validation (extra HTTP requests per link, browser-based re-navigation per link) is turned on and request volume goes up substantially.

## 16. Recommended Path Forward

1. **Decide whether this project is still wanted before investing further** — confirm the target (Eggplant Software docs, or something else/generic) and whether repeated crawling of that third-party domain is still sanctioned.
2. **Wire up validation** — this is the one gap that matters. Concretely: in `PageCrawler.crawl()`, after building each `validated` link entry, call `HttpValidator.validate(normalizedTarget)` (and merge its returned fields into the entry instead of the hard-coded `false`/`null` values), decide whether/when to escalate to `BrowserValidator` (e.g., only for internal links, or only for links `HttpValidator` couldn't resolve cleanly), and call `AnchorValidator.validate(page, url)` once per page to populate `anchorResults` instead of `null`. Fix the `href`/`text` scoping bug in `AnchorValidator` (§13.2) while touching that file.
3. **Wrap the new validation calls in `RetryManager`** so transient network errors aren't reported as permanent breakage.
4. **Fix `Soft404Detector` wiring** — attach the already-computed `isSoft404` result to the source page's own link entries (or reconsider whether soft-404 detection should apply to the *target* of each link, which would require fetching each link's content — a bigger design decision worth making deliberately).
5. **Add a validation strategy for scale** — concurrency limits, rate limiting per external domain, and a sampling strategy so that "10,000 pages" doesn't mean tens of thousands of uncontrolled outbound HTTP + browser navigations.
6. **Shrink the output payload** before running at scale again — cap or truncate `consoleErrors`/`htmlSnippet` more aggressively, consider not duplicating full result data across all three report formats, and reconsider whether `report.html` should inline the entire dataset or fetch it client-side from `report.json`.
7. **Delete or reduce the existing `output/`, `state/`, `logs/` artifacts** before any version control is set up, and add a `.gitignore` covering `node_modules/`, `output/`, `state/`, `logs/`, `screenshots/`.
8. **Remove unused dependencies** (`cheerio`, `chalk`) or use them if they were intended for something (e.g., `chalk` for colored CLI output, which the README's tone suggests was probably the plan).
9. **Add at least minimal tests** for the validators once wired in — these are the components whose *correctness*, not just *execution*, the whole tool's value depends on.
10. **Only after the above**, consider the screenshot-capture feature that's referenced throughout the data model/reports but was never actually built.

---

*This audit reflects the repository state as of 2026-09-02. No files were created, modified, or deleted as part of this analysis other than this document.*
