class BrowserValidator {
  constructor(config) {
    this.config = config;
  }

  async validate(page, url) {
    try {
      // Create a new page for validation to avoid interfering with current page
      const context = page.context();
      const validationPage = await context.newPage();

      try {
        const errors = [];
        const jsErrors = [];
        const requests = [];

        // Listen for console errors
        validationPage.on('console', msg => {
          if (msg.type() === 'error') {
            errors.push({
              type: 'console',
              message: msg.text(),
              location: msg.location()
            });
          }
        });

        // Listen for uncaught exceptions thrown by the page's own scripts.
        // (Playwright surfaces these as a real event — the previous
        // implementation here was a no-op that always returned zero errors.)
        validationPage.on('pageerror', err => {
          jsErrors.push({ message: err.message, stack: err.stack });
        });

        // Listen for failed requests
        validationPage.on('requestfailed', request => {
          requests.push({
            url: request.url(),
            method: request.method(),
            failure: request.failure()
          });
        });

        // Try to navigate to the URL
        const response = await validationPage.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: this.config.timeout
        });

        const statusCode = response ? response.status() : null;

        // Wait a bit for any dynamic content
        await validationPage.waitForTimeout(1000);

        // Check if the page actually loaded content
        const content = await validationPage.content();
        const hasContent = content.length > 100; // Basic check

        // Check for common error patterns in the DOM
        const errorIndicators = await validationPage.$$('[class*="error"], [id*="error"], .not-found, .404');

        const isBroken = !hasContent ||
                         (statusCode !== null && statusCode >= 400) ||
                         errors.length > 0 ||
                         jsErrors.length > 0 ||
                         errorIndicators.length > 0;

        return {
          statusCode,
          errors,
          failedRequests: requests,
          jsErrors,
          hasContent,
          isBroken,
          errorIndicators: errorIndicators.length
        };

      } finally {
        await validationPage.close();
      }

    } catch (error) {
      return {
        statusCode: null,
        errors: [{ type: 'navigation', message: error.message }],
        failedRequests: [],
        jsErrors: [],
        hasContent: false,
        isBroken: true,
        errorIndicators: 0
      };
    }
  }
}

module.exports = BrowserValidator;