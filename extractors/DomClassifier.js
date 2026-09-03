class DomClassifier {
  static async classify(element) {
    try {
      return await element.evaluate(el => {
        // Check for header
        if (el.closest('header, [role="banner"]')) {
          return 'header';
        }

        // Check for footer
        if (el.closest('footer, [role="contentinfo"]')) {
          return 'footer';
        }

        // Check for sidebar
        if (el.closest('aside, .sidebar, #sidebar, [role="complementary"]')) {
          return 'sidebar';
        }

        // Check for breadcrumb
        if (el.closest('.breadcrumb, .breadcrumbs, [aria-label*="breadcrumb"]')) {
          return 'breadcrumb';
        }

        // Check for navigation
        if (el.closest('nav, [role="navigation"], .nav, .navigation, .menu')) {
          return 'navigation';
        }

        // Check for table of contents
        if (el.closest('.toc, .table-of-contents, #toc')) {
          return 'toc';
        }

        // Check for previous/next navigation
        if (el.closest('.pagination, .pager') ||
            el.textContent.toLowerCase().includes('previous') ||
            el.textContent.toLowerCase().includes('next')) {
          return 'pagination';
        }

        // Check for version selector
        if (el.closest('.version-selector, .version-picker') ||
            el.textContent.toLowerCase().includes('version')) {
          return 'version-selector';
        }

        // Check if in main content
        if (el.closest('main, [role="main"], .content, .main-content, article')) {
          return 'content';
        }

        // Default to content
        return 'content';
      });
    } catch (error) {
      return 'unknown';
    }
  }
}

module.exports = DomClassifier;