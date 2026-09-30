import { describe, expect, it } from 'vitest';
import { targetBar, visibleLength } from '../src/render.js';

const WIDTH = 16;

const draw = (actual: number, target: number, width = WIDTH): string => {
  const bar = targetBar(actual, target, width);
  return bar.fill + bar.lead + bar.tick + bar.rest;
};

describe('targetBar', () => {
  it('always draws exactly the requested number of cells', () => {
    // A ragged right edge is the most visible way for a table to look broken.
    for (const actual of [0, 0.0004, 22, 118, 2012, 3419, 99999]) {
      for (const target of [0.1, 200, 1800, 2500, 3400]) {
        expect(visibleLength(draw(actual, target))).toBe(WIDTH);
      }
    }
  });

  it('puts the target marker in the same column on every row', () => {
    // The single most valuable property of this bar. Scanning the column to see
    // which rows reach the line is the whole exercise, so a marker that moved
    // with the data would reduce it to ten separate pictures.
    const columns = new Set<number>();
    for (const [actual, target] of [
      [0.0, 0.1],
      [22, 200],
      [118, 200],
      [2012, 1800],
      [2476, 2500],
      [3419, 3400],
    ] as Array<[number, number]>) {
      const bar = targetBar(actual, target, WIDTH);
      columns.add(bar.fill.length + bar.lead.length);
    }
    expect(columns.size).toBe(1);
  });

  it('makes a metric with a tiny share of its target look tiny, not broken', () => {
    // The bug this replaced: on a shared raw-value scale, TBT at 11% of its
    // target drew the shortest bar on the page and read as the worst metric,
    // while CLS at 0% read worse still. Both are excellent results.
    const tbt = targetBar(22, 200, WIDTH);
    const cls = targetBar(0, 0.1, WIDTH);
    expect(tbt.used).toBeCloseTo(0.11, 2);
    expect(cls.used).toBe(0);
    expect(tbt.over).toBe(false);
    expect(cls.over).toBe(false);
    // Far short of the marker at 8 of 16.
    expect(tbt.fill.length).toBeLessThan(8);
    expect(cls.fill.length).toBe(0);
  });

  it('makes a breached target readable without colour', () => {
    // FCP at 112% of target: the overrun is a fraction of one cell at this
    // resolution, so the fill length alone cannot say "over". The marker glyph
    // carries it, which matters because a report pasted into an issue has no
    // colour at all.
    const bar = targetBar(2012, 1800, WIDTH);
    expect(bar.used).toBeGreaterThan(1);
    expect(bar.over).toBe(true);
    expect(bar.tick).toBe('×');
    // Nothing to distinguish it by length, which is the point.
    expect(bar.lead).toBe('');
  });

  it('marks an unbreached target with a line, not a cross', () => {
    // LCP at 99% of target stops level with the marker. The glyph is the only
    // thing separating this row from a breached one.
    const bar = targetBar(2476, 2500, WIDTH);
    expect(bar.over).toBe(false);
    expect(bar.used).toBeLessThan(1);
    expect(bar.tick).toBe('┃');
  });

  it('never marks a metric with no target as breached', () => {
    // No target means no line to cross, so the cross glyph would be a claim the
    // data does not support.
    expect(targetBar(9999, 0).tick).toBe('');
  });

  it('distinguishes a small overshoot from a large one', () => {
    // The old bar could not: 0.6% over and 12% over were both "the longest bar
    // in the table", because both were the largest raw value in the column. The
    // share is the number that separates them, and it is printed.
    const barely = targetBar(3419, 3400, WIDTH);
    const badly = targetBar(2012, 1800, WIDTH);
    expect(barely.used - 1).toBeLessThan(0.01);
    expect(badly.used - 1).toBeGreaterThan(0.1);
  });

  it('clamps a value far past the target rather than overflowing the bar', () => {
    const bar = targetBar(99999, 200, WIDTH);
    expect(visibleLength(bar.fill + bar.lead + bar.tick + bar.rest)).toBe(WIDTH);
    expect(bar.over).toBe(true);
    // The exact overshoot is the VERDICT column's job; the bar only has to say
    // "past the line" without breaking the layout.
    expect(bar.used).toBeGreaterThan(2);
  });

  it('draws no marker when there is no target to measure against', () => {
    // A zero target gives nothing to compare to. Pinning the marker at a
    // meaningful-looking position would imply a comparison that does not exist.
    for (const target of [0, -1, Number.NaN]) {
      const bar = targetBar(100, target, WIDTH);
      expect(bar.tick).toBe('');
      expect(bar.used).toBe(0);
      expect(bar.over).toBe(false);
      expect(visibleLength(bar.fill + bar.lead + bar.tick + bar.rest)).toBe(WIDTH);
    }
  });

  it('reports the share of target used, which is what the bar is drawn from', () => {
    expect(targetBar(1800, 1800).used).toBe(1);
    expect(targetBar(900, 1800).used).toBe(0.5);
    expect(targetBar(0.05, 0.1).used).toBe(0.5);
  });
});
