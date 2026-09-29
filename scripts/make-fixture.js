// Generates tests/fixtures/raw-example.com.json - a trimmed but structurally
// realistic Google PageSpeed Insights v5 response. Run: node scripts/make-fixture.js
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
mkdirSync(outDir, { recursive: true });

const imageItems = Array.from({ length: 30 }, (_, i) => ({
  url: `https://example.com/assets/hero-${i + 1}.jpg`,
  totalBytes: 900_000 - i * 12_000,
  wastedBytes: 100_000 - i * 1_000,
  wastedMs: 100 - i * 2,
}));

const audits = {
  'first-contentful-paint': {
    id: 'first-contentful-paint',
    title: 'First Contentful Paint',
    description: 'First Contentful Paint marks the time at which the first text or image is painted.',
    score: 0.99,
    scoreDisplayMode: 'numeric',
    displayValue: '1.2 s',
    numericValue: 1234,
    numericUnit: 'millisecond',
  },
  'largest-contentful-paint': {
    id: 'largest-contentful-paint',
    title: 'Largest Contentful Paint',
    description: 'Largest Contentful Paint marks the time at which the largest text or image is painted.',
    score: 0.58,
    scoreDisplayMode: 'numeric',
    displayValue: '3.2 s',
    numericValue: 3210,
    numericUnit: 'millisecond',
    details: { type: 'filmstrip', metricSavings: { LCP: 820 } },
  },
  'total-blocking-time': {
    id: 'total-blocking-time',
    title: 'Total Blocking Time',
    description: 'Sum of all time periods between FCP and Time to Interactive.',
    score: 1,
    scoreDisplayMode: 'numeric',
    displayValue: '90 ms',
    numericValue: 90,
    numericUnit: 'millisecond',
  },
  'cumulative-layout-shift': {
    id: 'cumulative-layout-shift',
    title: 'Cumulative Layout Shift',
    description: 'Cumulative Layout Shift measures the movement of visible elements.',
    score: 1,
    scoreDisplayMode: 'numeric',
    displayValue: '0.02',
    numericValue: 0.02,
  },
  'speed-index': {
    id: 'speed-index',
    title: 'Speed Index',
    description: 'Speed Index shows how quickly the contents of a page are visibly populated.',
    score: 0.71,
    scoreDisplayMode: 'numeric',
    displayValue: '3.8 s',
    numericValue: 3810,
    numericUnit: 'millisecond',
  },
  interactive: {
    id: 'interactive',
    title: 'Time to Interactive',
    description: 'Time to Interactive marks the longest network response plus rendering.',
    score: null,
    scoreDisplayMode: 'informative',
    displayValue: '4.2 s',
    numericValue: 4200,
    numericUnit: 'millisecond',
  },
  'server-response-time': {
    id: 'server-response-time',
    title: 'Initial server response time',
    description: 'Keep the server response time for the main document short.',
    score: 1,
    scoreDisplayMode: 'metricSavings',
    displayValue: 'Root document took 180 ms',
    numericValue: 180,
    numericUnit: 'millisecond',
  },
  'render-blocking-resources': {
    id: 'render-blocking-resources',
    title: 'Eliminate render-blocking resources',
    description: 'Resources are blocking the first paint of your page.',
    score: 0.34,
    scoreDisplayMode: 'numeric',
    displayValue: 'Potential savings of 640 ms',
    numericValue: 640,
    numericUnit: 'millisecond',
    metricSavings: { FCP: 320, LCP: 640 },
    details: {
      type: 'opportunity',
      overallSavingsMs: 640,
      overallSavingsBytes: 153_600,
      items: [
        {
          url: 'https://example.com/assets/app.css',
          totalBytes: 102_400,
          wastedMs: 320,
        },
        {
          url: 'https://fonts.googleapis.com/css2?family=DM+Sans',
          totalBytes: 51_200,
          wastedMs: 320,
        },
      ],
    },
  },
  'unused-javascript': {
    id: 'unused-javascript',
    title: 'Reduce unused JavaScript',
    description: 'Reduce unused JavaScript to deliver less bytes and reduce JavaScript execution time.',
    score: 0.42,
    scoreDisplayMode: 'numeric',
    displayValue: 'Potential savings of 380 ms',
    numericValue: 380,
    numericUnit: 'millisecond',
    metricSavings: { LCP: 210 },
    details: {
      type: 'opportunity',
      overallSavingsMs: 380,
      overallSavingsBytes: 210_000,
      items: [
        { url: 'https://example.com/assets/vendor.js', totalBytes: 210_000, wastedMs: 380 },
      ],
    },
  },
  'uses-responsive-images': {
    id: 'uses-responsive-images',
    title: 'Properly size images',
    description: 'Serve images that are appropriately sized to save cellular data and improve load time.',
    score: 0,
    scoreDisplayMode: 'numeric',
    displayValue: 'Potential savings of 1.2 s',
    numericValue: 1200,
    numericUnit: 'millisecond',
    metricSavings: { LCP: 1200 },
    details: {
      type: 'opportunity',
      overallSavingsMs: 1200,
      overallSavingsBytes: 900_000,
      items: [
        { url: 'https://example.com/assets/hero.jpg', totalBytes: 900_000, wastedMs: 1200 },
      ],
    },
  },
  // Modern Lighthouse "insight" audits: informative display mode, null score,
  // but real metricSavings and item lists.
  'lcp-lazy-loaded-insight': {
    id: 'lcp-lazy-loaded-insight',
    title: 'LCP request was lazy loaded',
    description: 'The Largest Contentful Paint element was lazy loaded, delaying discovery of the resource.',
    score: null,
    scoreDisplayMode: 'informative',
    metricSavings: { LCP: 1250 },
    details: {
      type: 'list',
      items: [
        {
          entity: 'https://example.com/assets/hero.jpg',
          node: { snippet: 'img.hero' },
          wastedMs: 1250,
        },
      ],
    },
  },
  'font-display-insight': {
    id: 'font-display-insight',
    title: 'Text remains invisible while webfonts load',
    description: 'Fonts are hidden until loaded, so text is invisible for a period of time.',
    score: null,
    scoreDisplayMode: 'informative',
    details: {
      type: 'list',
      items: [
        { fontFamily: 'DM Sans', display: 'swap' },
        { fontFamily: 'Jones', display: 'block' },
      ],
    },
  },
  'image-delivery-insight': {
    id: 'image-delivery-insight',
    title: 'Improve image delivery',
    description: 'Compress and resize images to reduce the time they take to download.',
    score: 0.5,
    scoreDisplayMode: 'metricSavings',
    displayValue: 'Est savings of 2 KiB',
    // Lighthouse 13 reports savings per item and omits overallSavings*.
    details: { type: 'table', items: imageItems },
  },
  'uses-text-compression': {
    id: 'uses-text-compression',
    title: 'Enable text compression',
    description: 'Text-based resources should be served with compression.',
    score: 1,
    scoreDisplayMode: 'metricSavings',
    details: {
      type: 'list',
      items: [{ url: 'https://example.com/assets/app.js', totalBytes: 51_200, wastedMs: 0 }],
    },
  },
  'network-requests': {
    id: 'network-requests',
    title: 'Avoid enormous network payloads',
    description: 'Large network payloads cost users real money and are highly correlated with long load times.',
    score: null,
    scoreDisplayMode: 'informative',
    details: { type: 'table', items: [{ url: 'https://example.com/' }] },
  },
  'uses-http2': {
    id: 'uses-http2',
    title: 'Use HTTP/2',
    description: 'HTTP/2 allows many requests over a single connection.',
    score: null,
    scoreDisplayMode: 'notApplicable',
    details: { type: 'table', items: [] },
  },
  'legacy-javascript': {
    id: 'legacy-javascript',
    title: 'Avoid legacy JavaScript',
    description: 'Legacy polyfills and transforms inject code that browsers cannot always execute efficiently.',
    score: 0,
    scoreDisplayMode: 'metricSavings',
    details: { type: 'list', items: [{ url: 'https://example.com/assets/polyfill.js' }] },
  },
  'third-party-summary': {
    id: 'third-party-summary',
    title: 'Reduce the impact of third-party code',
    description: 'Third-party code can significantly impact load performance.',
    score: 0.6,
    scoreDisplayMode: 'numeric',
    displayValue: 'Main thread work: 1.1 s',
    details: { type: 'list', items: [{ entity: 'Other third parties' }] },
  },
  viewport: {
    id: 'viewport',
    title: 'Has a `<meta name="viewport">` tag',
    description: 'A `viewport` not only optimizes rendering for mobile but also prevents a 300 ms delay to user input.',
    score: 1,
    scoreDisplayMode: 'metricSavings',
  },
  // Group "hidden": Lighthouse deliberately does not surface this one.
  bfcache: {
    id: 'bfcache',
    title: 'Avoids page reloads on bfcache (Back/Forward Cache)',
    description: 'Not every page is eligible for bfcache.',
    score: 0,
    scoreDisplayMode: 'metricSavings',
    details: { type: 'list', items: [] },
  },
};

const auditRefs = [
  { id: 'first-contentful-paint', weight: 10, group: 'metrics' },
  { id: 'largest-contentful-paint', weight: 25, group: 'metrics' },
  { id: 'total-blocking-time', weight: 30, group: 'metrics' },
  { id: 'cumulative-layout-shift', weight: 25, group: 'metrics' },
  { id: 'speed-index', weight: 10, group: 'metrics' },
  { id: 'render-blocking-resources', weight: 0, group: 'diagnostics' },
  { id: 'unused-javascript', weight: 0, group: 'diagnostics' },
  {
    id: 'third-party-summary',
    weight: 0,
    group: 'diagnostics',
    relevantAudits: ['largest-contentful-paint', 'total-blocking-time'],
  },
  { id: 'font-display-insight', weight: 0, group: 'diagnostics' },
  { id: 'image-delivery-insight', weight: 0, group: 'diagnostics' },
  { id: 'uses-responsive-images', weight: 0, group: 'diagnostics' },
  { id: 'legacy-javascript', weight: 0, group: 'budgets' },
  { id: 'uses-text-compression', weight: 0, group: 'diagnostics' },
  { id: 'viewport', weight: 0, group: 'diagnostics' },
  { id: 'interactive', weight: 0, group: 'hidden' },
  { id: 'bfcache', weight: 0, group: 'hidden' },
];

const fixture = {
  id: 'https://example.com/',
  loadingExperience: {
    id: 'https://example.com/',
    metrics: {
      largest_contentful_paint: { percentile: 75, distributions: [{ min: 0, max: 2500, proportion: 0.72 }] },
      cumulative_layout_shift: { percentile: 75, distributions: [{ min: 0, max: 0.1, proportion: 0.9 }] },
      interaction_to_next_paint: { percentile: 75, distributions: [{ min: 0, max: 200, proportion: 0.95 }] },
    },
    overall_category: 'performance',
    origin_fallback_page: false,
  },
  originLoadingExperience: {
    id: 'https://example.com',
    metrics: {
      largest_contentful_paint: { percentile: 75, distributions: [{ min: 0, max: 3000, proportion: 0.68 }] },
    },
    overall_category: 'performance',
  },
  lighthouseResult: {
    requestedUrl: 'https://example.com/',
    finalDisplayedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    fetchTime: '2026-09-29T10:30:00.000Z',
    gatherMode: 'navigation',
    lighthouseVersion: '12.2.1',
    userAgent: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) Chrome/125.0.0.0',
    categories: {
      performance: {
        id: 'performance',
        title: 'Performance',
        score: 0.58,
        auditRefs,
      },
    },
    audits,
  },
};

writeFileSync(path.join(outDir, 'raw-example.com.json'), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log('wrote tests/fixtures/raw-example.com.json');
