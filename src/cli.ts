import { config as loadEnv } from 'dotenv';
import { pathToFileURL } from 'node:url';
import { runReport, MAX_RUNS, InsufficientRunsError } from './runner.js';
import { filterInsights } from './insights.js';
import { diagnose as diagnoseReport, METRIC_LABELS } from './diagnose.js';
import { loadTargets } from './targets.js';
import { loadReport } from './storage.js';
import { STATS, STRATEGIES, type AggregatedReport, type MetricKey, type SortField, type SortOrder } from './types.js';
import type { FilterGroup, InsightFilters } from './types.js';
import { UrlValidationError } from './psiClient.js';

loadEnv();

const FILTER_GROUPS = ['opportunity', 'diagnostic', 'passed', 'informative'] as const;
const SORT_FIELDS = ['savingsMs', 'savingsBytes', 'score', 'firstPartyShare'] as const;
const ORDERS = ['asc', 'desc'] as const;
const PARTIES = ['any', 'first', 'third'] as const;

interface CliOptions {
  /** Re-filter an already stored report instead of spending more quota. */
  reportId?: string;
  url: string;
  strategy: (typeof STRATEGIES)[number];
  runs: number;
  stat: (typeof STATS)[number];
  group?: FilterGroup[];
  minSavingsMs?: number;
  minSavingsBytes?: number;
  maxScore?: number;
  metric?: MetricKey[];
  search?: string;
  id?: string[];
  hasItems?: boolean;
  party: (typeof PARTIES)[number];
  minFirstPartyRatio?: number;
  sortBy: SortField;
  order: SortOrder;
  limit?: number;
  includeFlaky: boolean;
  json: boolean;
  noSave: boolean;
  /** Rank the work queue and print a diagnosis instead of a flat insight list. */
  diagnose: boolean;
}

const USAGE = `
psi - PageSpeed Insights report

Usage:
  npm run psi -- <url> [options]

Options:
  --reportId <id>        Re-filter a stored report instead of running PSI
  --runs <n>              Number of PSI runs (1-${MAX_RUNS}, default 10)
  --stat <mean|median|mode> Headline statistic (default median)
  --strategy <mobile|desktop>
                          Lighthouse strategy (default mobile)
  --group <list>          Comma separated: opportunity,diagnostic,passed,informative
  --minSavingsMs <n>      Only insights saving at least n ms
  --minSavingsBytes <n>   Only insights saving at least n bytes
  --maxScore <n>          Only insights scoring at or below n (e.g. 0.9)
  --metric <list>         Comma separated: lcp,tbt,cls,fcp,speedIndex,tti,ttfb,inp
  --search <text>         Case-insensitive match on audit id or title
  --id <list>             Comma separated audit ids
  --hasItems              Only insights that carry a details item list
  --party <any|first|third>  Whose cost counts (default any)
                          first = keep everything you own any part of; drops ONLY
                           findings that are entirely somebody else's cost. A mixed
                           finding (your CSS + a vendor stylesheet) is KEPT - you
                           still own most of that fix.
  --minFirstPartyRatio <n>  Keep insights whose cost is at least n yours (0-1)
  --sortBy <field>        savingsMs | savingsBytes | score | firstPartyShare
                           (default savingsMs)
  --order <asc|desc>      default desc (most savings first)
  --limit <n>             Max insights to print
  --noFlaky               Hide insights seen in fewer than 30% of runs
  --diagnose              Rank the work queue against the metrics that are
                           actually failing, and print the diagnosis
  --json                  Machine-readable JSON
  --no-save               Do not write the report to data/
  -h, --help              This message

Examples:
  npm run psi -- https://example.com --runs 10
  npm run psi -- https://example.com --group opportunity,diagnostic --maxScore 0.9
  npm run psi -- --reportId 2026-09-29T10-30-00Z-mobile --metric lcp

Use "npm run --silent psi -- ..." for --json, so npm's banner does not
end up in your stdout.
`;

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) fail(`${flag} requires a value`);
  return value;
}

function toNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${flag} expects a number, got "${value}"`);
  return parsed;
}

function csv<T extends readonly string[]>(value: string, allowed: T, flag: string): T[number][] {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (!(allowed as readonly string[]).includes(part)) {
      fail(`${flag}: "${part}" is not one of ${allowed.join(', ')}`);
    }
  }
  return parts as T[number][];
}

export function parseArgs(argv: string[]): CliOptions | null {
  if (argv.includes('-h') || argv.includes('--help')) return null;

  const positional: string[] = [];
  let reportId: string | undefined;
  let strategy: (typeof STRATEGIES)[number] = 'mobile';
  let runs = 10;
  let stat: (typeof STATS)[number] = 'median';
  let group: FilterGroup[] | undefined;
  let metric: MetricKey[] | undefined;
  let id: string[] | undefined;
  let search: string | undefined;
  let minSavingsMs: number | undefined;
  let minSavingsBytes: number | undefined;
  let maxScore: number | undefined;
  let hasItems: boolean | undefined;
  let party: (typeof PARTIES)[number] = 'any';
  let minFirstPartyRatio: number | undefined;
  let diagnoseFlag = false;
  let sortBy: SortField = 'savingsMs';
  let order: SortOrder = 'desc';
  let limit: number | undefined;
  let includeFlaky = true;
  let json = false;
  let noSave = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case '--reportId': {
        reportId = takeValue(argv, i, arg);
        i += 1;
        break;
      }
      case '--strategy': {
        const value = takeValue(argv, i, arg);
        if (!(STRATEGIES as readonly string[]).includes(value)) {
          fail(`--strategy must be one of ${STRATEGIES.join(', ')}`);
        }
        strategy = value as (typeof STRATEGIES)[number];
        i += 1;
        break;
      }
      case '--stat': {
        const value = takeValue(argv, i, arg);
        if (!(STATS as readonly string[]).includes(value)) {
          fail(`--stat must be one of ${STATS.join(', ')}`);
        }
        stat = value as (typeof STATS)[number];
        i += 1;
        break;
      }
      case '--runs': {
        runs = Math.floor(toNumber(takeValue(argv, i, arg), arg));
        i += 1;
        break;
      }
      case '--group':
        group = csv(takeValue(argv, i, arg), FILTER_GROUPS, arg) as FilterGroup[];
        i += 1;
        break;
      case '--metric':
        metric = csv(takeValue(argv, i, arg), [
          'fcp',
          'lcp',
          'tbt',
          'cls',
          'speedIndex',
          'tti',
          'ttfb',
          'inp',
        ], arg) as MetricKey[];
        i += 1;
        break;
      case '--id':
        id = takeValue(argv, i, arg)
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
        i += 1;
        break;
      case '--search':
        search = takeValue(argv, i, arg);
        i += 1;
        break;
      case '--minSavingsMs':
        minSavingsMs = toNumber(takeValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--minSavingsBytes':
        minSavingsBytes = toNumber(takeValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--maxScore':
        maxScore = toNumber(takeValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--party': {
        const value = takeValue(argv, i, arg);
        if (!PARTIES.includes(value as (typeof PARTIES)[number])) {
          fail(`--party must be one of: ${PARTIES.join(', ')}`);
        }
        party = value as (typeof PARTIES)[number];
        i += 1;
        break;
      }
      case '--minFirstPartyRatio': {
        const value = toNumber(takeValue(argv, i, arg), arg);
        if (value < 0 || value > 1) fail('--minFirstPartyRatio must be between 0 and 1');
        minFirstPartyRatio = value;
        i += 1;
        break;
      }
      case '--diagnose':
        diagnoseFlag = true;
        break;
      case '--hasItems':
        hasItems = true;
        break;
      case '--noItems':
        hasItems = false;
        break;
      case '--sortBy': {
        const value = takeValue(argv, i, arg);
        if (!(SORT_FIELDS as readonly string[]).includes(value)) {
          fail(`--sortBy must be one of ${SORT_FIELDS.join(', ')}`);
        }
        sortBy = value as SortField;
        i += 1;
        break;
      }
      case '--order': {
        const value = takeValue(argv, i, arg);
        if (!(ORDERS as readonly string[]).includes(value)) {
          fail(`--order must be one of ${ORDERS.join(', ')}`);
        }
        order = value as SortOrder;
        i += 1;
        break;
      }
      case '--limit':
        limit = Math.floor(toNumber(takeValue(argv, i, arg), arg));
        i += 1;
        break;
      case '--noFlaky':
        includeFlaky = false;
        break;
      case '--json':
        json = true;
        break;
      case '--no-save':
        noSave = true;
        break;
      default:
        if (arg.startsWith('-')) fail(`unknown option ${arg}`);
        positional.push(arg);
    }
  }

  const url = positional[0];
  if (!url && !reportId) fail(`a url or --reportId is required\n${USAGE}`);
  if (url && positional.length > 1) fail(`unexpected argument "${positional[1]}"`);
  if (runs < 1 || runs > MAX_RUNS) fail(`--runs must be between 1 and ${MAX_RUNS}`);

  return {
    url: url ?? '',
    reportId,
    strategy,
    runs,
    stat,
    group,
    metric,
    id,
    search,
    minSavingsMs,
    minSavingsBytes,
    maxScore,
    hasItems,
    party,
    minFirstPartyRatio,
    sortBy,
    order,
    limit,
    includeFlaky,
    json,
    noSave,
    diagnose: diagnoseFlag,
  };
}

/* -------------------------------- rendering --------------------------------- */

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

const color = (code: string, text: string, enabled: boolean) => (enabled ? `${code}${text}${RESET}` : text);

function scoreColor(score: number, useColor: boolean): string {
  if (score >= 90) return color(GREEN, String(score), useColor);
  if (score >= 50) return color(YELLOW, String(score), useColor);
  return color(RED, String(score), useColor);
}

function formatMs(value: number | undefined): string {
  return value === undefined ? '-' : `${Math.round(value)}ms`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

/** Filters the CLI applies to a stored report. Shared by both renderers. */
function filtersFrom(options: CliOptions): InsightFilters {
  return {
    group: options.group,
    minSavingsMs: options.minSavingsMs,
    minSavingsBytes: options.minSavingsBytes,
    maxScore: options.maxScore,
    metric: options.metric,
    search: options.search,
    id: options.id,
    hasItems: options.hasItems,
    party: options.party,
    minFirstPartyRatio: options.minFirstPartyRatio,
    sortBy: options.sortBy,
    order: options.order,
    limit: options.limit,
    includeFlaky: options.includeFlaky,
  };
}

function renderHuman(options: CliOptions, report: Awaited<ReturnType<typeof runReport>>['report']): string {
  if (options.diagnose) return renderDiagnosis(report, options);

  const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
  const insights = filterInsights(report.insights, filtersFrom(options));

  const lines: string[] = [];

  lines.push('');
  lines.push(`${color(BOLD, report.url, useColor)}  ${color(DIM, `[${report.strategy}]`, useColor)}`);
  lines.push(
    `${color(DIM, 'score', useColor)} ${scoreColor(report.headline.score, useColor)}/100  ` +
      `${color(DIM, `(${report.stat} of ${report.runsSucceeded}/${report.runsRequested} runs)`, useColor)}`,
  );

  const metricLabels: Array<[MetricKey, string]> = [
    ['lcp', 'LCP'],
    ['tbt', 'TBT'],
    ['cls', 'CLS'],
    ['fcp', 'FCP'],
    ['speedIndex', 'SI'],
  ];
  const metricsLine = metricLabels
    .filter(([key]) => report.headline.metrics[key] !== undefined)
    .map(([key, label]) => {
      const raw = report.headline.metrics[key] as number;
      const target = report.targets.targets[key];
      const value = key === 'cls' ? raw.toFixed(3) : formatMs(raw);
      const gap = report.targets.gaps.find((g) => g.metric === key);
      const mark = target === undefined ? '' : gap?.meets ? ' ' : color(RED, '!', useColor);
      return `${label} ${value}${mark}`;
    })
    .join('  ');
  if (metricsLine) lines.push(metricsLine);

  // Tail percentiles, because a budget describes real sessions rather than the
  // middle of the distribution. On a page whose score splits into two lanes the
  // p75 is the number that predicts what a user actually sees.
  const spread = `spread: score p25 ${report.score.p25} p75 ${report.score.p75} p95 ${report.score.p95} · stddev ${report.score.stddev.toFixed(1)}`;
  lines.push(color(DIM, spread, useColor));
  if (report.distributions?.score?.bimodal) {
    lines.push(color(YELLOW, `  bimodal: ${report.distributions.score.note}`, useColor));
  }

  const status = report.targets.meetsTarget
    ? color(GREEN, 'MEETS TARGET', useColor)
    : color(RED, 'BELOW TARGET', useColor);
  const failing = report.targets.gaps
    .filter((gap) => !gap.meets)
    .map((gap) => {
      const delta = `${gap.delta > 0 ? '+' : ''}${gap.delta}`;
      // Surface the pass rate next to any gap, since a median-only verdict hides
      // runs that bust the budget.
      const rate = gap.passRate === undefined ? '' : ` (${Math.round(gap.passRate * 100)}% of runs in budget)`;
      return `${gap.metric} ${delta}${rate}`;
    })
    .join(' ');
  lines.push(failing ? `${status}  ${color(DIM, failing, useColor)}` : status);

  if (report.targets.medianPass && !report.targets.meetsTarget) {
    lines.push(
      color(
        YELLOW,
        '  note: every median is inside budget, but too few individual runs are. Judged on the tail.',
        useColor,
      ),
    );
  }
  for (const reason of report.targets.blockedBy ?? []) {
    lines.push(color(YELLOW, `  blocked: ${reason}`, useColor));
  }

  lines.push('');
  lines.push(color(BOLD, `INSIGHTS (${insights.length} of ${report.insights.length})`, useColor));
  if (insights.length === 0) {
    lines.push(color(DIM, '  nothing matched the given filters', useColor));
  } else {
    lines.push(
      color(
        DIM,
        `  ${pad('SAVING', 9)}${pad('ID', 42)}${pad('GROUP', 15)}${pad('METRIC', 11)}ITEMS`,
        useColor,
      ),
    );
    for (const insight of insights) {
      const saving =
        insight.savingsMs !== null && insight.savingsMs > 0 ? formatMs(insight.savingsMs) : '-';
      const affected = (insight.metricsAffected ?? []).slice(0, 2).join(',') || '-';
      const items = insight.itemsTotal ?? insight.items?.length ?? 0;
      lines.push(
        `  ${pad(saving, 9)}${pad(insight.id, 42)}${pad(insight.group, 13)}${pad(affected, 9)}${items}` +
          (insight.flaky ? color(YELLOW, ' flaky', useColor) : '') +
          // Mixed findings are the ones `--party first` used to hide, so mark them.
          (insight.firstPartyShare !== null && insight.firstPartyShare !== undefined && insight.firstPartyShare < 1
            ? color(DIM, ` ${Math.round(insight.firstPartyShare * 100)}% first-party`, useColor)
            : ''),
      );
    }
  }

  const failed = report.errors.filter((error) => error.message);
  if (failed.length > 0) {
    lines.push('');
    lines.push(color(YELLOW, `${failed.length} run(s) failed:`, useColor));
    for (const failure of failed.slice(0, 3)) {
      lines.push(color(DIM, `  run ${failure.run}: ${failure.message}`, useColor));
    }
  }

  lines.push('');
  lines.push(color(DIM, `reportId ${report.reportId}`, useColor));
  lines.push('');
  return lines.join('\n');
}

/**
 * The diagnosis view: what is failing, what to do about it, and what to ignore.
 *
 * This exists because the flat insight table answers "what did Lighthouse find"
 * but not "what should I work on". Ranking by raw savings optimises whatever is
 * biggest; ranking against the metrics that actually fail optimises the page.
 */
function renderDiagnosis(report: AggregatedReport, options: CliOptions): string {
  const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
  const diagnosis = diagnoseReport(report, {
    filters: {
      group: options.group ?? ['opportunity', 'diagnostic'],
      party: options.party,
      minFirstPartyRatio: options.minFirstPartyRatio,
      sortBy: options.sortBy,
      limit: options.limit,
      includeFlaky: options.includeFlaky,
    },
  });

  const lines: string[] = [];
  lines.push('');
  lines.push(`${color(BOLD, report.url, useColor)}  ${color(DIM, `[${report.strategy}]`, useColor)}`);
  lines.push(
    `${color(DIM, 'score', useColor)} ${scoreColor(report.headline.score, useColor)}/100  ` +
      color(DIM, `(${report.stat} of ${report.runsSucceeded}/${report.runsRequested} runs)`, useColor),
  );
  lines.push(
    color(
      DIM,
      `p25 ${report.score.p25} · p75 ${report.score.p75} · p95 ${report.score.p95} · ` +
        `stddev ${report.score.stddev.toFixed(1)}`,
      useColor,
    ),
  );

  lines.push('');
  lines.push(color(BOLD, 'METRICS OVER BUDGET', useColor));
  if (diagnosis.priorityOrder.length === 0) {
    lines.push(color(GREEN, '  every measured metric is inside its budget', useColor));
  } else {
    for (const gap of diagnosis.priorityOrder) {
      const label = METRIC_LABELS[gap.metric] ?? gap.metric.toUpperCase();
      const pct = gap.passRate === undefined ? '' : `  pass ${Math.round(gap.passRate * 100)}%`;
      lines.push(`  ${color(RED, label, useColor)} ${gap.actual} vs ${gap.target} (${gap.delta > 0 ? '+' : ''}${gap.delta})${pct}`);
    }
  }

  if (diagnosis.blocked.length > 0) {
    lines.push('');
    lines.push(color(YELLOW, 'NOT REACHABLE FROM THE FRONTEND', useColor));
    for (const reason of diagnosis.blocked) lines.push(color(DIM, `  ${reason}`, useColor));
  }

  const lcp = report.lcp;
  if (lcp) {
    lines.push('');
    lines.push(color(BOLD, 'LCP ELEMENT', useColor));
    lines.push(
      color(
        DIM,
        `  ${lcp.isText ? 'text node' : `${lcp.elementType ?? 'image'} element`}` +
          `${lcp.text ? ` - "${lcp.text.slice(0, 60)}"` : ''}`,
        useColor,
      ),
    );
    const phaseEntries = Object.entries(lcp.phases).filter(([, v]) => typeof v === 'number') as Array<
      [string, number]
    >;
    if (phaseEntries.length > 0) {
      lines.push(
        color(
          DIM,
          '  phases: ' +
            phaseEntries
              .sort((a, b) => b[1] - a[1])
              .map(([key, value]) => `${key} ${Math.round(value)}ms`)
              .join(' · '),
          useColor,
        ),
      );
    }
    lines.push(color(DIM, `  dominant: ${lcp.bottleneck}`, useColor));
  }

  lines.push('');
  lines.push(color(BOLD, 'WORK QUEUE', useColor));
  if (diagnosis.ranked.length === 0) {
    lines.push(color(DIM, '  nothing actionable against the failing metrics', useColor));
  } else {
    for (const entry of diagnosis.ranked) {
      const saving = entry.insight.savingsMs !== null && entry.insight.savingsMs > 0 ? formatMs(entry.insight.savingsMs) : '-';
      const share = entry.firstPartyShare === null ? 'unattributed' : `${Math.round(entry.firstPartyShare * 100)}%`;
      lines.push(
        `  ${color(DIM, `#${entry.rank}`, useColor)} ${pad(saving, 8)}${pad(entry.insight.id, 40)}${pad(share, 14)}${color(DIM, entry.reason, useColor)}`,
      );
      if (entry.sop) {
        lines.push(color(DIM, `      ${entry.sop.sop}  ${entry.sop.action}`, useColor));
      }
      if (entry.thirdPartyOnly) {
        lines.push(color(YELLOW, '      third-party cost - log as "not actionable in repo"', useColor));
      }
    }
  }

  if (diagnosis.cautions.length > 0) {
    lines.push('');
    lines.push(color(BOLD, 'READ THIS BEFORE TRUSTING THE NUMBERS', useColor));
    for (const caution of diagnosis.cautions) lines.push(color(YELLOW, `  ! ${caution}`, useColor));
  }

  if (diagnosis.exhausted) {
    lines.push('');
    lines.push(
      color(
        GREEN,
        'STOP: no first-party work remains against the failing metrics. Report and escalate.',
        useColor,
      ),
    );
  }

  lines.push('');
  lines.push(color(DIM, `reportId ${report.reportId}`, useColor));
  lines.push('');
  return lines.join('\n');
}

/* ----------------------------------- main ----------------------------------- */

async function loadStoredReport(reportId: string): Promise<AggregatedReport> {
  const report = await loadReport(reportId);
  if (!report) fail(`no stored report "${reportId}" - run a report first without --reportId`);
  return report;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  if (!options) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    // Re-filtering a stored report costs no quota, so it short-circuits the run.
    const warnings: string[] = [];
    let report: AggregatedReport;

    if (options.reportId) {
      report = await loadStoredReport(options.reportId);
    } else {
      const result = await runReport({
        url: options.url,
        strategy: options.strategy,
        runs: options.runs,
        stat: options.stat,
        save: !options.noSave,
        targets: loadTargets(),
        onRetry: ({ reason, delayMs }) => {
          if (!options.json) {
            process.stderr.write(`${color(YELLOW, 'retry', false)}: ${reason} (${delayMs}ms)\n`);
          }
        },
        onRunFinished: ({ run, ok, score, error }) => {
          if (options.json) return;
          if (ok) {
            process.stderr.write(
              `  run ${run}/${options.runs}: score ${Math.round(score as number)}\n`,
            );
          } else {
            process.stderr.write(`  run ${run}/${options.runs}: failed - ${error}\n`);
          }
        },
      });
      report = result.report;
      warnings.push(...result.warnings);
    }

    for (const warning of warnings) {
      process.stderr.write(`${color(YELLOW, 'warning', false)}: ${warning}\n`);
    }

    if (options.json) {
      const insights = filterInsights(report.insights, filtersFrom(options));
      // The diagnosis is included because a machine consumer needs the same
      // ranking a human gets from --diagnose, without running two commands.
      const diagnosis = options.diagnose
        ? diagnoseReport(report, { filters: filtersFrom(options) })
        : undefined;
      process.stdout.write(
        `${JSON.stringify(
          { ...report, matchedInsights: insights, ...(diagnosis ? { diagnosis } : {}), warnings },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(`${renderHuman(options, report)}\n`);
    }

    return 0;
  } catch (error) {
    if (error instanceof UrlValidationError) {
      process.stderr.write(`error: ${error.message}\n`);
      for (const warning of error.warnings) process.stderr.write(`warning: ${warning}\n`);
      return 1;
    }
    if (error instanceof InsufficientRunsError) {
      process.stderr.write(`error: ${error.message}\n`);
      return 1;
    }
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
