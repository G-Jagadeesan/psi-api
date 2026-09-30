import { describe, expect, it } from 'vitest';
import { refreshInsightSavings } from '../src/insights.js';
import { diffReanalyzed, reanalyze, refreshRun } from '../src/reanalyze.js';
import type { AggregatedReport, Insight, NormalizedReport } from '../src/types.js';
import { normalizeLh13 } from './helpers.js';

const TARGETS = {
  mobile: { score: 90, lcp: 2500, tbt: 200, cls: 0.1, fcp: 1800, speedIndex: 3400 },
  desktop: { score: 90, lcp: 1800, tbt: 150, cls: 0.1, fcp: 1200, speedIndex: 2400 },
};

/** A stored insight carrying the old bug: savings decided at normalize time. */
function storedInsight(extra: Partial<Insight> = {}): Insight {
  return {
    id: 'render-blocking-insight',
    title: 'Eliminate render-blocking resources',
    description: '',
    score: 0.5,
    scoreDisplayMode: 'metricSavings',
    group: 'diagnostic',
    savingsMs: 0,
    savingsBytes: 0,
    items: [{ url: 'https://example.com/a.css', totalBytes: 46725, wastedMs: 601 }],
    firstPartyItems: 1,
    thirdPartyItems: 0,
    itemHosts: ['example.com'],
    ...extra,
  };
}

describe('refreshInsightSavings', () => {
  it('recovers a figure the old normalize-time logic reported as zero', () => {
    const refreshed = refreshInsightSavings(storedInsight());
    expect(refreshed.savingsMs).toBe(601);
    expect(refreshed.savingsSource).toBe('items');
  });

  it('recovers a byte figure from the display string alone', () => {
    const refreshed = refreshInsightSavings(
      storedInsight({ id: 'unused-javascript', displayValue: 'Est savings of 202 KiB', items: [] }),
    );
    expect(refreshed.savingsBytes).toBe(206_848);
    expect(refreshed.savingsSource).toBe('displayValue');
  });

  it('leaves a genuine null as null', () => {
    const refreshed = refreshInsightSavings(storedInsight({ items: [], displayValue: undefined }));
    expect(refreshed.savingsMs).toBeNull();
    expect(refreshed.savingsBytes).toBeNull();
  });

  it('never downgrades a known figure to null', () => {
    // The stored 300 may have come from `details.overallSavingsMs`, which is not
    // retained. Reconstructing from the rows would yield null, and reporting
    // null for an estimate Lighthouse actually gave is worse than leaving it.
    const refreshed = refreshInsightSavings(
      storedInsight({ savingsMs: 300, savingsBytes: 150_000, items: [] }),
    );
    expect(refreshed.savingsMs).toBe(300);
    expect(refreshed.savingsBytes).toBe(150_000);
  });

  it('never overrides a known rollup with a row-derived approximation', () => {
    const refreshed = refreshInsightSavings(
      storedInsight({ savingsMs: 250, savingsBytes: 100, items: [{ url: 'a', wastedMs: 451 }] }),
    );
    expect(refreshed.savingsMs).toBe(250);
  });

  it('fills only the axis that is missing', () => {
    const refreshed = refreshInsightSavings(
      storedInsight({ savingsMs: 250, savingsBytes: 0, displayValue: 'Est savings of 33 KiB', items: [] }),
    );
    expect(refreshed.savingsMs).toBe(250);
    expect(refreshed.savingsBytes).toBe(33 * 1024);
  });

  it('returns the same object when there is nothing to fill', () => {
    const before = storedInsight({ savingsMs: 601, savingsBytes: 46_725 });
    expect(refreshInsightSavings(before)).toBe(before);
  });

  it('does not touch fields it does not own', () => {
    const before = storedInsight();
    const after = refreshInsightSavings(before);
    expect(after.id).toBe(before.id);
    expect(after.items).toBe(before.items);
    expect(after.firstPartyItems).toBe(before.firstPartyItems);
  });

  it('is idempotent', () => {
    const once = refreshInsightSavings(storedInsight());
    expect(refreshInsightSavings(once)).toEqual(once);
  });
});

describe('refreshRun', () => {
  it('refreshes every insight in the run', () => {
    const run = normalizeLh13();
    const refreshed = refreshRun(run);
    expect(refreshed.insights).toHaveLength(run.insights.length);
    for (const insight of refreshed.insights) {
      expect(insight.savingsSource).toBeDefined();
    }
  });

  it('leaves the metrics and score untouched', () => {
    const run = normalizeLh13();
    const refreshed = refreshRun(run);
    expect(refreshed.metrics).toEqual(run.metrics);
    expect(refreshed.score).toBe(run.score);
  });
});

describe('reanalyze', () => {
  const runs = (): NormalizedReport[] =>
    Array.from({ length: 3 }, (_, i) => {
      const run = normalizeLh13();
      run.fetchTime = `2026-09-30T03-4${i}-00Z`;
      run.metrics = { lcp: 2401, tbt: 117, cls: 0, fcp: 2153, speedIndex: 3222, ttfb: 562 } as AggregatedReport['metrics'];
      return run;
    });

  it('rebuilds a report from stored runs', () => {
    const report = reanalyze(runs(), { reportId: 'r', targets: TARGETS });
    expect(report.reportId).toBe('r');
    expect(report.runsSucceeded).toBe(3);
  });

  it('adds the fields the old snapshot could not carry', () => {
    const report = reanalyze(runs(), { reportId: 'r', targets: TARGETS });
    expect(report.distributions).toBeDefined();
    expect(report.lcp).not.toBeNull();
    // Tail grading only exists on the rebuilt report.
    expect(report.targets.gaps.find((gap) => gap.metric === 'lcp')?.passRate).toBeDefined();
  });

  it('recovers the savings the old snapshot lost', () => {
    const report = reanalyze(runs(), { reportId: 'r', targets: TARGETS });
    const renderBlocking = report.insights.find((i) => i.id === 'render-blocking-insight');
    expect(renderBlocking?.savingsMs).toBe(601);
  });

  it('refuses to rebuild a report with no runs', () => {
    expect(() => reanalyze([], { reportId: 'r' })).toThrow(/no stored runs/);
  });
});

describe('diffReanalyzed', () => {
  const base = reanalyze(
    Array.from({ length: 3 }, (_, i) => {
      const run = normalizeLh13();
      run.fetchTime = `2026-09-30T03-4${i}-00Z`;
      return run;
    }),
    { reportId: 'r', targets: TARGETS },
  );

  it('reports no change when the snapshot already matches', () => {
    const delta = diffReanalyzed(base, base);
    expect(delta.changed).toBe(false);
    expect(delta.recovered).toEqual([]);
    expect(delta.phantomZeroes).toEqual([]);
  });

  it('reports a recovered savings figure', () => {
    const stale = structuredClone(base);
    const target = stale.insights.find((i) => i.id === 'render-blocking-insight');
    if (target) target.savingsMs = 0;
    const delta = diffReanalyzed(stale, base);
    expect(delta.changed).toBe(true);
    expect(delta.recovered[0]).toMatchObject({
      insightId: 'render-blocking-insight',
      beforeMs: 0,
      afterMs: 601,
    });
  });

  it('separates a corrected phantom zero from a recovered figure', () => {
    // `mainthread-work-breakdown` carries durations but no wasted-byte or
    // wasted-ms rows, and no display string - so a stored 0 has nothing to
    // recover and correctly becomes null. That is a phantom being removed, not
    // a cost being found, and conflating the two would overstate the result.
    const stale = structuredClone(base);
    const target = stale.insights.find((i) => i.id === 'mainthread-work-breakdown');
    expect(target).toBeDefined();
    if (target) {
      target.savingsMs = 0;
      target.savingsBytes = 0;
    }
    const delta = diffReanalyzed(stale, base);
    expect(delta.recovered.map((entry) => entry.insightId)).not.toContain('mainthread-work-breakdown');
    expect(delta.phantomZeroes).toContain('mainthread-work-breakdown');
    expect(delta.changed).toBe(true);
  });

  it('counts a byte recovery even when the time axis has nothing to recover', () => {
    const stale = structuredClone(base);
    const target = stale.insights.find((i) => i.id === 'unused-javascript');
    if (target) {
      target.savingsMs = 0;
      target.savingsBytes = 0;
    }
    const delta = diffReanalyzed(stale, base);
    const entry = delta.recovered.find((change) => change.insightId === 'unused-javascript');
    // 120400 + 57200 + 28000 from the retained rows.
    expect(entry?.afterBytes).toBe(205_600);
    expect(entry?.afterMs).toBeNull();
  });

  it('reports a change in which metrics fail', () => {
    const stale = structuredClone(base);
    stale.targets.gaps = stale.targets.gaps.map((gap) =>
      gap.metric === 'fcp' ? { ...gap, meets: true } : gap,
    );
    const delta = diffReanalyzed(stale, base);
    expect(delta.changed).toBe(true);
    expect(delta.failingBefore).not.toEqual(delta.failingAfter);
  });

  it('reports a change in the overall verdict', () => {
    const stale = structuredClone(base);
    stale.targets.meetsTarget = true;
    expect(diffReanalyzed(stale, base).changed).toBe(true);
  });

  it('sorts the biggest recovered figure first', () => {
    const stale = structuredClone(base);
    for (const insight of stale.insights) {
      insight.savingsMs = 0;
      insight.savingsBytes = 0;
    }
    const delta = diffReanalyzed(stale, base);
    const size = (entry: (typeof delta.recovered)[number]): number =>
      (entry.afterMs ?? 0) + (entry.afterBytes ?? 0) / 1024;
    const sizes = delta.recovered.map(size);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });
});
