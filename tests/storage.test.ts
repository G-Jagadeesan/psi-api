import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aggregateReports } from '../src/aggregate.js';
import { makeReport } from './helpers.js';
import {
  dataDirForHost,
  loadReport,
  loadRuns,
  makeReportId,
  reportDir,
  saveReport,
} from '../src/storage.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'psi-api-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function buildReport() {
  const runs = [makeReport({ score: 50, fetchTime: 'a' }), makeReport({ score: 60, fetchTime: 'b' })];
  return aggregateReports(runs, { reportId: '2026-09-29T10-30-00Z-mobile', runsRequested: 2 });
}

describe('storage', () => {
  it('buckets by host', () => {
    expect(dataDirForHost('https://example.com/x', dir)).toBe(path.join(dir, 'example.com'));
  });

  it('builds a filesystem safe report id', () => {
    const id = makeReportId('https://example.com/', 'desktop', new Date('2026-09-29T10:30:00Z'));
    expect(id).toBe('2026-09-29T10-30-00Z-desktop');
  });

  it('sanitises a hostile hostname', () => {
    // The path is irrelevant; only the hostname becomes a directory name.
    expect(dataDirForHost('https://ex/ample.com/../evil', dir)).toBe(path.join(dir, 'ex'));
  });

  it('round-trips a report', async () => {
    const report = buildReport();
    const saved = await saveReport(report, [makeReport(), makeReport()], dir);
    expect(saved.reportId).toBe(report.reportId);

    const loaded = await loadReport(report.reportId, dir);
    expect(loaded?.reportId).toBe(report.reportId);
    expect(loaded?.headline.score).toBe(report.headline.score);
    expect(loaded?.insights.length).toBe(report.insights.length);
  });

  it('round-trips the raw normalized runs', async () => {
    const runs = [makeReport({ score: 10 }), makeReport({ score: 90 })];
    const report = aggregateReports(runs, { reportId: '2026-09-29T10-30-00Z-mobile' });
    await saveReport(report, runs, dir);

    const loaded = await loadRuns('2026-09-29T10-30-00Z-mobile', dir);
    expect(loaded?.map((r) => r.score)).toEqual([10, 90]);
  });

  it('writes into data/<host>/<reportId>/', async () => {
    const report = buildReport();
    await saveReport(report, [], dir);
    const file = path.join(dir, 'example.com', report.reportId, 'report.json');
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(parsed.reportId).toBe(report.reportId);
  });

  it('returns null for an unknown report', async () => {
    expect(await loadReport('nope', dir)).toBeNull();
    expect(await loadReport('nope', path.join(dir, 'missing-root'))).toBeNull();
  });

  it('refuses to escape the data directory', () => {
    expect(() => reportDir('../escape', 'https://example.com', dir)).toThrow(/invalid reportId/);
    expect(() => reportDir('a/b', 'https://example.com', dir)).toThrow(/invalid reportId/);
    expect(() => reportDir('..\\escape', 'https://example.com', dir)).toThrow(/invalid reportId/);
    expect(() => reportDir('.hidden', 'https://example.com', dir)).toThrow(/invalid reportId/);
  });
});
