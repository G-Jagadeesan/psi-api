import type {
  AggregatedInsight,
  AggregatedReport,
  Insight,
  MetricKey,
  Metrics,
  NormalizedReport,
  RunFailure,
  SeriesStats,
  Stat,
  StatTriple,
} from './types.js';
import { METRIC_KEYS, STATS } from './types.js';

export const FLAKY_THRESHOLD = 0.3;
export const MIN_SUCCESS_RATIO = 0.6;

/**
 * Bucket width per metric for the `mode` statistic. Continuous values have to be
 * bucketed before "most frequent" means anything.
 */
const BUCKETS: Record<string, number> = {
  score: 1,
  // Audit scores are 0-1, not 0-100, so they need their own bucket width.
  // A width of 1 would collapse every score to 0 or 1 and make mode useless.
  auditScore: 0.05,
  fcp: 100,
  lcp: 100,
  tbt: 100,
  speedIndex: 100,
  tti: 100,
  ttfb: 100,
  inp: 100,
  cls: 0.01,
  savingsMs: 100,
  savingsBytes: 1024,
};

export function bucketWidth(metric: string): number {
  return BUCKETS[metric] ?? 1;
}

export function bucketOf(value: number, width: number): number {
  if (width <= 0) return value;
  return Math.round(value / width) * width;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * Modal bucket. When two or more buckets tie for most frequent the overall
 * median is used instead: a tie means the distribution is flat, and the median
 * is the more honest summary of it.
 */
export function mode(values: number[], width: number): number {
  if (values.length === 0) return 0;
  if (width <= 0) return median(values);

  const counts = new Map<number, number>();
  for (const value of values) {
    const bucket = bucketOf(value, width);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  let best = 0;
  let winners: number[] = [];
  for (const [bucket, count] of counts) {
    if (count > best) {
      best = count;
      winners = [bucket];
    } else if (count === best) {
      winners.push(bucket);
    }
  }

  if (winners.length > 1) return median(values);
  return winners[0] as number;
}

/** Sample standard deviation (n-1). Zero for fewer than 2 samples. */
export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function statTriple(values: number[], metricName: string): StatTriple {
  const width = bucketWidth(metricName);
  return {
    mean: round(mean(values), 4),
    median: round(median(values), 4),
    mode: round(mode(values, width), 4),
  };
}

export function seriesStats(values: number[], metricName: string): SeriesStats {
  const stats = statTriple(values, metricName);
  return {
    ...stats,
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
    stddev: round(stddev(values), 4),
    count: values.length,
    values: [...values],
  };
}

function pickStat(stats: SeriesStats, stat: Stat): number {
  return stats[stat];
}

/** Mutable accumulator while walking the runs. */
interface InsightAccumulator {
  representative: Insight;
  scoreValues: number[];
  savingsMsValues: number[];
  savingsBytesValues: number[];
  appearances: number;
}

function accumulateInsights(reports: NormalizedReport[]): Map<string, InsightAccumulator> {
  const byId = new Map<string, InsightAccumulator>();

  for (const report of reports) {
    for (const insight of report.insights) {
      const existing = byId.get(insight.id);
      if (!existing) {
        byId.set(insight.id, {
          representative: insight,
          scoreValues: insight.score === null ? [] : [insight.score],
          savingsMsValues: insight.savingsMs === null ? [] : [insight.savingsMs],
          savingsBytesValues: insight.savingsBytes === null ? [] : [insight.savingsBytes],
          appearances: 1,
        });
        continue;
      }

      existing.appearances += 1;
      if (insight.score !== null) existing.scoreValues.push(insight.score);
      if (insight.savingsMs !== null) existing.savingsMsValues.push(insight.savingsMs);
      if (insight.savingsBytes !== null) existing.savingsBytesValues.push(insight.savingsBytes);

      // Prefer metadata from an occurrence that actually carries it.
      if (existing.representative.items === undefined && insight.items !== undefined) {
        existing.representative = {
          ...existing.representative,
          items: insight.items,
          itemsTotal: insight.itemsTotal,
        };
      }
      if (existing.representative.metricsAffected === undefined && insight.metricsAffected !== undefined) {
        existing.representative = {
          ...existing.representative,
          metricsAffected: insight.metricsAffected,
        };
      }
      if (existing.representative.displayValue === undefined && insight.displayValue !== undefined) {
        existing.representative = {
          ...existing.representative,
          displayValue: insight.displayValue,
        };
      }
      if (existing.representative.savingsMs === null && insight.savingsMs !== null) {
        existing.representative = { ...existing.representative, savingsMs: insight.savingsMs };
      }
      if (existing.representative.savingsBytes === null && insight.savingsBytes !== null) {
        existing.representative = { ...existing.representative, savingsBytes: insight.savingsBytes };
      }
    }
  }

  return byId;
}

/**
 * Merge per-run insights by audit id.
 *
 * `items` come from the run whose score was closest to the overall median,
 * because that is the run the headline number is describing. A null score
 * (typical for informative audits) stays null rather than collapsing to 0, so
 * downstream `maxScore` filters keep behaving the same as on a single run.
 */
function aggregateInsights(
  reports: NormalizedReport[],
  medianScore: number,
  stat: Stat,
): AggregatedInsight[] {
  const runsSucceeded = reports.length;
  if (runsSucceeded === 0) return [];

  const byId = accumulateInsights(reports);

  const medianRun = [...reports].sort(
    (a, b) =>
      Math.abs(a.score - medianScore) - Math.abs(b.score - medianScore) ||
      a.fetchTime.localeCompare(b.fetchTime),
  )[0];
  const medianRunById = new Map((medianRun?.insights ?? []).map((i) => [i.id, i]));

  const results: AggregatedInsight[] = [];
  for (const [id, acc] of byId) {
    // The median run is the representative view, but it can be missing
    // metadata that another run carried, so fall back field by field.
    const fromMedian = medianRunById.get(id);
    const base: Insight = { ...(fromMedian ?? acc.representative) };
    const fallback = acc.representative;
    if (base.items === undefined && fallback.items !== undefined) {
      base.items = fallback.items;
      base.itemsTotal = fallback.itemsTotal;
    }
    if (base.metricsAffected === undefined && fallback.metricsAffected !== undefined) {
      base.metricsAffected = fallback.metricsAffected;
    }
    if (base.displayValue === undefined && fallback.displayValue !== undefined) {
      base.displayValue = fallback.displayValue;
    }
    if (base.savingsMs === null && fallback.savingsMs !== null) {
      base.savingsMs = fallback.savingsMs;
    }
    if (base.savingsBytes === null && fallback.savingsBytes !== null) {
      base.savingsBytes = fallback.savingsBytes;
    }

    const scoreStats = statTriple(acc.scoreValues, 'auditScore');
    const savingsMsStats = statTriple(acc.savingsMsValues, 'savingsMs');
    const savingsBytesStats = statTriple(acc.savingsBytesValues, 'savingsBytes');

    results.push({
      ...base,
      id,
      score: acc.scoreValues.length > 0 ? scoreStats[stat] : null,
      savingsMs: acc.savingsMsValues.length > 0 ? savingsMsStats[stat] : null,
      savingsBytes: acc.savingsBytesValues.length > 0 ? savingsBytesStats[stat] : null,
      appearedInRuns: acc.appearances,
      runsSucceeded,
      flaky: acc.appearances / runsSucceeded < FLAKY_THRESHOLD,
      stats: {
        score: scoreStats,
        savingsMs: acc.savingsMsValues.length > 0 ? savingsMsStats : null,
        savingsBytes: acc.savingsBytesValues.length > 0 ? savingsBytesStats : null,
      },
    });
  }

  return results;
}

export interface AggregateOptions {
  stat?: Stat;
  reportId?: string;
  runsRequested?: number;
  errors?: RunFailure[];
}

export function aggregateReports(
  reports: NormalizedReport[],
  options: AggregateOptions = {},
): AggregatedReport {
  const { stat = 'median', reportId = '', runsRequested, errors = [] } = options;

  const score = seriesStats(
    reports.map((report) => report.score),
    'score',
  );

  const metrics: Partial<Record<MetricKey, SeriesStats>> = {};
  for (const key of METRIC_KEYS) {
    const values = reports
      .map((report) => report.metrics[key])
      .filter((value): value is number => typeof value === 'number');
    if (values.length > 0) metrics[key] = seriesStats(values, key);
  }

  const headlineMetrics: Metrics = {};
  const statsByStat = {} as AggregatedReport['stats'];
  for (const s of STATS) {
    const perStatMetrics: Metrics = {};
    for (const key of METRIC_KEYS) {
      const m = metrics[key];
      if (m) {
        perStatMetrics[key] = pickStat(m, s);
        if (s === stat) headlineMetrics[key] = pickStat(m, s);
      }
    }
    statsByStat[s] = { score: pickStat(score, s), metrics: perStatMetrics };
  }

  const first = reports[0];

  return {
    reportId,
    url: first?.url ?? '',
    finalUrl: reports.find((r) => r.finalUrl)?.finalUrl ?? '',
    strategy: first?.strategy ?? 'mobile',
    stat,
    runsRequested: runsRequested ?? reports.length,
    runsSucceeded: reports.length,
    generatedAt: new Date().toISOString(),
    lighthouseVersion: first?.lighthouseVersion ?? 'unknown',
    headline: { score: pickStat(score, stat), metrics: headlineMetrics },
    score,
    metrics,
    stats: statsByStat,
    insights: aggregateInsights(reports, score.median, stat),
    fieldData: first?.fieldData ?? null,
    // Filled in by the runner once targets are known.
    targets: { strategy: first?.strategy ?? 'mobile', targets: {}, meetsTarget: false, gaps: [] },
    errors,
  };
}
