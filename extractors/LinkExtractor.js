const DomClassifier = require('./DomClassifier');

class LinkExtractor {
  constructor(config) {
    this.config = config;
  }

  async extract(page, sourceUrl, depth) {
    const links = [];
    const maxLinksPerPage = this.config.maxLinksPerPage || 500;

    // Extract all anchor tags
    const anchors = await page.$$('a[href]');

    for (let i = 0; i < Math.min(anchors.length, maxLinksPerPage); i++) {
      const anchor = anchors[i];
      try {
        const href = await anchor.getAttribute('href');
        const text = await anchor.textContent();
        const ariaLabel = await anchor.getAttribute('aria-label');
        const title = await anchor.getAttribute('title');

        if (!href) continue;

        // Resolve relative URLs
        const absoluteUrl = new URL(href, sourceUrl).href;

        // Skip excluded paths
        if (this.isExcludedPath(absoluteUrl)) continue;

        // Get DOM location info
        const boundingBox = await anchor.boundingBox();
        const selector = await this.getSelector(anchor);
        const htmlSnippet = await this.getHtmlSnippet(anchor);

        // Classify link location
        const linkType = await DomClassifier.classify(anchor);

        links.push({
          target: absoluteUrl,
          text: text.trim(),
          ariaLabel: ariaLabel || '',
          title: title || '',
          type: linkType,
          selector,
          htmlSnippet,
          boundingBox
        });

        if (links.length >= maxLinksPerPage) break;
      } catch (error) {
        // Skip malformed links
        continue;
      }
    }

    return links;
  }

  async extractOtherLinks(page, sourceUrl) {
    const links = [];

    // Extract button links (if they have click handlers or data-href)
    const buttons = await page.$$('button[data-href], button[onclick]');
    for (const button of buttons) {
      try {
        const dataHref = await button.getAttribute('data-href');
        const onclick = await button.getAttribute('onclick');
        const text = await button.textContent();

        let href = null;
        if (dataHref) {
          href = dataHref;
        } else if (onclick && onclick.includes('location.href')) {
          // Simple onclick location.href extraction
          const match = onclick.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
          if (match) href = match[1];
        }

        if (href) {
          const absoluteUrl = new URL(href, sourceUrl).href;
          if (!this.isExcludedPath(absoluteUrl)) {
            const selector = await this.getSelector(button);
            const htmlSnippet = await this.getHtmlSnippet(button);

            links.push({
              target: absoluteUrl,
              text: text.trim(),
              ariaLabel: '',
              title: '',
              type: 'button',
              selector,
              htmlSnippet,
              boundingBox: await button.boundingBox()
            });
          }
        }
      } catch (error) {
        continue;
      }
    }

    // Extract image links
    const images = await page.$$('img[onclick], a img');
    for (const img of images) {
      try {
        const src = await img.getAttribute('src');
        const alt = await img.getAttribute('alt');
        const title = await img.getAttribute('title');

        if (src) {
          const absoluteUrl = new URL(src, sourceUrl).href;
          if (!this.isExcludedPath(absoluteUrl)) {
            const selector = await this.getSelector(img);
            const htmlSnippet = await this.getHtmlSnippet(img);

            links.push({
              target: absoluteUrl,
              text: alt || title || 'Image',
              ariaLabel: '',
              title: title || '',
              type: 'image',
              selector,
              htmlSnippet,
              boundingBox: await img.boundingBox()
            });
          }
        }
      } catch (error) {
        continue;
      }
    }

    return links;
  }

  async getSelector(element) {
    try {
      return await element.evaluate(el => {
        const getSelector = (element) => {
          if (element.id) return `#${element.id}`;
          if (element.className) return `.${element.className.split(' ').join('.')}`;
          if (element.name) return `[name="${element.name}"]`;

          let selector = element.tagName.toLowerCase();
          if (element.className) {
            selector += `.${element.className.split(' ').join('.')}`;
          }

          // Add nth-child if needed
          const siblings = Array.from(element.parentNode?.children || []);
          const index = siblings.indexOf(element);
          if (index > 0) {
            selector += `:nth-child(${index + 1})`;
          }

          return selector;
        };

        return getSelector(el);
      });
    } catch (error) {
      return '';
    }
  }

  async getHtmlSnippet(element) {
    try {
      return await element.evaluate(el => {
        const clone = el.cloneNode(true);
        // Remove script and style content
        const scripts = clone.querySelectorAll('script, style');
        scripts.forEach(script => script.remove());

        return clone.outerHTML.substring(0, 200); // Limit length
      });
    } catch (error) {
      return '';
    }
  }

  isExcludedPath(url) {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;

      return this.config.excludedPaths.some(excluded => path.includes(excluded));
    } catch (error) {
      return false;
    }
  }
}

module.exports = LinkExtractor;