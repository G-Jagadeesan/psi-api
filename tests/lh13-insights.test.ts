import { describe, expect, it } from 'vitest';
import {
  baseHostOf,
  classifyItemParties,
  filterInsights,
  firstPartyShareOf,
  lcpDetailFrom,
  normalizeReport,
  parseSavingsText,
} from '../src/insights.js';
import type { AggregatedInsight, Insight } from '../src/types.js';
import { normalizeLh13 } from './helpers.js';

/**
 * Regression cover for the Lighthouse 13 audit shape.
 *
 * Every test here corresponds to a real defect: the tool reported 0ms for a
 * 601ms render-blocking stylesheet, 0ms for 202 KiB of unused JavaScript, and
 * discarded first-party CSS because a vendor stylesheet shared the finding.
 */
describe('savings recovery on Lighthouse 13 audits', () => {
  it('reads the per-item cost when overallSavingsMs is 0', () => {
    const report = normalizeLh13();
    const insight = report.insights.find((i) => i.id === 'render-blocking-insight');

    // The rollup says 0. The item says 601ms. Reporting the rollup hid the fact
    // that a 46.7 KB stylesheet was blocking the first paint.
    expect(insight?.savingsMs).toBe(601);
    expect(insight?.savingsSource).toBe('items');
  });

  it('prefers the exact rollup over Lighthouse’s rounded display string', () => {
    const report = normalizeLh13();
    const insight = report.insights.find((i) => i.id === 'unused-css-rules');
    // `displayValue` says "Est savings of 58 KiB" = 59392. Taking the largest
    // candidate would report 59392 and inflate the exact 58008 rollup.
    expect(insight?.savingsBytes).toBe(58_008);
  });

  it('sums per-row bytes when no rollup is present', () => {
    const report = normalizeLh13();
    const insight = report.insights.find((i) => i.id === 'unused-javascript');
    // 120400 + 57200 + 28000. The rounded "202 KiB" string is not consulted
    // because the rows already give a precise figure.
    expect(insight?.savingsBytes).toBe(205_600);
    expect(insight?.savingsSource).toBe('items');
    expect(insight?.savingsMs).toBeNull();
  });

  it('falls back to displayValue when nothing else carries an estimate', () => {
    // Real Lighthouse 13 audits do reach this shape: no overallSavingsBytes, and
    // rows that report a share of waste without an absolute byte count.
    const report = normalizeLh13((raw) => {
      const audits = (
        raw as { lighthouseResult: { audits: Record<string, { details: { items: unknown[] } }> } }
      ).lighthouseResult.audits;
      audits['unused-javascript']!.details.items = [
        { url: 'https://qwik-guvi-perf-fix.codingpuppet.com/build/q-__EuPQ6J.js', wastedPercent: 93.594 },
      ];
    });
    const insight = report.insights.find((i) => i.id === 'unused-javascript');
    expect(insight?.savingsBytes).toBe(206_848);
    expect(insight?.savingsSource).toBe('displayValue');
  });

  it('does not invent a time saving for a byte-only display string', () => {
    const report = normalizeLh13();
    const insight = report.insights.find((i) => i.id === 'image-delivery-insight');
    expect(insight?.savingsMs).toBeNull();
    expect(insight?.savingsBytes).toBe(11_909);
  });

  it('reports null rather than 0 when there is genuinely no estimate', () => {
    const report = normalizeLh13();
    const insight = report.insights.find((i) => i.id === 'mainthread-work-breakdown');
    expect(insight?.savingsMs).toBeNull();
  });
});

describe('parseSavingsText', () => {
  it('reads Lighthouse savings strings', () => {
    expect(parseSavingsText('Est savings of 202 KiB', 'bytes')).toBe(206_848);
    expect(parseSavingsText('Potential savings of 640 ms', 'ms')).toBe(640);
    expect(parseSavingsText('Est savings of 1.2 s', 'ms')).toBeUndefined();
  });

  it('refuses a non-savings number, however it is phrased', () => {
    // This is a measurement of main-thread work, not a saving. Parsed naively it
    // becomes a bogus 1100ms opportunity on an audit that never claimed one.
    expect(parseSavingsText('Main thread work: 1.1 s', 'ms')).toBeUndefined();
    expect(parseSavingsText('4.2 s', 'ms')).toBeUndefined();
    expect(parseSavingsText('Reduce the impact of third-party code', 'ms')).toBeUndefined();
  });

  it('returns undefined rather than 0 for absent or zero estimates', () => {
    expect(parseSavingsText(undefined, 'ms')).toBeUndefined();
    expect(parseSavingsText('', 'bytes')).toBeUndefined();
    expect(parseSavingsText('Est savings of 0 KiB', 'bytes')).toBeUndefined();
  });

  it('treats a comma as a thousands separator, not a decimal point', () => {
    // Lighthouse emits en-US formatting, where "1,5" is not a thing but "1,500"
    // is. Reading the comma as a decimal point would turn 1.5 KiB into 15 KiB.
    expect(parseSavingsText('Est savings of 1,024 KiB', 'bytes')).toBe(1_024 * 1024);
  });
});

describe('mixed-party findings survive party=first', () => {
  const withUnusedCss = () => normalizeLh13().insights.find((i) => i.id === 'unused-css-rules');

  it('classifies the insight as mixed, not third-party', () => {
    const insight = withUnusedCss();
    expect(insight?.firstPartyItems).toBe(1);
    expect(insight?.thirdPartyItems).toBe(1);
    expect(insight?.firstPartyShare).toBe(0.5);
  });

  it('keeps it under party=first', () => {
    const report = normalizeLh13();
    const kept = filterInsights(report.insights, {
      id: ['unused-css-rules'],
      party: 'first',
    });
    // Dropping this hid 43 KB of the site's own dead CSS because one row in the
    // same finding belonged to gstatic.
    expect(kept.map((i) => i.id)).toEqual(['unused-css-rules']);
  });

  it('still drops findings that are entirely somebody else"s cost', () => {
    const report = normalizeLh13();
    const dropped = filterInsights(report.insights, {
      id: ['third-parties-insight'],
      party: 'first',
    });
    expect(dropped).toEqual([]);
  });

  it('filters by first-party ratio', () => {
    const report = normalizeLh13();
    const majority = filterInsights(report.insights, { minFirstPartyRatio: 0.5 });
    expect(majority.map((i) => i.id)).toContain('unused-css-rules');
    const strict = filterInsights(report.insights, { minFirstPartyRatio: 0.6 });
    expect(strict.map((i) => i.id)).not.toContain('unused-css-rules');
  });

  it('sorts by first-party share', () => {
    const report = normalizeLh13();
    const sorted = filterInsights(report.insights, { sortBy: 'firstPartyShare', order: 'desc' });
    const shares = sorted.map((i) => firstPartyShareOf(i));
    // null (unattributed) sorts last in a descending numeric sort.
    expect(shares[0]).toBe(1);
    expect(shares[shares.length - 1]).toBeNull();
  });

  it('treats an item mixing your CDN with a vendor as fully first-party', () => {
    const breakdown = classifyItemParties(
      [{ url: 'https://example.com/app.js', subItems: { items: [{ url: 'https://cdn.vendor.com/lib.js' }] } }],
      baseHostOf('https://example.com/'),
    );
    expect(breakdown.firstPartyItems).toBe(1);
    expect(breakdown.thirdPartyItems).toBe(0);
  });
});

describe('firstPartyShareOf', () => {
  const base: Insight = {
    id: 'x',
    title: 't',
    description: '',
    score: 0,
    scoreDisplayMode: 'binary',
    group: 'diagnostic',
    savingsMs: 0,
    savingsBytes: null,
    firstPartyItems: 0,
    thirdPartyItems: 0,
    itemHosts: [],
  };

  it('derives the ratio when the field is absent', () => {
    expect(firstPartyShareOf({ ...base, firstPartyItems: 3, thirdPartyItems: 1 })).toBe(0.75);
  });

  it('returns null for unattributed cost rather than 0', () => {
    // Main-thread breakdowns carry no URL. Calling them 0% yours would rank
    // the site's own JavaScript below a vendor beacon.
    expect(firstPartyShareOf({ ...base })).toBeNull();
  });

  it('prefers the captured value over a recomputed one', () => {
    const insight: AggregatedInsight = {
      ...base,
      firstPartyItems: 1,
      thirdPartyItems: 1,
      firstPartyShare: 0.9,
      appearedInRuns: 10,
      runsSucceeded: 10,
      flaky: false,
      stats: { score: { mean: 0, median: 0, mode: 0 }, savingsMs: null, savingsBytes: null },
    };
    expect(firstPartyShareOf(insight)).toBe(0.9);
  });
});

describe('LCP element detail', () => {
  it('detects a text LCP element and its phase split', () => {
    const report = normalizeLh13();
    const lcp = lcpDetailFrom([report], report.score);

    expect(lcp?.isText).toBe(true);
    expect(lcp?.phases.ttfb).toBeCloseTo(578.17, 1);
    expect(lcp?.phases.renderDelay).toBeCloseTo(1083.338, 1);
    // No load phases: there is no LCP image to fetch.
    expect(lcp?.phases.loadDelay).toBeUndefined();
    expect(lcp?.phases.loadTime).toBeUndefined();
    expect(lcp?.dominantPhase).toBe('renderDelay');
    expect(lcp?.bottleneck).toBe('render');
  });

  it('sums the phases it found', () => {
    const report = normalizeLh13();
    const lcp = lcpDetailFrom([report], report.score);
    expect(lcp?.totalMs).toBe(Math.round(578.17 + 1083.338));
  });

  it('classifies a TTFB-dominated LCP as a server problem', () => {
    const lcp = lcpDetailFrom(
      [
        normalizeLh13((raw) => {
          const audits = (raw as { lighthouseResult: { audits: Record<string, unknown> } }).lighthouseResult
            .audits as Record<string, { details: { items: unknown[] } }>;
          audits['lcp-breakdown-insight']!.details.items = [
            {
              type: 'table',
              items: [
                { subpart: 'timeToFirstByte', duration: 2100 },
                { subpart: 'elementRenderDelay', duration: 300 },
              ],
            },
          ];
        }),
      ],
      0,
    );
    expect(lcp?.bottleneck).toBe('server');
    expect(lcp?.dominantPhase).toBe('ttfb');
  });

  it('returns null when the run carries no LCP breakdown audit', () => {
    const report = normalizeReport(
      { lighthouseResult: { categories: { performance: { score: 0.5, auditRefs: [] } }, audits: {} } },
      'https://example.com/',
    );
    expect(lcpDetailFrom([report], 0)).toBeNull();
  });

  it('uses the run closest to the median score', () => {
    const slow = normalizeLh13((raw) => {
      (raw as { lighthouseResult: { fetchTime: string } }).lighthouseResult.fetchTime = 'b';
    });
    slow.score = 40;
    const fast = normalizeLh13();
    fast.fetchTime = 'a';
    fast.score = 90;

    // Median is 65, so the 40-score run is nearer and must be the representative.
    const lcp = lcpDetailFrom([fast, slow], 65);
    expect(lcp).not.toBeNull();
    expect(lcp?.totalMs).toBe(Math.round(578.17 + 1083.338));
  });
});