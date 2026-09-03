const axios = require('axios');
const xml2js = require('xml2js');
const { isInternalUrl } = require('../utils/urlUtils');

class SitemapParser {
  constructor(config) {
    this.config = config;
  }

  async parse(baseUrl) {
    const urls = [];

    try {
      // Try common sitemap locations
      const sitemapUrls = [
        `${baseUrl}/sitemap.xml`,
        `${baseUrl}/sitemap_index.xml`,
        `${baseUrl}/sitemap/sitemap.xml`
      ];

      for (const sitemapUrl of sitemapUrls) {
        try {
          const response = await axios.get(sitemapUrl, {
            timeout: 10000,
            headers: {
              'User-Agent': 'Enterprise Doc Validator/1.0'
            }
          });

          if (response.status === 200) {
            // `visited` both prevents infinite recursion on a cyclic
            // sitemap-index (A references B, B references A) and caps
            // total sub-sitemap fetches for a pathologically wide index.
            const parsedUrls = await this.parseSitemapXml(response.data, new Set());
            urls.push(...parsedUrls);

            // If we found a sitemap, break
            break;
          }
        } catch (error) {
          // Continue to next sitemap URL
          continue;
        }
      }

      // Filter to internal URLs only
      return urls.filter(url => isInternalUrl(url, this.config.allowedDomains));
    } catch (error) {
      console.warn(`Failed to parse sitemap for ${baseUrl}: ${error.message}`);
      return [];
    }
  }

  static MAX_SITEMAPS_PER_INDEX = 50;

  /**
   * Fetches and parses one sub-sitemap referenced by a sitemap index, by
   * its actual URL — not by re-running parse()'s "guess common locations"
   * logic on it (that previously built a nonsensical URL like
   * ".../sitemap-index.xml/sitemap.xml", so a sitemap index's sub-sitemaps
   * were never actually read).
   */
  async fetchSubSitemap(sitemapUrl, visited) {
    if (visited.has(sitemapUrl) || visited.size >= SitemapParser.MAX_SITEMAPS_PER_INDEX) {
      return [];
    }
    visited.add(sitemapUrl);

    try {
      const response = await axios.get(sitemapUrl, {
        timeout: 10000,
        headers: { 'User-Agent': 'Enterprise Doc Validator/1.0' }
      });
      if (response.status !== 200) return [];
      return await this.parseSitemapXml(response.data, visited);
    } catch (error) {
      console.warn(`Failed to fetch sub-sitemap ${sitemapUrl}: ${error.message}`);
      return [];
    }
  }

  async parseSitemapXml(xmlContent, visited) {
    try {
      const parser = new xml2js.Parser();
      const result = await parser.parseStringPromise(xmlContent);

      const urls = [];

      // Handle sitemap index
      if (result.sitemapindex && Array.isArray(result.sitemapindex.sitemap)) {
        for (const sitemap of result.sitemapindex.sitemap) {
          const sitemapUrl = sitemap.loc && sitemap.loc[0];
          if (!sitemapUrl) continue;
          const subUrls = await this.fetchSubSitemap(sitemapUrl, visited);
          urls.push(...subUrls);
        }
      }

      // Handle regular sitemap
      if (result.urlset && Array.isArray(result.urlset.url)) {
        for (const url of result.urlset.url) {
          if (url.loc && url.loc[0]) {
            urls.push(url.loc[0]);
          }
        }
      }

      return urls;
    } catch (error) {
      console.warn(`Failed to parse sitemap XML: ${error.message}`);
      return [];
    }
  }

  async discoverSitemaps(baseUrl) {
    try {
      // Check robots.txt for sitemap references
      const robotsUrl = `${baseUrl}/robots.txt`;
      const response = await axios.get(robotsUrl, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Enterprise Doc Validator/1.0'
        }
      });

      if (response.status === 200) {
        const sitemaps = this.extractSitemapsFromRobots(response.data);
        return sitemaps;
      }
    } catch (error) {
      // Robots.txt not found or not accessible
    }

    return [];
  }

  extractSitemapsFromRobots(robotsContent) {
    const sitemaps = [];
    const lines = robotsContent.split('\n');

    for (const line of lines) {
      const sitemapMatch = line.match(/^sitemap:\s*(.+)$/i);
      if (sitemapMatch) {
        sitemaps.push(sitemapMatch[1].trim());
      }
    }

    return sitemaps;
  }
}

module.exports = SitemapParser;