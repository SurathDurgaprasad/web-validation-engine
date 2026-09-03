const fs = require('fs-extra');
const path = require('path');

class HtmlReporter {
  constructor(config) {
    this.config = config;
    this.templateDir = path.join(__dirname, 'templates');
  }

  async generate(results, metrics) {
    const reportPath = path.join(this.config.outputDirectory, 'report.html');
    const html = await this.generateHtml(results, metrics);

    await fs.writeFile(reportPath, html, 'utf8');

    console.log(`HTML report generated: ${reportPath}`);
  }

  async generateHtml(results, metrics) {
    const templateHtml = await this.loadTemplate('dashboard.html', () => this.getTemplateHtml());
    const styles = await this.loadTemplate('dashboard.css', () => this.getCss());
    const script = await this.loadTemplate('dashboard.js', () => this.getJavaScript());
    const body = this.generateBody(results, metrics);

    return templateHtml
      .replace('{{styles}}', styles)
      .replace('{{script}}', script)
      .replace('{{body}}', body);
  }

  async loadTemplate(fileName, fallback) {
    const templatePath = path.join(this.templateDir, fileName);
    if (await fs.pathExists(templatePath)) {
      return fs.readFile(templatePath, 'utf8');
    }
    return fallback();
  }

  getTemplateHtml() {
    const title = this.reportTitle();
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>{{styles}}</style>
</head>
<body>
    <div class="container">
        {{body}}
    </div>
    <script>{{script}}</script>
</body>
</html>`;
  }

  reportTitle() {
    return this.config.targetName
      ? `Validation Report — ${this.config.targetName}`
      : 'Web Validation Crawl Report';
  }

  generateBody(results, metrics) {
    const brokenLinks = results.filter(r => r.isBroken);
    const redirects = results.filter(r => r.isRedirect);
    const soft404s = results.filter(r => r.isSoft404);
    const externalLinks = results.filter(r => !r.isInternal);
    const notChecked = results.filter(r => r.validationStatus === 'not_checked');

    const duration = metrics.duration / 1000;

    return `
        <header>
            <h1>${this.reportTitle()}</h1>
            <div class="summary">
                <div class="metric">
                    <span class="value">${metrics.crawledPages}</span>
                    <span class="label">Pages Crawled</span>
                </div>
                <div class="metric">
                    <span class="value">${metrics.discoveredLinks}</span>
                    <span class="label">Links Found</span>
                </div>
                <div class="metric error">
                    <span class="value">${metrics.brokenLinks}</span>
                    <span class="label">Broken Links</span>
                </div>
                <div class="metric warning">
                    <span class="value">${metrics.redirects}</span>
                    <span class="label">Redirects</span>
                </div>
                <div class="metric warning">
                    <span class="value">${metrics.soft404s}</span>
                    <span class="label">Soft 404s</span>
                </div>
                <div class="metric">
                    <span class="value">${metrics.notCheckedLinks || 0}</span>
                    <span class="label">Not Checked</span>
                </div>
                <div class="metric">
                    <span class="value">${duration.toFixed(1)}s</span>
                    <span class="label">Duration</span>
                </div>
            </div>
        </header>

        <nav class="tabs">
            <button class="tab-button active" onclick="showTab('overview')">Overview</button>
            <button class="tab-button" onclick="showTab('broken')">Broken Links (${brokenLinks.length})</button>
            <button class="tab-button" onclick="showTab('redirects')">Redirects (${redirects.length})</button>
            <button class="tab-button" onclick="showTab('soft404s')">Soft 404s (${soft404s.length})</button>
            <button class="tab-button" onclick="showTab('external')">External Links (${externalLinks.length})</button>
            <button class="tab-button" onclick="showTab('notChecked')">Not Checked (${notChecked.length})</button>
            <button class="tab-button" onclick="showTab('all')">All Links (${results.length})</button>
        </nav>

        <div id="overview" class="tab-content active">
            ${this.generateOverviewTab(results, metrics)}
        </div>

        <div id="broken" class="tab-content">
            ${this.generateLinksTable(brokenLinks, 'broken')}
        </div>

        <div id="redirects" class="tab-content">
            ${this.generateLinksTable(redirects, 'redirect')}
        </div>

        <div id="soft404s" class="tab-content">
            ${this.generateLinksTable(soft404s, 'soft404')}
        </div>

        <div id="external" class="tab-content">
            ${this.generateLinksTable(externalLinks, 'external')}
        </div>

        <div id="notChecked" class="tab-content">
            ${this.generateLinksTable(notChecked, 'notChecked')}
        </div>

        <div id="all" class="tab-content">
            ${this.generateLinksTable(results, 'all')}
        </div>
    `;
  }

  generateOverviewTab(results, metrics) {
    // Group by source page
    const bySource = {};
    results.forEach(link => {
      if (!bySource[link.sourcePage]) {
        bySource[link.sourcePage] = { total: 0, broken: 0, redirects: 0, soft404s: 0 };
      }
      bySource[link.sourcePage].total++;
      if (link.isBroken) bySource[link.sourcePage].broken++;
      if (link.isRedirect) bySource[link.sourcePage].redirects++;
      if (link.isSoft404) bySource[link.sourcePage].soft404s++;
    });

    const sourceRows = Object.entries(bySource)
      .sort((a, b) => b[1].broken - a[1].broken)
      .slice(0, 20)
      .map(([url, stats]) => `
        <tr>
            <td><a href="${url}" target="_blank">${url}</a></td>
            <td>${stats.total}</td>
            <td class="error">${stats.broken}</td>
            <td class="warning">${stats.redirects}</td>
            <td class="warning">${stats.soft404s}</td>
        </tr>
      `).join('');

    return `
        <div class="overview-section">
            <h2>Crawl Summary</h2>
            <p>Started: ${new Date(metrics.startTime).toLocaleString()}</p>
            <p>Completed: ${metrics.endTime ? new Date(metrics.endTime).toLocaleString() : 'In Progress'}</p>
            <p>Configuration: Max Depth ${this.config.maxDepth}, Concurrency ${this.config.concurrency}, Timeout ${this.config.timeout}ms</p>
        </div>

        <div class="overview-section">
            <h2>Pages with Most Issues</h2>
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Source Page</th>
                        <th>Total Links</th>
                        <th>Broken</th>
                        <th>Redirects</th>
                        <th>Soft 404s</th>
                    </tr>
                </thead>
                <tbody>
                    ${sourceRows}
                </tbody>
            </table>
        </div>
    `;
  }

  // Never collapse "not checked" into "OK" — a link this tool didn't
  // actually validate must not read the same as one it confirmed working.
  getStatusInfo(link) {
    switch (link.validationStatus) {
      case 'not_checked':
        return { cssClass: 'not-checked', label: 'Not Checked' };
      case 'broken':
        return { cssClass: 'error', label: link.statusCode ? `Broken (${link.statusCode})` : 'Broken' };
      case 'redirect':
        return { cssClass: 'warning', label: link.statusCode ? `Redirect (${link.statusCode})` : 'Redirect' };
      case 'soft404':
        return { cssClass: 'warning', label: 'Soft 404' };
      case 'error':
        return { cssClass: 'error', label: 'Validation Error' };
      case 'valid':
        return { cssClass: 'success', label: link.statusCode ? String(link.statusCode) : 'OK' };
      default:
        return { cssClass: 'not-checked', label: 'Unknown' };
    }
  }

  generateLinksTable(links, type) {
    const rows = links.map(link => {
      const status = this.getStatusInfo(link);

      return `
        <tr>
            <td><a href="${link.sourcePage}" target="_blank">${this.truncateUrl(link.sourcePage)}</a></td>
            <td><a href="${link.targetUrl}" target="_blank">${this.truncateUrl(link.targetUrl)}</a></td>
            <td>${link.linkText || ''}</td>
            <td>${link.linkType}</td>
            <td>${link.urlCategory || ''}</td>
            <td class="${status.cssClass}">${status.label}</td>
            <td>${link.validationMethod || 'none'}</td>
            <td>${link.responseTime || ''}ms</td>
            <td>${link.depth}</td>
            <td>${link.errorMessage || ''}</td>
        </tr>
      `;
    }).join('');

    return `
        <table class="data-table">
            <thead>
                <tr>
                    <th>Source Page</th>
                    <th>Target URL</th>
                    <th>Link Text</th>
                    <th>Type</th>
                    <th>Category</th>
                    <th>Status</th>
                    <th>Method</th>
                    <th>Response Time</th>
                    <th>Depth</th>
                    <th>Detail</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
    `;
  }

  truncateUrl(url) {
    if (url.length <= 60) return url;
    return url.substring(0, 57) + '...';
  }

  getCss() {
    return `
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
            background: #f5f5f5;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            box-shadow: 0 0 20px rgba(0,0,0,0.1);
        }

        header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 2rem;
            text-align: center;
        }

        h1 {
            margin-bottom: 2rem;
            font-size: 2.5rem;
        }

        .summary {
            display: flex;
            justify-content: center;
            gap: 2rem;
            flex-wrap: wrap;
        }

        .metric {
            text-align: center;
            padding: 1rem;
            background: rgba(255,255,255,0.1);
            border-radius: 8px;
            min-width: 120px;
        }

        .metric .value {
            display: block;
            font-size: 2rem;
            font-weight: bold;
        }

        .metric .label {
            display: block;
            font-size: 0.9rem;
            opacity: 0.9;
        }

        .metric.error {
            background: rgba(220,53,69,0.1);
            border: 1px solid rgba(220,53,69,0.3);
        }

        .metric.warning {
            background: rgba(255,193,7,0.1);
            border: 1px solid rgba(255,193,7,0.3);
        }

        .tabs {
            display: flex;
            background: #f8f9fa;
            border-bottom: 1px solid #dee2e6;
        }

        .tab-button {
            padding: 1rem 1.5rem;
            border: none;
            background: none;
            cursor: pointer;
            font-size: 1rem;
            border-bottom: 3px solid transparent;
            transition: all 0.3s;
        }

        .tab-button.active {
            background: white;
            border-bottom-color: #667eea;
            color: #667eea;
        }

        .tab-button:hover {
            background: #e9ecef;
        }

        .tab-content {
            display: none;
            padding: 2rem;
        }

        .tab-content.active {
            display: block;
        }

        .overview-section {
            margin-bottom: 3rem;
        }

        .overview-section h2 {
            margin-bottom: 1rem;
            color: #495057;
            border-bottom: 2px solid #667eea;
            padding-bottom: 0.5rem;
        }

        .data-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 1rem;
        }

        .data-table th,
        .data-table td {
            padding: 0.75rem;
            text-align: left;
            border-bottom: 1px solid #dee2e6;
        }

        .data-table th {
            background: #f8f9fa;
            font-weight: 600;
            position: sticky;
            top: 0;
        }

        .data-table tr:hover {
            background: #f8f9fa;
        }

        .data-table a {
            color: #667eea;
            text-decoration: none;
        }

        .data-table a:hover {
            text-decoration: underline;
        }

        .success { color: #28a745; }
        .error { color: #dc3545; font-weight: bold; }
        .warning { color: #ffc107; font-weight: bold; }
        .not-checked { color: #6c757d; font-style: italic; }

        @media (max-width: 768px) {
            .summary {
                flex-direction: column;
                align-items: center;
            }

            .metric {
                width: 100%;
                max-width: 300px;
            }

            .tabs {
                flex-wrap: wrap;
            }

            .tab-button {
                flex: 1;
                min-width: 120px;
            }

            .data-table {
                font-size: 0.9rem;
            }

            .data-table th,
            .data-table td {
                padding: 0.5rem;
            }
        }
    `;
  }

  getJavaScript() {
    return `
        function showTab(tabName) {
            // Hide all tabs
            const tabs = document.querySelectorAll('.tab-content');
            tabs.forEach(tab => tab.classList.remove('active'));

            // Remove active class from buttons
            const buttons = document.querySelectorAll('.tab-button');
            buttons.forEach(button => button.classList.remove('active'));

            // Show selected tab
            document.getElementById(tabName).classList.add('active');

            // Add active class to clicked button
            event.target.classList.add('active');
        }

        // Initialize with overview tab
        document.addEventListener('DOMContentLoaded', function() {
            showTab('overview');
        });
    `;
  }
}

module.exports = HtmlReporter;