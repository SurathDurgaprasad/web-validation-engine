const fs = require('fs-extra');
const path = require('path');
const packageJson = require('../package.json');

class JsonReporter {
  constructor(config) {
    this.config = config;
  }

  async generate(results, metrics) {
    const reportData = {
      metadata: {
        generatedAt: new Date().toISOString(),
        tool: packageJson.name,
        version: packageJson.version,
        target: {
          name: this.config.targetName,
          environment: this.config.targetEnvironment,
          baseUrl: this.config.targetBaseUrl
        }
      },
      configuration: this.config,
      metrics: {
        ...metrics,
        duration: metrics.endTime ? (metrics.endTime - metrics.startTime) / 1000 : null
      },
      results: results.map(link => ({
        sourcePage: link.sourcePage,
        targetUrl: link.targetUrl,
        normalizedTarget: link.normalizedTarget,
        linkText: link.linkText,
        linkType: link.linkType,
        selector: link.selector,
        htmlSnippet: link.htmlSnippet,
        urlScheme: link.urlScheme,
        urlCategory: link.urlCategory,
        validationMethod: link.validationMethod,
        validationStatus: link.validationStatus,
        statusCode: link.statusCode,
        responseTime: link.responseTime,
        finalUrl: link.finalUrl,
        redirectChain: link.redirectChain,
        errorType: link.errorType,
        errorMessage: link.errorMessage,
        retryAttempts: link.retryAttempts,
        screenshotPath: link.screenshotPath,
        isBroken: link.isBroken,
        isRedirect: link.isRedirect,
        isSoft404: link.isSoft404,
        isInternal: link.isInternal,
        depth: link.depth,
        pageConsoleErrorCount: link.pageConsoleErrorCount,
        browserValidation: link.browserValidation,
        timestamp: new Date().toISOString()
      }))
    };

    const reportPath = path.join(this.config.outputDirectory, 'report.json');
    await fs.writeJson(reportPath, reportData, { spaces: 2 });

    console.log(`JSON report generated: ${reportPath}`);
  }
}

module.exports = JsonReporter;