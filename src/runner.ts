import type {
  AggregatedReport,
  NormalizedReport,
  RunFailure,
  Stat,
  Strategy,
} from './types.js';
import { aggregateReports, MIN_SUCCESS_RATIO } from './aggregate.js';
import { normalizeReport } from './insights.js';
import { PsiError, runPsiCall, validateTargetUrl, type RetryInfo } from './psiClient.js';
import { applyTargets, loadTargets, type Targets } from './targets.js';
import { makeReportId, saveReport } from './storage.js';

export const MAX_RUNS = 25;
export const DEFAULT_RUNS = 10;
export const DEFAULT_CONCURRENCY = 2;

export interface RunnerOptions {
  url: string;
  strategy?: Strategy;
  runs?: number;
  stat?: Stat;
  categories?: string[];
  apiKey?: string;
  concurrency?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
  /** Set false to skip writing to disk (used by tests). */
  save?: boolean;
  dataDir?: string;
  targets?: Targets;
  onRetry?: (info: RetryInfo) => void;
  onRunFinished?: (info: { run: number; ok: boolean; score?: number; error?: string }) => void;
  signal?: AbortSignal;
}

export interface RunnerResult {
  report: AggregatedReport;
  runs: NormalizedReport[];
  warnings: string[];
  dir?: string;
}

export function resolveConcurrency(): number {
  const parsed = Number(process.env.PSI_CONCURRENCY);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CONCURRENCY;
  return Math.min(Math.floor(parsed), 10);
}

export class InsufficientRunsError extends Error {
  readonly succeeded: number;
  readonly requested: number;

  constructor(succeeded: number, requested: number, failures: RunFailure[]) {
    const detail = failures
      .slice(0, 3)
      .map((failure) => `run ${failure.run}: ${failure.message}`)
      .join('; ');
    super(
      `Only ${succeeded} of ${requested} PSI runs succeeded ` +
        `(need at least ${Math.ceil(requested * MIN_SUCCESS_RATIO)}). ${detail}`,
    );
    this.name = 'InsufficientRunsError';
    this.succeeded = succeeded;
    this.requested = requested;
  }
}

/** Run PSI N times with bounded concurrency, then aggregate, score and persist. */
export async function runReport(options: RunnerOptions): Promise<RunnerResult> {
  const {
    url,
    strategy = 'mobile',
    runs = DEFAULT_RUNS,
    stat = 'median',
    categories = ['performance'],
    apiKey = process.env.PSI_API_KEY,
    concurrency = resolveConcurrency(),
    save = true,
    dataDir,
    targets,
    onRetry,
    onRunFinished,
    signal,
  } = options;

  const runCount = Math.max(1, Math.min(Math.floor(runs) || 1, MAX_RUNS));
  const { url: validatedUrl, warnings } = validateTargetUrl(url);

  const reports: Array<{ runNumber: number; report: NormalizedReport }> = [];
  const failures: RunFailure[] = [];

  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, runCount));

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= runCount) return;

      const runNumber = index + 1;

      try {
        const result = await runPsiCall({
          url: validatedUrl,
          strategy,
          categories,
          apiKey,
          fetchImpl: options.fetchImpl,
          sleepImpl: options.sleepImpl,
          randomImpl: options.randomImpl,
          onRetry,
          signal,
        });
        const normalized = normalizeReport(result.raw, validatedUrl, strategy);
        reports.push({ runNumber, report: normalized });
        onRunFinished?.({ run: runNumber, ok: true, score: normalized.score });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ run: runNumber, message });
        onRunFinished?.({ run: runNumber, ok: false, error: message });
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Deterministic ordering regardless of which worker finished first.
  reports.sort((a, b) => a.runNumber - b.runNumber);
  failures.sort((a, b) => a.run - b.run);
  const ordered = reports.map((entry) => entry.report);

  if (reports.length === 0) {
    throw new InsufficientRunsError(0, runCount, failures);
  }
  if (reports.length < Math.ceil(runCount * MIN_SUCCESS_RATIO)) {
    throw new InsufficientRunsError(reports.length, runCount, failures);
  }

  const reportId = makeReportId(validatedUrl, strategy);
  let aggregated = aggregateReports(ordered, {
    stat,
    reportId,
    runsRequested: runCount,
    errors: failures,
  });
  aggregated = applyTargets(aggregated, targets ?? loadTargets());

  // PSI caches per-URL, so N runs of one URL can collapse into a single cached
  // report repeated N times. The median would then be one sample wearing 10 hats.
  const runWarnings = [...warnings];
  if (ordered.length > 1) {
    const stamps = new Set(ordered.map((report) => report.fetchTime));
    if (stamps.size === 1) {
      runWarnings.push(
        `All ${ordered.length} runs returned the same analysis timestamp, so PSI served one ` +
          'cached report instead of re-measuring. The median and stddev here are not ' +
          'independent samples and must not be used to judge a change. Re-run after the ' +
          'PSI cache expires, or check that the cache-busting param is reaching the target URL.',
      );
    } else if (stamps.size < ordered.length) {
      runWarnings.push(
        `Only ${stamps.size} distinct measurements across ${ordered.length} runs - some runs ` +
          'were served from the PSI cache.',
      );
    }
  }

  let dir: string | undefined;
  if (save) {
    const saved = await saveReport(aggregated, ordered, dataDir);
    dir = saved.dir;
  }

  const result: RunnerResult = { report: aggregated, runs: ordered, warnings: runWarnings };
  if (dir) result.dir = dir;
  return result;
}

export function isPsiError(error: unknown): error is PsiError {
  return error instanceof PsiError;
}
