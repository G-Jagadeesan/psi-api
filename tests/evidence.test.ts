import { describe, expect, it } from 'vitest';
import { aggregateReports } from '../src/aggregate.js';
import {
  elementTagOf,
  filterInsights,
  firstPartyHostsFromEnv,
  isOwnUrl,
  lcpDetailFrom,
  normalizeReport,
  reclassifyInsightParties,
} from '../src/insights.js';
import { refreshRun } from '../src/reanalyze.js';
import type { AggregatedInsight, Insight } from '../src/types.js';
import { LH13_URL, lh13Raw, normalizeLh13 } from './helpers.js';

type RawResult = { lighthouseResult: { audits: Record<string, unknown>; configSettings?: Record<string, unknown> } };

function rawWith(mutate: (raw: RawResult) => void): RawResult {
  const raw = JSON.parse(JSON.stringify(lh13Raw)) as RawResult;
  mutate(raw);
  return raw;
}

const THIRD_PARTIES = {
  title: '3rd parties',
  score: 1,
  scoreDisplayMode: 'informative',
  details: {
    type: 'table',
    items: [
      {
        entity: 'Cloudflare',
        transferSize: 10_475,
        subItems: { type: 'subitems', items: [{ url: 'https://static.cloudflareinsights.com/beacon.min.js', transferSize: 10_475 }] },
      },
      {
        entity: 'guvi.in',
        transferSize: 805_875,
        subItems: { type: 'subitems', items: [{ url: 'https://static.guvi.in/zen-class-revamp/tools/devops.svg', transferSize: 576_081 }] },
      },
    ],
  },
};

describe('PSI_FIRST_PARTY_HOSTS', () => {
  it('normalises schemes, paths, wildcards and www', () => {
    expect(firstPartyHostsFromEnv(' https://www.guvi.in/path , *.guvi.co ,,')).toEqual(['guvi.in', 'guvi.co']);
    expect(firstPartyHostsFromEnv('')).toEqual([]);
  });

  it('owns subdomains of a listed domain, and nothing else', () => {
    const measured = 'https://www.guvi.co/zen-class/';
    expect(isOwnUrl('https://static.guvi.in/a.svg', measured, ['guvi.in'])).toBe(true);
    expect(isOwnUrl('https://static.guvi.in/a.svg', measured, [])).toBe(false);
    expect(isOwnUrl('https://notguvi.in/a.svg', measured, ['guvi.in'])).toBe(false);
  });

  it('counts a third-parties row on an owned domain as first party', () => {
    // static.guvi.in is GUVI's own CDN. Filed as a third party, 787 KB of the
    // page's own images read as "someone else's cost - document, do not fix".
    const raw = rawWith((r) => {
      r.lighthouseResult.audits['third-parties-insight'] = THIRD_PARTIES;
    });
    const without = normalizeReport(raw, LH13_URL, 'mobile', { firstPartyHosts: [] });
    const withOwned = normalizeReport(raw, LH13_URL, 'mobile', { firstPartyHosts: ['guvi.in'] });
    const pick = (insights: Insight[]) => insights.find((i) => i.id === 'third-parties-insight')!;
    expect(pick(without.insights)).toMatchObject({ firstPartyItems: 0, thirdPartyItems: 2 });
    expect(pick(withOwned.insights)).toMatchObject({ firstPartyItems: 1, thirdPartyItems: 1 });
  });

  it('re-judges ownership of a stored insight when its rows are complete', () => {
    const stored = normalizeReport(
      rawWith((r) => {
        r.lighthouseResult.audits['third-parties-insight'] = THIRD_PARTIES;
      }),
      LH13_URL,
      'mobile',
      { firstPartyHosts: [] },
    );
    const insight = stored.insights.find((i) => i.id === 'third-parties-insight')!;
    expect(reclassifyInsightParties(insight, LH13_URL, ['guvi.in'])).toMatchObject({ firstPartyItems: 1 });
    // Trimmed rows cannot be re-judged honestly, so the stored counts stand.
    const trimmed = { ...insight, itemsTotal: 30 };
    expect(reclassifyInsightParties(trimmed, LH13_URL, ['guvi.in'])).toBe(trimmed);
  });

  it('applies the owned hosts when re-analysing a stored run', () => {
    const run = normalizeReport(
      rawWith((r) => {
        r.lighthouseResult.audits['third-parties-insight'] = THIRD_PARTIES;
      }),
      LH13_URL,
      'mobile',
      { firstPartyHosts: [] },
    );
    const refreshed = refreshRun(run, ['guvi.in']);
    expect(refreshed.insights.find((i) => i.id === 'third-parties-insight')?.firstPartyItems).toBe(1);
  });
});

describe('request table', () => {
  const raw = rawWith((r) => {
    // No title, so it is kept as data and not listed as a finding.
    r.lighthouseResult.audits['network-requests'] = {
      details: {
        type: 'table',
        items: [
          {
            url: 'https://qwik-guvi-perf-fix.codingpuppet.com/',
            resourceType: 'Document',
            mimeType: 'text/html',
            priority: 'VeryHigh',
            networkRequestTime: 0.04,
            networkEndTime: 912.345,
            transferSize: 102_962,
            resourceSize: 600_000,
            statusCode: 200,
          },
          {
            url: 'https://static.guvi.in/tools/devops.svg',
            resourceType: 'Image',
            mimeType: 'image/svg+xml',
            networkRequestTime: 2000,
            networkEndTime: 3100,
            transferSize: 576_081,
            entity: 'guvi.in',
          },
          { url: 'https://static.cloudflareinsights.com/beacon.min.js', resourceType: 'Script', isLinkPreload: false },
          { url: 'data:image/png;base64,AAAA', resourceType: 'Image' },
        ],
      },
    };
  });

  it('keeps every request with its timing, size and owner', () => {
    const run = normalizeReport(raw, LH13_URL, 'mobile', { firstPartyHosts: ['guvi.in'] });
    expect(run.requests).toHaveLength(4);
    expect(run.requests?.[0]).toMatchObject({
      resourceType: 'Document',
      priority: 'VeryHigh',
      startMs: 0,
      endMs: 912.3,
      transferSize: 102_962,
      statusCode: 200,
      party: 'first',
    });
    expect(run.requests?.[1]).toMatchObject({ party: 'first', entity: 'guvi.in', mimeType: 'image/svg+xml' });
    expect(run.requests?.[2]).toMatchObject({ party: 'third', isLinkPreload: false });
    // A data: URL is part of the page itself.
    expect(run.requests?.[3]?.party).toBe('first');
    expect(run.insights.map((i) => i.id)).not.toContain('network-requests');
  });

  it('carries the median run’s requests onto the aggregate', () => {
    const run = normalizeReport(raw, LH13_URL, 'mobile', { firstPartyHosts: ['guvi.in'] });
    const report = aggregateReports([run], { reportId: 'r', runsRequested: 1 });
    expect(report.requests).toHaveLength(4);
    expect(report.images?.findings.some((f) => f.kind === 'heavyImage' && f.url?.endsWith('devops.svg'))).toBe(true);
  });

  it('is null on an aggregate whose runs carry no request table', () => {
    const report = aggregateReports([normalizeLh13()], { reportId: 'r', runsRequested: 1 });
    expect(report.requests).toBeNull();
  });
});

describe('screen emulation', () => {
  it('records the emulated screen Lighthouse reports', () => {
    const run = normalizeReport(
      rawWith((r) => {
        r.lighthouseResult.configSettings = {
          ...(r.lighthouseResult.configSettings ?? {}),
          screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
        };
      }),
      LH13_URL,
    );
    expect(run.environment.screen).toEqual({ width: 412, height: 823, deviceScaleFactor: 1.75, source: 'reported' });
  });

  it('falls back to Lighthouse’s defaults, marked as assumed', () => {
    const report = aggregateReports([normalizeLh13()], { reportId: 'r', runsRequested: 1 });
    expect(report.images?.screen).toMatchObject({ deviceScaleFactor: 1.75, source: 'default' });
  });
});

describe('LCP element type', () => {
  it('reads the tag from the snippet, then the path, then the lhId', () => {
    expect(elementTagOf({ snippet: '<img alt="x">' })).toBe('IMG');
    expect(elementTagOf({ path: '1,HTML,4,BODY,0,PICTURE,1,IMG' })).toBe('IMG');
    expect(elementTagOf({ lhId: 'page-0-IMG' })).toBe('IMG');
    expect(elementTagOf({})).toBeUndefined();
  });

  it('detects an image LCP whose alt text Lighthouse reports as its label', () => {
    // The real hero: nodeLabel is the alt text, which used to be read as
    // "this element has text", filing an image LCP as a text node.
    const run = normalizeLh13((raw) => {
      const audits = (raw as RawResult).lighthouseResult.audits as Record<string, { details: { items: unknown[] } }>;
      audits['lcp-breakdown-insight']!.details.items = [
        {
          type: 'table',
          items: [
            { subpart: 'timeToFirstByte', duration: 500 },
            { subpart: 'resourceLoadDelay', duration: 632 },
            { subpart: 'resourceLoadDuration', duration: 439 },
            { subpart: 'elementRenderDelay', duration: 344 },
          ],
        },
        {
          type: 'node',
          lhId: 'page-0-IMG',
          path: '1,HTML,4,BODY,5,MAIN,16,SECTION,0,DIV,0,PICTURE,1,IMG',
          selector: 'section > div > picture > img',
          nodeLabel: 'Master industry skills with HCL GUVI',
          snippet: '<img decoding="async" loading="eager" alt="Master industry skills with HCL GUVI" fetchpriority="high">',
        },
      ];
    });
    const lcp = lcpDetailFrom([run], run.score);
    expect(lcp?.isText).toBe(false);
    expect(lcp?.elementType).toBe('IMG');
    expect(lcp?.phases.loadTime).toBe(439);
    expect(lcp?.totalMs).toBe(500 + 632 + 439 + 344);
  });
});

describe('savings sort tiers', () => {
  const insight = (id: string, savingsMs: number | null, savingsBytes: number | null): AggregatedInsight => ({
    id,
    title: id,
    description: '',
    score: 0,
    scoreDisplayMode: 'metricSavings',
    group: 'opportunity',
    savingsMs,
    savingsBytes,
    firstPartyItems: 1,
    thirdPartyItems: 0,
    itemHosts: [],
    appearedInRuns: 1,
    runsSucceeded: 1,
    flaky: false,
    stats: { score: { mean: 0, median: 0, mode: 0 }, savingsMs: null, savingsBytes: null },
  });

  it('puts time-priced findings first, then byte-priced by size, then unpriced', () => {
    const ids = filterInsights(
      [
        insight('none', null, null),
        insight('small-bytes', null, 10_000),
        insight('ms-100', 100, null),
        insight('big-bytes', null, 500_000),
        insight('ms-300', 300, 5),
      ],
      { sortBy: 'savingsMs' },
    ).map((i) => i.id);
    expect(ids).toEqual(['ms-300', 'ms-100', 'big-bytes', 'small-bytes', 'none']);
  });
});

describe('borrowed rows keep their ownership counts', () => {
  it('takes the counts from the run the rows came from', () => {
    // A passing insight can carry no rows in the median run and four in another.
    // The rows were borrowed but the counts were not, so four first-party images
    // read as "0 first-party / 0 third-party".
    const withRows = normalizeLh13();
    const withoutRows = normalizeLh13();
    withRows.score = 90;
    withoutRows.score = 95;
    const target = withRows.insights.find((i) => (i.items?.length ?? 0) > 0 && i.firstPartyItems > 0)!;
    withoutRows.insights = withoutRows.insights.map((i) =>
      i.id === target.id
        ? { ...i, items: undefined, itemsTotal: undefined, firstPartyItems: 0, thirdPartyItems: 0, itemHosts: [], firstPartyShare: null }
        : i,
    );
    const report = aggregateReports([withoutRows, withRows, withoutRows], { reportId: 'r', runsRequested: 3 });
    const merged = report.insights.find((i) => i.id === target.id)!;
    expect(merged.items).toEqual(target.items);
    expect(merged.firstPartyItems).toBe(target.firstPartyItems);
    expect(merged.firstPartyShare).toBe(target.firstPartyShare);
  });
});
