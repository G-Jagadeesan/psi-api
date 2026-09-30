import type {
  AggregatedInsight,
  AggregatedReport,
  Distribution,
  Insight,
  Lane,
  MetricKey,
  Metrics,
  NormalizedReport,
  RunFailure,
  SavingsSource,
  SeriesStats,
  Stat,
  StatTriple,
} from './types.js';
import { METRIC_KEYS, STATS } from './types.js';
import { lcpDetailFrom } from './insights.js';

export const FLAKY_THRESHOLD = 0.3;
export const MIN_SUCCESS_RATIO = 0.6;

/**
 * Minimum samples before a two-lane split is even attempted.
 *
 * Below this, a "lane" is two or three points and any split is an artefact.
 */
const MIN_LANE_SAMPLES = 6;

/** Both lanes must hold at least this share of the samples to count as real. */
const MIN_LANE_SHARE = 0.2;

/**
 * Separation needed before a split is called bimodal.
 *
 * Calibrated against the observed data rather than guessed. A uniform spread -
 * the best case for "this is just jitter" - scores about 3.2, because splitting
 * a uniform population in half still puts its means half a range apart while its
 * pooled spread stays small. The genuine boundary-cliff case in the stored
 * reports, scores clustered at 87.5-88.5 and 93-95.5, scores about 8.0. 4.0 sits
 * above the jitter ceiling and well below a real split.
 */
const MIN_SEPARATION = 4;

/**
 * Gap between the two lane means before the split is worth *explaining*.
 *
 * Separate from `MIN_SEPARATION`, which decides whether a split exists at all.
 * That threshold is statistical and has to stay low: the reader may want to
 * inspect the lanes even when they are close together. This one is editorial -
 * it decides whether the report interrupts the reader about them - so it is set
 * at the point where two lanes describe two visibly different user experiences
 * rather than ordinary run-to-run variation on a 0-100 score.
 *
 * Six points is the calibration: below it, Lighthouse's own scoring bands put
 * both lanes in the same "needs improvement" region and a reader who is told to
 * "compare lane-to-lane" learns to skip the line. Measured against the observed
 * reports, a lane split of 1.1 points is pure noise and 6.25 is the real
 * boundary case.
 */
export const MIN_NOTE_GAP = 6;

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

/**
 * Linear-interpolated percentile (the PERCENTILE.INC convention).
 *
 * `p` is a fraction in 0-1. Uses the same index formula as `median` so the
 * median stays exactly the p50 of this function - the two can never disagree.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;

  const rank = (sorted.length - 1) * Math.min(Math.max(p, 0), 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower] as number;
  const weight = rank - lower;
  return (sorted[lower] as number) * (1 - weight) + (sorted[upper] as number) * weight;
}

/**
 * How far apart two clusters are, in units of their own spread.
 *
 * 1 means "one continuous population"; large means "two different worlds".
 * Uses the between-cluster separation over the pooled within-cluster variance,
 * which is the ratio that stays meaningful when the overall stddev is inflated
 * by the very gap being measured.
 */
function separation(between: number, withinSquares: number, totalCount: number): number {
  if (withinSquares <= 0) return between > 0 ? Number.POSITIVE_INFINITY : 0;
  // Unbiased pooled within-cluster standard deviation.
  const df = Math.max(totalCount - 2, 1);
  const withinSd = Math.sqrt(withinSquares / df);
  if (withinSd === 0) return between > 0 ? Number.POSITIVE_INFINITY : 0;
  return between / withinSd;
}

/**
 * Split samples into two lanes when they genuinely cluster, rather than smear.
 *
 * The split point is chosen to minimise within-lane variance (Otsu's method in
 * one dimension), so it is not a tunable threshold - it is the best 2-means
 * partition of these samples. Two guards stop it from firing on ordinary noise:
 * each lane must hold `MIN_LANE_SHARE` of the samples, and the separation must
 * exceed `MIN_SEPARATION`.
 *
 * This matters because Lighthouse scores off a log-normal curve. A metric
 * resting on a scoring boundary produces two stable clusters, the median lands
 * in whichever one got more runs, and a single headline number then describes
 * neither lane.
 */
export function detectDistribution(values: number[]): Distribution {
  const empty: Distribution = { bimodal: false, lanes: [], separation: 0 };
  if (values.length < MIN_LANE_SAMPLES) return empty;

  const sorted = [...values].sort((a, b) => a - b);

  let bestSquares = Number.POSITIVE_INFINITY;
  let bestIndex = -1;
  for (let i = 1; i < sorted.length; i += 1) {
    const left = sorted.slice(0, i) as number[];
    const right = sorted.slice(i) as number[];
    // Splitting exactly between two equal values carries no information.
    if (left[left.length - 1] === right[0]) continue;
    const squares = sumSquaredDeviations(left) + sumSquaredDeviations(right);
    if (squares < bestSquares) {
      bestSquares = squares;
      bestIndex = i;
    }
  }
  if (bestIndex < 0) return empty;

  const leftValues = sorted.slice(0, bestIndex) as number[];
  const rightValues = sorted.slice(bestIndex) as number[];
  const leftMean = mean(leftValues);
  const rightMean = mean(rightValues);
  const ratio = separation(Math.abs(rightMean - leftMean), bestSquares, sorted.length);

  const toLane = (vals: number[]): Lane => ({
    from: Math.min(...vals),
    to: Math.max(...vals),
    count: vals.length,
    share: round(vals.length / sorted.length, 4),
    value: round(median(vals), 4),
  });

  const lanes = [toLane(leftValues), toLane(rightValues)];
  const share = Math.min(lanes[0]?.share ?? 0, lanes[1]?.share ?? 0);
  const bimodal = share >= MIN_LANE_SHARE && ratio >= MIN_SEPARATION;

  const result: Distribution = { bimodal, lanes, separation: round(ratio, 2) };
  if (bimodal) {
    const lanesArray = lanes ?? [];
    const [slow, fast] = lanesArray[0] && lanesArray[0]!.value <= (lanesArray[1]?.value ?? 0)
      ? lanesArray
      : [...lanesArray].reverse();
    // The note is the *actionable* half of the claim, and it is gated separately
    // from `bimodal`. Two lanes a point apart on a 0-100 score are a real
    // statistical split but not a difference anyone should act on, and printing
    // "the median sits in one lane by run count" about a 1-point spread trains
    // the reader to ignore the line. Left undefined rather than set to an empty
    // string, so a caller testing for a note sees the same thing either way.
    //
    // Compared on the raw lane means, not on their rounded display values.
    // Rounding first would put the threshold on a step function of its own - a
    // real gap of 6.4 would be suppressed while 6.6 was reported - so the gate
    // would quietly disagree with the measurement it is gating.
    const distance = fast != null && slow != null ? fast.value - slow.value : 0;
    if (distance > MIN_NOTE_GAP) {
      result.note =
        `Bimodal: ${pct(slow?.share ?? 0)} of runs at ~${round(slow?.value ?? 0, 0)} and ` +
        `${pct(fast?.share ?? 0)} at ~${round(fast?.value ?? 0, 0)}. The median sits in one lane ` +
        'by run count, not because the page reliably performs there.';
    }
  }
  return result;
}

function sumSquaredDeviations(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = mean(values);
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0);
}

const pct = (share: number): string => `${Math.round(share * 100)}%`;

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
    p25: round(percentile(values, 0.25), 4),
    p75: round(percentile(values, 0.75), 4),
    p95: round(percentile(values, 0.95), 4),
  };
}

/**
 * Bimodality for one metric, reported under its own key so a caller can compare
 * distributions instead of guessing from a single number.
 */
export function distributionsFor(
  score: SeriesStats,
  metrics: Partial<Record<MetricKey, SeriesStats>>,
): Partial<Record<'score' | MetricKey, Distribution>> {
  const out: Partial<Record<'score' | MetricKey, Distribution>> = {
    score: detectDistribution(score.values),
  };
  for (const key of METRIC_KEYS) {
    const m = metrics[key];
    if (m) out[key] = detectDistribution(m.values);
  }
  return out;
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
/**
 * The run that best represents the headline number: the one whose score is
 * closest to the median, earliest on a tie.
 *
 * Anything that describes "what this report actually saw" - the LCP element, the
 * measurement environment - has to come from this same run, or it risks
 * describing a run the reader is not looking at.
 */
function medianRunOf(reports: NormalizedReport[], medianScore: number): NormalizedReport | undefined {
  return [...reports].sort(
    (a, b) =>
      Math.abs(a.score - medianScore) - Math.abs(b.score - medianScore) ||
      a.fetchTime.localeCompare(b.fetchTime),
  )[0];
}

function aggregateInsights(
  reports: NormalizedReport[],
  medianScore: number,
  stat: Stat,
): AggregatedInsight[] {
  const runsSucceeded = reports.length;
  if (runsSucceeded === 0) return [];

  const byId = accumulateInsights(reports);

  const medianRun = medianRunOf(reports, medianScore);
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
    const aggregateMs = acc.savingsMsValues.length > 0 ? savingsMsStats[stat] : null;
    const aggregateBytes = acc.savingsBytesValues.length > 0 ? savingsBytesStats[stat] : null;

    results.push({
      ...base,
      id,
      score: acc.scoreValues.length > 0 ? scoreStats[stat] : null,
      savingsMs: aggregateMs,
      savingsBytes: aggregateBytes,
      // Always defined, so the label is a statement about the estimate rather
      // than a field that happens to be missing on older rows.
      savingsSource: provenanceFor(fromMedian?.savingsSource ?? base.savingsSource),
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

/**
 * The savings label for an aggregated insight.
 *
 * `savingsSource` answers "which Lighthouse field produced this estimate", and
 * that is a property of the *finding*, not of one run's number: a finding whose
 * cost Lighthouse priced by summing per-item `wastedMs` was priced that way in
 * every run. So the representative run's label carries over, and the only thing
 * to guarantee is that the field is never absent - a missing label reads as a
 * figure nobody can account for, which is a different and worse claim than
 * "this estimate's origin is not recoverable".
 */
function provenanceFor(recorded: SavingsSource | undefined): SavingsSource {
  return recorded ?? 'none';
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
    // The median run, for the same reason `items` come from it: the headline
    // describes that run, so the conditions behind it are that run's.
    environment: medianRunOf(reports, score.median)?.environment ?? {
      lighthouseVersion: first?.lighthouseVersion ?? 'unknown',
    },
    headline: { score: pickStat(score, stat), metrics: headlineMetrics },
    score,
    metrics,
    distributions: distributionsFor(score, metrics),
    lcp: lcpDetailFrom(reports, score.median),
    stats: statsByStat,
    insights: aggregateInsights(reports, score.median, stat),
    fieldData: first?.fieldData ?? null,
    // Filled in by the runner once targets are known.
    targets: { strategy: first?.strategy ?? 'mobile', targets: {}, meetsTarget: false, gaps: [] },
    errors,
  };
}
