const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

class StateManager {
  constructor(config) {
    this.config = config;
    this.visited = new Set();
    this.stateFile = path.join(this.config.stateDirectory || './state', 'crawl-state.json');
  }

  async load() {
    // Only load if explicitly configured to resume
    if (this.config.resumePreviousCrawl === true) {
      try {
        if (await fs.pathExists(this.stateFile)) {
          const data = await fs.readJson(this.stateFile);
          this.visited = new Set(data.visited || []);
          logger.info(`Loaded previous crawl state with ${this.visited.size} visited URLs`);
        }
      } catch (error) {
        logger.error('Failed to load state: ' + error.message);
        this.visited = new Set();
      }
    } else {
      // Start fresh crawl
      this.visited = new Set();
    }
  }

  async save() {
    try {
      const data = {
        visited: Array.from(this.visited),
        lastUpdated: new Date().toISOString()
      };
      await fs.writeJson(this.stateFile, data, { spaces: 2 });
    } catch (error) {
      // Log error but don't fail the crawl
      logger.error('Failed to save crawl state: ' + error.message);
    }
  }

  hasVisited(url) {
    return this.visited.has(url);
  }

  markVisited(url) {
    this.visited.add(url);
    // Save state periodically (every 100 visits)
    if (this.visited.size % 100 === 0) {
      this.save();
    }
  }

  getVisitedCount() {
    return this.visited.size;
  }

  async finalize() {
    await this.save();
  }
}

module.exports = StateManager;