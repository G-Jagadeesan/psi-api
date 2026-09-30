import { describe, expect, it } from 'vitest';
import { defaultScreen } from '../src/insights.js';
import { placement, renderInsightRows, renderRequests, requestSummary } from '../src/rows.js';
import type { AggregatedInsight, NetworkRequest } from '../src/types.js';

const SCREEN = defaultScreen('mobile');
const VIEW = { width: 120, useColor: false, screen: SCREEN };

function insight(id: string, items: unknown[], extra: Partial<AggregatedInsight> = {}): AggregatedInsight {
  return {
    id,
    title: `${id} title`,
    description: '',
    score: 0,
    scoreDisplayMode: 'metricSavings',
    group: 'opportunity',
    savingsMs: null,
    savingsBytes: null,
    firstPartyItems: 0,
    thirdPartyItems: 0,
    itemHosts: [],
    items,
    appearedInRuns: 10,
    runsSucceeded: 10,
    flaky: false,
    stats: { score: { mean: 0, median: 0, mode: 0 }, savingsMs: null, savingsBytes: null },
    ...extra,
  };
}

const text = (lines: string[]): string => lines.join('\n');

describe('placement', () => {
  const node = (top: number, left = 0, width = 200, height = 100) => ({
    boundingRect: { top, left, width, height, bottom: top + height, right: left + width },
  });

  it('says where an element sits against the fold', () => {
    expect(placement(node(55), SCREEN)).toBe('top 55px, 200×100, in the first fold');
    expect(placement(node(3576), SCREEN)).toBe('top 3576px, 200×100, 2753px below the 823px fold');
    expect(placement(node(100, 900), SCREEN)).toMatch(/off-screen sideways/);
  });

  it('prefers "below the fold" for an element that is also off to the side', () => {
    expect(placement(node(3576, 900), SCREEN)).toMatch(/below the 823px fold/);
  });

  it('calls a zero-size element not rendered', () => {
    expect(placement(node(0, 0, 0, 0), SCREEN)).toMatch(/not rendered/);
  });

  it('has nothing to say without a rect', () => {
    expect(placement({}, SCREEN)).toBeUndefined();
  });
});

describe('renderInsightRows', () => {
  it('shows the URL, sizes, element position, snippet and the sub-row reason', () => {
    const rows = [
      {
        url: 'https://site.test/assets/tcl.webp',
        totalBytes: 17_842,
        wastedBytes: 15_629,
        node: {
          type: 'node',
          selector: 'article > img',
          snippet: '<img loading="lazy" alt="tcl Logo">',
          boundingRect: { top: 3576, bottom: 3632, left: 0, right: 251, width: 251, height: 56 },
        },
        subItems: {
          type: 'subitems',
          items: [{ reason: 'This image file is larger than it needs to be (714x159).', wastedBytes: 15_629 }],
        },
      },
    ];
    const out = text(renderInsightRows(insight('image-delivery-insight', rows, { savingsBytes: 15_629 }), VIEW));
    expect(out).toContain(' 1. https://site.test/assets/tcl.webp');
    expect(out).toContain('total bytes 17KB · wasted bytes 15KB');
    expect(out).toContain('element article > img');
    expect(out).toContain('2753px below the 823px fold');
    expect(out).toContain('<img loading="lazy" alt="tcl Logo">');
    expect(out).toContain('- This image file is larger than it needs to be (714x159).');
    expect(out).toContain('saving 15KB');
  });

  it('numbers the rows of a wrapped table individually', () => {
    const items = [
      {
        type: 'table',
        items: [
          { subpart: 'timeToFirstByte', label: 'Time to first byte', duration: 500.1 },
          { subpart: 'resourceLoadDelay', label: 'Resource load delay', duration: 632.3 },
        ],
      },
    ];
    const out = text(renderInsightRows(insight('lcp-breakdown-insight', items), VIEW));
    expect(out).toContain(' 1. Time to first byte');
    expect(out).toContain(' 2. Resource load delay');
    expect(out).toContain('duration 632ms');
    expect(out).not.toContain('subpart');
  });

  it('draws the request chain as a tree and marks the longest path', () => {
    const items = [
      {
        type: 'list-section',
        value: {
          type: 'network-tree',
          longestChain: { duration: 2218 },
          chains: {
            a: {
              url: 'https://site.test/',
              navStartToEndTime: 1154,
              transferSize: 102_962,
              isLongest: true,
              children: {
                b: { url: 'https://site.test/style.css', navStartToEndTime: 1802, transferSize: 46_484, children: {} },
              },
            },
          },
        },
      },
    ];
    const lines = renderInsightRows(insight('network-dependency-tree-insight', items), VIEW);
    const out = text(lines);
    expect(out).toContain('longest chain 2218ms');
    expect(out).toMatch(/https:\/\/site\.test\/ {2}ends 1154ms · 101KB {2}← longest/);
    expect(out).toMatch(/└ https:\/\/site\.test\/style\.css {2}ends 1802ms · 45KB$/m);
  });

  it('names a statistic row by its statistic', () => {
    const items = [{ statistic: 'Total elements', value: { type: 'numeric', value: 4406 } }];
    const out = text(renderInsightRows(insight('dom-size-insight', items), VIEW));
    expect(out).toContain(' 1. Total elements');
    expect(out).toContain('value 4406');
  });

  it('shows a source location as url:line:column, one-based', () => {
    const items = [
      {
        url: 'https://cdn.test/beacon.js',
        subItems: {
          items: [{ signal: 'Array.prototype.at', location: { type: 'source-location', url: 'https://cdn.test/beacon.js', line: 0, column: 19367 } }],
        },
      },
    ];
    const out = text(renderInsightRows(insight('legacy-javascript-insight', items), VIEW));
    expect(out).toContain('- Array.prototype.at');
    expect(out).toContain('location https://cdn.test/beacon.js:1:19368');
  });

  it('says when Lighthouse reported rows the report did not keep', () => {
    const out = text(renderInsightRows(insight('x', [{ url: 'https://a.test/1.js' }], { itemsTotal: 40 }), VIEW));
    expect(out).toContain('39 more row(s) Lighthouse reported but the report did not keep');
  });

  it('respects the row limit', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ url: `https://a.test/${i}.js` }));
    const out = text(renderInsightRows(insight('x', items), { ...VIEW, limit: 2 }));
    expect(out).toContain('https://a.test/1.js');
    expect(out).not.toContain('https://a.test/2.js');
    expect(out).toContain('3 more row(s) (raise --limit)');
  });

  it('says so when a finding has no rows', () => {
    const out = text(renderInsightRows(insight('x', []), VIEW));
    expect(out).toContain('no rows');
  });
});

describe('request table', () => {
  const requests: NetworkRequest[] = [
    { url: 'https://site.test/', resourceType: 'Document', priority: 'VeryHigh', startMs: 0, endMs: 900, transferSize: 103_000, party: 'first' },
    { url: 'https://site.test/style.css', resourceType: 'Stylesheet', priority: 'VeryHigh', startMs: 950, endMs: 1500, transferSize: 46_000, party: 'first' },
    { url: 'https://static.cloudflareinsights.com/beacon.min.js', resourceType: 'Script', priority: 'Low', startMs: 960, endMs: 1100, transferSize: 10_000, party: 'third' },
    { url: 'https://static.guvi.in/devops.svg', resourceType: 'Image', priority: 'Low', startMs: 2000, endMs: 3000, transferSize: 576_000, party: 'first' },
  ];

  it('totals bytes by party and by type, largest type first', () => {
    const summary = requestSummary(requests);
    expect(summary.count).toBe(4);
    expect(summary.byParty.third).toEqual({ count: 1, bytes: 10_000 });
    expect(summary.byType[0]).toEqual({ type: 'Image', count: 1, bytes: 576_000 });
  });

  it('lists requests in start order by default', () => {
    const out = renderRequests(requests, { width: 140, useColor: false });
    const urls = out.filter((line) => /site\.test|cloudflare|guvi/.test(line) && !line.includes('REQUESTS'));
    expect(urls[0]).toContain('site.test/');
    expect(urls[urls.length - 1]).toContain('devops.svg');
  });

  it('sorts by size and filters by party', () => {
    const bySize = renderRequests(requests, { width: 140, useColor: false, sortBy: 'size', limit: 1 });
    expect(text(bySize)).toContain('devops.svg');
    expect(text(bySize)).not.toContain('style.css');
    expect(text(bySize)).toContain('3 more hidden by --limit 1');

    const third = renderRequests(requests, { width: 140, useColor: false, party: 'third' });
    expect(text(third)).toContain('beacon.min.js');
    expect(text(third)).not.toContain('style.css');
  });

  it('explains a report stored without a request table', () => {
    expect(text(renderRequests(undefined, { width: 100, useColor: false }))).toMatch(/stored before requests were kept/);
  });
});
