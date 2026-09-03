class AnchorValidator {
  constructor(config) {
    this.config = config;
  }

  async validate(page, url) {
    try {
      // Find all anchor links with href="#..."
      const anchors = await page.$$('a[href^="#"]');

      const results = [];

      for (const anchor of anchors) {
        // Declared outside the try block (and before any awaits that can
        // throw) so the catch block can report which href it failed on
        // instead of throwing a ReferenceError of its own.
        let href = null;
        try {
          href = await anchor.getAttribute('href');
          const text = await anchor.textContent();

          if (!href || href === '#') continue;

          // Remove the # prefix to get the target ID
          const targetId = href.substring(1);

          // Check if the target element exists. A malformed id (spaces,
          // leading digits combined with CSS-special characters, etc.) will
          // make this selector invalid and throw — that's caught below and
          // reported as a validation error rather than crashing the crawl.
          const targetElement = await page.$(`#${targetId}`);

          const exists = targetElement !== null;

          results.push({
            anchorHref: href,
            targetId,
            linkText: (text || '').trim(),
            targetExists: exists,
            isBroken: !exists,
            status: exists ? 'valid' : 'missing'
          });
        } catch (error) {
          results.push({
            anchorHref: href,
            targetId: null,
            linkText: '',
            targetExists: false,
            isBroken: true,
            status: 'error',
            error: error.message
          });
        }
      }

      return {
        totalAnchors: results.length,
        brokenAnchors: results.filter(r => r.isBroken).length,
        results
      };
    } catch (error) {
      return {
        totalAnchors: 0,
        brokenAnchors: 0,
        results: [],
        error: error.message
      };
    }
  }
}

module.exports = AnchorValidator;