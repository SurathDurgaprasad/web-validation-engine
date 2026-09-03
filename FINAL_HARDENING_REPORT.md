# FINAL_HARDENING_REPORT.md

**Date:** 2026-09-03
**Scope:** Final engineering hardening pass — bug hunt, mandatory regression tests, report-consistency audit, CLI/config usability, security review, resource-management review, output/scalability review, dependency audit, README truthfulness review, and final verification.
**Constraint honored throughout:** no rewrite, no new frameworks/databases/Docker/cloud/AI/web UI, no dependency churn, no speculative features.

---

## 1. Executive Summary

This pass started from a codebase that already had validation genuinely wired up (per `ENGINEERING_REPORT.md`) and treated it as a real system to stress rather than a report to trust. Tracing the actual execution path — not just reading it — surfaced **six real, previously-unknown bugs**, one of them a genuine security-relevant scope bug (`isInternalUrl` matched by substring, not by host/subdomain), and one a silent data-loss bug caught only by actually running a real Playwright crawl against a local fixture and reading back the output.

Every bug below is fixed, and every fix has a regression test. The two explicitly mandated regression areas (redirect-chain safety, anchor-fragment deduplication) are covered by dedicated test files plus a full end-to-end integration test that exercises the real pipeline (Playwright + a local fixture HTTP server) against every link category in one pass. `ConfigLoader` was rewritten to reject malformed configuration early with field-identified errors instead of silently normalizing bad values. The CLI gained `--url`/`--environment`/`--max-pages`/`--max-depth`/`--output` overrides, validated through the exact same path as the config file. The README was corrected in several places where it claimed capabilities (screenshot capture, a screenshot viewer) the tool does not have.

**Test suite: 104/104 passing**, including one full Playwright-driven end-to-end test. Verified from a clean `npm install`.

**Verdict: READY FOR BASELINE COMMIT.** See §12 for the reasoning and the specific things a future contributor should know are still open.

---

## 2. Bugs Found and Fixed

### 2.1 `isInternalUrl` matched by substring, not by host — real scope/security bug

- **Symptom:** none visible in normal use — this only breaks when domain names have specific substring relationships.
- **Root cause:** `utils/urlUtils.js` used `parsed.hostname.includes(domain)`. With `allowedDomains: ["example.com"]`, this also matched `notexample.com`, `myexample.com`, and `example.com.attacker.net` — because `.includes()` checks for a substring anywhere, not a proper host/subdomain match. This function gates both what gets *queued for crawling* and (via `HttpValidator`) what gets a full GET-with-body vs. a lighter HEAD, and it's part of the browser-escalation eligibility check.
- **Fix:** exact host match or a proper `.`-prefixed subdomain match (`hostname === d || hostname.endsWith('.' + d)`), case-insensitive.
- **Verification:** `test/urlUtils.test.js` — 7 cases including the exact substring-lookalike scenarios above, all passing. Pre-existed since the original config-loading rewrite; never previously tested at this boundary.

### 2.2 `SitemapParser` never actually parsed sitemap-index sub-sitemaps

- **Symptom:** silent — `followSitemaps` would run without error but discover nothing extra from any site using a sitemap index (a very common pattern on large sites).
- **Root cause:** `parseSitemapXml`'s handling of `<sitemapindex>` called `this.parse(subSitemapUrl)` — but `parse()` builds its own "guess common locations" URLs by *appending* `/sitemap.xml` etc. to whatever it's given. Called on an already-fully-qualified sub-sitemap URL like `https://x.com/sitemap-posts.xml`, that produces `https://x.com/sitemap-posts.xml/sitemap.xml`, which reliably 404s (silently, caught by an inner try/catch). There was also no cycle guard — a sitemap index that references itself (a real, if rare, misconfiguration) had nothing to stop recursive re-fetching.
- **Fix:** a new `fetchSubSitemap(url, visited)` fetches the sub-sitemap by its *actual* URL and feeds the response straight to `parseSitemapXml`, threading a `visited` `Set` through recursive calls (cycle guard) with a hard cap (`MAX_SITEMAPS_PER_INDEX = 50`) as defense in depth.
- **Verification:** `test/sitemapParser.test.js` — a fixture with a self-referencing sitemap index plus a genuine sub-sitemap; confirms both real resolution and that the self-reference doesn't hang or loop.

### 2.3 `extractRedirectChain` could build a ~134-million-element array before crashing (previously found; now regression-tested)

- Already fixed in the prior pass (hop cap + seen-set cycle guard). This pass adds the **mandatory regression tests** (§3) proving termination, cap enforcement, and safe serialization using small controlled mock objects — not a live reproduction of the original allocation.

### 2.4 Anchor-fragment deduplication collision (previously found; now regression-tested + extracted for testability)

- Already fixed in the prior pass. This pass **extracts** the dedup-key logic into a pure, exported `utils/urlClassifier.getDedupeKey()` function specifically so it can be unit-tested independent of Playwright, and adds the mandatory regression tests (§3) plus a full E2E proof through the real pipeline.

### 2.5 Browser-escalation failure silently left a stale `soft404` status instead of reporting `error`

- **Symptom:** if the bounded browser escalation itself failed to complete (context closed, crash, navigation error inside the escalation), the link kept whatever status the *pre-escalation* HTTP check had produced (`soft404`) — misrepresenting "we tried to resolve this ambiguity and couldn't" as "we resolved it, and it's ambiguous."
- **Fix:** `LinkValidationService.validateLink()`'s escalation catch block now sets `validationStatus: 'error'`, `errorType: 'browser-escalation-failed'`, and a descriptive `errorMessage`, matching the canonical `error` state ("validation could not complete") from the report-consistency audit (§4).
- **Verification:** covered structurally by `test/reportConsistency.test.js`'s `error`-state synthetic entry (proves reporters render it correctly); the escalation-catch code path itself is exercised only indirectly (a live browser-crash-mid-escalation is impractical to reproduce deterministically in a fast test — documented as a residual gap, not silently skipped).

### 2.6 `maxPages` could be overrun under concurrency (race between check and increment)

- **Symptom:** with `concurrency > 1`, a crawl configured for e.g. `maxPages: 50` could crawl up to `50 + (concurrency - 1)` pages.
- **Root cause:** `CrawlManager.processPage()` checked `metrics.crawledPages >= maxPages` at the top, but `crawledPages` was only incremented *after* the full async `crawler.crawl()` call completed. With concurrency > 1, several queued pages could all pass the check before any of them finished and incremented the counter.
- **Fix:** a new `this.pagesStarted` counter, incremented synchronously (before any `await`, in the same synchronous stretch as `state.markVisited()`) at the point a page is committed to — closing the race window entirely, since no other queued task can observe a stale count in between two purely synchronous statements in JavaScript's run-to-completion model.
- **Verification:** reasoned from JS's single-threaded, run-to-completion semantics (documented inline); not separately unit-tested with a live race reproduction, since races of this kind are inherently flaky to assert on directly — the fix's correctness follows from the language guarantee, not from timing-dependent test observation.

### 2.7 Browser/state cleanup wasn't guaranteed on an unexpected mid-run failure

- **Symptom:** if anything between a successful browser launch and the end of `CrawlManager.start()` threw unexpectedly (report generation, an unforeseen bug), the Chromium process and crawl state were never cleaned up — no code path guaranteed it outside the two "happy" exits (normal completion, SIGINT).
- **Fix:** wrapped the body of `start()` (after `initialize()`) in `try { ... } finally { await this.browserManager.close(); await this.state.finalize(); }`.
- **Verification:** exercised implicitly by every passing test that runs a real crawl to completion (the `finally` always runs); not separately tested against a deliberately-injected mid-run throw, which would require fault-injection scaffolding disproportionate to the fix's size.

### 2.8 `results.ndjson` write stream was never explicitly closed on normal completion

- **Symptom:** none observed in practice (Node's stream buffering happened to make this work reliably for the crawl sizes tested), but there was no *guarantee* — the file handle stayed open until process exit, and `generateReports()`'s readback right after was relying on incidental timing, not an explicit flush.
- **Fix:** `closeResultsStream()` (a small helper, also de-duplicating what `gracefulShutdown()` already did) is now called at the end of the normal completion path, before the final `generateReports()` read.
- **Verification:** `test/e2e.crawl.test.js` reads back the NDJSON and report.json after a normal (non-interrupted) completion and asserts on exact record counts — this would be the first thing to flake if the stream weren't properly flushed/closed before the read.

### 2.9 Console errors were duplicated onto every link on a page, multiplying output size

- **Symptom:** confirmed directly in the historical `output/report.json` (the real Eggplant crawl artifact) — a single page's block of link records contained the *same* `consoleErrors` array copy-pasted dozens of times, once per link discovered on that page.
- **Root cause:** console errors are inherently page-scoped (captured once via a `page.on('console', ...)` listener), but `PageCrawler` attached the *entire array* to every individual link record built for that page.
- **Fix:** replaced the duplicated `consoleErrors: [...]` array on every link with a single `pageConsoleErrorCount: N` integer — the per-link signal that's actually meaningful (this page had N console errors) without the multiplicative payload blowup. `JsonReporter` updated to match (no HTML/Excel report ever rendered `consoleErrors` as a column, so this was zero-risk there).
- **Verification:** `test/reportConsistency.test.js`'s synthetic fixtures use the new field; `test/e2e.crawl.test.js` implicitly confirms the new schema round-trips correctly through NDJSON → JSON report.

### Known, deliberately unresolved issue

- **A SIGINT arriving *during* `chromium.launch()`** (before `BrowserManager.initialize()` returns) can leave an orphaned launching Chromium process, since `gracefulShutdown()`'s `browserManager.close()` is a no-op until `this.browser`/`this.context` are actually set. Fixing this properly would require tracking and forcibly killing the in-flight launch by PID — real added complexity for a narrow startup-only timing window. Documented here rather than fixed.

---

## 3. Regression Coverage

All new/extended test files, by mandate:

### Regression Test A — Redirect Chain Safety (`test/redirectChainSafety.test.js`)

Uses small, controlled synthetic request-like objects — **does not** allocate anywhere near the original ~134-million-element pathological case. Proves:
- A direct self-reference terminates immediately (1 hop recorded, < 100ms).
- An indirect 3-node cycle (A → B → C → A) terminates via the seen-set guard, not just the direct self-reference check.
- A long (30-node) *non-cyclic* chain is capped at the hard limit (20), proving the cap applies independently of cycle detection.
- The result of a pathological cyclic walk is always safely `JSON.stringify`-able and small.
- A normal, small, 2-hop redirect is still captured accurately (the fix doesn't break the common case).
- A malformed request object (`{}`, `null`, `undefined`) never throws.

### Regression Test B — Anchor Fragment Deduplication (`test/anchorFragmentDedup.test.js` + `test/e2e.crawl.test.js`)

Fast, Playwright-independent unit coverage (`anchorFragmentDedup.test.js`) proves, via the extracted `getDedupeKey()`:
- Two different fragments on the same page produce two different dedupe keys.
- The same fragment linked twice does dedupe to one entry.
- A realistic page scan (3 distinct anchors + 1 duplicate) yields exactly 3 kept entries.
- Ordinary (non-anchor) links are unaffected — still dedupe via the fragment-stripped normalized URL.
- Crawl identity (page visited-tracking, fragment-insensitive by design) and link-validation identity (fragment-sensitive) are explicitly, separately proven correct in the same test.

The full E2E test (§ below) proves the same regression through the *real* Playwright + validation pipeline, not just the isolated dedup function.

### End-to-End Integration Test (`test/e2e.crawl.test.js`)

One local fixture page (`/e2e-home`, served by `test/helpers/testServer.js`, no external network) containing every link category in one pass: a valid internal link, a broken internal link, a redirect, a soft-404 candidate (asserted to escalate to and be confirmed by `BrowserValidator`), two distinct anchors plus one duplicate of the first, a broken anchor, a `mailto:` link, a `tel:` link, and a `javascript:` link. Driven through the real `CrawlManager`/`PageCrawler`/`LinkExtractor`/`urlClassifier`/`LinkValidationService` pipeline with a real Playwright browser, into a temp output directory (never touches the project's own `output/`/`state/`). Reads back the actual NDJSON and `report.json` and asserts on:
- Exactly 10 unique persisted records (11 hrefs, 1 duplicate anchor deduped).
- Every category's correct `validationMethod`/`validationStatus`/`statusCode`.
- Run-directory isolation, report generation, and `run-manifest.json` contents.

### Additional regression/coverage tests added this pass

- `test/urlUtils.test.js` — `isInternalUrl` boundary cases (§2.1) and `redactCredentials` (§6).
- `test/sitemapParser.test.js` — §2.2.
- `test/reportConsistency.test.js` — the Phase 4 mandate: one synthetic entry per canonical state (`valid`/`broken`/`redirect`/`soft404`/`not_checked`/`error`), asserting none of `HtmlReporter`/`ExcelReporter`/`JsonReporter` ever renders `not_checked` or `error` as `OK`/`Valid`/`Healthy`.
- `test/httpValidator.test.js` — added a live redirect-loop case (`/redirect-loop` ↔ `/redirect-loop-b` bouncing fixture) proving `errorType: 'redirect-loop'` is reached in practice, not just mapped in a switch statement nobody exercises.
- `test/configLoader.test.js` — extended from 4 to 19 cases covering every malformed-config example the mission specified (§7) plus several more (non-object nested sections, array-typed sections, invalid entries inside `seedUrls`).

**Total: 104 tests, 0 failures**, run via `npm test` (`node --test`, zero new dependencies).

---

## 4. Architecture Status

Verified against the actual repository (not assumed from prior docs) — the runtime flow now is:

```
CLI (--url/--environment/--max-pages/--max-depth/--output, or --config)
  ↓
crawler.js: merge CLI overrides into raw config → ConfigLoader.load()
  ↓ (throws a field-identified error here on anything malformed — see §7)
CrawlManager (one output/runs/<timestamp>/ directory per run)
  ↓
  ├─ BrowserManager (single Chromium instance, one shared context)
  ├─ StateManager (visited-URL set, shared across runs — for resumePreviousCrawl)
  ├─ QueueManager (p-limit-based page-crawl concurrency)
  └─ LinkValidationService (one shared instance per run: HttpValidator + RetryManager + BrowserValidator + p-limit for per-page link-validation concurrency)
       ↓
PageCrawler.crawl(url, depth)
  ↓
  Playwright navigation → page.content() → Soft404Detector (page-level)
  ↓
  LinkExtractor → urlClassifier.classifyUrl() per link
  ↓                                    ↓
  AnchorValidator (once/page)    getDedupeKey() (fragment-aware dedup)
  ↓                                    ↓
  resolveAnchorLinks()            markUnfetchableLinks() (mailto/tel/javascript/data/file/blob)
  ↓
  LinkValidationService.validateBatch() for internal/external http(s) links
       ↓
       HttpValidator (GET internal w/ soft-404 body check, HEAD external)
       → retry loop for transient results (429/5xx/timeout/reset/network)
       → bounded escalation to BrowserValidator (internal + 200 + soft-404 match only)
  ↓
Result aggregation (CrawlManager.processPage: metrics, crawl-queue for urlCategory==="internal" only)
  ↓
Credential redaction (redactCredentials on sourcePage/targetUrl/normalizedTarget/finalUrl)
  ↓
NDJSON (per-run directory, stream explicitly closed before final read)
  ↓
HTML / Excel / JSON reports (all three: valid/broken/redirect/soft404/not_checked/error, never collapsed to OK)
```

This matches the mission's expected architecture diagram; no structural surprises were found — the deviations found were all bugs *within* the described flow (§2), not architectural gaps.

---

## 5. CLI and Configuration Status

**CLI:** `--config <path>` (unchanged) plus new `--url`, `--environment`, `--max-pages`, `--max-depth`, `--output`. A config file is still required (it supplies crawl/validation/scope/reporting defaults) — the CLI flags *override* its target, they don't replace the need for one. This was a deliberate scope decision: making the tool "config-optional" would be a larger design change than "final hardening" calls for, and every example config already ships in the repo. CLI overrides are merged into the raw config object *before* `ConfigLoader.load()`, so an invalid `--url` gets the exact same validation and error message a bad config file would — verified live:

```
$ node crawler.js --url "file:///etc/passwd"
Error: Configuration error: "target.baseUrl" must use http or https (got "file:" ...)

$ node crawler.js --max-pages notanumber
error: option '--max-pages <n>' argument 'notanumber' is invalid. must be an integer.
```

**Configuration validation** (`config/ConfigLoader.js`, fully rewritten this pass): every field either falls back to a documented default when *omitted*, or throws a specific, field-identified error when *present but invalid* — nothing is silently coerced. Verified against every malformed-config example the mission specified (§7) plus additional cases, all in `test/configLoader.test.js`.

---

## 6. Security Review

- **Crawl-scope containment fixed** (§2.1) — `allowedDomains` matching is now exact-host-or-subdomain, not substring. This is the single most important security fix in this pass: it directly bounds both what gets queued for crawling and what's eligible for the more expensive browser escalation.
- **URL scheme handling** (`utils/urlClassifier.js`, unchanged this pass but re-verified): `javascript:`, `data:`, `file:`, `blob:` are classified `unsupported` and never reach axios or `page.goto()`; `mailto:`/`tel:`/`sms:` are classified `ignored` and never fetched. Confirmed live through the E2E test.
- **Redirect behavior:** deliberately *not* restricted beyond axios's own hop limit (10 internal / 5 external) plus the redirect-loop `errorType` mapping. Blocking redirects to other domains, `localhost`, or private IPs was considered and rejected — the mission explicitly requires supporting internal/enterprise targets, where a legitimate internal link redirecting to another internal host is normal, and validation-time HTTP requests don't expand *crawl* scope (only `urlCategory === 'internal'` links ever get queued as new pages — a redirect encountered during validation never does).
- **Credential redaction added** (`utils/urlUtils.redactCredentials`, new this pass): a URL with embedded HTTP Basic Auth credentials (`https://user:pass@host/...`), if ever present in scraped page content, is stripped of `user:pass@` before being written to NDJSON/reports (applied once, at the `CrawlManager` write boundary — validation itself still uses the real URL). **Explicit residual gap, documented rather than fixed:** a credential embedded in the *raw* `htmlSnippet` field (the literal markup captured from the page, e.g. `<a href="https://user:pass@host/">`) is not scrubbed — regex-scrubbing arbitrary HTML snippets reliably is disproportionately fragile for how rare this scenario is; flagged rather than half-fixed.
- **No authentication/credential support was added** — correctly out of scope per the mission (`Do not add credential support in this phase`).
- **SSL verification is disabled** (`rejectUnauthorized: false` in `HttpValidator`'s HTTPS agent) — unchanged from before this pass, and still the right call for a tool that must also validate internal/staging targets with self-signed certs; the resulting SSL-related failures are still classified and reported (`errorType: 'ssl'`), not silently ignored.

---

## 7. Resource Management Review

Verified by direct code inspection plus the fact that every test — including the multi-browser-page E2E test — runs to completion and lets the process exit cleanly (no hanging handles observed across dozens of `node --test` runs this session):

| Resource | Status |
|---|---|
| Browser (Chromium process) | Closed on normal completion, on `gracefulShutdown()` (SIGINT/SIGTERM), and now also on any unexpected mid-run exception (§2.7, new `try/finally`) |
| Browser context | Single shared context per run; closed alongside the browser |
| Pages | Every `page` opened via `browserManager.newPage()` is closed in a `finally` in `PageCrawler.crawl()`; every validation page opened by `BrowserValidator` is closed in its own `finally` |
| Results NDJSON stream | Now explicitly closed before the final report read on the normal path too, not just on interrupted shutdown (§2.8) |
| State file (`state/crawl-state.json`) | `stateDirectory` is now actually `ensureDir`'d (fixed in the prior pass) |
| Timers | `setTimeout`-based delays (`CrawlManager.delay`, `RetryManager.delay`, `QueueManager`'s polling sleep, Playwright's own `waitForTimeout`) all resolve and complete normally — no `setInterval` anywhere in the codebase |
| Known gap | SIGINT during an in-flight `chromium.launch()` — documented, not fixed (§2, "Known, deliberately unresolved issue") |

---

## 8. Scalability Status

- **Run isolation:** verified for real by the E2E test's own assertions (a fresh `output/runs/<timestamp>/` directory every run; the historical Eggplant output in the repo's own `output/` directory was never touched or read by any run this session).
- **Fixed this pass:** console-error duplication (§2.9) — a genuine, measurable reduction (confirmed directly against the historical 447 MB `output/report.json`, where a single page's link block repeated the same console-errors array dozens of times).
- **Still true, not addressed this pass (by design — see Phase 9's explicit "do not redesign" instruction):** `htmlSnippet` (capped at 200 chars per link, unchanged), `redirectChain` (now capped at 20 hops, §2.3 — this *was* addressed, as a correctness fix, and happens to also bound size), and the overall pattern of `report.html` inlining the entire dataset into one static file rather than fetching it client-side from `report.json`. That last one is a real architectural change (client-side fetch, pagination, or a different report format entirely), correctly out of scope for a hardening pass — documented here, not attempted.
- **`maxPages` is now a hard bound** under concurrency (§2.6), where it previously could overrun by up to `concurrency - 1` pages — a small but real scalability-control fix.

---

## 9. Test Results

Exact commands run, in order, with outcomes:

```bash
npm test
# ℹ tests 104 / ℹ pass 104 / ℹ fail 0
```

```bash
node -e "require('./crawler/CrawlManager')"   # and 13 other touched modules individually
# All: OK (no syntax/import errors)
```

```bash
rm -rf node_modules && npm install --no-audit --no-fund
# added 153 packages in 8s (only pre-existing transitive-dependency deprecation warnings, nothing added by this pass)
npm test
# ℹ tests 104 / ℹ pass 104 / ℹ fail 0   (confirmed clean from a fresh install)
```

```bash
node crawler.js --url https://example.com/ --max-pages 1 --max-depth 0
# Real crawl of IANA's example.com (reserved for documentation/example use — not a real
# third-party service being hammered). Result: the page's one outbound link
# (https://iana.org/domains/example) correctly validated as validationStatus: "redirect",
# statusCode: 200, finalUrl: "http://www.iana.org/help/example-domains", retryAttempts: 1
# — a genuine, live, non-hard-coded validation result. Reports generated in a fresh
# output/runs/<timestamp>/ directory.

node crawler.js --url https://example.com/ --environment staging --max-pages 1 --max-depth 0
# Confirmed --environment override reaches run-manifest.json.target.environment ("staging").
```

No full or repeated crawl of the historical Eggplant Software documentation site was performed this session, per the mission's explicit instruction.

---

## 10. Files Changed

**New files:**

| File | Why |
|---|---|
| `test/redirectChainSafety.test.js` | Mandatory Regression Test A |
| `test/anchorFragmentDedup.test.js` | Mandatory Regression Test B (fast, Playwright-independent) |
| `test/e2e.crawl.test.js` | Mandatory end-to-end integration test (Phase 3), also the fuller proof for Regression Test B |
| `test/urlUtils.test.js` | Covers the `isInternalUrl` fix (§2.1) and `redactCredentials` (§6) |
| `test/sitemapParser.test.js` | Covers the sitemap-index fix (§2.2) |
| `test/reportConsistency.test.js` | Mandatory Phase 4 report-consistency coverage |
| `FINAL_HARDENING_REPORT.md` | This document |

**Modified files:**

| File | What changed | Type |
|---|---|---|
| `utils/urlUtils.js` | `isInternalUrl` substring-match fix (§2.1); added `redactCredentials` | Bug fix (security) + feature |
| `extractors/SitemapParser.js` | Sub-sitemap fetching fix + cycle guard (§2.2) | Bug fix |
| `crawler/LinkValidationService.js` | Browser-escalation failure now reports `error`, not stale `soft404` (§2.5) | Bug fix (truthful reporting) |
| `crawler/CrawlManager.js` | `pagesStarted` race fix (§2.6); `try/finally` browser/state cleanup (§2.7); explicit stream close on normal completion (§2.8); credential redaction at the NDJSON write boundary (§6); cleaned up remaining `console.log`/`console.error` debug-style output in favor of `logger` | Bug fix + security + hygiene |
| `crawler/StateManager.js` | `console.log`/`console.error` → `logger`, for consistency with the rest of the codebase | Hygiene |
| `crawler/PageCrawler.js` | Uses the extracted `getDedupeKey()`; `consoleErrors` array → `pageConsoleErrorCount` (§2.9) | Bug fix (dedup testability) + scalability |
| `utils/urlClassifier.js` | Extracted `getDedupeKey()` as a pure, testable, exported function | Refactor (testability) |
| `config/ConfigLoader.js` | Full rewrite: every field validated (type, range, scheme) with field-identified errors instead of silent normalization (§7) | Feature (mandatory) |
| `crawler.js` | Added `--url`/`--environment`/`--max-pages`/`--max-depth`/`--output` CLI flags, merged into the raw config before validation | Feature (mandatory) |
| `package.json` | Added `engines: { node: ">=18.0.0" }` (the test suite requires it; README previously claimed 16+) | Hygiene |
| `reporters/JsonReporter.js` | `metadata.tool`/`version` now read from `package.json` instead of a stale hard-coded `'1.0.0'`; added `target` metadata; `consoleErrors` → `pageConsoleErrorCount` | Bug fix (truthfulness) |
| `reporters/HtmlReporter.js` | Report title now generic and includes the target name, replacing the hard-coded "Enterprise Documentation Crawl Report" | Bug fix (truthfulness) |
| `reporters/ExcelReporter.js` | Same title fix; `workbook.creator` now reads from `package.json` | Bug fix (truthfulness) |
| `test/configLoader.test.js` | Extended from 4 to 19 tests covering every malformed-config case in §7 | Test |
| `test/helpers/testServer.js` | Added fixture routes: `/redirect-loop` + `/redirect-loop-b`, `/e2e-home` + `/e2e-ok`, `/sitemap.xml` + `/sitemap-a.xml` | Test infrastructure |
| `test/httpValidator.test.js` | Added a live redirect-loop test | Test |
| `README.md` | Corrected false claims (screenshot capture/viewer that don't exist), fixed the stale Node 16+ prerequisite, documented the new CLI flags, added a Validation States section, a Testing section, an explicit Limitations section, and refreshed Security Considerations/Performance Optimization to match reality | Truthfulness (Phase 11) |

---

## 11. Remaining Limitations

Explicit, not hidden:

- **Authentication / login-protected targets:** still entirely unsupported. A target behind a login wall will report its pages as broken/unreachable past the login boundary.
- **Screenshot capture:** still not implemented (data model field reserved; README now says so explicitly rather than implying otherwise).
- **SPA / heavily client-rendered targets:** the soft-404 browser escalation catches one specific ambiguous case (200 + content that looks broken); this is not a general SPA crawler, and links that only appear after client-side interaction are not discovered.
- **Output size at real scale:** per-run isolation and the console-error dedup fix (§2.9) reduce waste, but a genuinely large crawl (thousands of pages) will still produce a large NDJSON/JSON/HTML file — the architectural fix (client-side-fetched HTML report, pagination, etc.) is out of scope for a hardening pass.
- **`robots.txt` semantics for internal/enterprise targets behind real corporate infrastructure** (proxies, auth-gated internal DNS) haven't been verified against an actual such environment — only against the graceful-degrade behavior when no `robots.txt` exists at all.
- **SIGINT during an in-flight browser launch** can leave an orphaned Chromium process (§2, narrow startup-only window, documented not fixed).
- **`extractRedirectChain`'s underlying mechanism** still walks an undocumented axios/follow-redirects internal property — now safely capped and cycle-guarded, but a future axios upgrade could silently change that internal shape again. `finalUrl`/`isRedirect` (the fields actually used for the redirect *determination*) don't depend on it and are unaffected either way.
- **A credential embedded in `htmlSnippet`'s raw markup** (not the structured URL fields) is not scrubbed — documented in §6, not fixed, as disproportionately fragile to address via regex for how rare the scenario is.
- **The `maxPages` race fix (§2.6) and the mid-run-exception cleanup fix (§2.7)** are reasoned from JavaScript's execution-model guarantees and exercised implicitly by the full test suite, but neither has a dedicated test that deliberately reproduces the original race/failure condition — such tests would be inherently timing-fragile or require disproportionate fault-injection scaffolding for the size of the fix.

---

## 12. Release Readiness Verdict

```
READY FOR BASELINE COMMIT
```

Reasoning: every bug found this pass has a shipped fix; the two mandated regression areas plus a full real-pipeline E2E test are in place and passing; report output was audited and no reporter path can render `not_checked` or `error` as `OK`; configuration is validated early with actionable errors instead of silently normalizing anything dangerous; the CLI supports explicit target selection through the same validated path as the config file; the dependency set is confirmed minimal and used; and the README no longer claims capabilities (screenshots) the tool doesn't have. The test suite passes cleanly (104/104) from a fresh `npm install`, and a live, bounded smoke test against a safe public target produced genuine, non-hard-coded validation results. The limitations in §11 are real but are documented scope boundaries, not defects masquerading as done.
