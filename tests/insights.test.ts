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

  it('omits itemsTotal when nothing was trimmed', () => {
    const report = normalizeFixture();
    const audit = report.insights.find((i) => i.id === 'font-display-insight');
    expect(audit?.items).toHaveLength(2);
    expect(audit?.itemsTotal).toBeUndefined();
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

  it('reports no savings at all when nothing reports one', () => {
    const report = normalizeFixture();
    const insight = report.insights.find((i) => i.id === 'third-party-summary');
    expect(insight?.savingsMs).toBeUndefined();
    expect(insight?.savingsBytes).toBeUndefined();
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
