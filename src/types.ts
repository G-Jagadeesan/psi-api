export const STRATEGIES = ['mobile', 'desktop'] as const;
export const STATS = ['mean', 'median', 'mode'] as const;

export type Strategy = (typeof STRATEGIES)[number];
export type Stat = (typeof STATS)[number];

export type InsightGroup =
  | 'opportunity'
  | 'diagnostic'
  | 'passed'
  | 'informative'
  | 'notApplicable';

/** Groups that are selectable through the `group` insight filter. */
export type FilterGroup = Exclude<InsightGroup, 'notApplicable'>;

export const METRIC_KEYS = [
  'fcp',
  'lcp',
  'tbt',
  'cls',
  'speedIndex',
  'tti',
  'ttfb',
  'inp',
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

/** Core Web Vitals, always present when the audit ran. */
export const REQUIRED_METRICS = ['fcp', 'lcp', 'tbt', 'cls', 'speedIndex'] as const;

export type Metrics = Partial<Record<MetricKey, number>>;

export interface Insight {
  id: string;
  title: string;
  description: string;
  score: number | null;
  scoreDisplayMode: string;
  displayValue?: string;
  numericValue?: number;
  numericUnit?: string;
  group: InsightGroup;
  /** Null means "Lighthouse gave no estimate" - which is not the same as zero. */
  savingsMs: number | null;
  /** Null means "Lighthouse gave no estimate" - which is not the same as zero. */
  savingsBytes: number | null;
  /** Where the savings number was actually found, for auditing a suspicious estimate. */
  savingsSource?: SavingsSource;
  metricsAffected?: string[];
  items?: unknown[];
  /** Raw `details.items` length before trimming to the top 25. */
  itemsTotal?: number;
  /** Items whose resource is served from the measured site's own domain. */
  firstPartyItems: number;
  /** Items whose resource is served from someone else's domain. */
  thirdPartyItems: number;
  /** Distinct hosts behind the items, capped for readability. */
  itemHosts: string[];
  /**
   * Share of this insight's cost that is yours, 0-1; `null` when unattributed.
   *
   * A value strictly between 0 and 1 means the insight is *mixed*: some rows are
   * your own domain and some are a vendor's. Dropping a mixed insight wholesale
   * throws away the part you control, so this is what `--party first` ranks by
   * and what `--minFirstPartyRatio` filters on.
   */
  firstPartyShare?: FirstPartyShare;
}

/**
 * Which field a savings estimate was recovered from.
 *
 * Recorded because the sources disagree in practice: `details.overallSavingsMs`
 * is the rollup Lighthouse writes for its own UI, the per-item sum is what the
 * rows actually add up to, and `displayValue` is the human string that is the
 * *only* place some Lighthouse 13 audits put the number.
 */
export type SavingsSource = 'overall' | 'metricSavings' | 'items' | 'displayValue' | 'none';

/** CrUX field data, passed through untouched when the origin has real users. */
export interface FieldData {
  loadingExperience?: unknown;
  originLoadingExperience?: unknown;
}

/**
 * How a run was actually measured, read back from Lighthouse's own report.
 *
 * This exists because a performance number without its measurement conditions is
 * not interpretable. Two reports are only comparable when they were taken under
 * the same conditions, and the device emulation, network throttling model, CPU
 * benchmark and Lighthouse build are all chosen server-side by PSI - the caller
 * cannot request them, so a stored report has to *record* them or the comparison
 * has to be taken on trust.
 *
 * PSI echoes only part of its config, so every field here is what the response
 * actually stated. Anything it omits is omitted here too rather than guessed:
 * see `PSI_CONFIG_ECHOED_FIELDS` in `normalizeReport`.
 */
export interface RunEnvironment {
  /** Lighthouse release that produced the run. */
  lighthouseVersion: string;
  /** What the metrics were emulated as: `mobile` or `desktop`. */
  formFactor?: string;
  /** Device class, when it differs from `formFactor` (always `mobile` here). */
  emulatedFormFactor?: string;
  /**
   * Which CPU the run was scored against, as Lighthouse's `benchmarkIndex`.
   *
   * A higher number is a slower device. This is the single best predictor of
   * whether two reports are comparable at all, and it is worth checking when a
   * score moves for no reason you can find in the code.
   */
  benchmarkIndex?: number;
  /**
   * The user agent the page's network stack was emulated with, which names the
   * actual device model (e.g. "moto g power (2022)").
   */
  networkUserAgent?: string;
  /** The host that ran the audit, for provenance. */
  hostUserAgent?: string;
  /** PSI's release channel, e.g. `lr` (Lighthouse Runner). */
  channel?: string;
  /** Locale used for the audit. */
  locale?: string;
  /**
   * The categories actually scored, e.g. `["performance"]`.
   *
   * A report is not a full Lighthouse run unless this is everything you expected.
   */
  categories?: string[];
  /** The emulated screen, from `configSettings.screenEmulation`. */
  screen?: ScreenEmulation;
}

/**
 * The viewport a run was rendered in.
 *
 * Needed to judge an element's position ("below the first fold") and an image's
 * size ("larger than it renders"), both of which are in CSS pixels while the
 * image a phone needs is in device pixels.
 */
export interface ScreenEmulation {
  width: number;
  height: number;
  deviceScaleFactor: number;
  /** `reported` when read from the response, `default` when Lighthouse's defaults were assumed. */
  source: 'reported' | 'default';
}

/**
 * One row of Lighthouse's `network-requests` table.
 *
 * Times are observed on PSI's own connection, relative to the first request.
 * The order is meaningful; the absolute values are not comparable to FCP/LCP,
 * which PSI computes by simulating a throttled connection.
 */
export interface NetworkRequest {
  url: string;
  resourceType?: string;
  mimeType?: string;
  priority?: string;
  startMs?: number;
  endMs?: number;
  transferSize?: number;
  resourceSize?: number;
  statusCode?: number;
  isLinkPreload?: boolean;
  entity?: string;
  party: 'first' | 'third';
}

export type ImageFindingKind =
  | 'oversized'
  | 'compression'
  | 'srcsetWithoutSizes'
  | 'eagerOffscreen'
  | 'lazyInFirstFold'
  | 'heavyImage'
  | 'multipleHighPriority';

export interface ImageFinding {
  kind: ImageFindingKind;
  url?: string;
  selector?: string;
  /** One sentence saying what is wrong and what the fix is. */
  detail: string;
  /** Bytes the finding costs or could save, when known. */
  bytes?: number;
  /** For `oversized`: true when the waste survives the device-pixel correction. */
  real?: boolean;
}

export interface ImageChecks {
  screen: ScreenEmulation;
  findings: ImageFinding[];
}

export interface NormalizedReport {
  url: string;
  finalUrl: string;
  strategy: Strategy;
  fetchTime: string;
  lighthouseVersion: string;
  /** How this run was measured, as Lighthouse reported it. */
  environment: RunEnvironment;
  score: number;
  metrics: Metrics;
  insights: Insight[];
  fieldData: FieldData | null;
  /** Absent on runs stored before the request table was kept. */
  requests?: NetworkRequest[];
}

/** A distribution of one measured value across the successful runs. */
export interface SeriesStats {
  mean: number;
  median: number;
  mode: number;
  min: number;
  max: number;
  stddev: number;
  count: number;
  values: number[];
  /**
   * Quartiles, linear-interpolated (the PERCENTILE.INC convention).
   *
   * These exist because the mean/median/mode trio describes the *centre* of a
   * distribution and nothing else. A page whose LCP alternates between 2.4s and
   * 3.0s has a perfectly respectable median and a 95th percentile well over
   * budget, and a performance budget is a statement about the tail.
   */
  p25: number;
  p75: number;
  p95: number;
}

/**
 * One cluster of a bimodal distribution.
 *
 * Lighthouse scores off a log-normal curve, so a metric sitting on a scoring
 * boundary produces two stable clusters rather than one smear - and the median
 * then reports "whichever lane happened to get more runs", which is not a
 * property of the page at all.
 */
export interface Lane {
  /** Inclusive lower bound of the cluster. */
  from: number;
  /** Inclusive upper bound of the cluster. */
  to: number;
  count: number;
  /** Share of samples in this lane, 0-1. */
  share: number;
  /** Median of the lane - the honest headline for that lane. */
  value: number;
}

export interface Distribution {
  /** True when the samples split into two well-separated, meaningfully sized lanes. */
  bimodal: boolean;
  lanes: Lane[];
  /**
   * Between-lane separation over pooled within-lane spread. 1 means the split
   * explains nothing; large means the two lanes are genuinely different worlds.
   */
  separation: number;
  /**
   * Human-readable explanation of the split.
   *
   * Gated more tightly than `bimodal`, which is a statistical claim and this is
   * an actionable one: two lanes are reported as `bimodal: true` long before the
   * gap between them is wide enough to change what anyone should do. The note
   * only appears once the lanes are more than 10 apart, so a caller that wants to
   * *say something* about the distribution must test `note`, not `bimodal`.
   */
  note?: string;
}

export type StatTriple = Record<Stat, number>;

export interface AggregatedInsightStats {
  score: StatTriple;
  savingsMs: StatTriple | null;
  savingsBytes: StatTriple | null;
}

export interface AggregatedInsight extends Insight {
  appearedInRuns: number;
  runsSucceeded: number;
  /** Present in fewer than 30% of successful runs. Deprioritize these. */
  flaky: boolean;
  stats: AggregatedInsightStats;
}

export interface Gap {
  metric: string;
  actual: number;
  target: number;
  /** actual - target. Positive for "budget" metrics means over budget. */
  delta: number;
  meets: boolean;
  /**
   * Share of individual runs that were inside budget, 0-1.
   *
   * Only present when the per-run distribution was supplied. A median can sit
   * comfortably inside a budget while a fifth of real measurements blow straight
   * through it, and an SLO is a claim about the tail, not about the middle.
   */
  passRate?: number;
  /** How many runs were measured for this metric. */
  runsMeasured?: number;
  /** How many of those runs were over budget. */
  overBudgetRuns?: number;
  /** 75th/95th percentile, when available. */
  p75?: number;
  p95?: number;
}

export interface TargetComparison {
  strategy: Strategy;
  targets: Record<string, number>;
  meetsTarget: boolean;
  gaps: Gap[];
  /** The gap that is worst relative to its own budget - the one to work on. */
  worstGap?: Gap;
  /** True when the median alone would have passed but too few runs did. */
  medianPass?: boolean;
  /**
   * Metrics the page cannot reach through frontend work, with the reason.
   *
   * Set when the budget sits below what the server response alone already costs
   * (TTFB), or when the remaining work is owned by a third party. Without this
   * the loop burns every remaining iteration chasing a number that no
   * SOP-permitted change can move.
   */
  blockedBy?: string[];
}

export interface RunFailure {
  run: number;
  message: string;
}

export interface AggregatedReport {
  reportId: string;
  url: string;
  finalUrl: string;
  strategy: Strategy;
  /** Stat chosen by the caller; drives every `headline` value. */
  stat: Stat;
  runsRequested: number;
  runsSucceeded: number;
  generatedAt: string;
  lighthouseVersion: string;
  /**
   * How the run was measured, taken from the run closest to the median.
   *
   * One run describes the whole set: PSI runs them on identical infrastructure,
   * so a per-run breakdown would only add noise. Taken from the median run
   * because that is the run whose numbers the headline describes.
   */
  environment: RunEnvironment;
  /** Flattened chosen-stat values, for a caller that only wants one number. */
  headline: {
    score: number;
    metrics: Metrics;
  };
  /** All three stats side by side, plus spread, for the whole run set. */
  score: SeriesStats;
  metrics: Partial<Record<MetricKey, SeriesStats>>;
  /** Whether the headline score splits into two lanes, per metric. */
  distributions: Partial<Record<'score' | MetricKey, Distribution>>;
  /** What the LCP element actually is, and where its time went. */
  lcp: LcpDetail | null;
  /**
   * Every request the median run made, or null when the runs carry none.
   * Absent on reports stored before the request table was kept.
   */
  requests?: NetworkRequest[] | null;
  /**
   * Image problems worked out from the median run's element and request data.
   * Absent on reports stored before image checks existed; `--reanalyze` adds it.
   */
  images?: ImageChecks;
  /** Same aggregate recomputed with each stat, for easy comparison. */
  stats: Record<Stat, { score: number; metrics: Metrics }>;
  insights: AggregatedInsight[];
  fieldData: FieldData | null;
  targets: TargetComparison;
  errors: RunFailure[];
}

export type SortField = 'savingsMs' | 'savingsBytes' | 'score' | 'firstPartyShare';
export type SortOrder = 'asc' | 'desc';

/**
 * The four LCP phases Lighthouse reports, in order.
 *
 * `loadDelay` and `loadTime` are absent when the LCP element is text, because
 * there is no resource to load. That absence is the single most useful thing to
 * know: it means the image playbook does not apply, and the cost is elsewhere.
 */
export interface LcpPhases {
  /** Server round trip. Owned by the backend / CDN, never by a component. */
  ttfb?: number;
  /** Between TTFB and the LCP resource starting to load. */
  loadDelay?: number;
  /** Duration of the LCP resource load itself. */
  loadTime?: number;
  /** Load complete (or text ready) to first paint of the element. */
  renderDelay?: number;
}

export interface LcpDetail {
  /** Lighthouse's own label for the element, e.g. `DIV`. */
  elementType?: string;
  /** The `nodeLabel` text content, when Lighthouse captured one. */
  text?: string;
  selector?: string;
  snippet?: string;
  /** True when the LCP element is text, so no image fix can move it. */
  isText: boolean;
  /** Sum of the reported phases, in ms. */
  totalMs?: number;
  phases: LcpPhases;
  /** The single largest phase, for a one-line diagnosis. */
  dominantPhase?: keyof LcpPhases;
  /**
   * Playbook the LCP cost belongs to, derived from the phase split rather than
   * from the element tag: `server`, `resource` or `render`.
   */
  bottleneck: 'server' | 'resource' | 'render' | 'unknown';
}

/**
 * Which side of the wire an insight's cost sits on.
 *
 * `first` keeps every insight that carries any cost you own, plus ones Lighthouse
 * could not attribute to a URL at all - those are often the app's own code. It
 * only drops an insight whose cost is *entirely* somebody else's. A *mixed*
 * insight (your CDN plus a vendor, in the same finding) is kept, because
 * discarding it would throw away the rows you actually control.
 */
export type PartyFilter = 'any' | 'first' | 'third';

/**
 * Share of an insight's cost that belongs to the measured site, 0-1.
 *
 * `null` means the cost is unattributed - Lighthouse could not tie the rows to
 * any URL, which is normal for main-thread breakdowns and LCP phase tables. Those
 * are frequently the site's own work, so they are deliberately not scored as 0.
 */
export type FirstPartyShare = number | null;

export interface InsightFilters {
  group?: FilterGroup[];
  minSavingsMs?: number;
  minSavingsBytes?: number;
  maxScore?: number;
  metric?: MetricKey[];
  search?: string;
  id?: string[];
  hasItems?: boolean;
  /** Default `any`. */
  party?: PartyFilter;
  /**
   * Keep an insight only when at least this share of its cost is yours, 0-1.
   *
   * This is the honest form of `--party first`: it keeps mixed insights that are
   * majority yours instead of discarding the whole finding because one row
   * belongs to a vendor.
   */
  minFirstPartyRatio?: number;
  sortBy?: SortField;
  order?: SortOrder;
  limit?: number;
  includeFlaky?: boolean;
}

export interface Job {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  request: ReportRequest;
  result?: AggregatedReport;
  error?: { code: string; message: string };
}

export interface ReportRequest {
  url: string;
  strategy: Strategy;
  runs: number;
  stat: Stat;
}
