class Soft404Detector {
  static detect(content, keywords) {
    if (!content || typeof content !== 'string') {
      return false;
    }

    const lowerContent = content.toLowerCase();

    // Check for configured keywords
    for (const keyword of keywords) {
      if (lowerContent.includes(keyword.toLowerCase())) {
        return true;
      }
    }

    // Check for common soft 404 patterns
    const soft404Patterns = [
      'page not found',
      'content not available',
      'this page doesn\'t exist',
      'the page you\'re looking for',
      '404 error',
      'page unavailable',
      'content has been moved',
      'no longer available',
      'resource not found',
      'document not found'
    ];

    for (const pattern of soft404Patterns) {
      if (lowerContent.includes(pattern)) {
        return true;
      }
    }

    // Check for very short content (might indicate error page)
    if (content.trim().length < 500) {
      return true;
    }

    // Check for lack of main content indicators
    const contentIndicators = ['<h1', '<h2', '<p>', '<article', '<main'];
    const hasContentIndicators = contentIndicators.some(indicator =>
      lowerContent.includes(indicator.toLowerCase())
    );

    if (!hasContentIndicators) {
      return true;
    }

    return false;
  }

  static detectFromPage(page) {
    return page.evaluate((keywords) => {
      const content = document.body.textContent || '';
      const lowerContent = content.toLowerCase();

      // Check keywords
      for (const keyword of keywords) {
        if (lowerContent.includes(keyword.toLowerCase())) {
          return true;
        }
      }

      // Check for error indicators in DOM
      const errorSelectors = [
        '.error', '.not-found', '.404', '[class*="error"]',
        '[id*="error"]', '.page-not-found'
      ];

      for (const selector of errorSelectors) {
        if (document.querySelector(selector)) {
          return true;
        }
      }

      // Check title for error indicators
      const title = document.title.toLowerCase();
      if (title.includes('404') || title.includes('not found') || title.includes('error')) {
        return true;
      }

      return false;
    }, this.keywords);
  }
}

module.exports = Soft404Detector;