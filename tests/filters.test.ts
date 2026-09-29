import { describe, expect, it } from 'vitest';
import { filterInsights } from '../src/insights.js';
import type { AggregatedInsight, Insight } from '../src/types.js';

function insight(id: string, extra: Partial<Insight> = {}): AggregatedInsight {
  return {
    id,
    title: `Title for ${id}`,
    description: '',
    score: 0.5,
    scoreDisplayMode: 'numeric',
    group: 'diagnostic',
    appearedInRuns: 10,
    runsSucceeded: 10,
    flaky: false,
    stats: { score: { mean: 0.5, median: 0.5, mode: 0.5 }, savingsMs: { mean: 0, median: 0, mode: 0 }, savingsBytes: { mean: 0, median: 0, mode: 0 } },
    ...extra,
  };
}

const sample: AggregatedInsight[] = [
  insight('render-blocking-resources', {
    group: 'opportunity',
    savingsMs: 640,
    savingsBytes: 153_600,
    metricsAffected: ['fcp', 'lcp'],
    items: [{ url: 'a' }],
  }),
  insight('uses-responsive-images', {
    group: 'opportunity',
    savingsMs: 1200,
    savingsBytes: 900_000,
    metricsAffected: ['lcp'],
  }),
  insight('third-party-summary', { group: 'diagnostic', savingsMs: 250, metricsAffected: ['lcp', 'tbt'] }),
  insight('image-delivery-insight', { group: 'diagnostic', savingsMs: 180, items: [{ url: 'b' }, { url: 'c' }] }),
  insight('unused-javascript', { group: 'opportunity', savingsMs: 380, score: 1 }),
  insight('uses-text-compression', { group: 'passed', score: 1 }),
  insight('network-requests', { group: 'informative', score: null }),
  insight('uses-http2', { group: 'notApplicable', score: null }),
  insight('flaky-thing', { group: 'diagnostic', savingsMs: 50, flaky: true, appearedInRuns: 1 }),
];

const ids = (result: AggregatedInsight[]) => result.map((i) => i.id);

describe('filterInsights', () => {
  it('returns everything with no filters', () => {
    expect(filterInsights(sample)).toHaveLength(sample.length);
  });

  describe('group', () => {
    it('filters to a single group', () => {
      expect(ids(filterInsights(sample, { group: ['opportunity'] }))).toEqual([
        'uses-responsive-images',
        'render-blocking-resources',
        'unused-javascript',
      ]);
    });

    it('accepts several groups at once', () => {
      const result = ids(filterInsights(sample, { group: ['opportunity', 'passed'] }));
      expect(result).toContain('render-blocking-resources');
      expect(result).toContain('uses-text-compression');
      expect(result).not.toContain('network-requests');
    });

    it('excludes notApplicable unless asked for a group that includes it', () => {
      const result = ids(filterInsights(sample, { group: ['opportunity', 'diagnostic'] }));
      expect(result).not.toContain('uses-http2');
    });
  });

  describe('savings thresholds', () => {
    it('filters by minSavingsMs', () => {
      expect(ids(filterInsights(sample, { minSavingsMs: 400 }))).toEqual([
        'uses-responsive-images',
        'render-blocking-resources',
      ]);
    });

    it('filters by minSavingsBytes', () => {
      const result = ids(filterInsights(sample, { minSavingsBytes: 200_000 }));
      expect(result).toEqual(['uses-responsive-images']); // render-blocking saves 153,600
    });

    it('drops insights with no savings at all', () => {
      const result = ids(filterInsights(sample, { minSavingsMs: 1 }));
      expect(result).not.toContain('uses-text-compression');
    });
  });

  it('filters by maxScore, keeping only failing or weak audits', () => {
    const result = ids(filterInsights(sample, { maxScore: 0.9 }));
    expect(result).toEqual([
      'uses-responsive-images',
      'render-blocking-resources',
      'third-party-summary',
      'image-delivery-insight',
      'flaky-thing',
    ]);
    expect(result).not.toContain('unused-javascript'); // score 1
    expect(result).not.toContain('network-requests'); // null score
  });

  it('filters by metric', () => {
    const result = ids(filterInsights(sample, { metric: ['lcp'] }));
    expect(result).toEqual(
      expect.arrayContaining(['render-blocking-resources', 'uses-responsive-images', 'third-party-summary']),
    );
    expect(result).not.toContain('image-delivery-insight'); // affects nothing
  });

  it('matches an insight that is the metric audit itself', () => {
    const list = [insight('largest-contentful-paint', { metricsAffected: [] })];
    expect(ids(filterInsights(list, { metric: ['lcp'] }))).toEqual(['largest-contentful-paint']);
  });

  it('accepts several metrics', () => {
    const result = ids(filterInsights(sample, { metric: ['fcp', 'tbt'] }));
    expect(result).toEqual(expect.arrayContaining(['render-blocking-resources', 'third-party-summary']));
  });

  it('searches id and title case-insensitively', () => {
    expect(ids(filterInsights(sample, { search: 'RESPONSIVE' }))).toEqual(['uses-responsive-images']);
    expect(ids(filterInsights(sample, { search: 'render-blocking' }))).toEqual([
      'render-blocking-resources',
    ]);
    expect(filterInsights(sample, { search: 'nothing here' })).toEqual([]);
  });

  it('filters by an explicit id list', () => {
    expect(ids(filterInsights(sample, { id: ['uses-http2', 'network-requests'] }))).toEqual([
      'network-requests',
      'uses-http2',
    ]);
  });

  it('filters by hasItems', () => {
    expect(ids(filterInsights(sample, { hasItems: true }))).toEqual([
      'render-blocking-resources',
      'image-delivery-insight',
    ]);
    expect(filterInsights(sample, { hasItems: false }).length).toBe(sample.length - 2);
  });

  describe('sorting', () => {
    it('defaults to savingsMs descending', () => {
      const result = filterInsights(sample);
      expect(result[0]?.id).toBe('uses-responsive-images');
      expect(result[1]?.id).toBe('render-blocking-resources');
    });

    it('sorts ascending on request, with insights that report no savings last', () => {
      const result = filterInsights(sample, { sortBy: 'savingsMs', order: 'asc' });
      expect(result[0]?.id).toBe('flaky-thing'); // 50ms, the smallest saving
      // Anything without a savings figure is pushed past every real number.
      const undefinedAt = result.findIndex((i) => i.savingsMs === undefined);
      expect(undefinedAt).toBeGreaterThan(0);
      expect(result.slice(undefinedAt).every((i) => i.savingsMs === undefined)).toBe(true);
    });

    it('sorts by savingsBytes', () => {
      expect(filterInsights(sample, { sortBy: 'savingsBytes' })[0]?.id).toBe('uses-responsive-images');
    });

    it('sorts by score and puts missing scores last', () => {
      const result = filterInsights(sample, { sortBy: 'score' });
      expect(result[0]?.id).toBe('unused-javascript');
      expect(result.at(-1)?.score).toBeNull();
    });

    it('breaks ties deterministically by id', () => {
      const tied = [
        insight('b-audit', { savingsMs: 100 }),
        insight('a-audit', { savingsMs: 100 }),
        insight('c-audit', { savingsMs: 100 }),
      ];
      expect(ids(filterInsights(tied, { sortBy: 'savingsMs' }))).toEqual([
        'a-audit',
        'b-audit',
        'c-audit',
      ]);
    });
  });

  it('applies limit last', () => {
    expect(filterInsights(sample, { sortBy: 'savingsMs', limit: 2 })).toHaveLength(2);
    expect(filterInsights(sample, { limit: 0 })).toEqual([]);
  });

  describe('includeFlaky', () => {
    it('includes flaky insights by default', () => {
      expect(ids(filterInsights(sample))).toContain('flaky-thing');
    });

    it('hides them when includeFlaky is false', () => {
      expect(ids(filterInsights(sample, { includeFlaky: false }))).not.toContain('flaky-thing');
    });
  });

  it('combines filters', () => {
    const result = ids(
      filterInsights(sample, {
        group: ['opportunity', 'diagnostic'],
        maxScore: 0.9,
        minSavingsMs: 200,
        metric: ['lcp'],
        sortBy: 'savingsMs',
        order: 'desc',
        limit: 2,
      }),
    );
    expect(result).toEqual(['uses-responsive-images', 'render-blocking-resources']);
  });
});
