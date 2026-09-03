const ExcelJS = require('exceljs');
const fs = require('fs-extra');
const path = require('path');
const packageJson = require('../package.json');

class ExcelReporter {
  constructor(config) {
    this.config = config;
  }

  async generate(results, metrics) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = packageJson.name;
    workbook.created = new Date();

    // Create sheets
    await this.createSummarySheet(workbook, metrics, results);
    await this.createAllLinksSheet(workbook, results);
    await this.createBrokenLinksSheet(workbook, results);
    await this.createRedirectsSheet(workbook, results);
    await this.createSoft404sSheet(workbook, results);
    await this.createExternalLinksSheet(workbook, results);
    await this.createNotCheckedSheet(workbook, results);
    await this.createPerformanceSheet(workbook, results, metrics);

    // Save workbook
    const reportPath = path.join(this.config.outputDirectory, 'report.xlsx');
    await workbook.xlsx.writeFile(reportPath);

    console.log(`Excel report generated: ${reportPath}`);
  }

  async createSummarySheet(workbook, metrics, results = []) {
    const sheet = workbook.addWorksheet('Summary');

    // Summary metrics
    const title = this.config.targetName ? `Validation Report — ${this.config.targetName}` : 'Web Validation Crawl Report';
    sheet.addRow([title]);
    sheet.addRow([]);
    sheet.addRow(['Metric', 'Value']);
    sheet.addRow(['Pages Crawled', metrics.crawledPages]);
    sheet.addRow(['Links Discovered', metrics.discoveredLinks]);
    sheet.addRow(['Broken Links', metrics.brokenLinks]);
    sheet.addRow(['Redirects', metrics.redirects]);
    sheet.addRow(['Soft 404s (links)', metrics.soft404s]);
    sheet.addRow(['Soft 404s (crawled pages)', metrics.pageSoft404s || 0]);
    sheet.addRow(['Not Checked Links', metrics.notCheckedLinks != null ? metrics.notCheckedLinks : results.filter(r => r.validationStatus === 'not_checked').length]);
    sheet.addRow(['Failed Pages', metrics.failedPages]);
    sheet.addRow(['Start Time', new Date(metrics.startTime).toLocaleString()]);
    sheet.addRow(['End Time', metrics.endTime ? new Date(metrics.endTime).toLocaleString() : 'In Progress']);
    sheet.addRow(['Duration (seconds)', (metrics.duration / 1000).toFixed(1)]);

    // Configuration
    sheet.addRow([]);
    sheet.addRow(['Configuration']);
    sheet.addRow(['Max Depth', this.config.maxDepth]);
    sheet.addRow(['Max Pages', this.config.maxPages]);
    sheet.addRow(['Concurrency', this.config.concurrency]);
    sheet.addRow(['Timeout (ms)', this.config.timeout]);
    sheet.addRow(['Retry Count', this.config.retryCount]);
    sheet.addRow(['Crawl Delay (ms)', this.config.crawlDelay]);

    // Style the sheet
    sheet.getCell('A1').font = { size: 16, bold: true };
    sheet.getColumn('A').width = 25;
    sheet.getColumn('B').width = 15;
  }

  async createAllLinksSheet(workbook, results) {
    const sheet = workbook.addWorksheet('All Links');
    this.addLinksSheetHeaders(sheet);
    this.addLinksSheetData(sheet, results);
  }

  async createBrokenLinksSheet(workbook, results) {
    const brokenLinks = results.filter(r => r.isBroken);
    const sheet = workbook.addWorksheet('Broken Links');
    this.addLinksSheetHeaders(sheet);
    this.addLinksSheetData(sheet, brokenLinks);
  }

  async createRedirectsSheet(workbook, results) {
    const redirects = results.filter(r => r.isRedirect);
    const sheet = workbook.addWorksheet('Redirects');
    this.addLinksSheetHeaders(sheet);
    this.addLinksSheetData(sheet, redirects);
  }

  async createSoft404sSheet(workbook, results) {
    const soft404s = results.filter(r => r.isSoft404);
    const sheet = workbook.addWorksheet('Soft 404s');
    this.addLinksSheetHeaders(sheet);
    this.addLinksSheetData(sheet, soft404s);
  }

  async createExternalLinksSheet(workbook, results) {
    const externalLinks = results.filter(r => !r.isInternal);
    const sheet = workbook.addWorksheet('External Links');
    this.addLinksSheetHeaders(sheet);
    this.addLinksSheetData(sheet, externalLinks);
  }

  async createNotCheckedSheet(workbook, results) {
    const notChecked = results.filter(r => r.validationStatus === 'not_checked');
    const sheet = workbook.addWorksheet('Not Checked');
    this.addLinksSheetHeaders(sheet);
    this.addLinksSheetData(sheet, notChecked);
  }

  async createPerformanceSheet(workbook, results, metrics) {
    const sheet = workbook.addWorksheet('Performance');

    sheet.addRow(['Performance Metrics']);
    sheet.addRow([]);
    sheet.addRow(['Metric', 'Value']);
    sheet.addRow(['Total Response Time (ms)', results.reduce((sum, r) => sum + (r.responseTime || 0), 0)]);
    sheet.addRow(['Average Response Time (ms)', results.length > 0 ? (results.reduce((sum, r) => sum + (r.responseTime || 0), 0) / results.length).toFixed(2) : 0]);
    sheet.addRow(['Min Response Time (ms)', Math.min(...results.map(r => r.responseTime || Infinity).filter(t => t !== Infinity))]);
    sheet.addRow(['Max Response Time (ms)', Math.max(...results.map(r => r.responseTime || 0))]);
    sheet.addRow(['Timeouts', results.filter(r => r.errorMessage && r.errorMessage.includes('timeout')).length]);
    sheet.addRow(['DNS Failures', results.filter(r => r.errorMessage && r.errorMessage.includes('DNS')).length]);
    sheet.addRow(['SSL Failures', results.filter(r => r.errorMessage && r.errorMessage.includes('SSL')).length]);

    // Response time distribution
    sheet.addRow([]);
    sheet.addRow(['Response Time Distribution']);
    sheet.addRow(['Range (ms)', 'Count']);
    const ranges = [
      [0, 100], [100, 500], [500, 1000], [1000, 2000], [2000, 5000], [5000, Infinity]
    ];

    ranges.forEach(([min, max]) => {
      const count = results.filter(r => {
        const time = r.responseTime || 0;
        return time >= min && (max === Infinity ? true : time < max);
      }).length;
      const label = max === Infinity ? `${min}+ ms` : `${min}-${max} ms`;
      sheet.addRow([label, count]);
    });

    sheet.getColumn('A').width = 25;
    sheet.getColumn('B').width = 15;
  }

  addLinksSheetHeaders(sheet) {
    const headers = [
      'Source Page',
      'Target URL',
      'Link Text',
      'Link Type',
      'URL Category',
      'Status Code',
      'Result',
      'Validation Method',
      'Error Type',
      'Final URL',
      'Redirect Chain',
      'Depth',
      'Response Time (ms)',
      'Retry Attempts',
      'Error Message',
      'Screenshot Path',
      'First Seen Timestamp'
    ];

    sheet.addRow(headers);

    // Style headers
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE6E6FA' }
    };

    // Set column widths
    sheet.columns = headers.map(header => ({ width: 20 }));
    sheet.getColumn(1).width = 40; // Source Page
    sheet.getColumn(2).width = 40; // Target URL
    sheet.getColumn(10).width = 40; // Final URL
    sheet.getColumn(11).width = 50; // Redirect Chain
  }

  // "Result" never collapses "not checked" into "OK" — see
  // docs/ENGINEERING_REPORT.md, Principle 4 (never represent "not validated" as "valid").
  resultLabel(link) {
    switch (link.validationStatus) {
      case 'not_checked': return 'Not Checked';
      case 'broken': return 'Broken';
      case 'redirect': return 'Redirect';
      case 'soft404': return 'Soft 404';
      case 'error': return 'Validation Error';
      case 'valid': return 'OK';
      default: return 'Unknown';
    }
  }

  addLinksSheetData(sheet, links) {
    links.forEach(link => {
      const statusCode = link.statusCode || '';

      sheet.addRow([
        link.sourcePage,
        link.targetUrl,
        link.linkText || '',
        link.linkType,
        link.urlCategory || '',
        statusCode,
        this.resultLabel(link),
        link.validationMethod || 'none',
        link.errorType || '',
        link.finalUrl || '',
        link.redirectChain ? link.redirectChain.join(' -> ') : '',
        link.depth,
        link.responseTime || '',
        link.retryAttempts || 0,
        link.errorMessage || '',
        link.screenshotPath || '',
        new Date().toISOString()
      ]);
    });

    // Add conditional formatting for broken links (column G = "Result")
    const lastRow = sheet.rowCount;
    if (lastRow > 1) {
      sheet.addConditionalFormatting({
        ref: `G2:G${lastRow}`,
        rules: [
          {
            type: 'containsText',
            operator: 'containsText',
            text: 'Broken',
            style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCCCC' } } }
          }
        ]
      });
    }
  }
}

module.exports = ExcelReporter;