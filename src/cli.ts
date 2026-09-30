import { config as loadEnv } from 'dotenv';
import { pathToFileURL } from 'node:url';
import { runReport, MAX_RUNS, InsufficientRunsError } from './runner.js';
import { filterInsights } from './insights.js';
import { diagnose as diagnoseReport, METRIC_LABELS } from './diagnose.js';
import { loadTargets } from './targets.js';
import { loadReport, loadRuns, listReports, getDataDir, saveReport } from './storage.js';
import { diffReanalyzed, reanalyze, type ReanalyzeDelta } from './reanalyze.js';
import { STATS, STRATEGIES, type AggregatedReport, type MetricKey, type SortField, type SortOrder } from './types.js';
import type { FilterGroup, Gap, InsightFilters } from './types.js';
import { UrlValidationError } from './psiClient.js';
import {
  ABSENT,
  METRIC_ROWS,
  barSegments,
  colorEnabled,
  environmentLine,
  fit,
  formatBytes,
  lighthouseLabel,
  metricDelta,
  metricValue,
  medianOverTarget,
  passCount,
  passSeverity,
  paint,
  renderTable,
  savingsLabel,
  shortenUrl,
  spreadLine,
  termWidth,
  truncate,
  wrap,
  type Column,
} from './render.js';

loadEnv();

const FILTER_GROUPS = ['opportunity', 'diagnostic', 'passed', 'informative'] as const;
const SORT_FIELDS = ['savingsMs', 'savingsBytes', 'score', 'firstPartyShare'] as const;
const ORDERS = ['asc', 'desc'] as const;
const PARTIES = ['any', 'first', 'third'] as const;

interface CliOptions {
  /** Re-filter an already stored report instead of spending more quota. */
  reportId?: string;
  /**
   * Rebuild stored report(s) from their stored runs with today's rules.
   *
   * A stored `report.json` freezes the conclusions of whatever aggregation code
   * wrote it, so improving that code does nothing for the history. This
   * recomputes a report from the retained per-run output, which upgrades
   * historical findings without spending a single PSI request.
   */
  reanalyze: boolean;
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
  --reanalyze             Rebuild a stored report from its stored runs using
                           today's aggregation and target rules. Costs no PSI
                           quota. Combine with --reportId for one report, or
                           omit it to sweep every stored report on disk.
  --json                  Machine-readable JSON
  --no-save               Do not write the report to data/
  -h, --help              This message

Examples:
  npm run psi -- https://example.com --runs 10
  npm run psi -- https://example.com --group opportunity,diagnostic --maxScore 0.9
  npm run psi -- --reportId 2026-09-29T10-30-00Z-mobile --metric lcp

Output:
  The default view leads with a verdict, then a metric table where every row
  shares one bar scale and the target is marked on the bar. The --diagnose
  flag ranks the work queue against the metrics that are actually failing.

  https://example.com/zen-class/data-science-course/
  mobile · Lighthouse 13.5.0 · median of 10/10 runs · 2026-09-30
  measured under moto g power (2022) · CPU index 928 (higher = slower) · en-US · performance only

  SCORE    94 / 100  target 90   p25 93 · p75 94 · p95 94.6 · range 84–95 · stddev 3.4

  VERDICT  FAIL  1 of 6 targets failing
          FCP 2154ms vs 1800ms (0/10 runs in target)

    METRIC       MEDIAN  TARGET  VERDICT      RUNS IN TARGET
    FCP          2154ms  1800ms  +354ms over            0/10  ███████┃····
    LCP          2401ms  2500ms  in target             10/10  ████████┃···

  The "measured under" line records the device, CPU benchmark, locale and
  categories the run was taken with. Two reports are only comparable when they
  were measured under the same conditions, and PSI chooses those conditions
  server-side - the caller cannot request them.

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
  let reanalyzeFlag = false;
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
      case '--reanalyze':
        reanalyzeFlag = true;
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
  // A re-analysis reads reports from disk, so it needs neither a url nor an id:
  // with no `--reportId` it sweeps everything stored.
  if (!url && !reportId && !reanalyzeFlag) fail(`a url or --reportId is required\n${USAGE}`);
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
    reanalyze: reanalyzeFlag,
  };
}

/* -------------------------------- rendering --------------------------------- */

/** Round for display, dropping the float noise Lighthouse reports in. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Lighthouse's own score bands, so a score is coloured the way its own UI colours it. */
function scorePaint(score: number, useColor: boolean): string {
  const name = score >= 90 ? 'green' : score >= 50 ? 'yellow' : 'red';
  return paint(name, String(score), useColor);
}

const GAP = 2;
const INDENT = '  ';

/**
 * The two lines that identify the report, and the third that says what it means.
 *
 * The environment line is not decoration. A number measured against a different
 * emulated CPU is a different number, and before this was recorded the only way
 * to know the conditions was to take them on trust from the form factor.
 */
function header(report: AggregatedReport, useColor: boolean): string[] {
  const width = termWidth() - INDENT.length;
  return [
    paint('bold', shortenUrl(report.url, width), useColor),
    paint(
      'dim',
      [
        report.strategy,
        lighthouseLabel(report.lighthouseVersion),
        `${report.stat} of ${report.runsSucceeded}/${report.runsRequested} runs`,
        report.generatedAt.slice(0, 10),
      ].join(' · '),
      useColor,
    ),
    paint('dim', `measured under ${environmentLine(report.environment)}`, useColor),
  ];
}

/**
 * The one-sentence answer, before any of the evidence.
 *
 * A reader who stops after three lines should still know whether the page is
 * healthy and what to do about it. "BELOW TARGET  fcp +354" answered neither:
 * it did not say how many budgets were missed, and `+354` had no units.
 */
function verdict(report: AggregatedReport, useColor: boolean): string[] {
  const gaps = report.targets.gaps;
  const failing = gaps.filter((gap) => !gap.meets);
  const lines: string[] = [];

  // 'FAIL' only when more than half of budgets are failing.
  // "3 of 6" is exactly half, not a fail.
  const majority = failing.length > gaps.length / 2;
  const state = majority ? paint('red', 'FAIL', useColor) : paint('green', 'PASS', useColor);
  const scope = `${failing.length} of ${gaps.length} target${gaps.length === 1 ? '' : 's'} failing`;
  lines.push(`${paint('bold', 'VERDICT', useColor)}  ${state}  ${paint('dim', scope, useColor)}`);

  // Name the failures in the order they hurt. `worstGap` is already ranked by
  // relative overshoot, which is the only ranking that compares a 300ms TBT miss
  // against a 0.02 CLS miss fairly.
  const named = failing
    .slice()
    .sort((a, b) => overshoot(b) - overshoot(a))
    .slice(0, 4)
    .map((gap) => {
      const label = METRIC_LABELS[gap.metric] ?? gap.metric.toUpperCase();
      const count = passCount(gap);
      const held = count === ABSENT ? '' : ` (${count} runs in target)`;
      return `${label} ${metricValue(gap.metric, gap.actual)} vs ${metricValue(gap.metric, gap.target)}${held}`;
    });
  if (named.length > 0) lines.push(`        ${paint('dim', named.join(', '), useColor)}`);

  if (report.targets.medianPass && !report.targets.meetsTarget) {
    lines.push(
      paint(
        'yellow',
        '        every median is inside target, but too few individual runs are - judged on the tail',
        useColor,
      ),
    );
  }
  for (const reason of report.targets.blockedBy ?? []) {
    for (const line of wrap(`not fixable from here: ${reason}`, termWidth() - 8, '        ')) {
      lines.push(paint('yellow', `        ${line}`, useColor));
    }
  }
  return lines;
}

/** How far past its own budget a metric is, as a fraction. Dimensionless on purpose. */
function overshoot(gap: Gap): number {
  if (gap.target <= 0) return gap.delta > 0 ? Number.POSITIVE_INFINITY : 0;
  return gap.delta / gap.target;
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

/**
 * The graded-metric table, used verbatim by both views.
 *
 * `grow` sits on the id nowhere here because there is no free-text column: the
 * numbers are the content, and squeezing them to make room for a longer label
 * would be backwards.
 */
const BUDGET_COLUMNS: Column[] = [
  { key: 'metric', label: 'METRIC', min: 11 },
  { key: 'actual', label: 'MEDIAN', align: 'right', min: 8 },
  { key: 'target', label: 'TARGET', align: 'right', min: 8 },
  { key: 'delta', label: 'VERDICT', min: 13 },
  { key: 'pass', label: 'RUNS IN TARGET', align: 'right', min: 15 },
  { key: 'bar', label: '', min: 12, max: 12 },
];

/**
 * The metric table: every graded metric, its median, its budget, and how often
 * real runs actually held it.
 *
 * All rows share one bar scale, taken from the largest value in the table, so a
 * longer bar really is a worse metric. A bar scaled per row would make a 0.002
 * CLS and a 3.4s speed index look identical, which is the exact confusion the
 * table exists to prevent.
 */
function metricsTable(report: AggregatedReport, useColor: boolean): string[] {
  const rows = METRIC_ROWS.filter((row) => report.headline.metrics[row.key] !== undefined);
  if (rows.length === 0) return [];

  const byMetric = new Map(report.targets.gaps.map((gap) => [gap.metric, gap]));
  const entries = rows.map((row) => ({ ...row, gap: byMetric.get(row.key) }));
  const scale = Math.max(
    ...entries.map((entry) => Math.max(entry.gap?.actual ?? 0, entry.gap?.target ?? 0)),
    1,
  );

  const columns: Column[] = BUDGET_COLUMNS;

  return renderTable(columns, budgetCells(entries, scale, useColor), {    width: termWidth() - INDENT.length,
    gap: GAP,
    indent: INDENT,
    styleLabel: (text) => paint('dim', text, useColor),
  });
}

/**
 * One row per metric, for both the default view and `--diagnose`.
 *
 * Shared deliberately: the two views answer different questions but grade the
 * same budgets, and a reader who switches between them should not have to
 * re-learn what the columns mean or re-read a differently-scaled bar.
 */
function budgetCells(
  entries: Array<{ key: MetricKey; label: string; gap: Gap | undefined; actual?: number }>,
  scale: number,
  useColor: boolean,
): string[][] {
  return entries.map((entry) => {
    const gap = entry.gap;
    const actual = entry.actual ?? gap?.actual ?? 0;
    const target = gap?.target ?? 0;
    const bar = barSegments(actual, target, scale);
    // One decision, reused by the bar, the label and the verdict text, so they
    // cannot disagree with each other.
    const over = medianOverTarget(gap);
    const barText =
      paint(over ? 'red' : 'green', bar.fill + bar.lead, useColor) +
      paint('cyan', bar.tick, useColor) +
      paint('dim', bar.rest, useColor);
    return [
      // The label and the verdict text are coloured on the median's position
      // against the target, never on `meets` - see `medianOverTarget`.
      over ? paint('red', entry.label, useColor) : entry.label,
      metricValue(entry.key, actual),
      gap ? metricValue(entry.key, gap.target) : ABSENT,
      gap ? paint(over ? 'red' : 'green', metricDelta(entry.key, gap.delta), useColor) : ABSENT,
      gap ? paint(passSeverity(gap), passCount(gap), useColor) : ABSENT,
      barText,
    ];
  });
}


/**
 * A wrapped SOP line, with the guide section picked out.
 *
 * The section number is what a reader scans for - it says which rule of the
 * playbook the fix comes from - so it gets its own colour rather than being
 * lost in a run of prose. The split is on the first run of two spaces, which
 * the section reference never contains itself.
 */
function paintSop(line: string, useColor: boolean): string {
  const split = /\s{2,}/.exec(line);
  if (!split) return paint('dim', line, useColor);
  const at = split.index;
  return `${paint('cyan', line.slice(0, at), useColor)}  ${paint('dim', line.slice(at).trimStart(), useColor)}`;
}

const INSIGHT_COLUMNS: Column[] = [
  { key: 'saving', label: 'EST. SAVING', align: 'right', min: 11 },
  { key: 'id', label: 'INSIGHT', min: 16, grow: true },
  { key: 'metrics', label: 'AFFECTS', min: 9 },
  { key: 'ours', label: 'OURS', align: 'right', min: 5 },
  { key: 'runs', label: 'SEEN', align: 'right', min: 7 },
];

/** One insight as table cells, with the savings column falling back to bytes. */
function insightRow(insight: AggregatedReport['insights'][number], useColor: boolean): string[] {
  const saving = savingsLabel(insight.savingsMs, insight.savingsBytes);
  const affected = (insight.metricsAffected ?? []).map((m) => METRIC_LABELS[m] ?? m).join(' ');
  const share = insight.firstPartyShare;
  const shareText =
    share === null || share === undefined
      ? ABSENT
      : share === 0
        ? paint('dim', '0%', useColor)
        : paint(share < 1 ? 'yellow' : 'green', `${Math.round(share * 100)}%`, useColor);
  const runs = `${insight.appearedInRuns}/${insight.runsSucceeded}`;
  return [
    saving === ABSENT ? paint('dim', ABSENT, useColor) : saving,
    insight.flaky ? paint('yellow', `${insight.id} (flaky)`, useColor) : insight.id,
    affected || ABSENT,
    shareText,
    paint(insight.flaky ? 'yellow' : 'dim', runs, useColor),
  ];
}

function renderHuman(options: CliOptions, report: Awaited<ReturnType<typeof runReport>>['report']): string {
  if (options.diagnose) return renderDiagnosis(report, options);

  const useColor = colorEnabled();
  const insights = filterInsights(report.insights, filtersFrom(options));
  const lines: string[] = ['', ...header(report, useColor), ''];

  // Score, with the distribution beside it. A score with no spread next to it
  // reads as a stable property of the page when it is a summary of ten noisy
  // measurements, and "which lane is the page in" is the first question anyone
  // asks when a number moves.
  const scoreTarget = report.targets.targets.score;
  const targetText =
    scoreTarget === undefined ? '' : paint('dim', `  target ${scoreTarget}`, useColor);
  const spread = spreadLine(report.score);
  lines.push(
    `${paint('bold', 'SCORE', useColor)}    ${scorePaint(report.headline.score, useColor)} / 100` +
      `${targetText}   ` +
      paint('dim', spread, useColor),
  );
  // Gated on the note, not on `bimodal`. The two are separate claims: the
  // distribution can be a real split that is too small to act on, in which case
  // there is nothing to say and the sentence has to be omitted entirely rather
  // than printed with nothing after the colon.
  const scoreSplit = report.distributions?.score;
  if (scoreSplit?.bimodal && scoreSplit.note) {
    lines.push(
      paint('yellow', `         the score splits into two groups: ${scoreSplit.note}`, useColor),
    );
  }
  lines.push('');
  lines.push(...verdict(report, useColor));
  lines.push('');
  lines.push(...metricsTable(report, useColor));

  lines.push('');
  const total = report.insights.length;
  const shown = insights.length;
  lines.push(
    paint('bold', 'FINDINGS', useColor) +
      paint('dim', `  ${shown === total ? `${total}` : `${shown} of ${total}`} shown`, useColor),
  );
  if (insights.length === 0) {
    lines.push(paint('dim', `${INDENT}nothing matched the given filters`, useColor));
  } else {
    lines.push(
      ...renderTable(
        INSIGHT_COLUMNS,
        insights.map((insight) => insightRow(insight, useColor)),
        {
          width: termWidth() - INDENT.length,
          gap: GAP,
          indent: INDENT,
          styleLabel: (text) => paint('dim', text, useColor),
        },
      ),
    );
  }
  lines.push('');
  lines.push(
    paint('dim', `${INDENT}${ABSENT} in SAVING means Lighthouse gave no estimate, which is not zero.`, useColor),
  );
  lines.push(
    paint('dim', `${INDENT}OURS is how much of the cost your own code is responsible for.`, useColor),
  );
  if (options.limit !== undefined && shown < total) {
    lines.push(paint('dim', `${INDENT}${total - shown} more hidden by --limit ${options.limit}.`, useColor));
  }

  const failed = report.errors.filter((error) => error.message);
  if (failed.length > 0) {
    lines.push('');
    lines.push(paint('yellow', `${INDENT}${failed.length} run(s) failed:`, useColor));
    for (const failure of failed.slice(0, 3)) {
      lines.push(paint('dim', `${INDENT}${INDENT}run ${failure.run}: ${failure.message}`, useColor));
    }
  }

  lines.push('');
  lines.push(paint('dim', `saved as reportId ${report.reportId}`, useColor));
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
  const useColor = colorEnabled();
  const diagnosis = diagnoseReport(report, {
    filters: {
      // `group` is left to the diagnosis layer, which owns the default, so the
      // queue is identical here and on the HTTP endpoint.
      party: options.party,
      minFirstPartyRatio: options.minFirstPartyRatio,
      sortBy: options.sortBy,
      limit: options.limit,
      includeFlaky: options.includeFlaky,
    },
  });

  const lines: string[] = ['', ...header(report, useColor), ''];
  const scoreTarget = report.targets.targets.score;
  lines.push(
    `${paint('bold', 'SCORE', useColor)}    ${scorePaint(report.headline.score, useColor)} / 100` +
      `${scoreTarget === undefined ? '' : paint('dim', `  target ${scoreTarget}`, useColor)}   ` +
      paint('dim', spreadLine(report.score), useColor),
  );
  lines.push('');

  lines.push(paint('bold', 'TARGETS FAILING', useColor));
  if (diagnosis.priorityOrder.length === 0) {
    lines.push(paint('green', `${INDENT}every measured metric is inside its target`, useColor));
  } else {
    const scale = Math.max(
      ...diagnosis.priorityOrder.map((gap) => Math.max(gap.actual, gap.target)),
      1,
    );
    const entries = diagnosis.priorityOrder.map((gap) => ({
      key: gap.metric as MetricKey,
      label: METRIC_LABELS[gap.metric] ?? gap.metric.toUpperCase(),
      gap,
    }));
    lines.push(
      ...renderTable(BUDGET_COLUMNS, budgetCells(entries, scale, useColor), {
        width: termWidth() - INDENT.length,
        gap: GAP,
        indent: INDENT,
        styleLabel: (text) => paint('dim', text, useColor),
      }),
    );
  }

  if (diagnosis.blocked.length > 0) {
    lines.push('');
    lines.push(paint('bold', 'NOT REACHABLE FROM THE FRONTEND', useColor));
    for (const reason of diagnosis.blocked) {
      for (const line of wrap(reason, termWidth() - INDENT.length * 2, '    ')) {
        lines.push(paint('dim', `${INDENT}${line}`, useColor));
      }
    }
  }

  const lcp = report.lcp;
  if (lcp) {
    lines.push('');
    lines.push(paint('bold', 'LCP ELEMENT', useColor));
    lines.push(
      paint('dim', `${INDENT}${lcp.isText ? 'text node' : `${lcp.elementType ?? 'image'} element`}`, useColor),
    );
    if (lcp.text) {
      lines.push(paint('dim', `${INDENT}"${truncate(lcp.text, termWidth() - INDENT.length * 2 - 2)}"`, useColor));
    }
    // Phases in timeline order, not sorted by size: the point is "how much of
    // the wait happened before we could even start", and reordering by size
    // hides the fact that TTFB came first.
    const phaseEntries = Object.entries(lcp.phases).filter(([, v]) => typeof v === 'number') as Array<
      [string, number]
    >;
    if (phaseEntries.length > 0) {
      const total = phaseEntries.reduce((sum, [, value]) => sum + value, 0);
      const parts = phaseEntries
        .map(([key, value]) => `${key.replace(/([A-Z])/g, ' $1').toLowerCase()} ${Math.round(value)}ms`)
        .join('  ');
      lines.push(paint('dim', `${INDENT}phases: ${parts}`, useColor));
      lines.push(
        paint(
          'dim',
          `${INDENT}  of ${Math.round(total)}ms total, the bottleneck is ${lcp.bottleneck}`,
          useColor,
        ),
      );
    }
  }

  lines.push('');
  lines.push(paint('bold', 'WORK QUEUE', useColor));
  if (diagnosis.ranked.length === 0) {
    lines.push(paint('dim', `${INDENT}nothing actionable against the failing metrics`, useColor));
  } else {
    // Only the scannable facts get columns. The reason and the procedure are
    // prose, and prose squeezed into a column is prose nobody reads - so they go
    // on their own lines under the row they belong to.
    lines.push(
      ...renderTable(
        [
          { key: 'rank', label: '#', align: 'right', min: 2, max: 2 },
          { key: 'saving', label: 'EST. SAVING', align: 'right', min: 11 },
          { key: 'id', label: 'INSIGHT', min: 16, grow: true },
          { key: 'ours', label: 'OURS', align: 'right', min: 5 },
        ],
        diagnosis.ranked.map((entry) => [
          paint('dim', String(entry.rank), useColor),
          savingsLabel(entry.insight.savingsMs, entry.insight.savingsBytes),
          entry.insight.flaky
            ? paint('yellow', `${entry.insight.id} (flaky)`, useColor)
            : entry.insight.id,
          entry.firstPartyShare === null
            ? paint('dim', 'unknown', useColor)
            : paint(
                entry.firstPartyShare < 1 ? 'yellow' : 'green',
                `${Math.round(entry.firstPartyShare * 100)}%`,
                useColor,
              ),
        ]),
        {
          width: termWidth() - INDENT.length,
          gap: GAP,
          indent: INDENT,
          styleLabel: (text) => paint('dim', text, useColor),
          detail: (_row, index) => {
            const entry = diagnosis.ranked[index];
            if (!entry) return [];
            // `reason` already states the third-party verdict, so it is not
            // repeated as a separate line here.
            const detail = wrap(entry.reason, termWidth() - INDENT.length - 2, '    ');
            const lines = detail.map((line) => paint('dim', line, useColor));
            if (entry.sop) {
              const sop = wrap(
                `${entry.sop.sop}  ${entry.sop.action}`,
                termWidth() - INDENT.length - 2,
                '      ',
              );
              for (const line of sop) lines.push(paintSop(line, useColor));
            }
            return lines;
          },
        },
      ),
    );
  }

  if (diagnosis.cautions.length > 0) {
    lines.push('');
    lines.push(paint('bold', 'BEFORE YOU TRUST THESE NUMBERS', useColor));
    const body = termWidth() - INDENT.length - 2;
    for (const caution of diagnosis.cautions) {
      const wrapped = wrap(caution, body, '  ');
      lines.push(paint('yellow', `${INDENT}! ${wrapped[0] ?? ''}`, useColor));
      for (const line of wrapped.slice(1)) {
        lines.push(paint('yellow', `${INDENT}  ${line}`, useColor));
      }
    }
  }

  if (diagnosis.exhausted) {
    lines.push('');
    lines.push(
      paint(
        'green',
        `${INDENT}STOP: no first-party work remains against the failing metrics. Report and escalate.`,
        useColor,
      ),
    );
  }

  lines.push('');
  lines.push(paint('dim', `saved as reportId ${report.reportId}`, useColor));
  lines.push('');
  return lines.join('\n');
}

/* ----------------------------------- main ----------------------------------- */

async function loadStoredReport(reportId: string): Promise<AggregatedReport> {
  const report = await loadReport(reportId);
  if (!report) fail(`no stored report "${reportId}" - run a report first without --reportId`);
  return report;
}

/**
 * Upgrade stored report(s) from their own retained runs, at zero PSI cost.
 *
 * Writes the rebuilt report back over the stored one, but only after reporting
 * what changed, so an upgrade is auditable rather than a silent rewrite. The
 * `runs.json` beside it is left untouched: it is the evidence the rebuild was
 * derived from, and rewriting it would destroy the ability to re-derive again.
 */
async function runReanalyze(options: CliOptions): Promise<number> {
  const useColor = colorEnabled();
  const targets = loadTargets();

  const reportIds = options.reportId
    ? [options.reportId]
    : (await listReports()).map((ref) => ref.reportId);

  if (reportIds.length === 0) {
    process.stderr.write('no stored reports found\n');
    return 1;
  }

  const rows: Array<{
    reportId: string;
    delta: ReanalyzeDelta | null;
    error?: string;
    saved: boolean;
  }> = [];

  for (const reportId of reportIds) {
    try {
      const before = await loadReport(reportId);
      const runs = await loadRuns(reportId);
      if (!runs) {
        rows.push({ reportId, delta: null, error: 'no stored runs', saved: false });
        continue;
      }
      if (!before) {
        rows.push({ reportId, delta: null, error: 'no stored report', saved: false });
        continue;
      }

      const after = reanalyze(runs, {
        reportId,
        stat: before.stat,
        runsRequested: before.runsRequested,
        targets,
      });
      const delta = diffReanalyzed(before, after);

      // Persist the upgraded report. The stored runs are deliberately left
      // untouched: they are the evidence the rebuild was derived from, and
      // rewriting them would destroy the ability to re-derive again.
      let saved = false;
      if (!options.noSave) {
        await saveReport(after, runs, getDataDir());
        saved = true;
      }
      rows.push({ reportId, delta, saved });
    } catch (error) {
      rows.push({
        reportId,
        delta: null,
        error: error instanceof Error ? error.message : String(error),
        saved: false,
      });
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ reanalyzed: rows }, null, 2)}\n`);
    return rows.some((row) => row.error) ? 1 : 0;
  }

  const lines: string[] = [''];
  const changed = rows.filter((row) => row.delta?.changed).length;
  const totalRecovered = rows.reduce((sum, row) => sum + (row.delta?.recovered.length ?? 0), 0);
  const totalPhantoms = rows.reduce((sum, row) => sum + (row.delta?.phantomZeroes.length ?? 0), 0);
  const savedCount = rows.filter((row) => row.saved).length;

  lines.push(
    `${paint('bold', 'RE-ANALYZED', useColor)} ${rows.length} stored report(s)   ` +
      paint('dim', `${changed} changed · ${totalRecovered} cost figure(s) recovered · ${totalPhantoms} phantom zero(es) corrected`, useColor),
  );

  // Only reports that actually changed are worth a row. Listing all 27 identical
  // "same" lines buries the two that moved, which is the only reason to run this.
  const interesting = rows.filter((row) => row.delta?.changed || row.error);
  if (interesting.length === 0) {
    lines.push(paint('dim', `${INDENT}no stored report changed its conclusion`, useColor));
  }
  for (const row of interesting) {
    lines.push('');
    if (row.error) {
      lines.push(`${paint('bold', row.reportId, useColor)}  ${paint('red', row.error, useColor)}`);
      continue;
    }
    const delta = row.delta!;
    lines.push(
      `${paint('bold', row.reportId, useColor)}${row.saved ? '' : paint('dim', '  (not saved)', useColor)}`,
    );
    for (const change of delta.recovered) {
      const bytes =
        change.afterBytes !== change.beforeBytes ? ` / ${formatBytes(change.afterBytes)}` : '';
      // `none` is a real answer, not a missing one: the figure exists but the
      // field that produced it does not survive into a stored run. Saying
      // "found in none" would read as a bug in the reader's terminal.
      const where =
        change.source === 'none' || change.source === undefined
          ? 'provenance not recoverable from the stored run'
          : `found in ${change.source}`;
      lines.push(
        `  ${paint('green', 'recovered', useColor)}  ${change.insightId} ` +
          paint(
            'dim',
            `was recorded as 0, Lighthouse actually measured ${
              change.afterMs === null ? 'no time saving' : `${change.afterMs}ms`
            }${bytes} (${where})`,
            useColor,
          ),
      );
    }
    for (const phantom of delta.phantomZeroes) {
      lines.push(
        `  ${paint('yellow', 'corrected', useColor)}  ${phantom} ` +
          paint('dim', 'claimed a 0ms saving that Lighthouse never gave an estimate for', useColor),
      );
    }
    if (delta.failingBefore.join(',') !== delta.failingAfter.join(',')) {
      lines.push(
        `  ${paint('dim', 'now failing', useColor)}  ${paint('red', delta.failingAfter.join(', ') || 'nothing', useColor)}`,
      );
    }
  }

  lines.push('');
  if (savedCount > 0) {
    lines.push(paint('dim', `${savedCount} report(s) rewritten. Stored runs were left untouched.`, useColor));
  } else {
    lines.push(paint('dim', 'Nothing written. Drop --no-save to apply these upgrades.', useColor));
  }
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
  return rows.some((row) => row.error) ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  if (!options) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    if (options.reanalyze) return await runReanalyze(options);

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
          if (options.json) return;
          process.stderr.write(`${paint('yellow', 'retry', false)}: ${reason} (${delayMs}ms)\n`);
        },
        onRunFinished: ({ run, ok, score, error }) => {
          if (options.json) return;
          // One line per run, appended and never rewritten. A carriage return
          // would leave a single line that overwrites itself, which hides the
          // per-run spread the reader needs in order to judge the aggregate
          // that follows - and a report whose runs cannot be seen individually
          // cannot be checked for the cached-timestamp failure mode.
          const label = ok
            ? `run ${run}/${options.runs}  score ${Math.round(score as number)}`
            : `run ${run}/${options.runs}  FAILED  ${error}`;
          process.stderr.write(`${ok ? label : paint('yellow', label, false)}\n`);
        },
      });
      report = result.report;
      warnings.push(...result.warnings);
    }

    for (const warning of warnings) {
      process.stderr.write(`${paint('yellow', 'warning', false)}: ${warning}\n`);
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
