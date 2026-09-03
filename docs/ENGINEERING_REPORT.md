# ENGINEERING_REPORT.md

**Date:** 2026-09-02
**Scope:** Generalize the crawler away from a single hard-coded target, integrate the disconnected validation layer, and put the truthfulness/scale/hygiene fixes from `PROJECT_AUDIT.md` in place.
**Constraint honored throughout:** smallest correct set of changes — no rewrite, no new abstractions beyond what the mission required, no database/Docker/cloud/LLM/web UI added.

---

## 1. Repository Assessment (before this work)

Confirmed against source, not just against `PROJECT_AUDIT.md`'s claims (the audit's core findings all checked out; several *additional* issues turned up during integration — see §3.1 and §4):

- Crawling, DOM link extraction, sitemap/robots handling, NDJSON persistence, and all three reporters were real, working code, proven by a genuine 565-page/25,859-link historical crawl of `docs.eggplantsoftware.com` sitting in `output/`.
- The validation layer (`HttpValidator`, `BrowserValidator`, `AnchorValidator`, `RetryManager`) was fully written but **never called** from `PageCrawler.crawl()`. Every link record was hard-coded `statusCode: null, isBroken: false, isRedirect: false, isSoft404: false`.
- `Soft404Detector.detect()` was called against the *current page's own content* but the result was assigned to a local variable and discarded.
- The target (`docs.eggplantsoftware.com`) was baked directly into `config/config.json`, which doubled as both "the only config" and "the thing `npm run crawl` runs by default."
- No `.gitignore`, no tests, two unused dependencies (`cheerio`, `chalk`), `results.ndjson` opened in append mode across runs, `AnchorValidator`'s catch block referenced an undeclared variable.

## 2. Product Generalization

**Target-specific assumptions found and removed:**

| Where | Before | After |
|---|---|---|
| `config/config.json` | Hard-coded `seedUrls: ["https://docs.eggplantsoftware.com/epf/", ...]`, `allowedDomains: ["docs.eggplantsoftware.com"]` — this was both the default file *and* the only config format | Generic nested schema (`target` / `crawl` / `validation` / `scope` / `reporting`); default target is `https://example.com/` (IANA's reserved documentation/example domain) with a tiny `maxPages: 5` — safe to run out of the box, targets nothing real |
| `crawler.js` | Read the raw JSON file directly into `CrawlManager` | Now passes the raw file through `config/ConfigLoader.js`, which is the single place that knows how to turn a target definition into the internal config shape |
| Eggplant Software | Was the *only* config that existed | Preserved as `config/examples/eggplant-docs.historical.config.json` — explicitly labeled historical/reference, not run by any default script, not referenced anywhere in `crawler/`, `validators/`, `extractors/`, `reporters/`, or `utils/` |
| Environment concept | Didn't exist | `target.environment` (e.g. `"staging"`, `"production"`, `"public"`) is carried as metadata into `run-manifest.json` and the reports; nothing in the crawl/validation engine branches on it. `config/examples/internal-staging.config.json` demonstrates a non-public target (`respectRobotsTxt: false`, an internal domain) |
| Network reachability | N/A | Explicitly the runtime's responsibility — the tool has no VPN/auth/network logic of its own; this is stated in the example configs and in §7 below |

I grepped the entire non-`node_modules` tree for `eggplant`/`Eggplant` after the change — the only matches are in `PROJECT_AUDIT.md` (historical document, left untouched), `config/examples/eggplant-docs.historical.config.json`, and this report. Nothing in `crawler/`, `validators/`, `extractors/`, `reporters/`, or `utils/` references it.

**Backward compatibility:** `ConfigLoader.load()` still accepts the old flat config shape (no `target` key) with a console warning — an old config file doesn't hard-fail, it just isn't the recommended format anymore.

## 3. Validation Pipeline — actual final runtime flow

```
Target URL (config/ConfigLoader.js → CrawlManager)
   │
   ▼
Playwright navigation (PageCrawler.crawl) — one page.goto, console-error capture
   │
   ├─▶ Soft404Detector.detect(pageContent) ─────────────▶ pageIsSoft404 (page-level metadata,
   │                                                        NOT attached to every outbound link —
   │                                                        see §3.2)
   │
   ├─▶ LinkExtractor.extract() + extractOtherLinks() ──▶ raw <a>/button/img links
   │
   ├─▶ AnchorValidator.validate(page, url)  ───────────▶  ONE page-level scan of all
   │      (bug-fixed: href no longer referenced            `a[href^="#"]` elements, reused for
   │       before assignment in the catch path)             every "#section" link found below
   │
   ▼
For each extracted link → utils/urlClassifier.classifyUrl(target, sourceUrl, config)
   │
   ├── category "anchor"      → resolved from the ONE AnchorValidator pass above
   │                             (valid / missing / error) — never HTTP-fetched
   ├── category "ignored"     → mailto:/tel:/sms: — validationStatus "not_checked"
   ├── category "unsupported" → javascript:/data:/file:/blob:/unparsable —
   │                             validationStatus "not_checked", errorType "unsupported-scheme"
   │                             — NEVER handed to axios or page.goto()
   └── category "internal"/"external" (http/https only)
          │
          ▼
    LinkValidationService.validateBatch() — p-limit-bounded concurrency
          │
          ▼
    HttpValidator.validate() — GET for internal (with body, for soft-404 check),
                                HEAD for external (no body)
          │
          ├── result inspected for transience (429 / 5xx / timeout / connection-reset / network)
          │        │
          │        ├── transient → retry via RetryManager.getBackoffDelay() + delay(),
          │        │                up to validation.retryCount attempts
          │        └── not transient (incl. a real 404/403) → no retry, one attempt stands
          │
          ▼
    real statusCode / isBroken / isRedirect / redirectChain / errorType / errorMessage /
    isSoft404 (internal GET only) / validationMethod:"http" / validationStatus
          │
          ▼
    Escalation check: internal AND statusCode===200 AND isSoft404 AND
                       validation.browserFallback enabled?
          │ yes                                              │ no
          ▼                                                  ▼
    BrowserValidator.validate(page, url) — real page,   validationMethod stays "http",
    real pageerror/console/DOM-error-indicator check      validationStatus stands as computed
          │
          ▼
    Browser result is the tie-breaker: confirms broken or clears the
    static match as a false positive → validationMethod:"browser"
          │
          ▼
Result aggregation (CrawlManager.processPage — metrics, crawl-queue for
                     category==="internal" links only)
          │
          ▼
NDJSON (per-run directory, see §7) → HTML / Excel / JSON reports
```

### 3.1 Decisions made explicit (per the mission's request to document them, not just implement them)

- **Escalation policy (deliberately narrow):** browser validation only runs for links that are internal, came back HTTP 200, and whose already-fetched body matched the static soft-404 heuristic. A definitive 404/500 is never re-checked in a browser — it's already known. This bounds browser launches to genuinely ambiguous cases instead of "every link," which the mission explicitly ruled out as unscalable.
- **Soft-404 scope (deliberately not "attach the source page's result to every link"):** soft-404 status is computed for (a) every crawled page itself (`pageIsSoft404`, page-level metric `pageSoft404s`), and (b) every *internal* link target during HTTP validation, because `HttpValidator`'s internal GET already fetches the full body — reusing it costs nothing extra. It is **not** computed for external links (HEAD-only, no body — checking a third party's content isn't this tool's job) or for mailto/tel/anchor links (nothing was fetched).
- **Anchor validation is page-level, not per-link:** one `AnchorValidator.validate(page, url)` call per crawled page populates a `targetId → result` map; every `#section`-style link discovered on that page is resolved against that map instead of re-scanning the DOM per link.
- **RetryManager integration:** `HttpValidator.validate()` deliberately never throws (it converts every failure into a structured result) — which is *why* `RetryManager.executeWithRetry()`/`isNonRetryableError()` (both exception-driven) had never been wired to it. Rather than restructure `HttpValidator` to throw (bigger diff, more risk), `LinkValidationService` classifies transience from the structured result (`HttpValidator`'s new `errorType` field + status code) and reuses `RetryManager.getBackoffDelay()`/`delay()` for the actual backoff — genuine reuse of the existing file's config and backoff math, not a parallel reimplementation, without forcing an exception-based control flow onto a class that was deliberately designed not to throw.
- **Truthfulness (Principle 4):** every reporter (`HtmlReporter`, `ExcelReporter`, `JsonReporter`) was checked against "does an unchecked link ever render the same as a checked-and-valid one?" — it did, in both `HtmlReporter` and `ExcelReporter` (`link.statusCode || 'OK'` was the fallback for a `null` status code, which is exactly what an unchecked link has). Both were fixed to key off the new explicit `validationStatus` field, with `not_checked` rendered distinctly (grey/italic, its own report tab/sheet), never as `OK`.

### 3.2 Two bugs found during integration that the audit didn't catch (found by actually running the code, not just reading it)

1. **`HttpValidator.extractRedirectChain()` — silent data loss via `RangeError: Invalid string length`.** This method walks an undocumented internal axios/follow-redirects property (`_redirectable._currentRequest`). Under the axios version currently installed (never exercised before, since nothing called `HttpValidator`), that walk does not terminate the way the original author expected — it built a **134-million-element array** for an ordinary non-redirected request before `JSON.stringify` finally threw. `CrawlManager`'s NDJSON writer had a bare `catch (e) { /* ignore */ }` around that `JSON.stringify` call, which silently dropped the entire link record with zero trace. Both were fixed: `extractRedirectChain` now has a hard 20-hop cap and a seen-set/self-reference guard; the NDJSON write failure is now logged instead of swallowed (see `crawler/CrawlManager.js`).
2. **Per-page link dedup collided distinct anchor targets.** `PageCrawler` deduped discovered links by `normalizeUrl()`'s output, which strips URL fragments by design (that's correct for crawl-queue dedup). Applied to two different `#section` links on the same page, both normalize to the same bare page URL, so only the first anchor link on any page was ever recorded — every other in-page anchor silently vanished before validation even ran. Fixed by deduping anchor-category links on their exact (fragment-preserving) target instead of the fragment-stripped normalized URL.

Both were caught only because I ran the real pipeline against a controlled local fixture (§6) instead of trusting that "the code reads correctly." Both are now covered indirectly by the anchor and redirect-chain assertions in the controlled verification run, though not yet by a dedicated automated regression test (see §7).

## 4. Files Modified

### New files

| File | Why | Type |
|---|---|---|
| `config/ConfigLoader.js` | Single place that turns a generic `target`/`crawl`/`validation`/`scope`/`reporting` config into the internal flat shape the rest of the app already expected — this is what makes the target generic without touching every consumer | Architectural |
| `config/examples/eggplant-docs.historical.config.json` | Preserves the real, audited historical target as a labeled example, not a default | Architectural (product generalization) |
| `config/examples/internal-staging.config.json` | Demonstrates a non-public/internal target with `environment` metadata and `respectRobotsTxt: false` | Feature (documentation) |
| `utils/urlClassifier.js` | Central place classifying a discovered link as internal/external/anchor/ignored/unsupported before anything is fetched — Phase 3's safety requirement | Feature / bug fix (prevents javascript:/data:/file:/blob: from ever reaching HTTP or browser validation) |
| `crawler/LinkValidationService.js` | Owns HTTP validation + retry decision + the bounded browser-escalation policy, shared once per crawl (not re-created per page) | Feature (the core validation integration) |
| `utils/runId.js` | Timestamped run-id generator for output isolation | Feature |
| `.gitignore` | Repository hygiene | Hygiene |
| `test/**` (7 files) | Minimal automated coverage — see §5 | Test |
| `ENGINEERING_REPORT.md` | This document | Docs |

### Modified files

| File | What changed | Why | Type |
|---|---|---|---|
| `crawler.js` | Routes the raw config file through `ConfigLoader.load()` | Generic config | Architectural |
| `crawler/CrawlManager.js` | Per-run output directory (`output/runs/<timestamp>/`), `run-manifest.json`, wires `LinkValidationService` once per crawl, conditional reporter execution based on `reporting.*` flags, `pageSoft404s`/`notCheckedLinks` metric recording, `stateDirectory` is now actually created (was silently never `ensureDir`'d — see §3.2 analog, found via the same live-run testing), NDJSON write failures now logged instead of silently swallowed, replaced ad-hoc `console.log`/`console.error` debug output with `logger` | Feature (run isolation) + bug fixes + hygiene | Architectural, bug fix |
| `crawler/PageCrawler.js` | Full integration: page-level anchor scan, per-link classification, fragment-aware dedup, routes classified links to anchor-resolution / unfetchable-marking / `LinkValidationService` | This is where validation actually gets wired in | Feature (the audit's #1 finding, resolved) |
| `validators/HttpValidator.js` | Added `errorType` classification (replaces string-matching), added soft-404 detection reusing the already-fetched internal-GET body, fixed `isRedirect` detection (was checking `status>=300&&<400`, which axios's auto-follow makes almost always false — now compares final URL vs requested URL), fixed `extractRedirectChain` runaway (§3.2) | Feature integration + 2 real bug fixes | Feature, bug fix |
| `validators/AnchorValidator.js` | `href` now declared before the `try` block so the `catch` path can report which anchor failed instead of throwing its own `ReferenceError`; added explicit `status` (`valid`/`missing`/`error`) | Audit-flagged bug fix | Bug fix |
| `validators/BrowserValidator.js` | Replaced the no-op `jsErrors` stub (`page.evaluate` returning an always-empty array) with a real `pageerror` event listener | Audit-flagged incomplete implementation, now genuinely implemented | Bug fix |
| `utils/retry.js` | Extracted the inline backoff formula into `getBackoffDelay(attempt)` so `LinkValidationService` can reuse it without duplicating the constant | Enables real integration | Refactor (additive, no behavior change to existing methods) |
| `utils/metrics.js` | Added `pageSoft404s`, `notCheckedLinks` counters/recorders | Truthful reporting needs a way to count "not checked" | Feature |
| `utils/constants.js` | `DEFAULT_CONFIG` extended with validation/reporting defaults, now actually consumed by `ConfigLoader` (previously unused anywhere) | Generic config defaults | Feature |
| `reporters/JsonReporter.js` | Added `urlScheme`, `urlCategory`, `validationMethod`, `validationStatus`, `errorType`, `retryAttempts` to the (explicit, whitelisted) per-link output | Without this, the new fields would be silently dropped from the JSON report | Bug fix (data loss) |
| `reporters/HtmlReporter.js` | Status label logic keyed off `validationStatus` instead of falling back to `'OK'` for an unchecked link's `null` status code; added a "Not Checked" tab, Category/Method/Detail columns, a `.not-checked` style, a "Not Checked" summary tile | Principle 4 (truthful reporting) — this was a real "not validated" ≡ "OK" bug | Bug fix |
| `reporters/ExcelReporter.js` | Same truthful-status fix for the "Result" column (was `link.isBroken ? 'Broken' : ... : 'OK'`, same bug as HTML), added URL Category/Validation Method/Error Type/Retry Attempts columns, a "Not Checked" sheet, "Soft 404s (pages)"/"Not Checked Links" summary rows, fixed the conditional-formatting cell reference (shifted from column F to G after the new columns were inserted) | Same as above | Bug fix |
| `package.json` | Removed `cheerio`/`chalk` (confirmed unused via repo-wide grep, then `npm install` to prune 24 packages from `node_modules`/lockfile), added `test` script (`node --test`) and `crawl:example:eggplant`, version bump to 2.0.0 | Hygiene | Hygiene |
| `config/config.json` | Replaced the hard-coded Eggplant target with a safe generic default (`https://example.com/`, `maxPages: 5`) in the new nested schema | Product generalization | Architectural |

## 5. Tests Added

Zero new dependencies — Node's built-in `node:test` + `node:assert/strict`, and a ~70-line local `http.createServer` fixture (`test/helpers/testServer.js`) instead of a mocking library. `npm test` runs `node --test`, auto-discovering everything under `test/`.

| File | Covers |
|---|---|
| `test/httpValidator.test.js` | 200 (real status, not a default), 404 (broken with real code), a genuine redirect detected via final-URL comparison (regression test for the `isRedirect` bug), soft-404 content on a 200, a real network timeout classified as `errorType: "timeout"` |
| `test/linkValidationService.test.js` | Retries a transient 503 to a successful 200 and records `retryAttempts`, does **not** retry a deterministic 404, retry fully skipped when `validation.retry` is disabled |
| `test/urlClassifier.test.js` | http/https (internal + external), mailto, tel, javascript, data, file, blob, an unresolvable/relative string, a same-document fragment (→ "anchor"), a fragment link to a *different* page (→ not an anchor) |
| `test/anchorValidator.test.js` | Existing target (valid), missing target (broken), a thrown DOM error caught and reported rather than crashing (direct regression test for the audit's reference-before-assignment bug), `href="#"` alone is skipped rather than counted |
| `test/soft404Detector.test.js` | A normal substantial page (not flagged), known soft-404 keyword content (flagged), very short content (flagged), non-string content (not flagged, not a false positive) |
| `test/configLoader.test.js` | Missing `target.baseUrl` rejected, full nested-schema normalization, `scope.allowedDomains` override, legacy flat-schema backward compatibility |

**Explicitly not covered by automated tests** (documented rather than silently left out):
- `PageCrawler`'s full integration (Playwright navigation + all the classification/routing logic together) — verified manually against a real Playwright browser and a local fixture site instead (§6), not automated, because that would require bundling Playwright browser launches into the test suite (slow, and this mission's Phase 5 explicitly asked for a *minimal* foundation, not full coverage).
- `BrowserValidator` itself — exercised transitively during the manual fixture verification (§6) but has no dedicated unit test, since mocking a Playwright `Page` well enough to be meaningful is significant effort for a validator that mission Phase 2 explicitly said to keep narrowly-scoped.
- The two bugs found in §3.2 (redirect-chain runaway, anchor-dedup collision) are exercised by the manual fixture run in §6 but do not yet have dedicated regression tests in `test/` — flagged here rather than silently left undone.

## 6. Verification

All commands run from the repository root. Full output was reviewed, not just exit codes.

```bash
npm test
```
**Result:** 38/38 passing (`ℹ tests 38`, `ℹ pass 38`, `ℹ fail 0`).

```bash
node -e "require('./crawler/CrawlManager')"   # and 13 other modified/new files
```
**Result:** every touched module loads without a syntax/require error (`crawler.js` itself was excluded from this particular check because it's a self-executing CLI entry point — requiring it runs a live crawl).

```bash
npx playwright install chromium
```
**Result:** the machine's cached Chromium build (revision 1234) did not match what the installed `playwright` package (1.60.0) expects (revision 1223) — a pre-existing environment mismatch, unrelated to this refactor. Installed the correct build so a live browser-driven crawl could actually be run and verified, not just assumed to work.

```bash
node crawler.js --config=config/config.json
```
A real, bounded crawl of `https://example.com/` (`maxDepth: 1, maxPages: 5` — IANA's domain reserved for documentation/examples, one page, no risk of hammering anything real). **Result:** completed in ~13s. The single outbound link (`https://iana.org/domains/example`) was validated and correctly recorded as a genuine redirect:
```json
{
  "targetUrl": "https://iana.org/domains/example",
  "validationMethod": "http",
  "validationStatus": "redirect",
  "statusCode": 200,
  "finalUrl": "http://www.iana.org/help/example-domains",
  "isRedirect": true,
  "retryAttempts": 1
}
```
This is a concrete, live proof the `isRedirect` fix works — axios auto-follows the redirect and returns a terminal `200`, which is exactly the case the *original* status-code-based check would have missed.

A second, more thorough controlled run against a **local fixture** (`http.createServer`, not any real site) exercised every remaining code path in one pass — internal HTTP link, soft-404 page, valid anchor, broken anchor, mailto, tel, javascript: link:
```
/page2            → internal, http,    valid,  200
/soft404-page     → internal, browser, broken, 200 (soft-404 caught by HTTP layer,
                                                      escalated to BrowserValidator,
                                                      confirmed broken)
/#section1        → anchor,   anchor,  valid
/#no-such-section → anchor,   anchor,  broken (errorType: "missing-anchor")
mailto:...        → ignored,  none,    not_checked
tel:...           → ignored,  none,    not_checked
javascript:...    → unsupported, none, not_checked (errorType: "unsupported-scheme")
```
This run is what surfaced and confirmed the fix for both bugs in §3.2 — the redirect-chain runaway and the anchor-dedup collision were both found here, fixed, and this exact run was repeated afterward to confirm 7/7 expected link records now appear (previously only 4/7 did).

Report output was also spot-checked directly: `report.html`'s "Not Checked (3)" and "Broken Links (2)" tab counts matched the fixture data exactly, and the table renders `Not Checked` (not `OK`) for the mailto/tel/javascript rows.

**Not run:** a live crawl of `docs.eggplantsoftware.com`, per the mission's explicit instruction not to hammer that third-party site. `config/examples/eggplant-docs.historical.config.json` is ready for the user to run manually and deliberately when they choose to.

## 7. Remaining Limitations

Explicitly unresolved, in the mission's requested order:

- **Browser validation scale:** bounded by the escalation policy (§3.1) and a `p-limit`-based `validationConcurrency` (default 5), but escalation still opens a new Playwright page per triggered link, serially awaited per page's batch. A target with many genuinely soft-404-looking pages could still be slow; there's no global cap on total browser escalations per run.
- **Screenshot capture:** still not implemented, per the mission's explicit instruction not to build it in this pass. The data model (`screenshotPath`) and report columns still exist for it.
- **Output size:** run isolation (this pass) stops runs from silently merging, but the underlying per-link payload size (full `htmlSnippet`, full `consoleErrors`, full `redirectChain`) is unchanged from the audit's finding — a large crawl will still produce a large NDJSON/JSON/HTML file. Not addressed here per the mission's explicit "do not perform output optimization unless necessary for correctness" instruction.
- **Authentication:** none. `HttpValidator`/`BrowserValidator`/Playwright navigation carry no cookies, tokens, or login flow — a target behind auth will report every page as broken/unreachable past the login wall. Out of scope for this pass; would need explicit config (headers, storage state, or a login step) to support.
- **SPA / heavily JS-rendered behavior:** partially addressed — the soft-404 escalation to `BrowserValidator` exists specifically for "server says 200, content might be client-rendered and broken." It is not a general SPA-routing crawler; links that only appear after client-side interaction (not present in the initial DOM) will not be discovered.
- **`robots.txt` semantics for internal/enterprise targets:** `crawl.respectRobotsTxt` is configurable per target (see `config/examples/internal-staging.config.json`, which disables it), but there's no special handling for internal targets that don't serve a `robots.txt` at all (that already degrades gracefully — `RobotsManager.loadForUrl` catches the fetch failure and treats everything as allowed — but this hasn't been verified against a real internal target with corporate auth/proxy in front of it).
- **Login-protected applications:** same as authentication above — not supported in this pass.
- **`extractRedirectChain`'s internal-axios walk (§3.2):** the fix (hop cap + cycle guard) makes it *safe*, but it's still walking an undocumented axios property. It could silently stop producing a meaningfully accurate chain on a future axios upgrade. `finalUrl` and `isRedirect` (used for the actual redirect determination) do not depend on this and are unaffected.
- **The two bugs in §3.2 have no dedicated regression tests yet** — verified by manual controlled runs (§6), not by anything in `test/`.

## 8. Git Status

**There is no `.git` directory in this repository** (confirmed via `git rev-parse --is-inside-work-tree` → `fatal: not a git repository`, consistent with `PROJECT_AUDIT.md`'s original finding — this was never under version control). No commits exist to diff against, so a conventional `git status`/`git diff --stat` isn't available. I did not run `git init` on my own initiative since that wasn't asked for.

Full manifest of everything touched this session, in place of a diff:

**New files (20):**
```
config/ConfigLoader.js
config/examples/eggplant-docs.historical.config.json
config/examples/internal-staging.config.json
crawler/LinkValidationService.js
utils/runId.js
utils/urlClassifier.js
.gitignore
ENGINEERING_REPORT.md
test/helpers/testServer.js
test/httpValidator.test.js
test/linkValidationService.test.js
test/urlClassifier.test.js
test/anchorValidator.test.js
test/soft404Detector.test.js
test/configLoader.test.js
```

**Modified files (14):**
```
crawler.js
crawler/CrawlManager.js
crawler/PageCrawler.js
validators/HttpValidator.js
validators/AnchorValidator.js
validators/BrowserValidator.js
utils/retry.js
utils/metrics.js
utils/constants.js
reporters/JsonReporter.js
reporters/HtmlReporter.js
reporters/ExcelReporter.js
package.json
package-lock.json (auto-updated by `npm install` after removing cheerio/chalk)
config/config.json
```

**Untouched (deliberately — working code, no reason to change):** `crawler/BrowserManager.js`, `crawler/QueueManager.js`, `crawler/StateManager.js`, `extractors/LinkExtractor.js`, `extractors/DomClassifier.js`, `extractors/SitemapParser.js`, `utils/urlUtils.js`, `utils/robotsManager.js`, `utils/fileUtils.js`, `utils/logger.js`, `reporters/templates/*`, `README.md`, `PROJECT_AUDIT.md`.

**Not deleted:** the historical `output/`, `state/`, `logs/`, `screenshots/` artifacts from the original Eggplant crawl were left exactly as found, per the mission's explicit instruction not to remove existing output artifacts without explicit intent. A `state-fixture-verify/` directory and an `output/runs/` entry created by this session's controlled verification runs (§6) were removed as they were scratch outputs of this session's own testing, not pre-existing project state.

If the user wants this under version control going forward, `git init` plus an initial commit is a one-line ask away — left undone here since it wasn't part of the mission as scoped.
