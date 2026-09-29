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
  savingsMs?: number;
  savingsBytes?: number;
  metricsAffected?: string[];
  items?: unknown[];
  /** Raw `details.items` length before trimming to the top 25. */
  itemsTotal?: number;
}

/** CrUX field data, passed through untouched when the origin has real users. */
export interface FieldData {
  loadingExperience?: unknown;
  originLoadingExperience?: unknown;
}

export interface NormalizedReport {
  url: string;
  finalUrl: string;
  strategy: Strategy;
  fetchTime: string;
  lighthouseVersion: string;
  score: number;
  metrics: Metrics;
  insights: Insight[];
  fieldData: FieldData | null;
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
}

export type StatTriple = Record<Stat, number>;

export interface AggregatedInsightStats {
  score: StatTriple;
  savingsMs: StatTriple;
  savingsBytes: StatTriple;
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
}

export interface TargetComparison {
  strategy: Strategy;
  targets: Record<string, number>;
  meetsTarget: boolean;
  gaps: Gap[];
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
  /** Flattened chosen-stat values, for a caller that only wants one number. */
  headline: {
    score: number;
    metrics: Metrics;
  };
  /** All three stats side by side, plus spread, for the whole run set. */
  score: SeriesStats;
  metrics: Partial<Record<MetricKey, SeriesStats>>;
  /** Same aggregate recomputed with each stat, for easy comparison. */
  stats: Record<Stat, { score: number; metrics: Metrics }>;
  insights: AggregatedInsight[];
  fieldData: FieldData | null;
  targets: TargetComparison;
  errors: RunFailure[];
}

export type SortField = 'savingsMs' | 'savingsBytes' | 'score';
export type SortOrder = 'asc' | 'desc';

export interface InsightFilters {
  group?: FilterGroup[];
  minSavingsMs?: number;
  minSavingsBytes?: number;
  maxScore?: number;
  metric?: MetricKey[];
  search?: string;
  id?: string[];
  hasItems?: boolean;
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
