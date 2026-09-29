import { config as loadEnv } from 'dotenv';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { AggregatedReport, FilterGroup, Job, MetricKey, SortField, SortOrder } from './types.js';
import { METRIC_KEYS, STATS, STRATEGIES } from './types.js';
import { filterInsights } from './insights.js';
import { InsufficientRunsError, MAX_RUNS, runReport } from './runner.js';
import { UrlValidationError } from './psiClient.js';
import { loadReport } from './storage.js';

loadEnv();

const FILTER_GROUPS = ['opportunity', 'diagnostic', 'passed', 'informative'] as const;
const SORT_FIELDS = ['savingsMs', 'savingsBytes', 'score'] as const;
const ORDERS = ['asc', 'desc'] as const;

const CACHE_TTL_MS = 10 * 60 * 1000;

/* ---------------------------------- schemas --------------------------------- */

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()),
  );

const numericParam = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected a number, got "${value}"` });
      return z.NEVER;
    }
    return parsed;
  });

/** Splits "a,b" and tolerates repeated params (`?group=a&group=b`). */
const csv = (allowed?: readonly string[]) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (Array.isArray(value) ? value.join(',') : value)
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    )
    .refine(
      (parts) => !allowed || parts.every((part) => allowed.includes(part)),
      `allowed values: ${allowed?.join(', ')}`,
    );

const reportParams = z.object({
  url: z.string().min(1),
  strategy: z.enum(STRATEGIES).default('mobile'),
  runs: z.coerce.number().int().min(1).max(MAX_RUNS).default(10),
  stat: z.enum(STATS).default('median'),
  force: boolish.default(false),
  async: boolish.default(false),
});

const filterParams = z.object({
  group: csv(FILTER_GROUPS).optional(),
  minSavingsMs: numericParam.optional(),
  minSavingsBytes: numericParam.optional(),
  maxScore: numericParam.optional(),
  metric: csv(METRIC_KEYS).optional(),
  search: z.string().optional(),
  id: csv().optional(),
  hasItems: boolish.optional(),
  sortBy: z.enum(SORT_FIELDS).default('savingsMs'),
  order: z.enum(ORDERS).default('desc'),
  limit: numericParam.pipe(z.number().int().min(0)).optional(),
  includeFlaky: boolish.default(true),
});

export type ReportParams = z.infer<typeof reportParams>;
export type FilterParams = z.infer<typeof filterParams>;

/* ----------------------------------- state ---------------------------------- */

interface CacheEntry {
  report: AggregatedReport;
  expiresAt: number;
}

const reportCache = new Map<string, CacheEntry>();
const jobs = new Map<string, Job>();
const jobsByRequest = new Map<string, Job>();
let jobCounter = 0;

function cacheKey(params: ReportParams): string {
  return [params.url, params.strategy, params.runs, params.stat].join('|');
}

function readCache(key: string): AggregatedReport | undefined {
  const hit = reportCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    reportCache.delete(key);
    return undefined;
  }
  return hit.report;
}

function writeCache(key: string, report: AggregatedReport): void {
  reportCache.set(key, { report, expiresAt: Date.now() + CACHE_TTL_MS });
}

/* ---------------------------------- helpers --------------------------------- */

function toErrorPayload(error: unknown): { code: string; message: string } {
  if (error instanceof UrlValidationError) return { code: error.code, message: error.message };
  if (error instanceof InsufficientRunsError)
    return { code: 'INSUFFICIENT_RUNS', message: error.message };
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    const field = first?.path.join('.');
    return {
      code: 'INVALID_PARAMS',
      message: field ? `${field}: ${first?.message}` : (first?.message ?? 'invalid parameters'),
    };
  }
  if (error instanceof Error) return { code: error.name || 'ERROR', message: error.message };
  return { code: 'ERROR', message: String(error) };
}

function statusForError(error: unknown): number {
  if (error instanceof UrlValidationError || error instanceof z.ZodError) return 400;
  if (error instanceof InsufficientRunsError) return 502;
  return 500;
}

function compact(query: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries((query ?? {}) as Record<string, unknown>)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function produceReport(
  params: ReportParams,
  log: FastifyBaseLogger,
): Promise<AggregatedReport> {
  const result = await runReport({
    url: params.url,
    strategy: params.strategy,
    runs: params.runs,
    stat: params.stat,
    onRetry: ({ reason, attempt, maxAttempts, delayMs }) => {
      log.warn({ reason, attempt, maxAttempts, delayMs }, 'psi retry');
    },
    onRunFinished: ({ run, ok, score, error }) => {
      if (ok) log.info({ run, score }, 'psi run complete');
      else log.warn({ run, error }, 'psi run failed');
    },
  });
  for (const warning of result.warnings) log.warn(warning);
  return result.report;
}

function startJob(params: ReportParams, log: FastifyBaseLogger): Job {
  jobCounter += 1;
  const id = `job_${Date.now().toString(36)}_${jobCounter}`;
  const job: Job = {
    id,
    status: 'queued',
    createdAt: new Date().toISOString(),
    request: { url: params.url, strategy: params.strategy, runs: params.runs, stat: params.stat },
  };
  jobs.set(id, job);
  jobsByRequest.set(cacheKey(params), job);

  const key = cacheKey(params);
  void (async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const report = await produceReport(params, log);
      job.status = 'done';
      job.result = report;
      writeCache(key, report);
    } catch (error) {
      job.status = 'failed';
      job.error = toErrorPayload(error);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}

function insightsPayload(report: AggregatedReport, filters: FilterParams) {
  const typed = {
    group: filters.group as FilterGroup[] | undefined,
    minSavingsMs: filters.minSavingsMs,
    minSavingsBytes: filters.minSavingsBytes,
    maxScore: filters.maxScore,
    metric: filters.metric as MetricKey[] | undefined,
    search: filters.search,
    id: filters.id as string[] | undefined,
    hasItems: filters.hasItems,
    sortBy: filters.sortBy as SortField,
    order: filters.order as SortOrder,
    limit: filters.limit,
    includeFlaky: filters.includeFlaky,
  };
  const insights = filterInsights(report.insights, typed);
  return {
    reportId: report.reportId,
    url: report.url,
    strategy: report.strategy,
    stat: report.stat,
    runsRequested: report.runsRequested,
    runsSucceeded: report.runsSucceeded,
    headline: report.headline,
    targets: report.targets,
    score: report.score,
    totalInsights: report.insights.length,
    matched: insights.length,
    filters: typed,
    insights,
  };
}

/* ---------------------------------- server ---------------------------------- */

const insightsBody = z.object({
  url: z.string().min(1),
  strategy: z.enum(STRATEGIES).default('mobile'),
  runs: z.coerce.number().int().min(1).max(MAX_RUNS).default(10),
  stat: z.enum(STATS).default('median'),
  force: boolish.default(false),
  filters: filterParams.partial({ sortBy: true, order: true, includeFlaky: true }).optional(),
});

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  app.setErrorHandler((error, _req, reply) => {
    const status = statusForError(error);
    if (status >= 500) app.log.error({ err: error }, 'request failed');
    return reply.status(status).send({ error: toErrorPayload(error) });
  });

  app.get('/health', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    apiKeyConfigured: Boolean(process.env.PSI_API_KEY),
    cacheEntries: reportCache.size,
    activeJobs: [...jobs.values()].filter((job) => job.status === 'running').length,
  }));

  const reportHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.method === 'GET' ? compact(req.query) : { ...((req.body ?? {}) as object) };
    const params = reportParams.parse(raw);
    const key = cacheKey(params);

    if (!params.async) {
      const cached = params.force ? undefined : readCache(key);
      if (cached) return reply.send({ ...cached, cached: true });
    } else {
      const existing = jobsByRequest.get(key);
      if (existing && (existing.status === 'queued' || existing.status === 'running')) {
        return reply.status(202).send({ jobId: existing.id, status: existing.status });
      }
    }

    if (params.async) {
      const job = startJob(params, req.log);
      return reply.status(202).send({ jobId: job.id, status: job.status });
    }

    const report = await produceReport(params, req.log);
    writeCache(key, report);
    return reply.send(report);
  };

  app.get('/report', reportHandler);
  app.post('/report', reportHandler);

  const findReport = async (reportId: string): Promise<AggregatedReport | null> =>
    loadReport(reportId);

  app.get<{ Params: { reportId: string } }>('/report/:reportId', async (req, reply) => {
    const report = await findReport(req.params.reportId);
    if (!report) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: `no stored report "${req.params.reportId}"` } });
    }
    return reply.send(report);
  });

  app.get<{ Params: { reportId: string }; Querystring: Record<string, unknown> }>(
    '/report/:reportId/insights',
    async (req, reply) => {
      const report = await findReport(req.params.reportId);
      if (!report) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: `no stored report "${req.params.reportId}"` } });
      }
      return reply.send(insightsPayload(report, filterParams.parse(compact(req.query))));
    },
  );

  app.post('/insights', async (req, reply) => {
    const body = insightsBody.parse((req.body ?? {}) as object);
    const params: ReportParams = {
      url: body.url,
      strategy: body.strategy,
      runs: body.runs,
      stat: body.stat,
      force: body.force,
      async: false,
    };
    const key = cacheKey(params);

    let report = body.force ? undefined : readCache(key);
    if (!report) {
      report = await produceReport(params, req.log);
      writeCache(key, report);
    }
    return reply.send(insightsPayload(report, filterParams.parse(body.filters ?? {})));
  });

  app.get<{ Params: { jobId: string } }>('/jobs/:jobId', async (req, reply) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: `no job "${req.params.jobId}"` } });
    }
    return reply.send(job);
  });

  return app;
}

/* ----------------------------------- main ----------------------------------- */

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const port = Number(process.env.PORT ?? 3939);
  const host = process.env.HOST ?? '127.0.0.1';
  const app = buildServer();

  if (!process.env.PSI_API_KEY) {
    app.log.warn(
      'PSI_API_KEY is not set. PSI will fall back to the shared anonymous quota, which is very low ' +
        'and typically returns HTTP 429. Copy .env.example to .env and add your key.',
    );
  }

  app
    .listen({ port, host })
    .then(() => app.log.info({ host, port }, 'psi-api listening'))
    .catch((error) => {
      app.log.error(error);
      process.exit(1);
    });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}
