import { describe, expect, it } from 'vitest';
import { MAX_ITEMS, groupForAudit, normalizeReport } from '../src/insights.js';
import { FIXTURE_URL, makeReport, normalizeFixture } from './helpers.js';

describe('normalizeReport', () => {
  it('maps the performance score, url and lighthouse version', () => {
    const report = normalizeFixture();
    expect(report.score).toBe(58);
    expect(report.url).toBe(FIXTURE_URL);
    expect(report.finalUrl).toBe('https://example.com/');
    expect(report.lighthouseVersion).toBe('12.2.1');
    expect(report.strategy).toBe('mobile');
    expect(report.fetchTime).toBe('2026-09-29T10:30:00.000Z');
  });

  it('extracts the core metrics plus ttfb and tti', () => {
    const { metrics } = normalizeFixture();
    expect(metrics).toEqual({
      fcp: 1234,
      lcp: 3210,
      tbt: 90,
      cls: 0.02,
      speedIndex: 3810,
      tti: 4200,
      ttfb: 180,
    });
  });

  it('passes CrUX field data through', () => {
    const report = normalizeFixture();
    expect(report.fieldData).not.toBeNull();
    expect(report.fieldData?.loadingExperience).toBeDefined();
    expect(report.fieldData?.originLoadingExperience).toBeDefined();
  });

  it('returns null field data when PSI reported none', () => {
    const report = normalizeFixture((raw) => {
      delete (raw as Record<string, unknown>).loadingExperience;
      delete (raw as Record<string, unknown>).originLoadingExperience;
    });
    expect(report.fieldData).toBeNull();
  });

  it('pulls savings and affected metrics off an opportunity audit', () => {
    const report = normalizeFixture();
    const audit = report.insights.find((i) => i.id === 'render-blocking-resources');
    expect(audit).toBeDefined();
    expect(audit?.savingsMs).toBe(640);
    expect(audit?.savingsBytes).toBe(153_600);
    expect(audit?.metricsAffected).toEqual(['fcp', 'lcp']);
    expect(audit?.numericValue).toBe(640);
    expect(audit?.numericUnit).toBe('millisecond');
    expect(audit?.displayValue).toBe('Potential savings of 640 ms');
  });

  it('derives affected metrics from relevantAudits when there is no metricSavings', () => {
    const report = normalizeFixture();
    const audit = report.insights.find((i) => i.id === 'third-party-summary');
    expect(audit?.metricsAffected).toEqual(['lcp', 'tbt']);
  });

  it('trims details.items to the top 25 and records the original count', () => {
    const report = normalizeFixture();
    const audit = report.insights.find((i) => i.id === 'image-delivery-insight');
    expect(audit?.items).toHaveLength(MAX_ITEMS);
    expect(audit?.itemsTotal).toBe(30);
  });

  it('always reports itemsTotal, even when nothing was trimmed', () => {
    const report = normalizeFixture();
    const audit = report.insights.find((i) => i.id === 'font-display-insight');
    expect(audit?.items).toHaveLength(2);
    // Was only set past the 25-row cut, which made the row count unanswerable
    // for every smaller insight.
    expect(audit?.itemsTotal).toBe(2);
  });

  it('still reads metrics for audits Lighthouse marks hidden', () => {
    const report = normalizeFixture();
    expect(report.metrics.tti).toBe(4200);
    expect(report.insights.some((i) => i.id === 'interactive')).toBe(false);
  });

  it('excludes audits in the hidden group from the insight list', () => {
    const report = normalizeFixture();
    expect(report.insights.some((i) => i.id === 'bfcache')).toBe(false);
  });

  it('throws when there is no lighthouseResult', () => {
    expect(() => normalizeReport({}, 'https://example.com')).toThrow(/lighthouseResult/);
  });

  it('throws when the performance category is missing', () => {
    expect(() => normalizeReport({ lighthouseResult: { audits: {} } }, 'https://example.com')).toThrow(
      /performance category/,
    );
  });
});

describe('grouping', () => {
  it('assigns each fixture audit to the expected group', () => {
    const report = normalizeFixture();
    const byId = new Map(report.insights.map((i) => [i.id, i.group]));
    expect(byId.get('render-blocking-resources')).toBe('opportunity');
    expect(byId.get('uses-responsive-images')).toBe('opportunity');
    expect(byId.get('third-party-summary')).toBe('diagnostic');
    expect(byId.get('uses-text-compression')).toBe('passed');
    expect(byId.get('network-requests')).toBe('informative');
    expect(byId.get('uses-http2')).toBe('notApplicable');
  });

  it('treats a modern -insight audit as a diagnostic even when it is informative with no score', () => {
    const report = normalizeFixture();
    for (const id of ['lcp-lazy-loaded-insight', 'font-display-insight']) {
      const insight = report.insights.find((i) => i.id === id);
      expect(insight, id).toBeDefined();
      expect(insight?.group, id).toBe('diagnostic');
      expect(insight?.score, id).toBeNull();
    }
  });

  it('treats a metricSavings audit below 0.9 as a failing diagnostic', () => {
    // Lighthouse 13 emits scoreDisplayMode "metricSavings" for most insight
    // audits. It is a failure signal, not an "informative" marker.
    const report = normalizeFixture();
    const insight = report.insights.find((i) => i.id === 'image-delivery-insight');
    expect(insight?.scoreDisplayMode).toBe('metricSavings');
    expect(insight?.score).toBe(0.5);
    expect(insight?.group).toBe('diagnostic');
  });

  it('derives savings from detail items when overallSavings* is absent', () => {
    const report = normalizeFixture();
    const insight = report.insights.find((i) => i.id === 'image-delivery-insight');
    // Lighthouse 13 omits details.overallSavings*; the items carry wastedMs/wastedBytes.
    // Items are 100..42ms and 100000..71000 bytes, 30 of each.
    expect(insight?.savingsMs).toBe(2130);
    expect(insight?.savingsBytes).toBe(2_565_000);
  });

  it('reports savings as null rather than zero when Lighthouse gives no estimate', () => {
    const report = normalizeFixture();
    const insight = report.insights.find((i) => i.id === 'third-party-summary');
    // Zero would read as "this saves nothing", which is a different claim.
    expect(insight?.savingsMs).toBeNull();
    expect(insight?.savingsBytes).toBeNull();
  });

  it('surfaces an -insight audit that is missing from the category auditRefs', () => {
    const report = makeReport({
      extraAudits: {
        'brand-new-insight': {
          id: 'brand-new-insight',
          title: 'Something Lighthouse just added',
          description: 'A future audit this build has never heard of.',
          score: null,
          scoreDisplayMode: 'informative',
          details: { type: 'list', items: [{ note: 'x' }] },
          metricSavings: { CLS: 40 },
        },
      },
    });

    const insight = report.insights.find((i) => i.id === 'brand-new-insight');
    expect(insight).toBeDefined();
    expect(insight?.group).toBe('diagnostic');
    expect(insight?.metricsAffected).toEqual(['cls']);
  });

  it('marks a failing audit as diagnostic rather than dropping it', () => {
    const report = normalizeFixture();
    const audit = report.insights.find((i) => i.id === 'legacy-javascript');
    expect(audit?.group).toBe('diagnostic');
    expect(audit?.score).toBe(0);
  });

  it('prefers passed over the audit details type when the score is high', () => {
    const report = makeReport({
      patch: { 'uses-text-compression': { score: 1 } },
    });
    const audit = report.insights.find((i) => i.id === 'uses-text-compression');
    expect(audit?.group).toBe('passed');
  });

  it('applies the documented precedence for a hand-built audit', () => {
    // scoreDisplayMode wins over a high score for notApplicable/manual.
    expect(groupForAudit('x', 1, 'notApplicable', 'opportunity')).toBe('notApplicable');
    expect(groupForAudit('x', null, 'manual', undefined)).toBe('informative');
    // 0.9 or better is a pass.
    expect(groupForAudit('x', 0.9, 'numeric', 'opportunity')).toBe('passed');
    // Below that, the details type decides.
    expect(groupForAudit('x', 0.5, 'numeric', 'opportunity')).toBe('opportunity');
    expect(groupForAudit('x', 0.5, 'numeric', 'table')).toBe('diagnostic');
    // Insight audits are always actionable diagnostics.
    expect(groupForAudit('y-insight', null, 'informative', 'list')).toBe('diagnostic');
    expect(groupForAudit('y-insight', 1, 'informative', 'list')).toBe('passed');
  });
});

describe('first vs third party attribution', () => {
  const withAudits = (audits: Record<string, unknown>) =>
    normalizeFixture((raw) => {
      Object.assign((raw as { lighthouseResult: { audits: Record<string, unknown> } }).lighthouseResult.audits, audits);
    });

  it('counts items served from the measured domain as first party', () => {
    const report = withAudits({
      'image-delivery-insight': {
        id: 'image-delivery-insight',
        title: 'Improve image delivery',
        score: 0,
        scoreDisplayMode: 'binary',
        details: {
          type: 'opportunity',
          items: [
            { url: 'https://example.com/a.jpg', wastedBytes: 1000 },
            { url: 'https://example.com/b.jpg', wastedBytes: 2000 },
          ],
        },
      },
    });
    const insight = report.insights.find((i) => i.id === 'image-delivery-insight');
    expect(insight?.firstPartyItems).toBe(2);
    expect(insight?.thirdPartyItems).toBe(0);
    expect(insight?.itemHosts).toEqual(['example.com']);
  });

  it('treats a sibling subdomain as first party, since you own the fix', () => {
    const report = withAudits({
      'cache-insight': {
        id: 'cache-insight',
        title: 'Use efficient cache lifetimes',
        score: 0,
        scoreDisplayMode: 'binary',
        details: { items: [{ url: 'https://media.example.com/hero.jpg', wastedBytes: 10 }] },
      },
    });
    const insight = report.insights.find((i) => i.id === 'cache-insight');
    expect(insight?.firstPartyItems).toBe(1);
    expect(insight?.thirdPartyItems).toBe(0);
  });

  it('counts a foreign domain as third party even with a large saving', () => {
    const report = withAudits({
      'legacy-javascript-insight': {
        id: 'legacy-javascript-insight',
        title: 'Reduce legacy JavaScript',
        score: 0,
        scoreDisplayMode: 'binary',
        metricSavings: { TBT: 5000 },
        details: { items: [{ url: 'https://static.cloudflareinsights.com/beacon.min.js', wastedMs: 5000 }] },
      },
    });
    const insight = report.insights.find((i) => i.id === 'legacy-javascript-insight');
    expect(insight?.savingsMs).toBe(5000);
    expect(insight?.firstPartyItems).toBe(0);
    expect(insight?.thirdPartyItems).toBe(1);
    expect(insight?.itemHosts).toEqual(['static.cloudflareinsights.com']);
  });

  it('reads hosts out of nested subItems', () => {
    const report = withAudits({
      'third-parties-insight': {
        id: 'third-parties-insight',
        title: 'Reduce the impact of third parties',
        score: 1,
        scoreDisplayMode: 'informative',
        details: {
          items: [
            {
              entity: 'Stripe',
              subItems: { items: [{ url: 'https://js.stripe.com/v3/' }, { url: 'https://m.stripe.network/x' }] },
            },
          ],
        },
      },
    });
    const insight = report.insights.find((i) => i.id === 'third-parties-insight');
    expect(insight?.firstPartyItems).toBe(0);
    expect(insight?.thirdPartyItems).toBe(1);
    expect(insight?.itemHosts).toEqual(['js.stripe.com', 'm.stripe.network']);
  });

  it('treats an item mixing your CDN with a vendor as first party', () => {
    const report = withAudits({
      'bootup-time': {
        id: 'bootup-time',
        title: 'Reduce JavaScript execution time',
        score: 0,
        scoreDisplayMode: 'binary',
        details: {
          items: [
            {
              url: 'https://example.com/app.js',
              subItems: { items: [{ url: 'https://cdn.vendor.com/lib.js' }] },
            },
          ],
        },
      },
    });
    const insight = report.insights.find((i) => i.id === 'bootup-time');
    expect(insight?.firstPartyItems).toBe(1);
    expect(insight?.thirdPartyItems).toBe(0);
  });

  it('leaves insights with no URLs unattributed rather than calling them third party', () => {
    const report = withAudits({
      'mainthread-work-breakdown': {
        id: 'mainthread-work-breakdown',
        title: 'Minimize main thread work',
        score: 0.5,
        scoreDisplayMode: 'binary',
        details: {
          items: [
            { group: 'scriptEvaluation', duration: 9393 },
            { group: 'other', duration: 4135 },
          ],
        },
      },
    });
    const insight = report.insights.find((i) => i.id === 'mainthread-work-breakdown');
    // Unattributed, so it must not be filtered out by party=first - the cost is
    // most likely the site's own JavaScript.
    expect(insight?.firstPartyItems).toBe(0);
    expect(insight?.thirdPartyItems).toBe(0);
  });

  it('promotes third-parties-insight out of passed so it cannot hide at the bottom', () => {
    const report = withAudits({
      'third-parties-insight': {
        id: 'third-parties-insight',
        title: 'Reduce the impact of third parties',
        score: 1,
        scoreDisplayMode: 'informative',
        details: { items: [{ entity: 'Stripe', subItems: { items: [{ url: 'https://js.stripe.com/v3/' }] } }] },
      },
    });
    const insight = report.insights.find((i) => i.id === 'third-parties-insight');
    expect(insight?.group).toBe('diagnostic');
  });
});

describe('cache-busting param never reaches the report', () => {
  it('strips the nonce from the final url', () => {
    const report = normalizeFixture((raw) => {
      (raw as { lighthouseResult: { finalUrl: string } }).lighthouseResult.finalUrl =
        'https://example.com/?psi_nonce=abc123';
    });
    expect(report.finalUrl).toBe('https://example.com/');
  });

  it('strips the nonce from item urls, including nested ones', () => {
    const report = normalizeFixture((raw) => {
      const audits = (raw as { lighthouseResult: { audits: Record<string, unknown> } }).lighthouseResult.audits;
      audits['image-delivery-insight'] = {
        id: 'image-delivery-insight',
        title: 'Improve image delivery',
        score: 0,
        scoreDisplayMode: 'binary',
        details: {
          items: [
            { url: 'https://example.com/a.jpg?psi_nonce=zzz' },
            {
              entity: 'Stripe',
              subItems: {
                items: [
                  { url: 'https://m.stripe.network/i.html#url=https%3A%2F%2Fexample.com%2F%3Fpsi_nonce%3Dzzz' },
                ],
              },
            },
          ],
        },
      };
    });
    const insight = report.insights.find((i) => i.id === 'image-delivery-insight');
    const serialized = JSON.stringify(insight?.items);
    expect(serialized).not.toContain('psi_nonce');
  });
});

describe('field data is stripped too', () => {
  it('removes the nonce from CrUX initial_url', () => {
    const report = normalizeFixture((raw) => {
      (raw as { loadingExperience: unknown }).loadingExperience = {
        metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 75 } },
        initial_url: 'https://example.com/zen-class/?psi_nonce=abc123',
      };
    });
    const serialized = JSON.stringify(report.fieldData);
    expect(serialized).not.toContain('psi_nonce');
    const loading = report.fieldData as {
      loadingExperience: { initial_url: string };
    };
    expect(loading.loadingExperience.initial_url).toBe('https://example.com/zen-class/');
  });
});
