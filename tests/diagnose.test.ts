import { describe, expect, it } from 'vitest';
import { aggregateReports } from '../src/aggregate.js';
import { diagnose, INSIGHT_SOP, METRIC_PRIORITY, rankInsights } from '../src/diagnose.js';
import { applyTargets } from '../src/targets.js';
import type { AggregatedInsight, AggregatedReport, Insight } from '../src/types.js';
import { normalizeLh13 } from './helpers.js';

const TARGETS = {
  mobile: { score: 90, lcp: 2500, tbt: 200, cls: 0.1, fcp: 1800, speedIndex: 3400 },
  desktop: { score: 90, lcp: 1800, tbt: 150, cls: 0.1, fcp: 1200, speedIndex: 2400 },
};

/**
 * Build an aggregate from the Lighthouse 13 fixture with explicit per-metric
 * values, so each test controls exactly which metrics fail.
 */
function build(metrics: Record<string, number>, score = 60): AggregatedReport {
  const run = normalizeLh13();
  run.score = score;
  run.fetchTime = '2026-09-30T03-46-22Z';
  run.metrics = metrics as AggregatedReport['metrics'];
  // A single run keeps the headline and the distribution identical, which is
  // what these tests are about - the ranking, not the statistics.
  return applyTargets(aggregateReports([run], { reportId: 'r', runsRequested: 1 }), TARGETS);
}

const PASSING = build({ lcp: 2000, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000, ttfb: 400 }, 95);

describe('METRIC_PRIORITY', () => {
  it('leads with the Core Web Vitals and buries the composite score', () => {
    expect(METRIC_PRIORITY[0]).toBe('lcp');
    expect(METRIC_PRIORITY.indexOf('score')).toBe(-1);
  });

  it('includes FCP, which the old guide omitted entirely', () => {
    // FCP failed on all 20 stored reports while the old priority order started
    // at LCP, so the queue never pointed at it.
    expect(METRIC_PRIORITY).toContain('fcp');
  });
});

describe('priority order', () => {
  it('leads with the metric that is furthest over budget', () => {
    const report = build({ lcp: 4000, tbt: 300, cls: 0.01, fcp: 1500, speedIndex: 3000, ttfb: 400 });
    const result = diagnose(report);
    // LCP is 60% over 2500ms; TBT is 50% over 200ms; score is 30% under 90.
    expect(result.primary?.metric).toBe('lcp');
  });

  it('only lists metrics that are failing', () => {
    const result = diagnose(PASSING);
    expect(result.priorityOrder).toEqual([]);
    expect(result.primary).toBeUndefined();
  });

  it('excludes passing metrics from the queue', () => {
    const report = build({ lcp: 2000, tbt: 300, cls: 0.01, fcp: 1500, speedIndex: 3000, ttfb: 400 });
    const result = diagnose(report);
    expect(result.priorityOrder.map((gap) => gap.metric)).not.toContain('lcp');
  });
});

describe('rankInsights', () => {
  it('assigns sequential ranks with 1 first', () => {
    const ranked = rankInsights(build({ lcp: 2000, tbt: 300, cls: 0.01, fcp: 1500, speedIndex: 3000 }));
    expect(ranked.map((entry) => entry.rank)).toEqual(ranked.map((_, i) => i + 1));
  });

  it('excludes insights that do not touch a failing metric', () => {
    const report = build({ lcp: 2000, tbt: 300, cls: 0.01, fcp: 1500, speedIndex: 3000 });
    const ids = rankInsights(report).map((entry) => entry.insight.id);
    // The insight audits in the fixture are wired to FCP/LCP, not TBT, so none
    // of them belong in a TBT-only queue.
    expect(ids).not.toContain('render-blocking-insight');
  });

  it('surfaces insights that touch the failing metric', () => {
    const report = build({ lcp: 4000, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000 });
    const ids = rankInsights(report).map((entry) => entry.insight.id);
    expect(ids).toContain('render-blocking-insight');
  });

  it('marks a third-party-only finding as such', () => {
    const report = build({ lcp: 4000, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000 });
    const thirdParty = rankInsights(report).find((entry) => entry.insight.id === 'third-parties-insight');
    expect(thirdParty?.thirdPartyOnly).toBe(true);
    expect(thirdParty?.reason).toMatch(/third-party cost only/);
  });

  it('does not mark a mixed finding as third-party-only', () => {
    const report = build({ lcp: 4000, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000 });
    const css = rankInsights(report).find((entry) => entry.insight.id === 'unused-css-rules');
    expect(css?.thirdPartyOnly).toBe(false);
    expect(css?.firstPartyShare).toBe(0.5);
  });

  it('flags an estimate that was parsed out of display text', () => {
    const report = build({ lcp: 4000, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000 });
    const ranked = rankInsights(report);
    const textEstimated = ranked.filter((entry) => entry.estimateFromText);
    // In the fixture every byte figure has a structured source, so none should
    // be attributed to the display string.
    expect(textEstimated).toEqual([]);
  });

  it('routes every finding in the queue to an SOP section', () => {
    const ranked = rankInsights(build({ lcp: 4000, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000 }));
    expect(ranked.length).toBeGreaterThan(0);
    for (const entry of ranked) {
      // A finding with no playbook is a gap in the mapping, not a finding to skip.
      expect(`${entry.insight.id}:${String(entry.sop)}`).not.toMatch(/:undefined$/);
    }
  });

  it('keeps a metric audit out of the work queue', () => {
    const ranked = rankInsights(build({ lcp: 4000, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000 }));
    // `first-contentful-paint` restates the failing number; it is a symptom, not
    // a cause, and the gap list already reports it.
    expect(ranked.map((entry) => entry.insight.id)).not.toContain('first-contentful-paint');
  });

  it('keeps third-party findings visible rather than hiding them', () => {
    const ranked = rankInsights(build({ lcp: 4000, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000 }));
    // Pushing them down must not delete them: the agent needs to see them in
    // order to log them as "not actionable in repo".
    expect(ranked.map((entry) => entry.insight.id)).toContain('third-parties-insight');
    expect(ranked[ranked.length - 1]?.insight.id).toBe('third-parties-insight');
  });

  it('is deterministic', () => {
    const report = build({ lcp: 4000, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000 });
    expect(rankInsights(report).map((e) => e.insight.id)).toEqual(
      rankInsights(report).map((e) => e.insight.id),
    );
  });
});

describe('INSIGHT_SOP', () => {
  it('maps the audits that matter on this page', () => {
    expect(INSIGHT_SOP['unused-css-rules']?.sop).toMatch(/§/);
    expect(INSIGHT_SOP['render-blocking-insight']).toBeDefined();
    expect(INSIGHT_SOP['lcp-breakdown-insight']?.action).toMatch(/phase/);
  });

  it('marks third-party cost as not actionable rather than giving it a section', () => {
    expect(INSIGHT_SOP['third-parties-insight']?.sop).toBe('n/a');
  });
});

describe('cautions', () => {
  it('warns that a text LCP element voids the image playbook', () => {
    const result = diagnose(build({ lcp: 4000, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000 }));
    expect(result.cautions.join(' ')).toMatch(/LCP element is text/);
  });

  it('warns that a pinned metric cannot show a change', () => {
    const runs = Array.from({ length: 3 }, (_, i) => {
      const run = normalizeLh13();
      run.fetchTime = `2026-09-30T03-4${i}-00Z`;
      run.metrics = { lcp: 2401, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000 } as AggregatedReport['metrics'];
      return run;
    });
    const report = applyTargets(aggregateReports(runs, { reportId: 'r', runsRequested: 3 }), TARGETS);
    expect(diagnose(report).cautions.join(' ')).toMatch(/identical across all 3 runs/);
  });

  it('warns when a passing median hides runs over budget', () => {
    const runs = Array.from({ length: 4 }, (_, i) => {
      const run = normalizeLh13();
      run.fetchTime = `2026-09-30T03-4${i}-00Z`;
      const lcp = i === 0 ? 2600 : 2400;
      run.metrics = { lcp, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000 } as AggregatedReport['metrics'];
      return run;
    });
    const report = applyTargets(aggregateReports(runs, { reportId: 'r', runsRequested: 4 }), TARGETS);
    const result = diagnose(report);
    expect(result.unreliable.map((gap) => gap.metric)).toContain('lcp');
  });

  it('warns about a bimodal score', () => {
    const scores = [88, 87.5, 88.5, 88, 93.5, 94, 95.5, 93, 94.5, 95];
    const runs = scores.map((s, i) => {
      const run = normalizeLh13();
      run.fetchTime = `2026-09-30T03-4${i}-00Z`;
      run.score = s;
      run.metrics = { lcp: 2400, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000 } as AggregatedReport['metrics'];
      return run;
    });
    const report = applyTargets(aggregateReports(runs, { reportId: 'r', runsRequested: 10 }), TARGETS);
    expect(diagnose(report).cautions.join(' ')).toMatch(/[Bb]imodal/);
  });
});

describe('exhaustion', () => {
  it('stops when every target is met', () => {
    expect(diagnose(PASSING).exhausted).toBe(true);
  });

  it('stops when nothing actionable is left against a failing metric', () => {
    // Only a third-party finding remains, so the loop should escalate.
    const report = PASSING;
    report.targets.gaps = report.targets.gaps.map((gap) =>
      gap.metric === 'lcp' ? { ...gap, meets: false, actual: 4000, delta: 1500 } : gap,
    );
    const result = diagnose(report, {
      filters: { id: ['third-parties-insight'] } as never,
    });
    expect(result.ranked.every((entry) => entry.thirdPartyOnly)).toBe(true);
    expect(result.exhausted).toBe(true);
  });

  it('keeps going when first-party work remains', () => {
    const result = diagnose(build({ lcp: 4000, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000 }));
    expect(result.exhausted).toBe(false);
  });

  it('carries platform-blocked reasons through', () => {
    const report = build({ lcp: 4000, tbt: 100, cls: 0.01, fcp: 1500, speedIndex: 3000, ttfb: 3000 });
    const result = diagnose(report);
    expect(result.blocked.length).toBeGreaterThan(0);
    expect(result.blocked.join(' ')).toMatch(/server\/CDN/);
  });
});

describe('hand-built insights', () => {
  const base: Insight = {
    id: 'x',
    title: 't',
    description: '',
    score: 0,
    scoreDisplayMode: 'binary',
    group: 'opportunity',
    savingsMs: 100,
    savingsBytes: null,
    firstPartyItems: 1,
    thirdPartyItems: 0,
    itemHosts: ['example.com'],
  };

  const insight = (id: string, extra: Partial<Insight> = {}): AggregatedInsight => ({
    ...base,
    id,
    appearedInRuns: 1,
    runsSucceeded: 1,
    flaky: false,
    stats: { score: { mean: 0, median: 0, mode: 0 }, savingsMs: null, savingsBytes: null },
    ...extra,
  });

  it('ranks a first-party finding above a third-party one of equal size', () => {
    const report = { ...PASSING, targets: { ...PASSING.targets, meetsTarget: false } };
    const withInsights: AggregatedReport = {
      ...report,
      targets: {
        ...report.targets,
        gaps: report.targets.gaps.map((gap) =>
          gap.metric === 'lcp' ? { ...gap, meets: false, actual: 4000, delta: 1500 } : gap,
        ),
      },
      insights: [
        insight('theirs', { firstPartyItems: 0, thirdPartyItems: 2, metricsAffected: ['lcp'] }),
        insight('ours', { metricsAffected: ['lcp'] }),
      ],
    };
    const ranked = rankInsights(withInsights);
    expect(ranked[0]?.insight.id).toBe('ours');
  });

  it('tolerates an insight with no metricsAffected field', () => {
    const report = { ...PASSING, insights: [insight('bare')] };
    expect(() => rankInsights(report)).not.toThrow();
  });
});
