// HTTP Status Codes
const HTTP_STATUS = {
  OK: 200,
  MOVED_PERMANENTLY: 301,
  FOUND: 302,
  NOT_MODIFIED: 304,
  TEMPORARY_REDIRECT: 307,
  PERMANENT_REDIRECT: 308,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Link Types
const LINK_TYPES = {
  HEADER: 'header',
  FOOTER: 'footer',
  SIDEBAR: 'sidebar',
  BREADCRUMB: 'breadcrumb',
  NAVIGATION: 'navigation',
  TOC: 'toc',
  PAGINATION: 'pagination',
  VERSION_SELECTOR: 'version-selector',
  CONTENT: 'content',
  UNKNOWN: 'unknown'
};

// Error Types
const ERROR_TYPES = {
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  DNS: 'dns',
  SSL: 'ssl',
  BROWSER: 'browser',
  VALIDATION: 'validation'
};

// Retryable Error Codes
const RETRYABLE_ERROR_CODES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ECONNABORTED'
];

// Non-retryable Error Codes
const NON_RETRYABLE_ERROR_CODES = [
  'ENOTFOUND',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'EHOSTDOWN'
];

// Default Configuration
// This is the generic, target-agnostic baseline. Nothing here references any
// specific product or website — a concrete target is supplied at runtime via
// config/ConfigLoader.js (see config/config.json and config/examples/).
const DEFAULT_CONFIG = {
  seedUrls: [],
  allowedDomains: [],
  maxDepth: 10,
  maxPages: 1000,
  maxLinksPerPage: 500,
  concurrency: 5,
  timeout: 30000,
  retryCount: 3,
  crawlDelay: 100,
  followRobots: true,
  followSitemaps: true,
  captureScreenshots: false,
  ignoreFragments: true,
  outputDirectory: './output',
  screenshotDirectory: './screenshots',
  stateDirectory: './state',
  excludedPaths: ['/search', '/login', '/admin'],
  soft404Keywords: [
    'page not found',
    '404',
    'content unavailable',
    'not found',
    'documentation page not found'
  ],
  // Validation layer defaults — all on by default so a fresh config
  // gets real validation, not the old silent no-op behavior.
  validateHttp: true,
  validateBrowserFallback: true,
  validateAnchors: true,
  validateSoft404: true,
  retryEnabled: true,
  validationConcurrency: 5,
  reportHtml: true,
  reportExcel: true,
  reportJson: true
};

// File Extensions
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
const DOCUMENT_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];

// Browser Viewport
const BROWSER_VIEWPORT = {
  width: 1280,
  height: 720
};

// Report File Names
const REPORT_FILES = {
  HTML: 'report.html',
  EXCEL: 'report.xlsx',
  JSON: 'report.json'
};

module.exports = {
  HTTP_STATUS,
  LINK_TYPES,
  ERROR_TYPES,
  RETRYABLE_ERROR_CODES,
  NON_RETRYABLE_ERROR_CODES,
  DEFAULT_CONFIG,
  IMAGE_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  BROWSER_VIEWPORT,
  REPORT_FILES
};