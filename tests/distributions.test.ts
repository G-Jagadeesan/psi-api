import { describe, expect, it } from 'vitest';
import { aggregateReports, detectDistribution, percentile, seriesStats } from '../src/aggregate.js';
import { normalizeLh13, LH13_URL } from './helpers.js';
import type { NormalizedReport, Strategy } from '../src/types.js';

/** Ten runs: the real score spread observed across the stored qwik-guvi reports. */
const SCORE_SPLIT = [88, 87.5, 88.5, 93.5, 94, 95.5, 93, 88, 94.5, 95];

function run(index: number, overrides: Partial<NormalizedReport> = {}): NormalizedReport {
  const report = normalizeLh13();
  report.fetchTime = `2026-09-30T03-4${index}-00Z`;
  report.score = SCORE_SPLIT[index] ?? 90;
  return Object.assign(report, overrides);
}

describe('percentile', () => {
  it('agrees with the median at p50', () => {
    const values = [10, 20, 30, 40, 100];
    expect(percentile(values, 0.5)).toBe(30);
    expect(seriesStats(values, 'x').median).toBe(percentile(values, 0.5));
  });

  it('interpolates between samples', () => {
    expect(percentile([0, 10], 0.25)).toBe(2.5);
    expect(percentile([0, 10], 0.75)).toBe(7.5);
  });

  it('returns the endpoints and the only value', () => {
    expect(percentile([4, 8, 6], 0)).toBe(4);
    expect(percentile([4, 8, 6], 1)).toBe(8);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBe(0);
  });

  it('is order-independent', () => {
    expect(percentile([100, 10, 40], 0.75)).toBe(percentile([10, 40, 100], 0.75));
  });
});

describe('seriesStats', () => {
  it('reports quartiles alongside the existing triple', () => {
    const stats = seriesStats([1, 2, 3, 4], 'x');
    expect(stats.p25).toBe(1.75);
    expect(stats.p75).toBe(3.25);
    expect(stats.p95).toBe(3.85);
    // Existing fields are untouched.
    expect(stats.median).toBe(2.5);
    expect(stats.count).toBe(4);
  });
});

describe('detectDistribution', () => {
  it('flags two well-separated, evenly sized clusters', () => {
    const dist = detectDistribution([88, 88, 88.5, 87.5, 94, 95, 93.5, 94.5, 95.5, 93]);
    expect(dist.bimodal).toBe(true);
    expect(dist.lanes).toHaveLength(2);
    expect(dist.separation).toBeGreaterThan(2);
  });

  it('explains the split only when the two modes are more than 10 apart', () => {
    // The lanes here sit around 88 and 94 - a real 6-point cliff on a 0-100
    // scale, but not far enough to be worth a paragraph. The statistical claim
    // and the actionable one are separate gates on purpose: `bimodal` is true,
    // and the report stays quiet about it.
    const close = detectDistribution([88, 88, 88.5, 87.5, 94, 95, 93.5, 94.5, 95.5, 93]);
    expect(close.bimodal).toBe(true);
    // Undefined rather than empty: a caller testing for a note must not have to
    // handle both "no note" and "a note that happens to be blank".
    expect(close.note).toBeUndefined();

    // A genuine 30-point split is worth explaining.
    const wide = detectDistribution([60, 61, 60.5, 59.5, 90, 91, 89.5, 90.5, 91.5, 89]);
    expect(wide.bimodal).toBe(true);
    expect(wide.note).toMatch(/Bimodal/);
    expect(wide.note).toMatch(/~60/);
    expect(wide.note).toMatch(/~90/);
  });

  it('stays quiet on ordinary run-to-run jitter', () => {
    // A tight spread around one value is a single population, however it jitters.
    const dist = detectDistribution([93, 94, 93.5, 94.2, 93.8, 94.5, 93.2, 94.1]);
    expect(dist.bimodal).toBe(false);
  });

  it('ignores a lopsided outlier rather than calling it a lane', () => {
    // One bad run among nine good ones is noise, not a second mode.
    const dist = detectDistribution([90, 91, 90.5, 91.2, 90.8, 91.5, 90.2, 91.1, 40]);
    expect(dist.bimodal).toBe(false);
  });

  it('needs a minimum sample count before claiming anything', () => {
    expect(detectDistribution([1, 2, 100]).bimodal).toBe(false);
    expect(detectDistribution([]).bimodal).toBe(false);
  });

  it('reports a single cluster when every sample is identical', () => {
    expect(detectDistribution([5, 5, 5, 5, 5, 5]).bimodal).toBe(false);
  });
});

describe('aggregateReports', () => {
  const reports = SCORE_SPLIT.map((_, index) => run(index));

  it('attaches a distribution per metric and for the score', () => {
    const report = aggregateReports(reports, { reportId: 'r', runsRequested: 10 });
    expect(report.distributions?.score?.bimodal).toBe(true);
    expect(report.distributions?.lcp).toBeDefined();
    expect(report.distributions?.cls).toBeDefined();
  });

  it('carries the LCP element detail', () => {
    const report = aggregateReports(reports, { reportId: 'r', runsRequested: 10 });
    expect(report.lcp?.isText).toBe(true);
    expect(report.lcp?.bottleneck).toBe('render');
  });

  it('is null for the LCP detail when there is no run to read', () => {
    expect(aggregateReports([], { reportId: 'r', runsRequested: 0 }).lcp).toBeNull();
  });

  it('exposes percentiles on every metric series', () => {
    const report = aggregateReports(reports, { reportId: 'r', runsRequested: 10 });
    expect(report.score.p75).toBeGreaterThanOrEqual(report.score.median);
    expect(report.score.p95).toBeGreaterThanOrEqual(report.score.p75);
    expect(report.metrics.lcp?.p95).toBeGreaterThan(0);
  });
});

describe('aggregateReports url and strategy', () => {
  it('records the measured url on the aggregate', () => {
    const report = aggregateReports([run(0)], { reportId: 'r', runsRequested: 1 });
    expect(report.url).toBe(LH13_URL);
  });

  it('aggregates desktop runs without mixing strategies', () => {
    const desktop = run(0);
    desktop.strategy = 'desktop' as Strategy;
    const report = aggregateReports([desktop], { reportId: 'r', runsRequested: 1 });
    expect(report.strategy).toBe('desktop');
  });
});
