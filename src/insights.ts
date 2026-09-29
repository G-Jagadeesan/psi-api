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
import { CACHE_BUST_PARAM } from './psiClient.js';
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
): { savingsMs: number | null; savingsBytes: number | null } {
  const ms = savingsMsFrom(audit, details);

  let bytes: number | undefined;
  if (details && typeof details === 'object') {
    const record = details as Record<string, unknown>;
    bytes = asNumber(record.overallSavingsBytes) ?? sumItemField(details, ['wastedBytes']);
  }

  return {
    // Null, not 0: "no estimate" and "no gain" are different facts and only one
    // of them is a reason to skip an insight.
    savingsMs: ms === undefined ? null : Math.round(ms),
    savingsBytes: bytes === undefined ? null : Math.round(bytes),
  };
}

/**
 * The cache-busting param this tool adds so PSI cannot reuse one report for
 * every run. Lighthouse echoes the measured URL back in several places,
 * including third-party iframe URLs, so it is stripped before anything is
 * reported - a report should not claim the site was loaded with a query param
 * the site never saw in production.
 */
export function stripCacheBust(value: string): string {
  if (!value.includes(CACHE_BUST_PARAM)) return value;

  // Absolute URL: let URL do the cleanup so no dangling "?" or "&" is left.
  try {
    const parsed = new URL(value);
    parsed.searchParams.delete(CACHE_BUST_PARAM);
    // Third-party iframes often mirror the page URL into their fragment, where
    // it is percent-encoded and invisible to searchParams.
    if (parsed.hash.includes(CACHE_BUST_PARAM)) {
      parsed.hash = parsed.hash
        .replace(new RegExp(`%3F${CACHE_BUST_PARAM}%3D[^&]*`, 'gi'), '')
        .replace(new RegExp(`[?&]${CACHE_BUST_PARAM}=[^&]*`, 'gi'), '');
    }
    return parsed.toString();
  } catch {
    // Relative or malformed URL: fall back to a textual strip.
    return value
      .replace(new RegExp(`([?&])${CACHE_BUST_PARAM}=[^&#]*`, 'g'), '')
      .replace(/[?&]$/, '');
  }
}

function hostOf(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
  try {
    return new URL(stripCacheBust(value)).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The measured site's own domain, with a leading `www.` removed, so that
 * `media.example.com` counts as first-party when `www.example.com` was measured.
 * Deliberately not a public-suffix implementation: that would need a
 * maintained list to avoid treating `example.co.uk` as the registrable domain.
 */
export function baseHostOf(url: string): string {
  const host = hostOf(url);
  if (!host) return '';
  return host.replace(/^www\./, '');
}

function isFirstPartyHost(host: string, baseHost: string): boolean {
  if (!baseHost) return false;
  return host === baseHost || host.endsWith(`.${baseHost}`);
}

/** Collect every resource URL an item refers to, including nested sub-items. */
function itemUrls(item: unknown, depth = 0): string[] {
  if (!item || typeof item !== 'object' || depth > 3) return [];
  const record = item as Record<string, unknown>;
  const urls: string[] = [];
  if (typeof record.url === 'string') urls.push(record.url);
  const sub = record.subItems as { items?: unknown } | undefined;
  if (Array.isArray(sub?.items)) {
    for (const child of sub.items) urls.push(...itemUrls(child, depth + 1));
  }
  return urls;
}

function itemsFromDetails(details: unknown): { items?: unknown[]; itemsTotal: number } {
  const items = detailItemsOf(details);
  if (items.length === 0 && !Array.isArray((details as { items?: unknown } | null)?.items)) {
    return { itemsTotal: 0 };
  }
  return {
    items: items.slice(0, MAX_ITEMS),
    // Always set, not just when trimmed. A stored run that reported itemsTotal
    // only past the 25-item cut made "how many rows are there" unanswerable for
    // every smaller insight.
    itemsTotal: items.length,
  };
}

/** Every `details.items` row, with the cache-busting param removed from any URL. */
function detailItemsOf(details: unknown): unknown[] {
  if (!details || typeof details !== 'object') return [];
  const items = (details as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => stripCacheBustDeep(item));
}

/**
 * Third-party resources lack element-level data in Lighthouse's own rollup
 * (`third-parties-insight` only has entity aggregates). To make them usable by
 * an agent, we need to know which element loaded each resource so it can be
 * removed or lazy-loaded. This helper builds a lookup from URL to element
 * info by scanning every audit that records DOM nodes.
 */
function buildElementMap(audits: Record<string, RawAudit>): Map<string, { node?: unknown; resourceType?: string }> {
  const elementAudits = [
    'unsized-images',
    'image-delivery-insight',
    'render-blocking-insight',
    'font-display-insight',
  ];
  const map = new Map<string, { node?: unknown; resourceType?: string }>();

  // Populate from element-level audits
  for (const id of elementAudits) {
    const audit = audits[id];
    if (!audit?.details) continue;
    const items = detailItemsOf(audit.details);
    for (const item of items) {
      const url = asString((item as { url?: unknown }).url);
      if (!url) continue;
      const node = (item as { node?: unknown }).node;
      if (node) {
        const existing = map.get(url) || {};
        existing.node = node;
        map.set(url, existing);
      }
    }
  }

  // Add resourceType from network-requests. Lighthouse does not give element
  // mapping here, but it knows the request type (Image, Script, etc.).
  const network = audits['network-requests'];
  if (network?.details) {
    const items = detailItemsOf(network.details);
    for (const item of items) {
      const url = asString((item as { url?: unknown }).url);
      if (!url) continue;
      const rt = asString((item as { resourceType?: unknown }).resourceType);
      if (rt) {
        const existing = map.get(url) || {};
        existing.resourceType = rt;
        map.set(url, existing);
      }
    }
  }

  return map;
}

/**
 * Walk an item (including nested subItems) and attach element info from the
 * element map when a URL matches. Mutates in place.
 */
function enrichItemsWithElements(items: unknown[], elementMap: Map<string, { node?: unknown; resourceType?: string }>): void {
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    // Top-level URL (exists for most audits, but third-parties entities have none)
    const url = asString(record.url);
    if (url) {
      const info = elementMap.get(url);
      if (info) {
        if (info.resourceType && !record.resourceType) record.resourceType = info.resourceType;
        if (info.node && !record.node) record.node = info.node;
      }
    }
    // Nested subItems (third-parties stores the actual resources here)
    const subItems = (record.subItems as { items?: unknown[] } | undefined)?.items;
    if (Array.isArray(subItems)) {
      enrichItemsWithElements(subItems, elementMap);
    }
  }
}

/**
 * `third-parties-insight` exists precisely to list other people's code, so every
 * row is third party by definition - even though its rows carry an `entity` name
 * rather than a top-level URL.
 */
function thirdPartyByDefinition(items: unknown[]): PartyBreakdown {
  const hosts = new Set<string>();
  let attributed = 0;
  for (const item of items) {
    for (const url of itemUrls(item)) {
      const host = hostOf(url);
      if (host) {
        hosts.add(host);
        attributed += 1;
      }
    }
  }
  return {
    firstPartyItems: 0,
    thirdPartyItems: items.length,
    itemHosts: [...hosts].slice(0, MAX_REPORTED_HOSTS).sort(),
  };
}

/** Remove the cache-busting param from every URL anywhere inside an item. */
function stripCacheBustDeep(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  if (typeof value === 'string') return stripCacheBust(value);
  if (Array.isArray(value)) return value.map((entry) => stripCacheBustDeep(entry, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = key === 'url' && typeof entry === 'string' ? stripCacheBust(entry) : stripCacheBustDeep(entry, depth + 1);
    }
    return out;
  }
  return value;
}
export interface PartyBreakdown {
  firstPartyItems: number;
  thirdPartyItems: number;
  itemHosts: string[];
}

const MAX_REPORTED_HOSTS = 8;

/**
 * Split an insight's items into first-party and third-party by resource host.
 *
 * Without this, sorting by savings puts third-party CDN beacons and vendor tags
 * at the top of the queue - on a real deployment the two largest actionable
 * findings were both Cloudflare's own analytics script, which no amount of
 * editing the app source can fix. Items with no URL at all (main-thread
 * breakdowns, LCP phase breakdowns) count as neither, because their cost is
 * unattributed and may well be first-party code.
 */
export function classifyItemParties(items: unknown[], baseHost: string): PartyBreakdown {
  const hosts = new Set<string>();
  let firstPartyItems = 0;
  let thirdPartyItems = 0;

  for (const item of items) {
    const itemHosts = new Set<string>();
    for (const url of itemUrls(item)) {
      const host = hostOf(url);
      if (host) itemHosts.add(host);
    }
    if (itemHosts.size === 0) continue;

    let own = false;
    for (const host of itemHosts) {
      hosts.add(host);
      if (isFirstPartyHost(host, baseHost)) own = true;
    }
    // An item is third-party if every host it loads is foreign. Mixed items
    // (your CDN plus a vendor) still count as first-party, since you own part
    // of the cost and part of the fix.
    if (own) firstPartyItems += 1;
    else thirdPartyItems += 1;
  }

  return {
    firstPartyItems,
    thirdPartyItems,
    itemHosts: [...hosts].slice(0, MAX_REPORTED_HOSTS).sort(),
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
    // CrUX echoes `initial_url` back verbatim, nonce included, so it is stripped
    // on the way through rather than passed through untouched.
    fieldData.loadingExperience = stripCacheBustDeep(raw.loadingExperience);
  }
  if (raw.originLoadingExperience !== undefined && raw.originLoadingExperience !== null) {
    fieldData.originLoadingExperience = stripCacheBustDeep(raw.originLoadingExperience);
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

  // Third-party resources come without element data. Correlate URLs from
  // element-level audits so an agent knows where to cut or lazy-load them.
  const elementMap = buildElementMap(audits);

  // Lighthouse echoes the URL it was actually given, cache-busting param and
  // all. Strip it so ownership is judged against the real site, and so nothing
  // downstream reports a URL the site never served.
  const finalUrl = stripCacheBust(asString(result.finalUrl, requestedUrl)) || requestedUrl;
  const measuredUrl = finalUrl || requestedUrl;

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
    const affected = metricsAffectedBy(audit, ref);

    const rawItems = detailItemsOf(details);
    // Classify across every row, not the trimmed 25, so firstPartyItems and
    // thirdPartyItems are honest counts rather than a sample.
    const party = audit.id === 'third-parties-insight'
      ? thirdPartyByDefinition(rawItems)
      : classifyItemParties(rawItems, baseHostOf(measuredUrl));

    const insight: Insight = {
      id,
      title,
      description: asString(audit.description),
      score,
      scoreDisplayMode,
      group: groupForAudit(id, score, scoreDisplayMode, detailsTypeOf(details)),
      savingsMs: savings.savingsMs,
      savingsBytes: savings.savingsBytes,
      firstPartyItems: party.firstPartyItems,
      thirdPartyItems: party.thirdPartyItems,
      itemHosts: party.itemHosts,
    };

    const displayValue = asString(audit.displayValue);
    if (displayValue) insight.displayValue = displayValue;

    const numericValue = asNumber(audit.numericValue);
    if (numericValue !== undefined) insight.numericValue = numericValue;

    const numericUnit = asString(audit.numericUnit);
    if (numericUnit) insight.numericUnit = numericUnit;

    if (affected.length > 0) insight.metricsAffected = affected;
    const { items, itemsTotal } = itemsFromDetails(details);
    if (items && items.length > 0) insight.items = items;
    if (itemsTotal > 0) insight.itemsTotal = itemsTotal;
    // A third party that costs you time has not "passed". Filing it under
    // `passed` buried it at the bottom of every savings-sorted work queue, which
    // is exactly where an agent needs to see it in order to rule it out.
    if (id === 'third-parties-insight' && itemsTotal > 0 && insight.group === 'passed') {
      insight.group = 'diagnostic';
    }

    insights.push(insight);
  }

  // Third-party item enrichment: attach element info (selector, snippet)
  // wherever we were able to correlate a resource URL to an element-level audit.
  for (const insight of insights) {
    if (insight.thirdPartyItems > 0 && Array.isArray(insight.items)) {
      enrichItemsWithElements(insight.items, elementMap);
    }
  }

  return {
    url: requestedUrl,
    finalUrl,
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
    party = 'any',
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

    // `first` keeps anything not charged to a foreign host, including insights
    // Lighthouse could not attribute to a URL at all - a main-thread breakdown
    // with no script behind it is usually the site's own code. `third` is the
    // inverse, and is how you inspect what the tag managers are costing you
    // without it polluting the work queue.
    if (party === 'first' && insight.thirdPartyItems > 0) return false;
    if (party === 'third' && insight.thirdPartyItems === 0) return false;

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
