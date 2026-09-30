/**
 * Rebuilding a stored report with today's aggregation logic.
 *
 * The aggregation and target logic in this tool has changed several times in
 * ways that alter stored conclusions: budgets are now graded on the tail rather
 * than the median, savings figures are recovered from row data when Lighthouse
 * writes a zero rollup, and metrics report their own distribution instead of a
 * single stddev.
 *
 * A stored `report.json` is a frozen snapshot of whatever those rules produced
 * on the day it was written. Re-filtering it with `--reportId` therefore
 * re-applies *filters* to stale *findings* - it cannot surface anything the
 * older logic missed.
 *
 * What it can do is re-derive the report from the stored runs, which is exactly
 * what this module does. The per-run Lighthouse output is retained, so a report
 * can be upgraded in full without spending a single PSI request.
 *
 * The savings recovery works because a stored run keeps `items` and
 * `displayValue` on every insight. The zero-rollup defect was a decision made
 * during normalization, so it has to be undone at the same level - see
 * `refreshInsightSavings`.
 */

import { aggregateReports } from './aggregate.js';
import { refreshInsightSavings } from './insights.js';
import { applyTargets, type Targets } from './targets.js';
import type {
  AggregatedReport,
  NormalizedReport,
  Stat,
} from './types.js';

export interface ReanalyzeOptions {
  reportId: string;
  stat?: Stat;
  runsRequested?: number;
  targets?: Targets;
}

/** Recompute every insight's savings figure in one stored run. */
export function refreshRun(run: NormalizedReport): NormalizedReport {
  return {
    ...run,
    insights: run.insights.map(refreshInsightSavings),
  };
}

/**
 * Rebuild an aggregated report from stored runs.
 *
 * Everything downstream of normalization is recomputed: insight savings, the
 * aggregated statistics and their distributions, the LCP element detail, and the
 * target comparison including pass rates and platform-blocked metrics. Anything
 * that only exists in the raw Lighthouse response and was never stored cannot be
 * recovered, which is why `refreshRun` works from the retained rows rather than
 * pretending to a full re-normalization.
 */
export function reanalyze(runs: NormalizedReport[], options: ReanalyzeOptions): AggregatedReport {
  if (runs.length === 0) {
    throw new Error(`no stored runs for report "${options.reportId}"`);
  }

  const refreshed = runs.map(refreshRun);
  // `strategy` is not an aggregate option: it is carried on the runs themselves,
  // so the rebuilt report inherits it from the data rather than from the caller.
  const aggregated = aggregateReports(refreshed, {
    reportId: options.reportId,
    stat: options.stat ?? 'median',
    runsRequested: options.runsRequested ?? refreshed.length,
  });

  return options.targets ? applyTargets(aggregated, options.targets) : aggregated;
}

/**
 * What a re-analysis actually changed.
 *
 * Recorded so the operator can see whether an upgrade moved a conclusion, rather
 * than silently overwriting a report and losing the record of what it used to
 * say. A report whose headline, gaps and queue are all unchanged is reported as
 * such, which is the common case and is worth knowing.
 */
export interface RecoveredSaving {
  insightId: string;
  beforeMs: number | null;
  afterMs: number | null;
  beforeBytes: number | null;
  afterBytes: number | null;
  source: string;
}

export interface ReanalyzeDelta {
  reportId: string;
  /**
   * Findings where a real figure was recovered from the retained rows.
   *
   * This is the headline: a stored `0` replaced by a real millisecond or byte
   * count is a cost the tool had been hiding.
   */
  recovered: RecoveredSaving[];
  /**
   * Insights whose stored `0` was simply wrong - it claimed an estimate of zero
   * where Lighthouse gave none at all - and is now correctly `null`.
   *
   * Tracked separately from `recovered` because it is a correction of a phantom
   * number rather than a recovered one, and it is far more common. Reporting the
   * two in one list buries the recoveries under bookkeeping.
   */
  phantomZeroes: string[];
  scoreBefore: number;
  scoreAfter: number;
  /** Metrics that failed before and after, for a before/after diff. */
  failingBefore: string[];
  failingAfter: string[];
  meetsTargetBefore: boolean;
  meetsTargetAfter: boolean;
  changed: boolean;
}

function failingMetrics(report: AggregatedReport): string[] {
  return report.targets?.gaps.filter((gap) => !gap.meets).map((gap) => gap.metric).sort() ?? [];
}

/** Compare a stored report against its re-analyzed replacement. */
export function diffReanalyzed(before: AggregatedReport, after: AggregatedReport): ReanalyzeDelta {
  const beforeInsights = new Map(before.insights.map((insight) => [insight.id, insight]));
  const recovered: RecoveredSaving[] = [];
  const phantomZeroes: string[] = [];

  for (const insight of after.insights) {
    const old = beforeInsights.get(insight.id);
    if (!old) continue;

    const msChanged = old.savingsMs !== insight.savingsMs;
    const bytesChanged = old.savingsBytes !== insight.savingsBytes;
    if (!msChanged && !bytesChanged) continue;

    // "Recovered" means a real number appeared where there was none. A stored
    // `0` going to `null` is the other kind of correction: the old value claimed
    // an estimate of zero when Lighthouse never gave one.
    const gainedMs = old.savingsMs === 0 && insight.savingsMs !== null;
    const gainedBytes = old.savingsBytes === 0 && insight.savingsBytes !== null;
    if (gainedMs || gainedBytes) {
      recovered.push({
        insightId: insight.id,
        beforeMs: old.savingsMs,
        afterMs: insight.savingsMs,
        beforeBytes: old.savingsBytes,
        afterBytes: insight.savingsBytes,
        source: insight.savingsSource ?? 'none',
      });
    } else {
      phantomZeroes.push(insight.id);
    }
  }

  const failingBefore = failingMetrics(before);
  const failingAfter = failingMetrics(after);
  const meetsTargetBefore = before.targets?.meetsTarget ?? false;
  const meetsTargetAfter = after.targets?.meetsTarget ?? false;

  return {
    reportId: after.reportId,
    recovered: recovered.sort((a, b) => {
      const size = (entry: RecoveredSaving): number =>
        (entry.afterMs ?? 0) + (entry.afterBytes ?? 0) / 1024;
      return size(b) - size(a);
    }),
    phantomZeroes,
    scoreBefore: before.headline.score,
    scoreAfter: after.headline.score,
    failingBefore,
    failingAfter,
    meetsTargetBefore,
    meetsTargetAfter,
    changed:
      recovered.length > 0 ||
      phantomZeroes.length > 0 ||
      failingBefore.join(',') !== failingAfter.join(',') ||
      meetsTargetBefore !== meetsTargetAfter,
  };
}
