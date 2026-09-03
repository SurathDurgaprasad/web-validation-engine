const axios = require('axios');
const { URL } = require('url');

class RobotsManager {
  constructor(config) {
    this.config = config;
    this.rules = new Map();
  }

  async loadForUrl(url) {
    try {
      const parsed = new URL(url);
      const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;
      const response = await axios.get(robotsUrl, {
        timeout: 10000,
        headers: { 'User-Agent': 'Enterprise Doc Validator/1.0' }
      });

      if (response.status !== 200 || !response.data) {
        return;
      }

      const rules = this.parse(response.data);
      this.rules.set(parsed.host, rules);
    } catch (error) {
      // Robots file may not exist or be accessible; keep crawling defaults
    }
  }

  parse(content) {
    const lines = content.split(/\r?\n/);
    const rules = {
      disallow: [],
      allow: [],
      sitemaps: []
    };
    let currentUserAgent = null;

    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const [key, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      const normalizedKey = key.trim().toLowerCase();

      if (normalizedKey === 'user-agent') {
        currentUserAgent = value.toLowerCase();
        continue;
      }

      if (normalizedKey === 'disallow' && currentUserAgent === '*') {
        rules.disallow.push(value);
        continue;
      }

      if (normalizedKey === 'allow' && currentUserAgent === '*') {
        rules.allow.push(value);
        continue;
      }

      if (normalizedKey === 'sitemap') {
        rules.sitemaps.push(value);
      }
    }

    return rules;
  }

  isAllowed(url) {
    try {
      const parsed = new URL(url);
      const hostRules = this.rules.get(parsed.host);
      if (!hostRules) {
        return true;
      }

      const path = parsed.pathname || '/';
      const isAllowedByAllowRule = hostRules.allow.some(rule => path.startsWith(rule));
      if (isAllowedByAllowRule) {
        return true;
      }

      const isDisallowed = hostRules.disallow.some(rule => {
        if (!rule) return false;
        return path.startsWith(rule);
      });

      return !isDisallowed;
    } catch (error) {
      return false;
    }
  }
}

module.exports = RobotsManager;
