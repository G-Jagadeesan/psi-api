import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { aggregateReports } from '../src/aggregate.js';
import { applyTargets } from '../src/targets.js';
import { saveReport } from '../src/storage.js';
import { buildServer } from '../src/server.js';
import { makeReport } from './helpers.js';

const REPORT_ID = '2026-09-29T10-30-00Z-mobile';

let dir: string;
let app: FastifyInstance;
let previousDataDir: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'psi-api-server-'));
  previousDataDir = process.env.PSI_DATA_DIR;
  process.env.PSI_DATA_DIR = dir;

  const runs = [
    makeReport({ score: 50, fetchTime: 'a' }),
    makeReport({ score: 60, fetchTime: 'b' }),
    makeReport({ score: 55, fetchTime: 'c' }),
  ];
  const report = applyTargets(aggregateReports(runs, { reportId: REPORT_ID, runsRequested: 3 }));
  await saveReport(report, runs, dir);

  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PSI_DATA_DIR;
  else process.env.PSI_DATA_DIR = previousDataDir;
});

describe('GET /health', () => {
  it('reports status and key configuration', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('apiKeyConfigured');
    expect(body).toHaveProperty('uptimeSeconds');
  });
});

describe('GET /report/:reportId', () => {
  it('returns a stored report', async () => {
    const response = await app.inject({ method: 'GET', url: `/report/${REPORT_ID}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.reportId).toBe(REPORT_ID);
    expect(body.headline.score).toBe(55);
    expect(body.stats.median.score).toBe(55);
    expect(body.targets).toBeDefined();
  });

  it('404s for an unknown report', async () => {
    const response = await app.inject({ method: 'GET', url: '/report/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});

describe('GET /report/:reportId/insights', () => {
  const url = (query: string) => `/report/${REPORT_ID}/insights${query}`;

  it('returns all insights plus headline metrics by default', async () => {
    const body = (await app.inject({ method: 'GET', url: url('') })).json();
    expect(body.reportId).toBe(REPORT_ID);
    expect(body.matched).toBe(body.totalInsights);
    expect(body.headline.metrics.lcp).toBe(3210);
    expect(body.targets.meetsTarget).toBe(false);
  });

  it('filters by group', async () => {
    const body = (await app.inject({ method: 'GET', url: url('?group=opportunity') })).json();
    const groups = new Set(body.insights.map((i: { group: string }) => i.group));
    expect([...groups]).toEqual(['opportunity']);
  });

  it('accepts a comma separated group list', async () => {
    const body = (await app.inject({ method: 'GET', url: url('?group=opportunity,passed') })).json();
    const groups = new Set(body.insights.map((i: { group: string }) => i.group));
    expect([...groups].sort()).toEqual(['opportunity', 'passed']);
  });

  it('filters by minSavingsMs and maxScore together', async () => {
    const body = (await app.inject({ method: 'GET', url: url('?minSavingsMs=500&maxScore=0.9') })).json();
    expect(body.insights.map((i: { id: string }) => i.id)).toEqual([
      'image-delivery-insight', // 2130ms derived from its items
      'uses-responsive-images',
      'render-blocking-resources',
    ]);
  });

  it('filters by metric, including the metric audit itself', async () => {
    const body = (await app.inject({ method: 'GET', url: url('?metric=tbt') })).json();
    expect(body.insights.map((i: { id: string }) => i.id).sort()).toEqual([
      'third-party-summary',
      'total-blocking-time',
    ]);
  });

  it('searches, sorts, limits and hides flaky insights', async () => {
    const searched = (await app.inject({ method: 'GET', url: url('?search=image') })).json();
    expect(searched.insights.map((i: { id: string }) => i.id)).toEqual([
      'image-delivery-insight', // larger saving first
      'uses-responsive-images',
    ]);

    const limited = (await app.inject({ method: 'GET', url: url('?limit=2') })).json();
    expect(limited.insights).toHaveLength(2);
    expect(limited.matched).toBe(2);

    const noFlaky = (await app.inject({ method: 'GET', url: url('?includeFlaky=false') })).json();
    expect(noFlaky.insights.every((i: { flaky: boolean }) => !i.flaky)).toBe(true);
  });

  it('sorts by savingsMs descending by default', async () => {
    const body = (await app.inject({ method: 'GET', url: url('') })).json();
    const savings = body.insights.map((i: { savingsMs?: number }) => i.savingsMs ?? -1);
    expect(savings).toEqual([...savings].sort((a: number, b: number) => b - a));
  });

  it('rejects an unknown filter value with a helpful error', async () => {
    const response = await app.inject({ method: 'GET', url: url('?group=bogus') });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_PARAMS');
    expect(response.json().error.message).toMatch(/opportunity/);
  });

  it('rejects a non-numeric minSavingsMs', async () => {
    const response = await app.inject({ method: 'GET', url: url('?minSavingsMs=abc') });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_PARAMS');
  });

  it('404s when the report does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/report/nope/insights' });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /insights', () => {
  it('rejects a body with no url', async () => {
    const response = await app.inject({ method: 'POST', url: '/insights', payload: { runs: 3 } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_PARAMS');
  });

  it('rejects an unreachable url before spending quota', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/insights',
      payload: { url: 'file:///app/index.html', runs: 1, filters: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_URL');
    expect(response.json().error.message).toMatch(/file: URLs are not supported/);
  });

  it('rejects runs above the maximum', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/insights',
      payload: { url: 'https://example.com', runs: 99, filters: {} },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /report validation', () => {
  it('rejects a missing url', async () => {
    const response = await app.inject({ method: 'GET', url: '/report' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_PARAMS');
  });

  it('rejects an out of range runs value', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/report?url=https%3A%2F%2Fexample.com&runs=99',
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an unknown strategy', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/report?url=https%3A%2F%2Fexample.com&strategy=tablet',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /jobs/:jobId', () => {
  it('404s for an unknown job', async () => {
    const response = await app.inject({ method: 'GET', url: '/jobs/job_missing' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});

describe('beforeEach', () => {
  it('keeps the data dir isolated', () => {
    expect(process.env.PSI_DATA_DIR).toBe(dir);
  });
});
