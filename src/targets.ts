import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AggregatedReport, Gap, MetricKey, Metrics, Strategy, TargetComparison } from './types.js';

const CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'config',
  'targets.json',
);

export type Targets = Record<Strategy, Record<string, number>>;

let cached: Targets | null = null;

export function loadTargets(configPath: string = CONFIG_PATH): Targets {
  if (configPath === CONFIG_PATH && cached) return cached;
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Targets;
  if (configPath === CONFIG_PATH) cached = raw;
  return raw;
}

/**
 * Metrics where a *higher* number is worse, so a run passes only when
 * `actual <= target`. `score` is inverted: higher is better.
 */
const LOWER_IS_BETTER = new Set(['lcp', 'tbt', 'cls', 'fcp', 'speedIndex', 'tti', 'ttfb', 'inp']);

/** Sub-100 gaps keep two decimals (CLS needs them); larger ones round to whole units. */
function roundDelta(value: number): number {
  return Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
}

/**
 * Share of runs that must be inside budget for a metric to count as met.
 *
 * A budget is a promise about real sessions, so it is judged on the tail. The
 * previous behaviour compared the *median* alone, which reported a pass while a
 * fifth of measurements were over budget - and those over-budget runs are
 * precisely the ones dragging the score down.
 */
export const DEFAULT_MIN_PASS_RATE = 0.9;

const EPSILON = 1e-9;

/** Round to 4dp like the rest of the aggregation, avoiding float noise in deltas. */
function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Whether the gap's *headline* sits inside budget, ignoring run-to-run spread.
 *
 * `gap.meets` is the graded verdict and already accounts for the pass rate, so
 * it cannot be used to answer "would this have passed on the median alone?".
 * Callers that need to distinguish "fails outright" from "passes on the median
 * but fails on the tail" - which are very different problems - use this instead.
 */
export function medianMeets(gap: Gap): boolean {
  const lowerIsBetter = LOWER_IS_BETTER.has(gap.metric);
  return lowerIsBetter ? gap.actual <= gap.target + EPSILON : gap.actual >= gap.target - EPSILON;
}

/**
 * Which gaps cannot be closed by frontend work at all.
 *
 * When TTFB alone already meets or exceeds a budget, no component change can get
 * that metric under it. Saying so lets the optimization loop escalate instead of
 * spending every remaining iteration on a number it structurally cannot reach.
 */
export function blockedByPlatform(report: Pick<AggregatedReport, 'headline' | 'metrics'>, gaps: Gap[]): string[] {
  const reasons: string[] = [];
  const ttfb = report.metrics?.ttfb?.median;
  if (typeof ttfb !== 'number' || !Number.isFinite(ttfb)) return reasons;

  for (const gap of gaps) {
    if (gap.meets) continue;
    // CLS is unitless, so a millisecond floor cannot apply to it.
    if (!LOWER_IS_BETTER.has(gap.metric) || gap.metric === 'cls') continue;
    if (ttfb >= gap.target - EPSILON) {
      reasons.push(
        `${gap.metric}: TTFB alone is ${Math.round(ttfb)}ms against a ${gap.target}ms budget, so no ` +
          'frontend change can meet it - this is a server/CDN problem',
      );
    }
  }
  return reasons;
}

/**
 * Compare the chosen-stat headline against the strategy's targets.
 *
 * When the caller supplies the per-run `metrics` series, every gap also carries
 * its pass rate and tail percentiles, and `meetsTarget` requires the tail to hold
 * up as well as the median.
 */
export function compareToTargets(
  report: Pick<AggregatedReport, 'headline' | 'strategy' | 'metrics'>,
  targets?: Targets,
  options: { minPassRate?: number } = {},
): TargetComparison {
  const config = targets ?? loadTargets();
  const targetSet = config[report.strategy] ?? {};
  const actual: Record<string, number> = {
    score: report.headline.score,
    ...(report.headline.metrics as Metrics),
  };
  const minPassRate = options.minPassRate ?? DEFAULT_MIN_PASS_RATE;
  const series = report.metrics;

  const gaps: Gap[] = [];
  const unmeasured: string[] = [];
  for (const [metric, target] of Object.entries(targetSet)) {
    const value = actual[metric];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      unmeasured.push(metric);
      continue;
    }
    const lowerIsBetter = LOWER_IS_BETTER.has(metric);
    const meets = lowerIsBetter ? value <= target : value >= target;
    const gap: Gap = {
      metric,
      actual: value,
      target,
      delta: roundDelta(value - target),
      meets,
    };

    // Grade the whole distribution when we have it, not just its centre.
    const stats = metric === 'score' ? undefined : series?.[metric as MetricKey];
    if (stats && stats.values.length > 0) {
      let inside = 0;
      for (const sample of stats.values) {
        const ok = lowerIsBetter ? sample <= target + EPSILON : sample >= target - EPSILON;
        if (ok) inside += 1;
      }
      gap.runsMeasured = stats.values.length;
      gap.overBudgetRuns = stats.values.length - inside;
      gap.passRate = round(inside / stats.values.length);
      gap.p75 = stats.p75;
      gap.p95 = stats.p95;
      // A metric whose median passes but whose runs do not reliably pass is
      // reported as failing: the budget describes sessions, not the average one.
      if (meets && gap.passRate < minPassRate - EPSILON) gap.meets = false;
    }

    gaps.push(gap);
  }

  const allMeasuredPass = gaps.every((gap) => gap.meets);
  const medianPass = gaps.every(medianMeets);

  // Rank failing gaps by how far over budget they are *relative to the budget*,
  // so a 400ms LCP miss on a 2500ms budget outranks a 3-point score miss on 90.
  const relativeOvershoot = (gap: Gap): number => {
    const over = gap.metric === 'score' ? -gap.delta : gap.delta;
    return over / (gap.target || 1);
  };
  const worst = gaps.filter((gap) => !gap.meets).reduce<Gap | undefined>(
    (worstSoFar, gap) =>
      worstSoFar === undefined || relativeOvershoot(gap) > relativeOvershoot(worstSoFar) ? gap : worstSoFar,
    undefined,
  );

  const result: TargetComparison = {
    strategy: report.strategy,
    targets: targetSet,
    // A target we could not measure must not be silently treated as a pass,
    // otherwise an incomplete run would look like a successful optimization.
    meetsTarget: Object.keys(targetSet).length > 0 && unmeasured.length === 0 && allMeasuredPass,
    gaps,
  };
  if (worst) result.worstGap = worst;
  result.medianPass = medianPass;
  const blocked = blockedByPlatform(report, gaps);
  if (blocked.length > 0) result.blockedBy = blocked;
  return result;
}

export function applyTargets(report: AggregatedReport, targets?: Targets): AggregatedReport {
  return { ...report, targets: compareToTargets(report, targets) };
}
