import type {
  FieldData,
  FilterGroup,
  Insight,
  InsightFilters,
  MetricKey,
  Metrics,
  NormalizedReport,
  SortOrder,
  Strategy,
} from './types.js';
import { METRIC_KEYS } from './types.js';

export const MAX_ITEMS = 25;

/** Audit ids that correspond to each headline metric. */
const METRIC_AUDIT_IDS: Record<MetricKey, string[]> = {
  fcp: ['first-contentful-paint'],
  lcp: ['largest-contentful-paint'],
  tbt: ['total-blocking-time'],
  cls: ['cumulative-layout-shift'],
  speedIndex: ['speed-index'],
  tti: ['interactive'],
  ttfb: ['server-response-time'],
  inp: ['interaction-to-next-paint', 'experimental-interaction-to-next-paint'],
};

const METRIC_KEY_BY_AUDIT_ID = new Map<string, MetricKey>();
for (const key of METRIC_KEYS) {
  for (const id of METRIC_AUDIT_IDS[key]) {
    METRIC_KEY_BY_AUDIT_ID.set(id, key);
  }
}

/** Lighthouse's own metric names (as used in `metricSavings`) to ours. */
const METRIC_KEY_BY_LH_NAME = new Map<string, MetricKey>([
  ['FCP', 'fcp'],
  ['LCP', 'lcp'],
  ['TBT', 'tbt'],
  ['CLS', 'cls'],
  ['SI', 'speedIndex'],
  ['SPEEDINDEX', 'speedIndex'],
  ['TTI', 'tti'],
  ['TTFB', 'ttfb'],
  ['INP', 'inp'],
]);

type RawAudit = {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  score?: unknown;
  scoreDisplayMode?: unknown;
  displayValue?: unknown;
  numericValue?: unknown;
  numericUnit?: unknown;
  metricSavings?: unknown;
  details?: unknown;
};

type RawAuditRef = { id?: unknown; group?: unknown; relevantAudits?: unknown };

type RawPsiResponse = {
  lighthouseResult?: {
    requestedUrl?: unknown;
    finalUrl?: unknown;
    fetchTime?: unknown;
    lighthouseVersion?: unknown;
    categories?: Record<string, unknown>;
    audits?: Record<string, RawAudit>;
  };
  loadingExperience?: unknown;
  originLoadingExperience?: unknown;
};

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asScore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isInsightAudit(id: string): boolean {
  return id.endsWith('-insight');
}

/**
 * Decide what bucket an audit belongs to.
 *
 * Precedence (documented so the output is predictable):
 *   1. `notApplicable`  - Lighthouse scored the audit out of scope.
 *   2. `passed`         - a real score of 0.9 or better.
 *   3. `informative`    - display mode says there is nothing to act on.
 *   4. `opportunity`    - Lighthouse typed the details as an opportunity.
 *   5. `diagnostic`     - everything else that is worth reporting,
 *                         including every `-insight` audit.
 *
 * Modern `-insight` audits (Lighthouse 10.4+) are usually `informative` with a
 * null score but carry real `metricSavings` and item lists. Treating them as
 * merely informative would hide them from `group=opportunity,diagnostic`, which
 * is the filter the optimization loop depends on, so they are reported as
 * diagnostics.
 */
export function groupForAudit(
  id: string,
  score: number | null,
  scoreDisplayMode: string,
  detailsType: string | undefined,
): Insight['group'] {
  if (scoreDisplayMode === 'notApplicable') return 'notApplicable';
  if (score !== null && score >= 0.9) return 'passed';

  const modernInsight = isInsightAudit(id);
  if (!modernInsight) {
    if (scoreDisplayMode === 'informative' || scoreDisplayMode === 'manual') return 'informative';
    if (detailsType === 'opportunity') return 'opportunity';
  }
  return 'diagnostic';
}

function metricsAffectedBy(audit: RawAudit, auditRef: RawAuditRef | undefined): string[] {
  const affected = new Set<MetricKey>();

  const savings = audit.metricSavings;
  if (savings && typeof savings === 'object' && !Array.isArray(savings)) {
    for (const [name, value] of Object.entries(savings as Record<string, unknown>)) {
      if (asNumber(value) === undefined) continue;
      const key = METRIC_KEY_BY_LH_NAME.get(name.toUpperCase());
      if (key) affected.add(key);
    }
  }

  const relevant = auditRef?.relevantAudits;
  if (Array.isArray(relevant)) {
    for (const related of relevant) {
      if (typeof related !== 'string') continue;
      const key = METRIC_KEY_BY_AUDIT_ID.get(related);
      if (key) affected.add(key);
    }
  }

  return [...affected];
}

function detailsTypeOf(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const type = (details as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

/**
 * The largest time saving this audit claims, in ms.
 *
 * Lighthouse 13 dropped `details.overallSavingsMs` from most insight audits and
 * reports the time impact in `metricSavings` instead (e.g. `{ LCP: 6650 }`),
 * which is the number its own UI shows. Fall back to summing the detail items
 * for audits that report `wastedMs` per row.
 */
function savingsMsFrom(audit: RawAudit, details: unknown): number | undefined {
  const overall = asNumber((details as Record<string, unknown> | undefined)?.overallSavingsMs);
  if (overall !== undefined) return overall;

  const savings = audit.metricSavings;
  if (savings && typeof savings === 'object' && !Array.isArray(savings)) {
    const values = Object.values(savings as Record<string, unknown>)
      .map(asNumber)
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) return Math.max(...values);
  }

  return sumItemField(details, ['wastedMs']);
}

/**
 * Lighthouse 13 reports savings on the detail items (`wastedBytes` / `wastedMs`)
 * rather than in `details.overallSavings*`, which it now omits for most insight
 * audits. Sum the items as a fallback so sorting by savings still works.
 * Returns undefined when no item carried the field at all, so an unknown saving
 * is never reported as zero.
 */
function sumItemField(details: unknown, keys: string[]): number | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const items = (details as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return undefined;

  let total = 0;
  let seen = false;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    for (const key of keys) {
      const value = (item as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        total += value;
        seen = true;
      }
    }
  }
  return seen ? total : undefined;
}

function savingsFromDetails(
  audit: RawAudit,
  details: unknown,
): { savingsMs?: number; savingsBytes?: number } {
  const out: { savingsMs?: number; savingsBytes?: number } = {};

  const ms = savingsMsFrom(audit, details);
  if (ms !== undefined) out.savingsMs = ms;

  if (details && typeof details === 'object') {
    const record = details as Record<string, unknown>;
    const bytes = asNumber(record.overallSavingsBytes) ?? sumItemField(details, ['wastedBytes']);
    if (bytes !== undefined) out.savingsBytes = bytes;
  }

  return out;
}

function itemsFromDetails(details: unknown): { items?: unknown[]; itemsTotal?: number } {
  if (!details || typeof details !== 'object') return {};
  const items = (details as { items?: unknown }).items;
  if (!Array.isArray(items)) return {};
  return {
    items: items.slice(0, MAX_ITEMS),
    itemsTotal: items.length,
  };
}

export function extractMetrics(audits: Record<string, RawAudit>): Metrics {
  const metrics: Metrics = {};
  for (const key of METRIC_KEYS) {
    for (const id of METRIC_AUDIT_IDS[key]) {
      const value = asNumber(audits[id]?.numericValue);
      if (value !== undefined) {
        metrics[key] = value;
        break;
      }
    }
  }
  return metrics;
}

export function extractFieldData(raw: RawPsiResponse): FieldData | null {
  const fieldData: FieldData = {};
  if (raw.loadingExperience !== undefined && raw.loadingExperience !== null) {
    fieldData.loadingExperience = raw.loadingExperience;
  }
  if (raw.originLoadingExperience !== undefined && raw.originLoadingExperience !== null) {
    fieldData.originLoadingExperience = raw.originLoadingExperience;
  }
  return Object.keys(fieldData).length > 0 ? fieldData : null;
}

/**
 * Turn one raw PSI response into the normalized report shape.
 * The audit list is derived entirely from the response, so new Lighthouse
 * versions are picked up without a code change.
 */
export function normalizeReport(
  raw: unknown,
  requestedUrl: string,
  strategy: Strategy = 'mobile',
): NormalizedReport {
  const body = (raw ?? {}) as RawPsiResponse;
  const result = body.lighthouseResult;
  if (!result || typeof result !== 'object') {
    throw new Error('PSI response contained no lighthouseResult');
  }

  const performance = result.categories?.performance as
    | { score?: unknown; auditRefs?: RawAuditRef[] }
    | undefined;
  if (!performance || typeof performance !== 'object') {
    throw new Error('PSI response contained no performance category (did you request category=performance?)');
  }

  const audits = (result.audits ?? {}) as Record<string, RawAudit>;
  const refs = Array.isArray(performance.auditRefs) ? performance.auditRefs : [];
  const refById = new Map<string, RawAuditRef>();
  for (const ref of refs) {
    if (typeof ref?.id === 'string') refById.set(ref.id, ref);
  }

  const insights: Insight[] = [];

  for (const [id, audit] of Object.entries(audits)) {
    if (!audit || typeof audit !== 'object') continue;
    const title = asString(audit.title);
    // Structural entries carry no title; they are not insights.
    if (!title) continue;

    const ref = refById.get(id);
    // Lighthouse's `hidden` group is deliberately not surfaced in its UI.
    if (ref && ref.group === 'hidden' && !isInsightAudit(id)) continue;

    const scoreDisplayMode = asString(audit.scoreDisplayMode, 'binary');
    const score = asScore(audit.score);
    const details = audit.details;
    const savings = savingsFromDetails(audit, details);
    const { items, itemsTotal } = itemsFromDetails(details);
    const affected = metricsAffectedBy(audit, ref);

    const insight: Insight = {
      id,
      title,
      description: asString(audit.description),
      score,
      scoreDisplayMode,
      group: groupForAudit(id, score, scoreDisplayMode, detailsTypeOf(details)),
    };

    const displayValue = asString(audit.displayValue);
    if (displayValue) insight.displayValue = displayValue;

    const numericValue = asNumber(audit.numericValue);
    if (numericValue !== undefined) insight.numericValue = numericValue;

    const numericUnit = asString(audit.numericUnit);
    if (numericUnit) insight.numericUnit = numericUnit;

    if (savings.savingsMs !== undefined) insight.savingsMs = savings.savingsMs;
    if (savings.savingsBytes !== undefined) insight.savingsBytes = savings.savingsBytes;
    if (affected.length > 0) insight.metricsAffected = affected;
    if (items) insight.items = items;
    if (itemsTotal !== undefined && itemsTotal > MAX_ITEMS) insight.itemsTotal = itemsTotal;

    insights.push(insight);
  }

  return {
    url: requestedUrl,
    finalUrl: asString(result.finalUrl, requestedUrl),
    strategy,
    fetchTime: asString(result.fetchTime, new Date().toISOString()),
    lighthouseVersion: asString(result.lighthouseVersion, 'unknown'),
    // Lighthouse scores are 0-1; 0.58 * 100 is 57.99999999999999 in binary
    // floating point, so round away the representation error.
    score: Math.round(((asNumber(performance.score) ?? 0) * 100 + Number.EPSILON) * 10) / 10,
    metrics: extractMetrics(audits),
    insights,
    fieldData: extractFieldData(body),
  };
}

function sortValue(
  insight: Insight,
  sortBy: NonNullable<InsightFilters['sortBy']>,
  order: SortOrder,
): number {
  const raw =
    sortBy === 'savingsMs' ? insight.savingsMs : sortBy === 'savingsBytes' ? insight.savingsBytes : insight.score;
  if (raw === undefined || raw === null) {
    // Missing values always sort to the end, whichever direction is requested.
    return order === 'desc' ? -Infinity : Infinity;
  }
  return raw;
}

export function filterInsights<T extends Insight>(insights: T[], filters: InsightFilters = {}): T[] {
  const {
    group,
    minSavingsMs,
    minSavingsBytes,
    maxScore,
    metric,
    search,
    id,
    hasItems,
    sortBy = 'savingsMs',
    order = 'desc',
    limit,
    includeFlaky = true,
  } = filters;

  const groups = group?.length ? new Set<FilterGroup>(group) : null;
  const metrics = metric?.length ? new Set<MetricKey>(metric) : null;
  const ids = id?.length ? new Set(id.map((value) => value.trim().toLowerCase())) : null;
  const needle = search?.trim().toLowerCase();

  const direction = order === 'asc' ? 1 : -1;

  const filtered = insights.filter((insight) => {
    const flaky = (insight as { flaky?: boolean }).flaky === true;
    if (flaky && !includeFlaky) return false;

    if (groups && !groups.has(insight.group as FilterGroup)) return false;

    if (minSavingsMs !== undefined && (insight.savingsMs ?? -Infinity) < minSavingsMs) return false;
    if (minSavingsBytes !== undefined && (insight.savingsBytes ?? -Infinity) < minSavingsBytes) {
      return false;
    }
    if (maxScore !== undefined) {
      if (insight.score === null || insight.score > maxScore) return false;
    }

    if (metrics) {
      // Matches when the insight names the metric (metricSavings / relevantAudits)
      // or is the metric's own audit.
      const affected = insight.metricsAffected ?? [];
      const touchesAny = [...metrics].some(
        (key) => affected.includes(key) || METRIC_AUDIT_IDS[key].includes(insight.id),
      );
      if (!touchesAny) return false;
    }

    if (needle) {
      const haystack = `${insight.id} ${insight.title}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    if (ids && !ids.has(insight.id.toLowerCase())) return false;
    if (hasItems !== undefined && ((insight.items?.length ?? 0) > 0) !== hasItems) return false;

    return true;
  });

  filtered.sort((a, b) => {
    const left = sortValue(a, sortBy, order);
    const right = sortValue(b, sortBy, order);
    // Guard against Infinity - Infinity, which is NaN and would make the
    // comparator behave as "always equal" and skip the tie-break below.
    if (left === right) return a.id.localeCompare(b.id);
    return (left - right) * direction;
  });

  if (limit !== undefined && limit >= 0) {
    return filtered.slice(0, limit);
  }
  return filtered;
}
