import { describe, expect, it } from 'vitest';
import {
  ABSENT,
  colorEnabled,
  deviceLabel,
  environmentLine,
  fit,
  formatBytes,
  metricDelta,
  metricValue,
  medianOverTarget,
  paint,
  passCount,
  passSeverity,
  renderTable,
  savingsLabel,
  shortenUrl,
  spreadLine,
  termWidth,
  truncate,
  visibleLength,
  wrap,
  type Column,
} from '../src/render.js';
import type { RunEnvironment } from '../src/types.js';

/** The exact environment PSI echoes back for a default mobile run. */
const MOBILE_ENV: RunEnvironment = {
  lighthouseVersion: '13.5.0',
  formFactor: 'mobile',
  emulatedFormFactor: 'mobile',
  benchmarkIndex: 927.5,
  networkUserAgent:
    'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36',
  hostUserAgent: 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/153.0.8010.36',
  channel: 'lr',
  locale: 'en-US',
  categories: ['performance'],
};

describe('visibleLength / fit / truncate', () => {
  it('measures a painted string by what it looks like, not by its bytes', () => {
    // Alignment breaks if the escape codes are counted as characters.
    expect(visibleLength('abc')).toBe(3);
    expect(visibleLength(paint('red', 'abc', true))).toBe(3);
  });

  it('pads to an exact visible width even when the text is painted', () => {
    const painted = paint('red', 'abc', true);
    expect(visibleLength(fit(painted, 8))).toBe(8);
    expect(fit('ab', 5, 'right')).toBe('   ab');
  });

  it('truncates with an ellipsis and closes the colour it cut', () => {
    expect(truncate('abcdefgh', 4)).toBe('abc…');
    const painted = truncate(paint('red', 'abcdefgh', true), 4);
    expect(visibleLength(painted)).toBe(4);
    // Without the reset, everything after the cut would be red too.
    expect(painted.endsWith('\u001b[0m…')).toBe(true);
  });

  it('leaves a string that already fits alone', () => {
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate('abc', 0)).toBe('');
  });
});

describe('termWidth', () => {
  it('clamps to a range a table can actually be laid out in', () => {
    expect(termWidth(10)).toBe(60);
    expect(termWidth(500)).toBe(120);
    expect(termWidth(100)).toBe(100);
  });

  it('falls back to a usable default when nothing is known', () => {
    const previous = process.env.COLUMNS;
    delete process.env.COLUMNS;
    try {
      const width = termWidth();
      expect(width).toBeGreaterThanOrEqual(60);
      expect(width).toBeLessThanOrEqual(120);
    } finally {
      if (previous !== undefined) process.env.COLUMNS = previous;
    }
  });
});

describe('wrap', () => {
  it('breaks on word boundaries and indents continuations', () => {
    expect(wrap('one two three four', 9, '..')).toEqual(['one two', '..three', '..four']);
  });

  it('never leaves trailing whitespace on a wrapped line', () => {
    // The bug this guards: a space that fitted at the end of a line survives
    // after the following word starts the next line.
    for (const line of wrap('alpha beta gamma delta epsilon', 12, '  ')) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it('cuts a single token too long for the line instead of spilling it', () => {
    const lines = wrap('https://example.com/a/very/long/path/segment', 12);
    expect(lines).toHaveLength(1);
    expect(visibleLength(lines[0] as string)).toBeLessThanOrEqual(12);
  });

  it('returns the input unchanged when it already fits', () => {
    expect(wrap('short', 40)).toEqual(['short']);
  });
});

describe('renderTable', () => {
  const columns: Column[] = [
    { key: 'name', label: 'NAME', min: 5 },
    { key: 'value', label: 'VALUE', align: 'right', min: 5 },
  ];

  it('aligns every column to one width', () => {
    const lines = renderTable(
      columns,
      [
        ['a', '1'],
        ['longer-name', '2000'],
      ],
      { width: 60 },
    );
    expect(lines[0]).toBe('NAME         VALUE');
    expect(lines[1]).toBe('a                1');
    expect(lines[2]).toBe('longer-name   2000');
  });

  it('shrinks the flexible column rather than the numbers', () => {
    const table = renderTable(
      [
        { key: 'id', label: 'ID', min: 8, grow: true },
        { key: 'n', label: 'N', align: 'right', min: 6 },
      ],
      [['a-very-long-audit-identifier-here', '12345']],
      { width: 30 },
    );
    for (const line of table) expect(visibleLength(line)).toBeLessThanOrEqual(30);
    // The number must survive intact - a truncated figure is worse than a
    // truncated id, because there is no other place to read it.
    expect(table[1]).toContain('12345');
    expect(table[1]).toContain('…');
  });

  it('renders a header even with no rows, so a table never looks broken', () => {
    expect(renderTable(columns, [], { width: 40 })).toEqual(['NAME  VALUE']);
  });

  it('emits detail lines directly beneath the row they belong to', () => {
    const lines = renderTable(columns, [['a', '1'], ['b', '2']], {
      width: 60,
      indent: '  ',
      detail: (row) => [`why ${row[0]}`],
    });
    expect(lines).toEqual([
      '  NAME  VALUE',
      '  a         1',
      '    why a',
      '  b         2',
      '    why b',
    ]);
  });

  it('fills a missing cell rather than printing undefined', () => {
    const lines = renderTable(columns, [['only-a-name']], { width: 60 });
    expect(lines[1]).not.toContain('undefined');
  });
});


describe('metricValue', () => {
  it('uses each metric own unit', () => {
    expect(metricValue('lcp', 2401)).toBe('2401ms');
    expect(metricValue('cls', 0)).toBe('0.000');
    expect(metricValue('cls', 0.12345)).toBe('0.123');
  });

  it('never renders a score as a duration', () => {
    // `94ms` for a performance score is the kind of error that makes a reader
    // distrust every other number on the page.
    expect(metricValue('score', 94)).toBe('94');
    expect(metricValue('score', 94.5)).toBe('94.5');
    expect(metricValue('score', 87.25)).toBe('87.3');
  });

  it('renders an unmeasured value as absent, never as zero', () => {
    for (const missing of [undefined, null, Number.NaN]) {
      expect(metricValue('lcp', missing)).toBe(ABSENT);
    }
  });
});

describe('metricDelta', () => {
  it('says "in target" when the median is under, whatever the pass rate says', () => {
    // A metric can sit inside its target on the median while too few runs hold
    // it. Printing "-178ms over" for a metric 178ms *under* target sends a
    // reader to fix the wrong thing.
    expect(metricDelta('speedIndex', -178)).toBe('in target');
    expect(metricDelta('tbt', -82)).toBe('in target');
  });

  it('states the overshoot in the metric own unit', () => {
    expect(metricDelta('fcp', 354.4)).toBe('+354ms over');
    expect(metricDelta('cls', 0.02)).toBe('+0.020 over');
  });
});

describe('formatBytes / savingsLabel', () => {
  it('scales byte counts the way Lighthouse writes them', () => {
    expect(formatBytes(999)).toBe('999B');
    expect(formatBytes(33_465)).toBe('33KB');
    expect(formatBytes(205_600)).toBe('201KB');
    expect(formatBytes(2_500_000)).toBe('2.4MB');
    expect(formatBytes(undefined)).toBe(ABSENT);
  });

  it('falls back to bytes when a finding is priced in bytes only', () => {
    // The old table printed a dash here, discarding the largest single number in
    // most reports.
    expect(savingsLabel(null, 205_600)).toBe('201KB');
    expect(savingsLabel(150, 205_600)).toBe('150ms');
  });

  it('distinguishes "no estimate" from zero', () => {
    expect(savingsLabel(null, null)).toBe(ABSENT);
    expect(savingsLabel(0, 0)).toBe(ABSENT);
  });
});

describe('passCount', () => {
  it('reports the run split when it was measured', () => {
    expect(passCount({ runsMeasured: 10, overBudgetRuns: 2 })).toBe('8/10');
  });

  it('reports absent rather than a misleading 100%', () => {
    expect(passCount({})).toBe(ABSENT);
    expect(passCount({ passRate: 0.9 })).toBe(ABSENT);
  });
});

describe('medianOverTarget', () => {
  it('ignores the pass-rate verdict entirely', () => {
    // The reported bug: a metric whose median is comfortably inside target still
    // fails the pass-rate gate, and colouring the row off the gate put the word
    // "in target" next to a red label. The row is the median's business.
    expect(medianOverTarget({ delta: -178 })).toBe(false);
    expect(medianOverTarget({ delta: -82 })).toBe(false);
    expect(medianOverTarget({ delta: 354 })).toBe(true);
  });

  it('treats sitting exactly on the line as in target', () => {
    // A median equal to the target has not exceeded it, and the bar draws the
    // marker at the fill's edge, so the two must agree.
    expect(medianOverTarget({ delta: 0 })).toBe(false);
  });

  it('treats an ungraded metric as in target', () => {
    expect(medianOverTarget(undefined)).toBe(false);
  });
});

describe('passSeverity', () => {
  it('does not paint a variable-but-fine target the same red as a broken one', () => {
    // 8/10 and 0/10 both fail the 90% gate. Reporting them identically is what
    // made a healthy page look like a regression.
    expect(passSeverity({ meets: false, passRate: 0.8 })).toBe('yellow');
    expect(passSeverity({ meets: false, passRate: 1 })).toBe('yellow');
    expect(passSeverity({ meets: false, passRate: 0.6 })).toBe('red');
    expect(passSeverity({ meets: false, passRate: 0 })).toBe('red');
  });

  it('is green when the target was met', () => {
    expect(passSeverity({ meets: true, passRate: 1 })).toBe('green');
  });

  it('never paints red when the median is inside target', () => {
    // LCP 2476ms vs 2500ms, held in 6/10 runs.
    expect(passSeverity({ meets: false, passRate: 0.6, delta: -24 })).toBe('yellow');
    expect(passSeverity({ meets: false, passRate: 0.6, delta: 39 })).toBe('red');
  });

  it('assumes the worst when the pass rate was never measured', () => {
    // An absent pass rate is not evidence of health, so it must not read green.
    expect(passSeverity({ meets: false })).toBe('red');
  });
});

describe('spreadLine', () => {
  it('omits percentiles a stored report predates instead of printing undefined', () => {
    // Old stored reports have no p25/p75/p95, and the previous renderer
    // printed the literal text "undefined" for each.
    const line = spreadLine({ median: 94, min: 84, max: 95, stddev: 3.4, metric: 'score' });
    expect(line).not.toContain('undefined');
    expect(line).toBe('range 84–95 · stddev 3.4');
  });

  it('includes the tail percentiles when they exist', () => {
    const line = spreadLine({ median: 94, p25: 87.5, p75: 95.5, p95: 95.5, min: 84, max: 95.5, stddev: 3.4, metric: 'score' });
    expect(line).toBe('p25 87.5 · p75 95.5 · p95 95.5 · range 84–95.5 · stddev 3.4');
  });

  it('is empty rather than wrong when it has nothing to say', () => {
    expect(spreadLine({ median: 94, metric: 'lcp' })).toBe('');
  });
});

describe('deviceLabel / environmentLine', () => {
  it('names the emulated device out of the network user agent', () => {
    expect(deviceLabel(MOBILE_ENV)).toBe('moto g power (2022)');
  });

  it('does not present a desktop CPU model as a device name', () => {
    const desktop: RunEnvironment = {
      lighthouseVersion: '13.5.0',
      formFactor: 'desktop',
      networkUserAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    };
    expect(deviceLabel(desktop)).toBe('desktop');
  });

  it('falls back to the form factor when there is no user agent', () => {
    expect(deviceLabel({ lighthouseVersion: '13.5.0', formFactor: 'mobile' })).toBe('mobile');
    expect(deviceLabel({ lighthouseVersion: '13.5.0' })).toBe(ABSENT);
  });

  it('records the conditions a number was measured under', () => {
    const line = environmentLine(MOBILE_ENV);
    expect(line).toContain('moto g power (2022)');
    expect(line).toContain('CPU index 928'); // rounded: Lighthouse's 927.5
    expect(line).toContain('en-US');
    expect(line).toContain('performance only');
  });

  it('does not name a throttling model PSI never reported', () => {
    // Inferring "Slow 4G" from the form factor would be a guess printed as a
    // measurement, and PSI does not echo the throttle at all.
    expect(environmentLine(MOBILE_ENV)).not.toMatch(/4G|throttl/i);
  });

  it('says so when a report predates the environment capture', () => {
    expect(environmentLine(undefined)).toBe('not recorded');
    expect(environmentLine({ lighthouseVersion: '13.5.0' })).toBe(
      'Lighthouse 13.5.0, device not recorded',
    );
  });
});

describe('shortenUrl', () => {
  it('keeps the path tail, which is what distinguishes one page from another', () => {
    const url = 'https://qwik-guvi-perf-fix.codingpuppet.com/zen-class/data-science-course/';
    expect(shortenUrl(url, 200)).toBe(url);
    // Wide enough to keep the scheme: the host is the part that identifies the site.
    expect(shortenUrl(url, 80)).toBe(url);
    // Too narrow for the scheme, so it goes and the path survives.
    const shortened = shortenUrl(url, 70);
    expect(shortened.startsWith('https://')).toBe(false);
    expect(shortened).toContain('zen-class/data-science-course');
    // Narrower still: the tail of the path is what tells two pages apart.
    const tail = shortenUrl(url, 30);
    expect(tail.startsWith('…')).toBe(true);
    expect(visibleLength(tail)).toBeLessThanOrEqual(30);
  });

  it('still drops the scheme when that is all that needs to go', () => {
    expect(shortenUrl('https://example.com/', 15)).toBe('example.com/');
  });
});

describe('colorEnabled', () => {
  it('follows NO_COLOR rather than deciding on its own', () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      expect(colorEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });
});
