class MetricsCollector {
  constructor() {
    this.reset();
  }

  reset() {
    this.startTime = Date.now();
    this.endTime = null;
    this.crawledPages = 0;
    this.discoveredLinks = 0;
    this.brokenLinks = 0;
    this.redirects = 0;
    this.soft404s = 0;
    this.pageSoft404s = 0;
    this.notCheckedLinks = 0;
    this.failedPages = 0;
    this.externalLinks = 0;
    this.internalLinks = 0;
    this.responseTimes = [];
    this.errors = [];
    this.totalAnchors = 0;
    this.brokenAnchors = 0;
  }

  recordPageCrawled() {
    this.crawledPages++;
  }

  recordLinksDiscovered(count) {
    this.discoveredLinks += count;
  }

  recordBrokenLink() {
    this.brokenLinks++;
  }

  recordAnchorMetrics(totalAnchors, brokenAnchors) {
    this.totalAnchors += totalAnchors;
    this.brokenAnchors += brokenAnchors;
  }

  recordRedirect() {
    this.redirects++;
  }

  recordSoft404() {
    this.soft404s++;
  }

  recordPageSoft404() {
    this.pageSoft404s++;
  }

  recordNotChecked() {
    this.notCheckedLinks++;
  }

  recordFailedPage() {
    this.failedPages++;
  }

  recordResponseTime(time) {
    if (time > 0) {
      this.responseTimes.push(time);
    }
  }

  recordError(error) {
    this.errors.push({
      message: error.message,
      timestamp: Date.now(),
      stack: error.stack
    });
  }

  getAverageResponseTime() {
    if (this.responseTimes.length === 0) return 0;
    return this.responseTimes.reduce((sum, time) => sum + time, 0) / this.responseTimes.length;
  }

  getMedianResponseTime() {
    if (this.responseTimes.length === 0) return 0;
    const sorted = [...this.responseTimes].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  getResponseTimePercentile(percentile) {
    if (this.responseTimes.length === 0) return 0;
    const sorted = [...this.responseTimes].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  getDuration() {
    return this.endTime ? this.endTime - this.startTime : Date.now() - this.startTime;
  }

  finalize() {
    this.endTime = Date.now();
  }

  getSummary() {
    return {
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.getDuration(),
      crawledPages: this.crawledPages,
      discoveredLinks: this.discoveredLinks,
      brokenLinks: this.brokenLinks,
      redirects: this.redirects,
      soft404s: this.soft404s,
      pageSoft404s: this.pageSoft404s,
      notCheckedLinks: this.notCheckedLinks,
      failedPages: this.failedPages,
      totalAnchors: this.totalAnchors,
      brokenAnchors: this.brokenAnchors,
      averageResponseTime: this.getAverageResponseTime(),
      medianResponseTime: this.getMedianResponseTime(),
      p95ResponseTime: this.getResponseTimePercentile(95),
      errorCount: this.errors.length
    };
  }
}

module.exports = MetricsCollector;