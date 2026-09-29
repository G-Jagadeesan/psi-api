import { describe, expect, it } from 'vitest';
import { compareToTargets, loadTargets } from '../src/targets.js';
import type { AggregatedReport, Strategy, Targets } from '../src/types.js';

const targets: Targets = {
  mobile: { score: 90, lcp: 2500, tbt: 200, cls: 0.1, fcp: 1800, speedIndex: 3400 },
  desktop: { score: 90, lcp: 1800, tbt: 150, cls: 0.1, fcp: 1200, speedIndex: 2400 },
};

function fakeReport(headline: { score: number; metrics: Record<string, number> }, strategy: Strategy = 'mobile') {
  return { headline, strategy } as Pick<AggregatedReport, 'headline' | 'strategy'>;
}

describe('loadTargets', () => {
  it('reads the shipped config', () => {
    const loaded = loadTargets();
    expect(loaded.mobile.score).toBe(90);
    expect(loaded.mobile.lcp).toBe(2500);
    expect(loaded.mobile.cls).toBe(0.1);
    expect(loaded.mobile.fcp).toBe(1800);
    expect(loaded.mobile.speedIndex).toBe(3400);
    expect(loaded.mobile.tbt).toBe(200);
  });
});

describe('compareToTargets', () => {
  it('passes when every metric is inside budget', () => {
    const result = compareToTargets(
      fakeReport({ score: 95, metrics: { lcp: 2000, tbt: 100, cls: 0.05, fcp: 1500, speedIndex: 3000 } }),
      targets,
    );
    expect(result.meetsTarget).toBe(true);
    expect(result.gaps.every((gap) => gap.meets)).toBe(true);
  });

  it('rounds large gaps to whole units but keeps precision for sub-100 values', () => {
    const result = compareToTargets(
      fakeReport({ score: 27, metrics: { lcp: 19412.34, tbt: 1191.82, cls: 0.1234 } }),
      targets,
    );
    const delta = (metric: string) => result.gaps.find((gap) => gap.metric === metric)?.delta;

    // Millisecond-scale gaps read better as integers than as 19412.34.
    expect(delta('lcp')).toBe(16912);
    expect(delta('tbt')).toBe(992);
    // CLS is a fraction, so it keeps two decimals - a whole number would be useless.
    expect(delta('cls')).toBe(0.02);
  });

  it('treats higher as better for score and lower as better for everything else', () => {
    const result = compareToTargets(
      fakeReport({ score: 95, metrics: { lcp: 2000, tbt: 100, cls: 0.05, fcp: 1500, speedIndex: 3000 } }),
      targets,
    );
    const scoreGap = result.gaps.find((gap) => gap.metric === 'score');
    const lcpGap = result.gaps.find((gap) => gap.metric === 'lcp');
    expect(scoreGap?.meets).toBe(true);
    expect(lcpGap?.meets).toBe(true);
  });

  it('fails and reports the delta when a budget metric is exceeded', () => {
    const result = compareToTargets(
      fakeReport({ score: 95, metrics: { lcp: 3200, tbt: 100, cls: 0.05, fcp: 1500, speedIndex: 3000 } }),
      targets,
    );
    expect(result.meetsTarget).toBe(false);
    const lcpGap = result.gaps.find((gap) => gap.metric === 'lcp');
    expect(lcpGap).toEqual({ metric: 'lcp', actual: 3200, target: 2500, delta: 700, meets: false });
  });

  it('fails when the score is below the floor', () => {
    const result = compareToTargets(
      fakeReport({ score: 88, metrics: { lcp: 2000, tbt: 100, cls: 0.05, fcp: 1500, speedIndex: 3000 } }),
      targets,
    );
    expect(result.meetsTarget).toBe(false);
    expect(result.gaps.find((gap) => gap.metric === 'score')).toMatchObject({ delta: -2, meets: false });
  });

  it('uses the desktop targets for a desktop report', () => {
    const report = fakeReport(
      { score: 95, metrics: { lcp: 2000, tbt: 100, cls: 0.05, fcp: 1500, speedIndex: 3000 } },
      'desktop',
    );
    const result = compareToTargets(report, targets);
    expect(result.strategy).toBe('desktop');
    // 2000ms LCP is fine on mobile but over the 1800ms desktop budget.
    expect(result.gaps.find((gap) => gap.metric === 'lcp')?.meets).toBe(false);
    expect(result.meetsTarget).toBe(false);
  });

  it('skips metrics that could not be measured but does not claim success', () => {
    const result = compareToTargets(fakeReport({ score: 99, metrics: {} }), targets);
    expect(result.gaps).toHaveLength(1); // only score
    expect(result.meetsTarget).toBe(false);
  });

  it('reports a fractional delta for CLS', () => {
    const result = compareToTargets(
      fakeReport({ score: 95, metrics: { lcp: 2000, tbt: 100, cls: 0.12, fcp: 1500, speedIndex: 3000 } }),
      targets,
    );
    const clsGap = result.gaps.find((gap) => gap.metric === 'cls');
    expect(clsGap).toMatchObject({ actual: 0.12, target: 0.1, delta: 0.02, meets: false });
  });

  it('falls back to the shipped config when none is passed', () => {
    const result = compareToTargets(
      fakeReport({ score: 99, metrics: { lcp: 2000, tbt: 100, cls: 0.05, fcp: 1500, speedIndex: 3000 } }),
    );
    expect(result.meetsTarget).toBe(true);
  });
});
