/**
 * Turning a report into a ranked work queue.
 *
 * The measurement layer tells you what Lighthouse observed. This module answers
 * the questions an optimizing agent actually has to answer next:
 *
 *   - Which metric is failing, in what order, and why that order?
 *   - For the chosen metric, which insights are worth touching, and which are
 *     somebody else's cost?
 *   - Which SOP section does each insight map to?
 *   - Is any remaining gap structurally unreachable, so the loop should escalate
 *     instead of burning its iteration budget?
 *
 * The ranking is deliberately metric-first. Lighthouse's own audit ordering is
 * by savings estimate, which optimises whatever happens to be biggest rather
 * than whatever is actually failing - on this project that pointed the queue at
 * a passing LCP while FCP failed on all 20 stored reports.
 */

import type {
  AggregatedInsight,
  AggregatedReport,
  Gap,
  InsightFilters,
  MetricKey,
  SeriesStats,
} from './types.js';
import { METRIC_KEYS } from './types.js';
import { filterInsights, firstPartyShareOf, isMetricAudit, isOwnUrl } from './insights.js';
import { medianMeets } from './targets.js';

/**
 * Metric priority, highest first.
 *
 * Core Web Vitals lead because they are what the page is scored on and what the
 * business cares about; `score` is a composite that inherits from them, so it
 * comes last and is never worth optimising directly.
 *
 * `fcp` and `speedIndex` are first-class members rather than afterthoughts: FCP
 * gates everything painted after it, and Speed Index is the honest "how much of
 * the page has appeared" number.
 */
export const METRIC_PRIORITY: readonly MetricKey[] = [
  'lcp',
  'inp',
  'cls',
  'fcp',
  'tbt',
  'speedIndex',
  'tti',
  'ttfb',
] as const;

/** Display order for the human-readable output. */
export const METRIC_LABELS: Record<string, string> = {
  score: 'SCORE',
  lcp: 'LCP',
  inp: 'INP',
  cls: 'CLS',
  fcp: 'FCP',
  tbt: 'TBT',
  speedIndex: 'SI',
  tti: 'TTI',
  ttfb: 'TTFB',
};

/**
 * Which insight ids belong to which SOP section.
 *
 * Kept here rather than in prose so the mapping is testable and so a new
 * Lighthouse insight is visibly unmapped instead of silently misrouted.
 */
export const INSIGHT_SOP: Record<string, { sop: string; action: string }> = {
  'render-blocking-insight': { sop: '§6/§8', action: 'Inline critical CSS or defer the rest; ship no JS on first fold' },
  'render-blocking-resources': { sop: '§8', action: 'Inline critical CSS or defer the rest' },
  'unused-css-rules': { sop: '§6/§8', action: 'Split the stylesheet per route; drop rules no route uses' },
  'lcp-discovery-insight': { sop: '§6', action: 'Make the LCP image discoverable: preload, no lazy load' },
  'prioritize-lcp-image-insight': { sop: '§6', action: 'fetchpriority=high on the LCP image, not a decorative one' },
  'lcp-lazy-loaded-insight': { sop: '§6', action: 'LCP image must be eager, never lazy' },
  'lcp-breakdown-insight': { sop: '§6/§8', action: 'Work the dominant LCP phase, not the element type' },
  'image-delivery-insight': { sop: '§6', action: 'Resize/compress via Unpic with explicit dimensions' },
  unsized_images: { sop: '§6', action: 'Give every image width/height to reserve layout space' },
  'unsized-images': { sop: '§6', action: 'Give every image width/height to reserve layout space' },
  'bootup-time': { sop: '§8', action: 'Dynamic-import heavy libs at their point of use' },
  'mainthread-work-breakdown': { sop: '§8', action: 'Cut main-thread work; no useVisibleTask$ on first fold' },
  'long-tasks': { sop: '§8', action: 'Break up long tasks; defer non-critical JS' },
  'duplicated-javascript-insight': { sop: '§10.3', action: 'Remove duplicate copies of an existing lib' },
  'legacy-javascript-insight': { sop: '§10.3', action: 'Transpile or drop legacy-polyfilled code' },
  'unused-javascript': { sop: '§8/§10.3', action: 'Delay the import; do not delete a library to win bytes' },
  'font-display-insight': { sop: '§6', action: 'Update @font-face and every preload together' },
  'third-parties-insight': { sop: 'n/a', action: 'Third-party cost - document, do not attempt' },
  'cls-culprits-insight': { sop: '§5/§7', action: 'Reserve space; never a useStore for static arrays' },
  'cumulative-layout-shift': { sop: '§5/§7', action: 'Reserve space for everything that arrives late' },
  'forced-reflow-insight': { sop: '§7', action: 'Remove the sync layout read; noSerialize lib instances' },
  'cache-insight': { sop: 'n/a', action: 'Cache headers - usually server/CDN, check ownership first' },
  'document-latency-insight': { sop: 'n/a', action: 'Document latency - plausibility check against real TTFB' },
  'non-composited-animations': { sop: '§8', action: 'Animate transform/opacity only' },
  'dom-size-insight': { sop: '§4/§7', action: 'Split the component; avoid duplicated markup' },
  'viewport-insight': { sop: '§5', action: 'Add the missing viewport meta' },
  'network-dependency-tree-insight': { sop: '§8', action: 'Shorten the critical request chain' },
  'total-byte-weight': { sop: '§8', action: 'Total transfer weight - a summary, not a single fix' },
};

/**
 * Lighthouse's simulated throughput, in kilobits per second.
 *
 * Used only to put a byte-priced finding on the same scale as a time-priced one
 * for ranking. The figure is transfer time on PSI's throttled link, which
 * overstates the cost of bytes that are not on the critical path.
 */
const THROUGHPUT_KBPS: Record<string, number> = { mobile: 1638.4, desktop: 10240 };

export function bytesToTransferMs(bytes: number, strategy: string): number {
  const kbps = THROUGHPUT_KBPS[strategy] ?? THROUGHPUT_KBPS.mobile!;
  return (bytes * 8) / kbps;
}

export interface RankedInsight {
  insight: AggregatedInsight;
  /** 1 = highest priority. */
  rank: number;
  /**
   * The time figure the insight was ranked on: `savingsMs`, or for a finding
   * Lighthouse priced only in bytes, those bytes as transfer time.
   */
  rankingMs: number;
  /** True when `rankingMs` was converted from bytes rather than estimated by Lighthouse. */
  rankingFromBytes: boolean;
  /** Metrics that failed and that this insight claims to affect. */
  affectsFailing: MetricKey[];
  /** Share of the cost that is yours: 0-1, or null when unattributed. */
  firstPartyShare: number | null;
  /** True when no first-party row backs this finding. */
  thirdPartyOnly: boolean;
  /** True when the estimate was recovered from a display string, not a rollup. */
  estimateFromText: boolean;
  sop?: { sop: string; action: string };
  /** Why this insight is ranked where it is - shown to the operator. */
  reason: string;
}

export interface Diagnosis {
  /** Gaps sorted by how far over budget, worst first. */
  priorityOrder: Gap[];
  /** The single gap to work on next, if any. */
  primary: Gap | undefined;
  ranked: RankedInsight[];
  /** Gaps that no frontend change can close. */
  blocked: string[];
  /** Metrics that fail on some runs while the median passes. */
  unreliable: Gap[];
  /** Human-readable cautions about reading this report. */
  cautions: string[];
  /** True when nothing actionable is left, so the loop should stop. */
  exhausted: boolean;
}

const fmt = (metric: string): string => METRIC_LABELS[metric] ?? metric.toUpperCase();

/** Sort gaps worst-first by relative overshoot, then by a fixed metric priority. */
function orderGaps(gaps: Gap[]): Gap[] {
  const overshoot = (gap: Gap): number => {
    const over = gap.metric === 'score' ? -gap.delta : gap.delta;
    return over / (gap.target || 1);
  };
  const rank = (metric: string): number => {
    const index = (METRIC_PRIORITY as readonly string[]).indexOf(metric);
    return index < 0 ? METRIC_PRIORITY.length : index;
  };
  return [...gaps].sort((a, b) => {
    const aFails = a.meets ? 1 : 0;
    const bFails = b.meets ? 1 : 0;
    if (aFails !== bFails) return aFails - bFails;
    const diff = overshoot(b) - overshoot(a);
    if (Math.abs(diff) > 1e-9) return diff;
    return rank(a.metric) - rank(b.metric);
  });
}

/**
 * Metrics that pass on the median but fail on too many individual runs.
 *
 * Keyed on `medianMeets`, not `gap.meets`: the graded verdict has already been
 * flipped to false for these, so testing `gap.meets` would find none and the
 * "median passed, the tail did not" warning would never fire.
 */
function unreliableGaps(gaps: Gap[], minPassRate: number): Gap[] {
  return gaps.filter(
    (gap) => medianMeets(gap) && gap.passRate !== undefined && gap.passRate < minPassRate - 1e-9,
  );
}

/**
 * Rank the insights that are worth acting on for the metrics currently failing.
 *
 * Ranking rules, in order of importance:
 *   1. Affects a failing metric. An insight that helps a green metric is not
 *      work, however large its estimate.
 *   2. First-party cost. Third-party-only findings are reported, not hidden, so
 *      they can be logged as "not actionable in repo".
 *   3. Size of the estimate.
 *   4. Stability. A flaky finding cannot be validated by re-measurement.
 */
/**
 * The failing metrics that a Lighthouse audit can actually be attributed to.
 *
 * `score` is a composite, not a metric - no audit "affects" it - and passing it
 * into the metric filter would look up a non-existent audit-id mapping. It is
 * dropped here, and the score is handled as a consequence of the other metrics
 * rather than as a target in its own right.
 */
function failingMetricKeys(report: AggregatedReport): Set<string> {
  return new Set(
    report.targets.gaps
      .filter((gap) => !gap.meets)
      .map((gap) => gap.metric)
      .filter((metric): metric is MetricKey => (METRIC_KEYS as readonly string[]).includes(metric)),
  );
}

export function rankInsights(
  report: AggregatedReport,
  options: { filters?: InsightFilters; minPassRate?: number } = {},
): RankedInsight[] {
  const minPassRate = options.minPassRate ?? 0.9;
  const failing = failingMetricKeys(report);
  const unreliable = new Set(
    unreliableGaps(report.targets.gaps, minPassRate)
      .map((gap) => gap.metric)
      .filter((metric): metric is MetricKey => (METRIC_KEYS as readonly string[]).includes(metric)),
  );

  // Gate on `group`, not on a score threshold: Lighthouse scores an audit it
  // considers fine at 1.0 even when that audit is a diagnostic worth reading
  // (a 9.7ms third-party beacon, for one), so a `maxScore` filter would hide
  // exactly the findings the queue needs in order to rule them out.
  //
  // The group default lives here rather than in each caller. When it lived in
  // the CLI renderer, the HTTP endpoint silently defaulted to "no group filter"
  // and let `passed` audits into the queue - so a bootup-time audit that
  // Lighthouse considers fine outranked a 601ms render-blocking diagnostic,
  // purely because it nominally touched an unstable metric. The work queue must
  // not depend on which surface asked for it.
  //
  // Lighthouse also scores an insight as passing while it still names bytes that
  // can be removed (`image-delivery-insight` at 76 KiB, scored 1). Those are
  // admitted by default. A passing audit priced only in time is not: that is
  // the bootup-time case above, a 50-100ms TBT figure Lighthouse considers fine.
  const explicitGroup = options.filters?.group;
  const candidates = filterInsights(report.insights, {
    includeFlaky: false,
    ...options.filters,
    group: explicitGroup ?? ['opportunity', 'diagnostic', 'passed'],
  }).filter((insight) => {
    if (!explicitGroup && insight.group === 'passed' && !((insight.savingsBytes ?? 0) > 0)) return false;
    // A metric audit is the failing number restated, not a cause of it, and it
    // has no playbook to route to. The gap list already says it is over budget.
    if (isMetricAudit(insight.id)) return false;
    // Only restrict when the caller has not asked for a metric filter of their own.
    if (options.filters?.metric || failing.size === 0) return true;
    const affected = insight.metricsAffected;
    // No attribution at all: cannot be proven irrelevant, so it stays.
    if (!affected || affected.length === 0) return true;
    return affected.some((metric) => failing.has(metric as MetricKey));
  });

  const scored = candidates.map((insight) => {
    const share = firstPartyShareOf(insight);
    const affectsFailing = (insight.metricsAffected ?? []).filter((metric) =>
      failing.has(metric as MetricKey),
    ) as MetricKey[];
    const thirdPartyOnly = insight.firstPartyItems === 0 && insight.thirdPartyItems > 0;
    const affectsUnreliable = (insight.metricsAffected ?? []).some((metric) =>
      unreliable.has(metric as MetricKey),
    );

    const bytes = insight.savingsBytes ?? 0;
    const rankingFromBytes = (insight.savingsMs ?? 0) <= 0 && bytes > 0;
    const saving = rankingFromBytes ? bytesToTransferMs(bytes, report.strategy) : (insight.savingsMs ?? 0);
    // A finding that only affects an unstable metric is a weak candidate, and a
    // flaky one cannot be proven by re-measurement, so both push it down.
    let score = saving + affectsFailing.length * 100_000;
    if (affectsUnreliable) score += 50_000;
    if (thirdPartyOnly) score -= 10_000_000;
    if (share === 0) score -= 10_000_000;
    if (insight.flaky) score -= 5_000_000;

    const reasons: string[] = [];
    if (affectsFailing.length > 0) {
      reasons.push(`affects failing ${affectsFailing.map(fmt).join('/')}`);
    }
    if (affectsUnreliable) reasons.push('affects an unstable metric');
    if (thirdPartyOnly) reasons.push('third-party cost only - document, do not fix');
    else if (share !== null) reasons.push(`${Math.round(share * 100)}% first-party`);
    if (rankingFromBytes) {
      reasons.push(
        `${Math.round(bytes / 1024)} KiB est. saving (~${Math.round(saving)}ms of transfer on PSI's ` +
          `${report.strategy} link, a ranking estimate only)`,
      );
    } else if (saving > 0) reasons.push(`${Math.round(saving)}ms est. saving`);
    else reasons.push('no size estimate');
    if (insight.group === 'passed') reasons.push('Lighthouse scores it as passing, but the bytes are real');

    // The generic route for this insight is "someone else's code". Rows on the
    // site's own domains are not, and have to be routed as the resources they are.
    const sop =
      insight.id === 'third-parties-insight' && insight.firstPartyItems > 0
        ? { sop: '§6/§8', action: 'Rows on your own domains are yours: work them as image or script findings' }
        : INSIGHT_SOP[insight.id];

    return {
      insight,
      rank: 0,
      rankingMs: Math.round(saving),
      rankingFromBytes,
      affectsFailing,
      firstPartyShare: share,
      thirdPartyOnly,
      estimateFromText: insight.savingsSource === 'displayValue',
      sop,
      reason: reasons.join('; '),
      score,
    } satisfies RankedInsight & { score: number };
  });

  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
    // Deterministic tiebreak so two runs of the tool agree.
    return a.insight.id.localeCompare(b.insight.id);
  });

  return scored.map((entry, index) => {
    const { score: _score, ...rest } = entry;
    void _score;
    return { ...rest, rank: index + 1 };
  });
}

/**
 * Warnings that change how the numbers should be read.
 *
 * These matter because the naive reading of a Lighthouse report is wrong in
 * specific, predictable ways, and each of these has a fix.
 */
function cautionsFor(report: AggregatedReport, ranked: RankedInsight[]): string[] {
  const cautions: string[] = [];

  // Gated on `note`, not on `bimodal`: a split can be statistically real and too
  // small to act on, and a caution with an empty bracket in it is worse than no
  // caution at all - it reads as a bug in the tool.
  const scoreDist = report.distributions?.score;
  if (scoreDist?.bimodal && scoreDist.note) {
    cautions.push(
      `Score is bimodal (${scoreDist.note}). Compare lane-to-lane, not median-to-median: ` +
        'a median sitting in one lane reflects run count, not page behaviour.',
    );
  }

  for (const gap of report.targets.gaps) {
    if (medianMeets(gap) && gap.passRate !== undefined && gap.passRate < 0.9) {
      cautions.push(
        `${fmt(gap.metric)} reads as passing on the median (${gap.actual} vs ${gap.target}) but only ` +
          `${Math.round(gap.passRate * 100)}% of runs are inside budget ` +
          `(${gap.overBudgetRuns}/${gap.runsMeasured} over). Judge it on the tail.`,
      );
    }
  }

  const lcp = report.lcp;
  if (lcp?.isText) {
    cautions.push(
      'The LCP element is text, not an image. Image-flavoured insights (lcp-discovery, ' +
        'prioritize-lcp-image, lcp-lazy-loaded) do not apply to this page; work the phase breakdown instead.',
    );
  }
  if (lcp?.bottleneck === 'server') {
    cautions.push(
      `LCP is dominated by TTFB (~${Math.round(lcp.phases.ttfb ?? 0)}ms of ~${lcp.totalMs ?? 0}ms). ` +
        'No component change will move it - this belongs to the backend/CDN.',
    );
  }

  // A metric whose LCP/FCP never moves is pinned; a moving one is being measured
  // against genuine variance and needs more samples to judge.
  for (const metric of METRIC_KEYS) {
    const stats: SeriesStats | undefined = report.metrics[metric];
    if (stats && stats.stddev === 0 && stats.count > 1) {
      cautions.push(
        `${fmt(metric)} is identical across all ${stats.count} runs (${stats.median}). The page is pinned ` +
          'on this metric, so a change to it will not show up as score movement.',
      );
    }
  }

  const documentBytes = documentTransferSize(report);
  if (documentBytes !== undefined && documentBytes > HEAVY_DOCUMENT_BYTES) {
    cautions.push(
      `The HTML document is ${Math.round(documentBytes / 1024)} KB compressed. The browser discovers the LCP ` +
        'image, stylesheets and fonts only as it parses it, so a heavy document delays all of them. Look for ' +
        'long lists rendered up front, duplicated markup and large serialized state.',
    );
  }

  const dom = domSizeOf(report);
  if (dom && dom.elements > LARGE_DOM_ELEMENTS) {
    cautions.push(
      `The page has ${dom.elements.toLocaleString('en-US')} DOM elements.` +
        (dom.widest
          ? ` The widest node holds ${dom.widest.children} children (${dom.widest.selector}) - render it when it is opened, not in the server HTML.`
          : ''),
    );
  }

  const chain = longestChain(report);
  if (chain && chain.thirdPartyHosts.length > 0) {
    cautions.push(
      `The longest request chain (${chain.durationMs}ms) runs through third-party requests ` +
        `(${chain.thirdPartyHosts.join(', ')}). Loaded async they do not block the first paint, but they compete ` +
        'with the page for bandwidth. Check who injects them before counting them as work.',
    );
  }

  const textEstimated = ranked.filter((entry) => entry.estimateFromText);
  if (textEstimated.length > 0) {
    cautions.push(
      `${textEstimated.length} finding(s) had their size parsed from Lighthouse's display text rather than ` +
        'a structured field, so the figure is an estimate read out of a string.',
    );
  }

  const noFirstParty = ranked.filter((entry) => entry.thirdPartyOnly);
  if (noFirstParty.length > 0 && noFirstParty.length === ranked.length && ranked.length > 0) {
    cautions.push(
      'Every remaining finding is third-party cost. Log them as "not actionable in repo" and stop - ' +
        'there is no first-party win left in this report.',
    );
  }

  return cautions;
}

/** Compressed HTML above this delays everything discovered from it. */
export const HEAVY_DOCUMENT_BYTES = 60 * 1024;
/** Lighthouse's own failing threshold for DOM size. */
export const LARGE_DOM_ELEMENTS = 1400;

function documentTransferSize(report: AggregatedReport): number | undefined {
  const fromRequests = report.requests?.find(
    (request) => request.resourceType === 'Document' && request.transferSize !== undefined,
  );
  if (fromRequests) return fromRequests.transferSize;
  const weight = report.insights.find((insight) => insight.id === 'total-byte-weight');
  for (const row of (weight?.items ?? []) as Array<Record<string, unknown>>) {
    if (row.resourceType === 'Document' && typeof row.totalBytes === 'number') return row.totalBytes;
  }
  return undefined;
}

function domSizeOf(
  report: AggregatedReport,
): { elements: number; widest?: { children: number; selector: string } } | undefined {
  const insight = report.insights.find((entry) => entry.id === 'dom-size-insight');
  const rows = (insight?.items ?? []) as Array<{
    statistic?: string;
    value?: { value?: number };
    node?: { selector?: string };
  }>;
  const elements = rows.find((row) => row.statistic === 'Total elements')?.value?.value;
  if (typeof elements !== 'number') return undefined;
  const widest = rows.find((row) => row.statistic === 'Most children');
  const children = widest?.value?.value;
  const selector = widest?.node?.selector;
  return typeof children === 'number' && selector
    ? { elements, widest: { children, selector } }
    : { elements };
}

interface ChainNode {
  url?: string;
  isLongest?: boolean;
  children?: Record<string, ChainNode>;
}

/** The longest chain from `network-dependency-tree-insight`, and the foreign hosts on it. */
function longestChain(report: AggregatedReport): { durationMs: number; thirdPartyHosts: string[] } | undefined {
  const insight = report.insights.find((entry) => entry.id === 'network-dependency-tree-insight');
  const tree = ((insight?.items ?? []) as Array<{
    value?: { type?: string; chains?: Record<string, ChainNode>; longestChain?: { duration?: number } };
  }>).find((section) => section.value?.type === 'network-tree')?.value;
  if (!tree?.chains || typeof tree.longestChain?.duration !== 'number') return undefined;

  const hosts = new Set<string>();
  let level: Record<string, ChainNode> | undefined = tree.chains;
  while (level) {
    const next: ChainNode | undefined = Object.values(level).find((node) => node.isLongest);
    if (!next) break;
    if (next.url && !isOwnUrl(next.url, report.finalUrl || report.url)) {
      try {
        hosts.add(new URL(next.url).host);
      } catch {
        /* not a URL - nothing to attribute */
      }
    }
    level = next.children;
  }
  return { durationMs: Math.round(tree.longestChain.duration), thirdPartyHosts: [...hosts] };
}

/**
 * Build the full diagnosis for a report.
 *
 * `exhausted` is true when the only remaining findings belong to other people or
 * are flaky, which is the condition under which further iterations cannot pay -
 * the loop should report and hand back rather than keep spending quota.
 */
export function diagnose(
  report: AggregatedReport,
  options: { filters?: InsightFilters; minPassRate?: number } = {},
): Diagnosis {
  const minPassRate = options.minPassRate ?? 0.9;
  const priorityOrder = orderGaps(report.targets.gaps.filter((gap) => !gap.meets));
  const ranked = rankInsights(report, options);
  const unreliable = unreliableGaps(report.targets.gaps, minPassRate);

  const actionable = ranked.filter((entry) => !entry.thirdPartyOnly);
  const exhausted =
    report.targets.meetsTarget ||
    (priorityOrder.length > 0 && actionable.length === 0) ||
    (ranked.length === 0 && priorityOrder.length === 0);

  return {
    priorityOrder,
    primary: priorityOrder[0],
    ranked,
    blocked: report.targets.blockedBy ?? [],
    unreliable,
    cautions: cautionsFor(report, ranked),
    exhausted,
  };
}