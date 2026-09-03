const fs = require('fs-extra');
const path = require('path');
const { program, InvalidArgumentError } = require('commander');
const CrawlManager = require('./crawler/CrawlManager');
const ConfigLoader = require('./config/ConfigLoader');

function parseCliInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    // commander catches this specific error type itself, prints a clean
    // single-line "error: option '--max-pages <n>' argument '...' is
    // invalid. <message>" and exits — a plain Error here would instead
    // propagate out of program.parse() (which runs before our own
    // try/catch) as a raw, unhandled stack trace.
    throw new InvalidArgumentError('must be an integer.');
  }
  return n;
}

program
  .option('--config <path>', 'Configuration file path (default: ./config/config.json)')
  .option('--url <url>', 'Target base URL to crawl — overrides target.baseUrl from the config file')
  .option('--environment <name>', 'Target environment label (metadata only, e.g. "staging", "production") — overrides target.environment')
  .option('--max-pages <n>', 'Maximum pages to crawl — overrides crawl.maxPages', parseCliInt)
  .option('--max-depth <n>', 'Maximum crawl depth — overrides crawl.maxDepth', parseCliInt)
  .option('--output <dir>', 'Output directory for reports — overrides outputDirectory');
program.parse();

/**
 * Applies CLI overrides onto the raw (pre-validation) config object, then
 * hands the merged result to ConfigLoader — so CLI flags go through the
 * exact same validation as the config file (an invalid `--url` fails with
 * the same clear, actionable error a bad config file would produce).
 */
function applyCliOverrides(rawConfig, opts) {
  const merged = { ...rawConfig, target: { ...(rawConfig.target || {}) }, crawl: { ...(rawConfig.crawl || {}) } };

  if (opts.url) merged.target.baseUrl = opts.url;
  if (opts.environment) merged.target.environment = opts.environment;
  if (opts.maxPages !== undefined) merged.crawl.maxPages = opts.maxPages;
  if (opts.maxDepth !== undefined) merged.crawl.maxDepth = opts.maxDepth;
  if (opts.output) merged.outputDirectory = opts.output;

  return merged;
}

(async () => {
  try {
    const opts = program.opts();
    const configPath = opts.config || './config/config.json';

    if (!fs.existsSync(configPath)) {
      throw new Error(`Config not found: ${configPath}`);
    }

    const rawConfig = await fs.readJson(path.resolve(configPath));
    const mergedConfig = applyCliOverrides(rawConfig, opts);
    const config = ConfigLoader.load(mergedConfig);

    const crawler = new CrawlManager(config);

    // Attach signal handlers so Ctrl-C generates a report before exit
    const shutdown = async (signal) => {
      console.log(`${signal} received — generating report and exiting`);
      try {
        await crawler.gracefulShutdown();
      } catch (e) {
        console.error('Error during shutdown:', e.message);
      }
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    await crawler.start();

    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();