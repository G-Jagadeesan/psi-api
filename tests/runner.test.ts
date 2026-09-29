import { describe, expect, it } from 'vitest';
import { InsufficientRunsError, runReport } from '../src/runner.js';
import { PSI_ERROR_BODY, fakeResponse, fixtureRaw } from './helpers.js';

/** A fetch stand-in that succeeds `ok` times, then always fails. */
function flakyFetch(ok: number, total: number, scoreOf: (i: number) => number) {
  const calls: number[] = [];
  const impl = (async () => {
    const index = calls.length;
    calls.push(index);
    if (index < ok) {
      const raw = JSON.parse(JSON.stringify(fixtureRaw)) as {
        lighthouseResult: { categories: { performance: { score: number } } };
      };
      raw.lighthouseResult.categories.performance.score = scoreOf(index) / 100;
      return fakeResponse(raw);
    }
    return fakeResponse(PSI_ERROR_BODY, { status: 429 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noSleep = async () => {};

const targets = {
  mobile: { score: 90, lcp: 2500, tbt: 200, cls: 0.1, fcp: 1800, speedIndex: 3400 },
  desktop: { score: 90, lcp: 1800, tbt: 150, cls: 0.1, fcp: 1200, speedIndex: 2400 },
};

describe('runReport', () => {
  it('aggregates every successful run and reports both counts', async () => {
    const { impl } = flakyFetch(4, 4, (i) => 50 + i * 10);
    const result = await runReport({
      url: 'https://example.com/',
      runs: 4,
      save: false,
      fetchImpl: impl,
      sleepImpl: noSleep,
      targets,
    });

    expect(result.report.runsRequested).toBe(4);
    expect(result.report.runsSucceeded).toBe(4);
    expect(result.report.headline.score).toBe(65);
    expect(result.runs).toHaveLength(4);
  });

  it('continues past failures while at least 60% succeed', async () => {
    // 4 succeed out of 5 -> 80% >= 60%.
    const { impl } = flakyFetch(4, 5, () => 72);
    const result = await runReport({
      url: 'https://example.com/',
      runs: 5,
      save: false,
      fetchImpl: impl,
      sleepImpl: noSleep,
      targets,
    });

    expect(result.report.runsSucceeded).toBe(4);
    expect(result.report.runsRequested).toBe(5);
    expect(result.report.errors).toHaveLength(1);
    expect(result.report.errors[0]).toMatchObject({ run: 5 });
  });

  it('throws when fewer than 60% of runs succeed', async () => {
    // 2 of 5 -> 40% < 60%.
    const { impl } = flakyFetch(2, 5, () => 70);
    await expect(
      runReport({ url: 'https://example.com/', runs: 5, save: false, fetchImpl: impl, sleepImpl: noSleep, targets }),
    ).rejects.toBeInstanceOf(InsufficientRunsError);
  });

  it('throws when every run fails', async () => {
    const { impl } = flakyFetch(0, 3, () => 0);
    await expect(
      runReport({ url: 'https://example.com/', runs: 3, save: false, fetchImpl: impl, sleepImpl: noSleep, targets }),
    ).rejects.toBeInstanceOf(InsufficientRunsError);
  });

  it('clamps the run count to the allowed maximum', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return fakeResponse(fixtureRaw);
    }) as unknown as typeof fetch;

    await runReport({ url: 'https://example.com/', runs: 999, save: false, fetchImpl: impl, sleepImpl: noSleep, targets });
    expect(calls).toBe(25);
  });

  it('rejects an unreachable url before spending any quota', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return fakeResponse(fixtureRaw);
    }) as unknown as typeof fetch;

    await expect(
      runReport({ url: 'file:///app/index.html', save: false, fetchImpl: impl, sleepImpl: noSleep, targets }),
    ).rejects.toThrow(/file: URLs are not supported/);
    expect(calls).toBe(0);
  });

  it('returns a warning for a private host but still attempts the run', async () => {
    const { impl } = flakyFetch(1, 1, () => 10);
    const result = await runReport({
      url: 'http://localhost:5173/',
      runs: 1,
      save: false,
      fetchImpl: impl,
      sleepImpl: noSleep,
      targets,
    });
    expect(result.warnings[0]).toMatch(/cannot reach/);
  });

  it('honours the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const impl = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return fakeResponse(fixtureRaw);
    }) as unknown as typeof fetch;

    await runReport({
      url: 'https://example.com/',
      runs: 8,
      concurrency: 3,
      save: false,
      fetchImpl: impl,
      sleepImpl: noSleep,
      targets,
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('scores the report against the strategy targets', async () => {
    const { impl } = flakyFetch(3, 3, () => 92);
    const result = await runReport({
      url: 'https://example.com/',
      runs: 3,
      save: false,
      fetchImpl: impl,
      sleepImpl: noSleep,
      targets,
    });
    expect(result.report.targets.meetsTarget).toBe(false); // lcp 3210 is over budget
    expect(result.report.targets.gaps.find((gap) => gap.metric === 'score')?.meets).toBe(true);
  });

  it('generates a sortable report id', async () => {
    const { impl } = flakyFetch(1, 1, () => 50);
    const result = await runReport({ url: 'https://example.com/', runs: 1, save: false, fetchImpl: impl, sleepImpl: noSleep, targets });
    expect(result.report.reportId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-mobile$/);
  });
});
