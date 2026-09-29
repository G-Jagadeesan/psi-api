import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AggregatedReport, Gap, Metrics, Strategy, TargetComparison } from './types.js';

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

/** Compare the chosen-stat headline against the strategy's targets. */
export function compareToTargets(
  report: Pick<AggregatedReport, 'headline' | 'strategy'>,
  targets?: Targets,
): TargetComparison {
  const config = targets ?? loadTargets();
  const targetSet = config[report.strategy] ?? {};
  const actual: Record<string, number> = {
    score: report.headline.score,
    ...(report.headline.metrics as Metrics),
  };

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
    gaps.push({
      metric,
      actual: value,
      target,
      delta: roundDelta(value - target),
      meets,
    });
  }

  return {
    strategy: report.strategy,
    targets: targetSet,
    // A target we could not measure must not be silently treated as a pass,
    // otherwise an incomplete run would look like a successful optimization.
    meetsTarget:
      Object.keys(targetSet).length > 0 && unmeasured.length === 0 && gaps.every((gap) => gap.meets),
    gaps,
  };
}

export function applyTargets(report: AggregatedReport, targets?: Targets): AggregatedReport {
  return { ...report, targets: compareToTargets(report, targets) };
}
