const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const ExcelJS = require('exceljs');
const HtmlReporter = require('../reporters/HtmlReporter');
const ExcelReporter = require('../reporters/ExcelReporter');
const JsonReporter = require('../reporters/JsonReporter');

// One synthetic entry per canonical validation state. The mission-critical
// invariant: a reporter must never render "not_checked" or "error" (or a
// null status code) as "OK" / "Valid" / "Healthy" — that would misrepresent
// an unvalidated or failed check as a successful one.
function buildSyntheticResults() {
  const base = {
    sourcePage: 'https://example.com/',
    linkText: 'link',
    linkType: 'content',
    urlScheme: 'https',
    isInternal: true,
    depth: 0,
    pageConsoleErrorCount: 0,
    browserValidation: null,
    retryAttempts: 0,
    screenshotPath: '',
    redirectChain: null
  };

  return [
    { ...base, targetUrl: 'https://example.com/valid-marker', normalizedTarget: 'https://example.com/valid-marker', urlCategory: 'internal', validationMethod: 'http', validationStatus: 'valid', statusCode: 200, isBroken: false, isRedirect: false, isSoft404: false, errorType: null, errorMessage: null, responseTime: 50 },
    { ...base, targetUrl: 'https://example.com/broken-marker', normalizedTarget: 'https://example.com/broken-marker', urlCategory: 'internal', validationMethod: 'http', validationStatus: 'broken', statusCode: 404, isBroken: true, isRedirect: false, isSoft404: false, errorType: null, errorMessage: 'Not Found', responseTime: 40 },
    { ...base, targetUrl: 'https://example.com/redirect-marker', normalizedTarget: 'https://example.com/redirect-marker', urlCategory: 'external', validationMethod: 'http', validationStatus: 'redirect', statusCode: 200, isBroken: false, isRedirect: true, isSoft404: false, errorType: null, errorMessage: null, finalUrl: 'https://example.com/final', responseTime: 60 },
    { ...base, targetUrl: 'https://example.com/soft404-marker', normalizedTarget: 'https://example.com/soft404-marker', urlCategory: 'internal', validationMethod: 'http', validationStatus: 'soft404', statusCode: 200, isBroken: false, isRedirect: false, isSoft404: true, errorType: null, errorMessage: null, responseTime: 70 },
    { ...base, targetUrl: 'mailto:someone-marker@example.com', normalizedTarget: 'mailto:someone-marker@example.com', urlScheme: 'mailto', urlCategory: 'ignored', isInternal: false, validationMethod: 'none', validationStatus: 'not_checked', statusCode: null, isBroken: false, isRedirect: false, isSoft404: false, errorType: null, errorMessage: null, responseTime: null },
    { ...base, targetUrl: 'https://example.com/error-marker', normalizedTarget: 'https://example.com/error-marker', urlCategory: 'internal', validationMethod: 'browser', validationStatus: 'error', statusCode: null, isBroken: false, isRedirect: false, isSoft404: false, errorType: 'browser-escalation-failed', errorMessage: 'Browser escalation failed: context closed', responseTime: null }
  ];
}

const metrics = {
  startTime: Date.now() - 1000,
  endTime: Date.now(),
  duration: 1000,
  crawledPages: 1,
  discoveredLinks: 6,
  brokenLinks: 1,
  redirects: 1,
  soft404s: 1,
  pageSoft404s: 0,
  notCheckedLinks: 1,
  failedPages: 0,
  totalAnchors: 0,
  brokenAnchors: 0
};

const FORBIDDEN_LABELS = ['OK', 'Valid', 'Healthy'];

test('Report consistency — not_checked/error/null must never render as OK/Valid/Healthy', async (t) => {
  const results = buildSyntheticResults();
  const outputDirectory = path.join(os.tmpdir(), `report-consistency-test-${Date.now()}`);
  await fs.ensureDir(outputDirectory);
  const config = { outputDirectory, targetName: 'Test Target' };

  t.after(async () => {
    await fs.remove(outputDirectory);
  });

  await t.test('JsonReporter preserves validationStatus verbatim for every canonical state', async () => {
    await new JsonReporter(config).generate(results, metrics);
    const report = await fs.readJson(path.join(outputDirectory, 'report.json'));

    const byMarker = (marker) => report.results.find(r => r.targetUrl.includes(marker));

    assert.equal(byMarker('valid-marker').validationStatus, 'valid');
    assert.equal(byMarker('broken-marker').validationStatus, 'broken');
    assert.equal(byMarker('redirect-marker').validationStatus, 'redirect');
    assert.equal(byMarker('soft404-marker').validationStatus, 'soft404');
    assert.equal(byMarker('someone-marker').validationStatus, 'not_checked');
    assert.equal(byMarker('error-marker').validationStatus, 'error');

    assert.equal(report.metadata.version, require('../package.json').version, 'report version should reflect the actual package, not a stale hard-coded string');
  });

  await t.test('ExcelReporter never labels a not_checked or error row as OK', async () => {
    await new ExcelReporter(config).generate(results, metrics);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(outputDirectory, 'report.xlsx'));
    const sheet = workbook.getWorksheet('All Links');

    const headerRow = sheet.getRow(1).values; // 1-indexed, values[0] is undefined
    const targetCol = headerRow.indexOf('Target URL');
    const resultCol = headerRow.indexOf('Result');

    const rowFor = (marker) => {
      for (let i = 2; i <= sheet.rowCount; i++) {
        const row = sheet.getRow(i);
        if (String(row.getCell(targetCol).value).includes(marker)) return row;
      }
      throw new Error(`No row found for marker ${marker}`);
    };

    const notCheckedResult = String(rowFor('someone-marker').getCell(resultCol).value);
    const errorResult = String(rowFor('error-marker').getCell(resultCol).value);
    const validResult = String(rowFor('valid-marker').getCell(resultCol).value);
    const brokenResult = String(rowFor('broken-marker').getCell(resultCol).value);

    assert.equal(notCheckedResult, 'Not Checked');
    assert.equal(errorResult, 'Validation Error');
    assert.equal(validResult, 'OK');
    assert.equal(brokenResult, 'Broken');

    for (const forbidden of FORBIDDEN_LABELS) {
      assert.notEqual(notCheckedResult, forbidden, `not_checked row must not read "${forbidden}"`);
      assert.notEqual(errorResult, forbidden, `error row must not read "${forbidden}"`);
    }
  });

  await t.test('HtmlReporter never renders a not_checked or error row with the "OK" label', async () => {
    await new HtmlReporter(config).generate(results, metrics);
    const html = await fs.readFile(path.join(outputDirectory, 'report.html'), 'utf8');

    const rowContaining = (marker) => {
      const rows = html.split('<tr>');
      const row = rows.find(r => r.includes(marker));
      if (!row) throw new Error(`No HTML row found for marker ${marker}`);
      return row;
    };

    const notCheckedRow = rowContaining('someone-marker');
    const errorRow = rowContaining('error-marker');
    const validRow = rowContaining('valid-marker');

    assert.ok(notCheckedRow.includes('Not Checked'), 'not_checked row should say "Not Checked"');
    assert.ok(!/>OK</.test(notCheckedRow), 'not_checked row must not render ">OK<"');

    assert.ok(errorRow.includes('Validation Error'), 'error row should say "Validation Error"');
    assert.ok(!/>OK</.test(errorRow), 'error row must not render ">OK<"');

    assert.ok(/>200</.test(validRow) || validRow.includes('OK'), 'valid row should show a real status');

    assert.ok(html.includes('Not Checked (1)'), 'summary tab count should reflect the one not_checked link');
  });
});
