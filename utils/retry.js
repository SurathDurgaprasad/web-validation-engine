const logger = require('./logger');

class RetryManager {
  constructor(config) {
    this.config = config;
    this.maxRetries = config.retryCount || 3;
  }

  async executeWithRetry(operation, operationName = 'operation') {
    let lastError;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        logger.warn(`${operationName} failed (attempt ${attempt}/${this.maxRetries}): ${error.message}`);

        // Don't retry on certain errors
        if (this.isNonRetryableError(error)) {
          logger.warn(`Non-retryable error encountered, aborting: ${error.message}`);
          break;
        }

        // Wait before retry (exponential backoff)
        if (attempt < this.maxRetries) {
          const delay = this.getBackoffDelay(attempt);
          logger.info(`Waiting ${delay}ms before retry...`);
          await this.delay(delay);
        }
      }
    }

    throw lastError;
  }

  isNonRetryableError(error) {
    const nonRetryableCodes = [
      'ENOTFOUND', // DNS resolution failed
      'CERT_HAS_EXPIRED', // SSL certificate issues
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE', // SSL verification failed
      'ECONNREFUSED', // Connection refused
      'EHOSTUNREACH', // Host unreachable
      'ENETUNREACH' // Network unreachable
    ];

    return nonRetryableCodes.includes(error.code) ||
           error.message.includes('404') ||
           error.message.includes('403') ||
           error.message.includes('401');
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getBackoffDelay(attempt) {
    return Math.min(1000 * Math.pow(2, attempt - 1), 10000);
  }

  async retryHttpRequest(requestFn, url) {
    return this.executeWithRetry(requestFn, `HTTP request to ${url}`);
  }

  async retryBrowserAction(actionFn, description) {
    return this.executeWithRetry(actionFn, `Browser action: ${description}`);
  }
}

module.exports = RetryManager;