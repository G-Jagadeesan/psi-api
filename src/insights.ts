import type {
  FieldData,
  FilterGroup,
  FirstPartyShare,
  Insight,
  InsightFilters,
  LcpDetail,
  LcpPhases,
  MetricKey,
  Metrics,
  NormalizedReport,
  SavingsSource,
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

/**
 * Fill in a stored insight's savings figure when the stored one is missing.
 *
 * A stored `NormalizedReport` keeps `items` and `displayValue` but not the raw
 * `details` object, and the savings decision was baked in at normalize time.
 * Reports written before the zero-rollup fix therefore carry `savingsMs: 0` for
 * their largest findings, and no amount of re-aggregating will change that - the
 * figure has to be derived again from the per-row `wastedMs`/`wastedBytes` and
 * the display string, which are both still on the record.
 *
 * This only ever **fills a gap**. A stored positive figure is left exactly as it
 * is, because it may have come from `details.overallSavingsMs` or
 * `metricSavings` - neither of which survives normalization, so neither can be
 * reconstructed here. Overwriting a known Lighthouse rollup with a row-derived
 * approximation would trade a precise answer for a rough one, and reporting
 * `null` for an estimate that already existed would be strictly worse than
 * leaving the report alone. The zero-rollup defect is the only case worth
 * repairing, and a stored `0` is unambiguous evidence of it.
 */
export function refreshInsightSavings(insight: Insight): Insight {
  const known = (value: number | null | undefined): boolean =>
    typeof value === 'number' && value > 0;

  if (known(insight.savingsMs) && known(insight.savingsBytes)) return insight;

  const recomputed = savingsFromDetails(
    // The stored form has no `metricSavings`, so only the row and text sources
    // are available here. That is exactly what the real data needs.
    {} as RawAudit,
    { items: insight.items ?? [] },
    insight.displayValue,
  );

  const refreshed: Insight = { ...insight };
  if (!known(insight.savingsMs)) {
    // A stored `0` is the zero-rollup defect's fingerprint - the tool's own
    // convention is that `null` means "no estimate" and `0` never reaches a
    // normalized insight at all. So it is replaced, including by `null` when
    // nothing better can be recovered.
    refreshed.savingsMs = recomputed.savingsMs;
  }
  if (!known(insight.savingsBytes)) {
    refreshed.savingsBytes = recomputed.savingsBytes;
  }
  // The source is only known when this function supplied the value; a stored
  // figure keeps whatever provenance it was written with.
  if (refreshed.savingsMs !== insight.savingsMs || refreshed.savingsBytes !== insight.savingsBytes) {
    refreshed.savingsSource = recomputed.savingsSource;
  }
  return refreshed;
}

/**
 * True when this audit *is* a headline metric rather than a finding about one.
 *
 * A metric audit reports the number itself, so putting it in a work queue tells
 * the agent nothing it cannot already read off the failing-gaps list. It is a
 * symptom, never a cause, and it has no playbook to route to.
 */
export function isMetricAudit(id: string): boolean {
  return METRIC_KEY_BY_AUDIT_ID.has(id);
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

/** Where a savings figure was recovered from, and its value. */
interface SavingsHit {
  value: number;
  source: SavingsSource;
}

const NONE: SavingsHit = { value: 0, source: 'none' };

/**
 * Pick the first *non-zero* estimate, in descending order of precision.
 *
 * Two rules, both learned the hard way from real Lighthouse output:
 *
 *  - **Zero means "no estimate", not "no gain".** Lighthouse 13 writes
 *    `details.overallSavingsMs: 0` on audits whose detail items carry real waste.
 *    A "first one wins, and 0 counts" chain reported a render-blocking
 *    stylesheet costing 601ms as saving nothing.
 *  - **Precision beats size.** `Est savings of 58 KiB` is Lighthouse's rounded
 *    rendering of an exact 58008 bytes. Taking the *largest* candidate would
 *    prefer 58 * 1024 = 59392 and quietly inflate the number. So sources are
 *    consulted in order of exactness - structured rollup, then per-row sums -
 *    and the display string is a last-resort fallback for audits that carry no
 *    structured estimate at all.
 */
function firstPositive(...candidates: Array<SavingsHit | undefined>): SavingsHit {
  for (const candidate of candidates) {
    if (candidate && candidate.value > 0) return candidate;
  }
  return NONE;
}

/** Largest value in a `metricSavings` map, which Lighthouse uses for time impact. */
function metricSavingsHit(audit: RawAudit): SavingsHit {
  const savings = audit.metricSavings;
  if (!savings || typeof savings !== 'object' || Array.isArray(savings)) return NONE;
  const values = Object.values(savings as Record<string, unknown>)
    .map(asNumber)
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return NONE;
  return { value: Math.max(...values), source: 'metricSavings' };
}

function overallHit(details: unknown, field: 'overallSavingsMs' | 'overallSavingsBytes'): SavingsHit {
  const value = asNumber((details as Record<string, unknown> | undefined)?.[field]);
  return value !== undefined && value > 0 ? { value, source: 'overall' } : NONE;
}

function itemsHit(details: unknown, keys: string[]): SavingsHit {
  const value = sumItemField(details, keys);
  return value !== undefined && value > 0 ? { value, source: 'items' } : NONE;
}

function textHit(displayValue: string | undefined, unit: 'ms' | 'bytes'): SavingsHit {
  const value = parseSavingsText(displayValue, unit);
  return value !== undefined && value > 0 ? { value, source: 'displayValue' } : NONE;
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

/** Byte units Lighthouse uses in its display strings. */
const BYTE_UNITS: Record<string, number> = {
  b: 1,
  byte: 1,
  bytes: 1,
  kib: 1024,
  kb: 1024,
  mib: 1024 ** 2,
  mb: 1024 ** 2,
  gib: 1024 ** 3,
  gb: 1024 ** 3,
};

/**
 * Parse a savings figure out of a human display string.
 *
 * Lighthouse renders estimates like `Est savings of 202 KiB` or
 * `Potential savings of 640 ms`, and for some audits that string is the **only**
 * place the number exists - there is no `overallSavings*` and no per-row field.
 * Ignoring it reported a 202 KiB unused-JavaScript finding as saving 0ms.
 *
 * The string must actually be a *savings* claim. That guard is essential:
 * Lighthouse uses `displayValue` for plenty of non-savings numbers, and
 * `Main thread work: 1.1 s` read naively becomes a bogus 1100ms saving on an
 * audit that never claimed one.
 *
 * Returns undefined when the string carries no savings figure, so "no estimate"
 * stays distinguishable from zero.
 */
export function parseSavingsText(displayValue: string | undefined, unit: 'ms' | 'bytes'): number | undefined {
  if (!displayValue) return undefined;
  // Only a savings claim may be parsed. `savings` is Lighthouse's own wording in
  // both "Potential savings of X" and "Est savings of X".
  if (!/saving/i.test(displayValue)) return undefined;

  const cleaned = displayValue.replace(/[\u2013\u2014]/g, '-');
  const match = /(-?[\d.,]+)\s*([a-zA-Z]*)/.exec(cleaned);
  if (!match) return undefined;

  const raw = match[1];
  if (raw === undefined) return undefined;
  // Locale formats use a comma as the decimal separator.
  const numeric = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;

  const suffix = (match[2] ?? '').toLowerCase();
  if (unit === 'ms') {
    // Only an explicit millisecond figure counts. Seconds are deliberately not
    // inferred: "1.1 s" of main thread work is a measurement, not a saving.
    return suffix === 'ms' ? numeric : undefined;
  }

  const factor = BYTE_UNITS[suffix];
  return factor === undefined ? undefined : numeric * factor;
}

function savingsFromDetails(
  audit: RawAudit,
  details: unknown,
  displayValue: string | undefined,
): {
  savingsMs: number | null;
  savingsBytes: number | null;
  savingsSource: SavingsSource;
} {
  // Exactness order: Lighthouse's own rollup, its per-metric time impact, the
  // per-row sum, and only then the rounded human string.
  const msHit = firstPositive(
    overallHit(details, 'overallSavingsMs'),
    metricSavingsHit(audit),
    itemsHit(details, ['wastedMs']),
    textHit(displayValue, 'ms'),
  );
  const bytesHit = firstPositive(
    overallHit(details, 'overallSavingsBytes'),
    itemsHit(details, ['wastedBytes']),
    textHit(displayValue, 'bytes'),
  );

  return {
    // Null, not 0: "no estimate" and "no gain" are different facts and only one
    // of them is a reason to skip an insight.
    savingsMs: msHit.value > 0 ? Math.round(msHit.value) : null,
    savingsBytes: bytesHit.value > 0 ? Math.round(bytesHit.value) : null,
    savingsSource: msHit.source !== 'none' ? msHit.source : bytesHit.source,
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
    const displayValue = asString(audit.displayValue);
    // `displayValue` is passed in because for several Lighthouse 13 audits it is
    // the only place a savings estimate exists.
    const savings = savingsFromDetails(audit, details, displayValue || undefined);
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
      savingsSource: savings.savingsSource,
      firstPartyItems: party.firstPartyItems,
      thirdPartyItems: party.thirdPartyItems,
      itemHosts: party.itemHosts,
    };

    if (displayValue) insight.displayValue = displayValue;

    // Captured here so `--sortBy firstPartyShare` and `--minFirstPartyRatio`
    // never have to re-derive it, and so the stored report explains itself.
    const attributedTotal = party.firstPartyItems + party.thirdPartyItems;
    insight.firstPartyShare = attributedTotal === 0 ? null : party.firstPartyItems / attributedTotal;

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

/* ------------------------------ LCP element detail ---------------------------- */

/** Lighthouse's own subpart names, mapped onto our phase keys. */
const LCP_PHASE_KEYS: Record<string, keyof LcpPhases> = {
  ttfb: 'ttfb',
  timeToFirstByte: 'ttfb',
  loadDelay: 'loadDelay',
  resourceLoadDelay: 'loadDelay',
  loadTime: 'loadTime',
  resourceLoadTime: 'loadTime',
  elementRenderDelay: 'renderDelay',
  renderDelay: 'renderDelay',
};

/**
 * The phase of LCP that dominates, and therefore which playbook applies.
 *
 * A page whose TTFB is the biggest single phase cannot be fixed by a component
 * change, and an agent that reads `lcp-discovery-insight` as "my hero image is
 * late" will spend its whole budget on the wrong layer.
 */
function bottleneckOf(phases: LcpPhases): LcpDetail['bottleneck'] {
  const entries = Object.entries(phases).filter(([, value]) => typeof value === 'number') as Array<
    [keyof LcpPhases, number]
  >;
  if (entries.length === 0) return 'unknown';
  entries.sort((a, b) => b[1] - a[1]);
  const dominant = entries[0]?.[0];
  if (dominant === 'ttfb') return 'server';
  if (dominant === 'loadDelay' || dominant === 'loadTime') return 'resource';
  if (dominant === 'renderDelay') return 'render';
  return 'unknown';
}

/** Collect every `{subpart, duration}` row from anywhere inside an insight. */
function collectPhases(value: unknown, depth = 0, out: LcpPhases = {}): LcpPhases {
  if (depth > 5 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const entry of value) collectPhases(entry, depth + 1, out);
    return out;
  }
  const record = value as Record<string, unknown>;
  const key = LCP_PHASE_KEYS[asString(record.subpart)];
  const duration = asNumber(record.duration);
  if (key && duration !== undefined) out[key] = (out[key] ?? 0) + duration;

  for (const entry of Object.values(record)) {
    if (entry && typeof entry === 'object') collectPhases(entry, depth + 1, out);
  }
  return out;
}

/** The element node Lighthouse attached to an LCP audit, if any. */
function nodeOf(items: unknown[]): Record<string, unknown> | undefined {
  for (const item of items) {
    if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'node') {
      return item as Record<string, unknown>;
    }
  }
  return undefined;
}

/** Image-ish element tags. Everything else as an LCP element is text. */
const IMAGE_TAGS = new Set(['IMG', 'PICTURE', 'VIDEO', 'SVG', 'IMAGE', 'CANVAS', 'IFRAME']);

function isTextElement(type: string | undefined): boolean {
  if (!type) return true;
  return !IMAGE_TAGS.has(type.toUpperCase());
}

/**
 * Work out what the LCP element is and where its time went.
 *
 * Two facts matter for choosing a fix, and neither is visible in the metric
 * number:
 *
 *  1. **Is it an image?** If the LCP element is a text node there is no image to
 *     prioritise, lazy-load or resize, so every image-flavoured insight about
 *     "the LCP image" is irrelevant to this page.
 *  2. **Which phase dominates?** `loadDelay`/`loadTime` means fetch earlier.
 *     `renderDelay` means something is blocking paint - usually CSS. TTFB means
 *     the server is the constraint and no component change will help.
 *
 * Uses the median-scoring run, matching how `items` are chosen elsewhere.
 */
export function lcpDetailFrom(reports: NormalizedReport[], medianScore: number): LcpDetail | null {
  if (reports.length === 0) return null;

  const run =
    [...reports].sort(
      (a, b) => Math.abs(a.score - medianScore) - Math.abs(b.score - medianScore) || a.fetchTime.localeCompare(b.fetchTime),
    )[0] ?? null;
  if (!run) return null;

  const lcpAudit =
    run.insights.find((i) => i.id === 'lcp-breakdown-insight') ??
    run.insights.find((i) => i.id === 'lcp-phases-insight') ??
    run.insights.find((i) => i.id === 'largest-contentful-paint-element');

  const items = lcpAudit?.items ?? [];
  if (!lcpAudit) {
    // No breakdown audit at all: report the absence rather than guessing.
    return null;
  }

  const node = nodeOf(items);
  const phases = collectPhases(items);
  const phaseEntries = Object.entries(phases).filter(([, value]) => typeof value === 'number') as Array<
    [keyof LcpPhases, number]
  >;
  const totalMs = phaseEntries.reduce((sum, [, value]) => sum + value, 0);

  const type = asString(node?.nodeType, undefined) || undefined;
  const elementType = asString(node?.nodeLabel, undefined) ? undefined : type;

  const detail: LcpDetail = {
    isText: isTextElement(elementType),
    phases,
    bottleneck: bottleneckOf(phases),
  };
  if (type) detail.elementType = type;
  const text = asString(node?.nodeLabel, undefined);
  if (text) detail.text = text;
  const selector = asString(node?.selector, undefined);
  if (selector) detail.selector = selector;
  const snippet = asString(node?.snippet, undefined);
  if (snippet) detail.snippet = snippet;
  if (totalMs > 0) detail.totalMs = Math.round(totalMs);

  if (phaseEntries.length > 0) {
    phaseEntries.sort((a, b) => b[1] - a[1]);
    detail.dominantPhase = phaseEntries[0]?.[0];
  }
  return detail;
}

/**
 * Share of an insight's cost attributable to the measured site.
 *
 * Prefers the value captured at normalize time and recomputes if absent, so
 * hand-built insights and insights restored from an older stored report still
 * behave. Unattributed cost returns `null` rather than 0, because "Lighthouse
 * could not tell" and "it is all someone else's" are different facts - main
 * thread breakdowns are unattributed and are usually your own JavaScript.
 */
export function firstPartyShareOf(insight: Insight): FirstPartyShare {
  if (insight.firstPartyShare !== undefined) return insight.firstPartyShare;
  const total = insight.firstPartyItems + insight.thirdPartyItems;
  if (total === 0) return null;
  return insight.firstPartyItems / total;
}

function sortValue(
  insight: Insight,
  sortBy: NonNullable<InsightFilters['sortBy']>,
  order: SortOrder,
): number {
  let raw: number | null | undefined;
  if (sortBy === 'savingsMs') raw = insight.savingsMs;
  else if (sortBy === 'savingsBytes') raw = insight.savingsBytes;
  else if (sortBy === 'firstPartyShare') raw = firstPartyShareOf(insight);
  else raw = insight.score;

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
    minFirstPartyRatio,
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
    if (minFirstPartyRatio !== undefined && (firstPartyShareOf(insight) ?? 0) < minFirstPartyRatio) {
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

    // `first` keeps every insight carrying any cost you own, and keeps insights
    // Lighthouse could not attribute to a URL at all - a main-thread breakdown
    // with no script behind it is usually the site's own code.
    //
    // It only drops an insight whose cost is *entirely* foreign. The previous
    // `thirdPartyItems > 0` test also dropped *mixed* insights, which discarded
    // the first-party rows along with the vendor's: a finding holding 43 KB of
    // your own dead CSS and one vendor stylesheet vanished from the queue
    // because the two shared a finding. That is precisely the case where you
    // still own most of the fix.
    if (party === 'first' && insight.thirdPartyItems > 0 && insight.firstPartyItems === 0) return false;
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
