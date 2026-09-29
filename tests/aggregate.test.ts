import { describe, expect, it } from 'vitest';
import {
  FLAKY_THRESHOLD,
  aggregateReports,
  bucketOf,
  bucketWidth,
  mean,
  median,
  mode,
  seriesStats,
  stddev,
} from '../src/aggregate.js';
import { makeReport } from './helpers.js';

/** Build `count` reports, one per entry in scores, with a matching LCP. */
function reportsFor(scores: number[], lcp?: number[]) {
  return scores.map((score, index) =>
    makeReport({
      score,
      fetchTime: new Date(Date.UTC(2026, 8, 29, 10, 30, index)).toISOString(),
      ...(lcp ? { metrics: { lcp: lcp[index] as number } } : {}),
    }),
  );
}

describe('mean / median / mode', () => {
  it('computes mean, median and mode', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(mode([1, 2, 2, 3], 1)).toBe(2);
  });

  it('returns 0 for an empty series', () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
    expect(mode([], 1)).toBe(0);
    expect(stddev([])).toBe(0);
    expect(stddev([42])).toBe(0);
  });

  it('uses the sample standard deviation (n-1)', () => {
    // [2,4,4,4,5,5,7,9] has mean 5 and sample stddev 2.13809
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4);
  });
});

describe('mode bucketing', () => {
  it('uses the documented bucket widths', () => {
    expect(bucketWidth('score')).toBe(1);
    expect(bucketWidth('lcp')).toBe(100);
    expect(bucketWidth('fcp')).toBe(100);
    expect(bucketWidth('tbt')).toBe(100);
    expect(bucketWidth('speedIndex')).toBe(100);
    expect(bucketWidth('ttfb')).toBe(100);
    expect(bucketWidth('cls')).toBe(0.01);
  });

  it('buckets score to whole points', () => {
    expect(bucketOf(58.4, 1)).toBe(58);
    expect(bucketOf(58.6, 1)).toBe(59);
  });

  it('buckets millisecond metrics to 100ms', () => {
    expect(bucketOf(3210, 100)).toBe(3200);
    expect(bucketOf(3250, 100)).toBe(3300);
  });

  it('buckets CLS to 0.01', () => {
    expect(bucketOf(0.024, 0.01)).toBe(0.02);
    expect(bucketOf(0.026, 0.01)).toBe(0.03);
  });

  it('finds the most frequent bucket', () => {
    // 3210/3240/3180 land in 3200; 3250 lands in 3300; 2500 is alone.
    const values = [3210, 3240, 3180, 3250, 2500];
    expect(mode(values, 100)).toBe(3200);
  });

  it('falls back to the median when buckets tie', () => {
    const values = [100, 200, 300, 400];
    // Four distinct buckets, all with count 1 -> tie -> median.
    expect(mode(values, 100)).toBe(median(values));
    expect(mode(values, 100)).toBe(250);
  });

  it('returns the winning bucket when other buckets only tie at lower counts', () => {
    // 90 and 110 share the 100 bucket; 200 and 300 are alone.
    const values = [90, 110, 200, 300];
    expect(mode(values, 100)).toBe(100);
  });
});

describe('seriesStats', () => {
  it('reports every statistic plus the raw values', () => {
    const stats = seriesStats([1980, 2010, 2050, 2600], 'lcp');
    expect(stats.count).toBe(4);
    expect(stats.min).toBe(1980);
    expect(stats.max).toBe(2600);
    expect(stats.mean).toBe(2160);
    expect(stats.median).toBe(2030);
    expect(stats.mode).toBe(2000); // 1980 and 2010 share a bucket
    expect(stats.values).toEqual([1980, 2010, 2050, 2600]);
  });
});

describe('aggregateReports', () => {
  it('exposes the headline value for the chosen stat', () => {
    const reports = reportsFor([50, 60, 70]);
    const byMedian = aggregateReports(reports, { stat: 'median' });
    expect(byMedian.headline.score).toBe(60);
    expect(byMedian.stat).toBe('median');

    const byMean = aggregateReports(reports, { stat: 'mean' });
    expect(byMean.headline.score).toBe(60);

    const byMode = aggregateReports(reports, { stat: 'mode' });
    expect(byMode.headline.score).toBe(60);
  });

  it('shows all three stats side by side for the whole run set', () => {
    const report = aggregateReports(reportsFor([40, 50, 90, 100]), { stat: 'median' });
    expect(Object.keys(report.stats).sort()).toEqual(['mean', 'median', 'mode']);
    expect(report.stats.mean.score).toBe(70);
    expect(report.stats.median.score).toBe(70);
    // Four distinct single-run buckets tie, so mode falls back to the median.
    expect(report.stats.mode.score).toBe(70);
    expect(report.score).toMatchObject({ count: 4, min: 40, max: 100 });
    expect(report.score.values).toEqual([40, 50, 90, 100]);
  });

  it('aggregates every metric it can measure', () => {
    const report = aggregateReports(reportsFor([50, 60, 70], [3000, 3200, 3400]), {
      stat: 'median',
    });
    expect(report.metrics.lcp?.median).toBe(3200);
    expect(report.metrics.lcp?.mode).toBe(3200);
    expect(report.headline.metrics.lcp).toBe(3200);
    expect(report.metrics.tbt?.median).toBe(90);
    expect(report.stats.mean.metrics.lcp).toBe(3200);
  });

  it('omits metrics that were not measured at all', () => {
    const reports = reportsFor([50, 60]).map((report) => ({ ...report, metrics: {} }));
    const report = aggregateReports(reports, { stat: 'median' });
    expect(report.metrics.lcp).toBeUndefined();
    expect(report.headline.metrics.lcp).toBeUndefined();
  });

  it('carries the report id, run counts and failures through', () => {
    const report = aggregateReports(reportsFor([50, 60]), {
      reportId: '2026-09-29T10-30-00Z-mobile',
      runsRequested: 3,
      errors: [{ run: 3, message: 'timeout' }],
    });
    expect(report.reportId).toBe('2026-09-29T10-30-00Z-mobile');
    expect(report.runsRequested).toBe(3);
    expect(report.runsSucceeded).toBe(2);
    expect(report.errors).toEqual([{ run: 3, message: 'timeout' }]);
  });

  it('does not mutate the caller targets placeholder', () => {
    const report = aggregateReports(reportsFor([50]));
    expect(report.targets.meetsTarget).toBe(false);
  });
});

describe('insight aggregation', () => {
  it('merges by audit id and counts appearances', () => {
    const reports = Array.from({ length: 4 }, (_, i) => makeReport({ score: 50 + i, fetchTime: `2026-01-0${i + 1}` }));
    const report = aggregateReports(reports, { stat: 'median' });
    const audit = report.insights.find((i) => i.id === 'render-blocking-resources');
    expect(audit?.appearedInRuns).toBe(4);
    expect(audit?.runsSucceeded).toBe(4);
    expect(audit?.flaky).toBe(false);
    expect(audit?.savingsMs).toBe(640);
    expect(audit?.stats.savingsMs.median).toBe(640);
  });

  it('flags an insight seen in fewer than 30% of runs as flaky', () => {
    // 10 runs; the audit only shows up in 2 of them.
    const reports = Array.from({ length: 10 }, (_, i) =>
      makeReport({
        score: 50 + i,
        fetchTime: `2026-01-${String(i + 1).padStart(2, '0')}`,
        omit: i < 2 ? [] : ['render-blocking-resources'],
      }),
    );
    const report = aggregateReports(reports, { stat: 'median' });
    const flaky = report.insights.find((i) => i.id === 'render-blocking-resources');
    const stable = report.insights.find((i) => i.id === 'unused-javascript');

    expect(flaky?.appearedInRuns).toBe(2);
    expect(flaky?.flaky).toBe(true);
    expect(stable?.appearedInRuns).toBe(10);
    expect(stable?.flaky).toBe(false);
    expect(FLAKY_THRESHOLD).toBe(0.3);
  });

  it('keeps a null score null instead of collapsing it to zero', () => {
    const report = aggregateReports(reportsFor([50, 60, 70]));
    const insight = report.insights.find((i) => i.id === 'network-requests');
    expect(insight?.score).toBeNull();
  });

  it('aggregates scores with the chosen stat', () => {
    const reports = [
      makeReport({ score: 40, patch: { 'legacy-javascript': { score: 0 } }, fetchTime: 'a' }),
      makeReport({ score: 60, patch: { 'legacy-javascript': { score: 0.5 } }, fetchTime: 'b' }),
      makeReport({ score: 80, patch: { 'legacy-javascript': { score: 1 } }, fetchTime: 'c' }),
    ];
    expect(
      aggregateReports(reports, { stat: 'median' }).insights.find((i) => i.id === 'legacy-javascript')
        ?.score,
    ).toBe(0.5);
    expect(
      aggregateReports(reports, { stat: 'mean' }).insights.find((i) => i.id === 'legacy-javascript')
        ?.score,
    ).toBe(0.5);
    expect(
      aggregateReports(reports, { stat: 'mode' }).insights.find((i) => i.id === 'legacy-javascript')
        ?.score,
    ).toBe(0.5); // audit scores bucket at 0.05, so all three tie -> median
  });

  it('averages savings across runs using the chosen stat', () => {
    const reports = [
      makeReport({ score: 40, patch: { 'unused-javascript': { savingsMs: 100 } }, fetchTime: 'a' }),
      makeReport({ score: 50, patch: { 'unused-javascript': { savingsMs: 300 } }, fetchTime: 'b' }),
      makeReport({ score: 60, patch: { 'unused-javascript': { savingsMs: 500 } }, fetchTime: 'c' }),
    ];
    const byMedian = aggregateReports(reports, { stat: 'median' }).insights.find(
      (i) => i.id === 'unused-javascript',
    );
    const byMean = aggregateReports(reports, { stat: 'mean' }).insights.find(
      (i) => i.id === 'unused-javascript',
    );
    expect(byMedian?.savingsMs).toBe(300);
    expect(byMean?.savingsMs).toBe(300);
    expect(byMedian?.stats.savingsMs.mean).toBe(300);
    expect(byMedian?.stats.savingsMs.mode).toBe(300); // three distinct buckets tie
  });

  it('leaves savingsMs undefined when no run reported savings', () => {
    const report = aggregateReports(reportsFor([50, 60]));
    const insight = report.insights.find((i) => i.id === 'network-requests');
    expect(insight?.savingsMs).toBeUndefined();
    expect(insight?.items).toBeDefined();
  });

  it('takes items from the run closest to the median score', () => {
    const reports = [
      makeReport({
        score: 10,
        fetchTime: 'a',
        patch: { 'image-delivery-insight': { items: [{ tag: 'from-worst-run' }] } },
      }),
      makeReport({
        score: 60,
        fetchTime: 'b',
        patch: { 'image-delivery-insight': { items: [{ tag: 'from-median-run' }] } },
      }),
      makeReport({
        score: 90,
        fetchTime: 'c',
        patch: { 'image-delivery-insight': { items: [{ tag: 'from-best-run' }] } },
      }),
    ];
    const report = aggregateReports(reports, { stat: 'median' });
    const insight = report.insights.find((i) => i.id === 'image-delivery-insight');
    expect(insight?.items).toEqual([{ tag: 'from-median-run' }]);
  });

  it('keeps metadata from whichever run carried it', () => {
    const reports = [
      makeReport({
        score: 50,
        fetchTime: 'a',
        patch: { 'unused-javascript': { metricsAffected: undefined, displayValue: undefined } },
      }),
      makeReport({ score: 60, fetchTime: 'b' }),
    ];
    const insight = aggregateReports(reports, { stat: 'median' }).insights.find(
      (i) => i.id === 'unused-javascript',
    );
    expect(insight?.metricsAffected).toEqual(['lcp']);
    expect(insight?.displayValue).toBe('Potential savings of 380 ms');
  });

  it('returns no insights when every run failed', () => {
    expect(aggregateReports([], { stat: 'median' }).insights).toEqual([]);
  });
});
