import { describe, expect, it } from 'vitest';
import { aggregateReports, seriesStats } from '../src/aggregate.js';
import { applyTargets, blockedByPlatform, compareToTargets, DEFAULT_MIN_PASS_RATE } from '../src/targets.js';
import type { AggregatedReport, NormalizedReport, Targets } from '../src/types.js';
import { normalizeLh13 } from './helpers.js';

const targets: Targets = {
  mobile: { score: 90, lcp: 2500, tbt: 200, cls: 0.1, fcp: 1800, speedIndex: 3400 },
  desktop: { score: 90, lcp: 1800, tbt: 150, cls: 0.1, fcp: 1200, speedIndex: 2400 },
};

const METRICS = { lcp: 2000, tbt: 100, cls: 0.05, fcp: 1500, speedIndex: 3000, ttfb: 180 };

/** The longest series, which sets how many runs are simulated. */
const runCount = (values: Record<string, number[]>): number =>
  Math.max(...Object.values(values).map((series) => series.length));

/**
 * Build one run carrying its *own* sample from each series.
 *
 * Each series is walked in lockstep, so a run's metrics describe that run - which
 * is what makes the pass rate meaningful. Collapsing each series to its median
 * first would make every run identical and hide the tail entirely.
 */
function runAt(values: Record<string, number[]>, index: number, score: number): NormalizedReport {
  const report = normalizeLh13();
  report.score = score;
  report.fetchTime = `2026-09-30T03-4${index % 10}-0${Math.floor(index / 10)}Z`;
  const metrics: NormalizedReport['metrics'] = {};
  for (const [key, series] of Object.entries(values)) {
    metrics[key as keyof typeof metrics] = series[index] ?? series[series.length - 1] ?? 0;
  }
  report.metrics = metrics;
  return report;
}

function aggregate(values: Record<string, number[]>, score = 95): AggregatedReport {
  const runs = Array.from({ length: runCount(values) }, (_, index) => runAt(values, index, score));
  return applyTargets(aggregateReports(runs, { reportId: 'r', runsRequested: runs.length }), targets);
}

describe('pass rate grading', () => {
  it('keeps a metric that passes on every run', () => {
    const report = aggregate({ lcp: [2000, 2100, 2200, 2300, 2400], ttfb: [180] });
    const lcp = report.targets.gaps.find((gap) => gap.metric === 'lcp');
    expect(lcp?.passRate).toBe(1);
    expect(lcp?.overBudgetRuns).toBe(0);
    expect(lcp?.meets).toBe(true);
  });

  it('fails a metric whose median passes but whose runs do not', () => {
    // The real shape from 2026-09-30T03-46-50Z-mobile: TBT median 117.5 against
    // a 200ms budget, with 2 of 10 runs at 270 and 423.
    const report = aggregate({ tbt: [110, 118, 270, 86, 118, 116, 423, 122, 107.5, 117] });
    const tbt = report.targets.gaps.find((gap) => gap.metric === 'tbt');

    expect(tbt?.actual).toBeLessThanOrEqual(200);
    expect(tbt?.passRate).toBe(0.8);
    expect(tbt?.overBudgetRuns).toBe(2);
    expect(tbt?.runsMeasured).toBe(10);
    // The median is inside budget; the metric is still reported as failing, and
    // `medianPass` is what lets a caller show both verdicts side by side.
    expect(tbt?.meets).toBe(false);
    expect(report.targets.medianPass).toBe(true);
  });

  it('distinguishes the median verdict from the tail verdict', () => {
    // Everything the median sees passes, so medianPass is true, but 3/10 runs
    // bust the budget. This is the false-PASS case the old code could not see.
    const report = aggregate({ lcp: [2000, 2000, 2000, 2000, 2000, 2000, 2000, 2600, 2700, 2800] });
    const lcp = report.targets.gaps.find((gap) => gap.metric === 'lcp');
    expect(lcp?.passRate).toBe(0.7);
    expect(lcp?.meets).toBe(false);
  });

  it('honours an explicit pass-rate threshold', () => {
    const lenient = compareToTargets(
      { headline: { score: 95, metrics: { lcp: 2400 } }, strategy: 'mobile', metrics: { lcp: seriesStats([2400, 2500, 2600], 'lcp') } },
      targets,
      { minPassRate: 0.5 },
    );
    expect(lenient.gaps.find((gap) => gap.metric === 'lcp')?.meets).toBe(true);

    const strict = compareToTargets(
      { headline: { score: 95, metrics: { lcp: 2400 } }, strategy: 'mobile', metrics: { lcp: seriesStats([2400, 2500, 2600], 'lcp') } },
      targets,
      { minPassRate: 0.99 },
    );
    expect(strict.gaps.find((gap) => gap.metric === 'lcp')?.meets).toBe(false);
  });

  it('defaults to a 90% pass rate', () => {
    expect(DEFAULT_MIN_PASS_RATE).toBe(0.9);
    // 8/10 = 0.8 is below the default, so a median that passes still fails.
    const report = aggregate({ lcp: [2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2600, 2700] });
    expect(report.targets.gaps.find((gap) => gap.metric === 'lcp')?.meets).toBe(false);
  });

  it('adds the tail percentiles to each graded gap', () => {
    const report = aggregate({ lcp: [1000, 1100, 1200, 1300, 4000] });
    const lcp = report.targets.gaps.find((gap) => gap.metric === 'lcp');
    // rank = (5-1)*0.75 = 3, which lands exactly on the fourth sample.
    expect(lcp?.p75).toBe(1300);
    expect(lcp?.p95).toBe(3460);
  });

  it('omits pass-rate fields when no per-run series is available', () => {
    const bare = compareToTargets({ headline: { score: 95, metrics: METRICS }, strategy: 'mobile' }, targets);
    const lcp = bare.gaps.find((gap) => gap.metric === 'lcp');
    expect(lcp?.passRate).toBeUndefined();
    expect(lcp?.p75).toBeUndefined();
    expect(bare.gaps.find((gap) => gap.metric === 'lcp')?.meets).toBe(true);
  });
});

describe('worst gap', () => {
  it('ranks a relative overshoot above an absolute one', () => {
    const result = compareToTargets(
      {
        headline: { score: 85, metrics: { ...METRICS, lcp: 4200 } },
        strategy: 'mobile',
      },
      targets,
    );
    // LCP is 68% over its 2500ms budget; score is 5.6% under its 90 target.
    expect(result.worstGap?.metric).toBe('lcp');
  });

  it('is absent when every metric is inside budget', () => {
    const result = compareToTargets({ headline: { score: 95, metrics: METRICS }, strategy: 'mobile' }, targets);
    expect(result.worstGap).toBeUndefined();
  });
});

describe('platform-blocked metrics', () => {
  it('flags a budget that sits below the server round trip', () => {
    const reasons = blockedByPlatform(
      { headline: { score: 90, metrics: {} }, metrics: { ttfb: seriesStats([2000, 2100, 2200], 'ttfb') } },
      [{ metric: 'lcp', actual: 2400, target: 1800, delta: 600, meets: false }],
    );
    expect(reasons[0]).toMatch(/lcp/);
    expect(reasons[0]).toMatch(/server\/CDN/);
  });

  it('leaves a reachable budget alone', () => {
    const reasons = blockedByPlatform(
      { headline: { score: 90, metrics: {} }, metrics: { ttfb: seriesStats([300], 'ttfb') } },
      [{ metric: 'lcp', actual: 3200, target: 2500, delta: 700, meets: false }],
    );
    expect(reasons).toEqual([]);
  });

  it('never applies a millisecond floor to a unitless budget', () => {
    const reasons = blockedByPlatform(
      { headline: { score: 90, metrics: {} }, metrics: { ttfb: seriesStats([5000], 'ttfb') } },
      [{ metric: 'cls', actual: 0.2, target: 0.1, delta: 0.1, meets: false }],
    );
    expect(reasons).toEqual([]);
  });

  it('surfaces the reason on the comparison', () => {
    const report = aggregate({ lcp: [3200, 3200, 3200], ttfb: [2800, 2800, 2800] });
    expect(report.targets.blockedBy?.[0]).toMatch(/fcp|lcp/);
  });

  it('says nothing when TTFB was not measured', () => {
    const reasons = blockedByPlatform(
      { headline: { score: 90, metrics: {} }, metrics: {} },
      [{ metric: 'lcp', actual: 3200, target: 1800, delta: 1400, meets: false }],
    );
    expect(reasons).toEqual([]);
  });
});
