import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeReport } from '../src/insights.js';
import type { Insight, MetricKey, NormalizedReport, Strategy } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const fixtureRaw = JSON.parse(
  readFileSync(path.join(here, 'fixtures', 'raw-example.com.json'), 'utf8'),
) as Record<string, unknown>;

export const FIXTURE_URL = 'https://example.com/';

export function normalizeFixture(
  mutate?: (raw: Record<string, unknown>) => void,
  strategy: Strategy = 'mobile',
): NormalizedReport {
  const raw = JSON.parse(JSON.stringify(fixtureRaw)) as Record<string, unknown>;
  mutate?.(raw);
  return normalizeReport(raw, FIXTURE_URL, strategy);
}

export interface MakeReportOptions {
  score?: number;
  metrics?: Partial<Record<MetricKey, number>>;
  fetchTime?: string;
  /** Audit ids to drop from the insight list. */
  omit?: string[];
  /** Overrides applied to a single insight, keyed by audit id. */
  patch?: Record<string, Partial<Insight>>;
  extraAudits?: Record<string, unknown>;
  strategy?: Strategy;
}

/** Build a normalized report from the fixture, tuned per test case. */
export function makeReport(options: MakeReportOptions = {}): NormalizedReport {
  const {
    score,
    metrics,
    fetchTime,
    omit = [],
    patch = {},
    extraAudits,
    strategy = 'mobile',
  } = options;

  const report = normalizeFixture((raw) => {
    const result = (raw as { lighthouseResult: Record<string, unknown> }).lighthouseResult;
    if (extraAudits) {
      Object.assign(result.audits as Record<string, unknown>, extraAudits);
    }
  }, strategy);

  if (score !== undefined) report.score = score;
  if (metrics) Object.assign(report.metrics, metrics);
  if (fetchTime) report.fetchTime = fetchTime;

  if (omit.length > 0) {
    report.insights = report.insights.filter((insight) => !omit.includes(insight.id));
  }
  if (Object.keys(patch).length > 0) {
    report.insights = report.insights.map((insight) => {
      const override = patch[insight.id];
      return override ? { ...insight, ...override } : insight;
    });
  }
  return report;
}

export interface FakeResponseInit {
  status?: number;
  headers?: Record<string, string>;
}

/** Minimal stand-in for the parts of `Response` the client uses. */
export function fakeResponse(body: unknown, init: FakeResponseInit = {}): Response {
  const { status = 200, headers = {} } = init;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

export const PSI_ERROR_BODY = {
  error: {
    code: 429,
    message: "Quota exceeded for quota metric 'Queries'",
    status: 'RESOURCE_EXHAUSTED',
  },
};
