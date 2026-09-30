/**
 * Terminal layout primitives, shared by every renderer in the CLI.
 *
 * These live apart from `cli.ts` because layout is where a report quietly stops
 * being trustworthy. A column that does not line up, an audit id cut in half, or
 * the literal text `undefined` where a number belongs - none of these announce
 * themselves as errors, they just read as "the tool knows something I don't" and
 * cost the reader a re-run to disprove. So every function here is total: it
 * takes missing input and renders it as *absent*, never as a broken value, and
 * is tested directly instead of through a snapshot of a whole report.
 *
 * Nothing in this module knows what a performance metric is. It knows how wide
 * the terminal is, how much room a column wants, and how to say "no data" in a
 * way that does not look like a zero.
 */

import type { MetricKey, RunEnvironment } from './types.js';

/* ---------------------------------- colour ---------------------------------- */

const ESC = '\u001b';
const RESET = `${ESC}[0m`;

export const CODES = {
  green: `${ESC}[32m`,
  red: `${ESC}[31m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  cyan: `${ESC}[36m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
} as const;

export type CodeName = keyof typeof CODES;

/**
 * Wrap `text` in an ANSI colour, or return it untouched when colour is off.
 *
 * Colour is a rendering concern and never changes meaning, so everything that
 * styles output goes through here: `--json` and `NO_COLOR` then need no special
 * cases at the call sites.
 */
export function paint(code: CodeName, text: string, enabled: boolean): string {
  return enabled ? `${CODES[code]}${text}${RESET}` : text;
}

/** Whether the current stdout can render colour. */
export function colorEnabled(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** How many columns a string occupies on screen, ignoring colour codes. */
export function visibleLength(text: string): number {
  return text.replace(ANSI_PATTERN, '').length;
}

/* --------------------------------- geometry --------------------------------- */

const MIN_WIDTH = 60;
const MAX_WIDTH = 120;
const DEFAULT_WIDTH = 88;

/**
 * The width to lay out for, from `COLUMNS`, the tty size, or a sane default.
 *
 * Clamped at both ends on purpose: narrower than 60 and the metric table cannot
 * hold a value and its budget, wider than 120 and lines start wrapping in
 * anything that copies the output into a bug report.
 */
export function termWidth(explicit?: number): number {
  const candidates = [explicit, toInt(process.env.COLUMNS), process.stdout.columns];
  const found = candidates.find((value) => typeof value === 'number' && value > 0);
  const width = found ?? DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(width)));
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Pad or truncate to an exact visible width. */
export function fit(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const length = visibleLength(text);
  if (length > width) return truncate(text, width);
  const padding = ' '.repeat(width - length);
  return align === 'right' ? padding + text : text + padding;
}

/**
 * Re-flow prose to a width, indenting continuation lines under the first.
 *
 * The alternative - letting the terminal wrap - breaks every column alignment
 * after the first long line and turns a report into a wall of ragged text. This
 * is what keeps a two-sentence explanation readable in a table view.
 *
 * Takes plain text and returns plain text, because re-flowing painted text would
 * have to carry colour state across line breaks. Callers style afterwards.
 */
export function wrap(text: string, width: number, continuation = ''): string[] {
  if (width <= 0) return [text];
  const tokens = text.split(/(\s+)/).filter((token) => token.length > 0);
  const lines: string[] = [];
  let current = '';
  let visible = 0;

  const flush = () => {
    if (current.length > 0) lines.push(current);
    current = '';
    visible = 0;
  };

  for (const token of tokens) {
    const tokenWidth = visibleLength(token);
    if (tokenWidth === 0) continue;

    if (/^\s+$/.test(token)) {
      // Whitespace at a line break is dropped, so the indent supplies it.
      if (visible === 0 || visible + tokenWidth > width) continue;
      current += token;
      visible += tokenWidth;
      continue;
    }

    if (visible > 0 && visible + tokenWidth > width) flush();
    if (tokenWidth > width) {
      // A single unbreakable token - a URL, an id. Cut it rather than let it
      // spill, and keep the remainder as its own line.
      current += truncate(token, width);
      flush();
      continue;
    }
    current += token;
    visible += tokenWidth;
  }
  flush();

  // `trimEnd` because a space token that fit at the end of a line is kept, and
  // the word after it then starts the next line - leaving a trailing space that
  // shows up as a ragged gap under wrapped text.
  return lines.map((line, index) => (index === 0 ? line.trimEnd() : `${continuation}${line.trimEnd()}`));
}

/**
 * Cut to a visible width, ending with an ellipsis.
 *
 * A truncated audit id is still findable, and a colour reset is restored at the
 * cut so a half-coloured cell cannot bleed into the rest of the row.
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (visibleLength(text) <= width) return text;

  const keep = width - 1;
  let out = '';
  let visible = 0;
  let index = 0;
  let hadCodes = false;

  while (index < text.length && visible < keep) {
    if (text[index] === ESC) {
      const end = text.indexOf('m', index);
      if (end !== -1 && end - index < 12) {
        out += text.slice(index, end + 1);
        hadCodes = true;
        index = end + 1;
        continue;
      }
    }
    out += text[index];
    index += 1;
    visible += 1;
  }

  return `${out}${hadCodes ? RESET : ''}…`;
}

/* ---------------------------------- tables ---------------------------------- */

export type Align = 'left' | 'right';

export interface Column {
  key: string;
  label: string;
  align?: Align;
  /** Never shrink below this, however tight the terminal is. */
  min?: number;
  /** Never grow past this, however much content there is. */
  max?: number;
  /**
   * Absorbs the overflow when the table has to shrink.
   *
   * Set on exactly one column - the one carrying the free text. Names and
   * numbers that get squeezed become unreadable, whereas a truncated audit id
   * stays findable, so the id is the one that gives way.
   */
  grow?: boolean;
}

export interface TableOptions {
  /** Total width to fit, gaps and indent included. */
  width?: number;
  /** Spaces between columns. */
  gap?: number;
  /** Prefix applied to every line. */
  indent?: string;
  /** Applied to the header row, so callers can dim it without restyling cells. */
  styleLabel?: (text: string) => string;
  /**
   * Extra lines to emit directly beneath a body row.
   *
   * For prose that is worth reading but does not survive a column: a ranking
   * explanation, a procedure. Printed under the row it belongs to, because a
   * block of explanations gathered at the bottom of the table leaves the reader
   * guessing which of eight rows each one is about.
   */
  detail?: (row: string[], index: number) => string[];
}

/**
 * Lay out a table that fits the terminal.
 *
 * Columns first take the width their content wants, and the flexible column
 * gives ground only if the total still does not fit. Every cell is then fitted
 * to its column's final width, so the table stays square regardless of content.
 */
export function renderTable(
  columns: Column[],
  rows: string[][],
  options: TableOptions = {},
): string[] {
  const { width = termWidth(), gap = 2, indent = '', styleLabel } = options;
  if (columns.length === 0) return [];

  const widths = naturalWidths(columns, rows);
  const budget = Math.max(8, width - visibleLength(indent));
  shrinkToFit(widths, columns, budget, gap);

  const render = (cells: string[], transform?: (text: string) => string): string =>
    indent +
    columns
      .map((column, index) => {
        const cell = fit(cells[index] ?? '', widths[index] ?? 0, column.align ?? 'left');
        return transform ? transform(cell) : cell;
      })
      .join(' '.repeat(gap))
      .replace(/\s+$/, '');

  const lines = [render(columns.map((column) => column.label), styleLabel)];
  rows.forEach((row, index) => {
    lines.push(render(row));
    for (const extra of options.detail?.(row, index) ?? []) {
      lines.push(`${indent}${' '.repeat(2)}${extra}`.replace(/\s+$/, ''));
    }
  });
  return lines;
}

function naturalWidths(columns: Column[], rows: string[][]): number[] {
  return columns.map((column, index) => {
    const widest = rows.reduce((max, row) => Math.max(max, visibleLength(row[index] ?? '')), 0);
    const wanted = Math.max(visibleLength(column.label), widest);
    return clampWidth(wanted, column);
  });
}

/**
 * Take width back from the flexible column, then from the widest others.
 *
 * Shrinking the widest first keeps narrow columns intact, which is what makes a
 * squeezed table still readable: the id loses its tail, the numbers do not.
 */
function shrinkToFit(widths: number[], columns: Column[], budget: number, gap: number): void {
  const overhead = gap * (columns.length - 1);
  let total = widths.reduce((sum, value) => sum + value, 0) + overhead;
  if (total <= budget) return;

  const growIndex = columns.findIndex((column) => column.grow === true);
  if (growIndex !== -1) {
    const growColumn: Partial<Column> = columns[growIndex] ?? {};
    const growWidth = widths[growIndex] ?? 0;
    const floor = clampWidth(growColumn.min ?? 8, growColumn);
    // Everything except the flexible column is fixed, so it takes the whole
    // remainder - including the gaps, which are part of the budget.
    const available = Math.max(floor, budget - (total - growWidth));
    widths[growIndex] = Math.min(growWidth, available);
    total = widths.reduce((sum, value) => sum + value, 0) + overhead;
  }

  // Still over: shave the widest columns one character at a time, respecting
  // each one's floor. Ties break to the left so the result is deterministic.
  while (total > budget) {
    let widestIndex = -1;
    let widest = 0;
    for (let index = 0; index < widths.length; index += 1) {
      const width = widths[index] ?? 0;
      if (index === growIndex) continue;
      if (width > widest) {
        widest = width;
        widestIndex = index;
      }
    }
    if (widestIndex === -1) return;
    const column: Partial<Column> = columns[widestIndex] ?? {};
    const floor = clampWidth(column.min ?? 3, column);
    if ((widths[widestIndex] ?? 0) <= floor) return;
    widths[widestIndex] = (widths[widestIndex] ?? 0) - 1;
    total -= 1;
  }
}

function clampWidth(width: number, column: Partial<Column>): number {
  const max = column.max ?? Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(width, max));
}

/* ----------------------------------- bars ----------------------------------- */

export interface BarSegments {
  /** The part of the bar the measured value covers, up to the budget marker. */
  fill: string;
  /** Unfilled cells between the value and the budget, when the value is under it. */
  lead: string;
  /** The budget marker's single cell. */
  tick: string;
  /** The unused remainder, after the marker. */
  rest: string;
  /** Whether the value runs past the budget. */
  over: boolean;
}

/**
 * A value against a budget, drawn on a scale shared with its neighbours.
 *
 * `scale` is passed in rather than derived, and that is the whole point: a bar
 * scaled to its own row makes every row look equally bad, so the caller takes
 * the largest value in the table and every row is read against the same ruler.
 *
 * The marker is what makes the bar a judgement rather than a picture. Fill alone
 * only says "this metric is large", and TBT is small *and* fine. A filled bar
 * that stops before the marker is in budget; one that runs past it is not. The
 * marker is therefore a separate segment rather than a character inside the
 * fill, because when the value is over budget it has to overwrite the fill
 * instead of hiding behind it.
 */
export function barSegments(
  value: number,
  target: number,
  scale: number,
  width = 12,
): BarSegments {
  const safeScale = scale > 0 ? scale : 1;
  const cells = Math.max(1, width);
  // How many cells the value covers, as a whole number of cells.
  const covered = Math.round(clamp(value / safeScale, 0, 1) * cells);
  // A budget beyond the scale still needs a mark, so the marker pins to the end
  // rather than disappearing off the right edge.
  const mark = Math.min(cells - 1, Math.floor(clamp(target / safeScale, 0, 1) * cells));

  // The marker occupies one of the `cells` positions, so the value gets the
  // other `cells - 1`. When the value runs past the marker that means one fewer
  // filled cell than its own length - the marker sits *on top of* the fill rather
  // than beside it, which is the whole visual point of an over-budget bar.
  if (covered > mark) {
    return {
      fill: '█'.repeat(mark),
      lead: '█'.repeat(covered - mark - 1),
      tick: '┃',
      rest: '·'.repeat(cells - covered),
      over: true,
    };
  }
  return {
    fill: '█'.repeat(covered),
    // The value is under budget: the gap between it and the marker is headroom.
    lead: '·'.repeat(mark - covered),
    tick: '┃',
    rest: '·'.repeat(cells - mark - 1),
    over: false,
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/* --------------------------------- values ----------------------------------- */

/** Printed in place of a number that was never measured. */
export const ABSENT = '—';

/**
 * A value in the unit its budget is written in.
 *
 * Three units, not one: CLS is a unitless score and is the one metric where
 * printing milliseconds' worth of decimal places is actively harmful, and the
 * performance score is not a duration at all - rendering it as `94ms` is the
 * kind of error that makes a reader distrust every other number on the page.
 *
 * Missing renders as `ABSENT` rather than `0`, because "not measured" and
 * "measured as nothing" are different claims and only one of them is true.
 */
export function metricValue(metric: string, value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return ABSENT;
  if (metric === 'cls') return value.toFixed(3);
  if (metric === 'score') return trimNumber(value);
  return `${Math.round(value)}ms`;
}

/** A score to one decimal, with a trailing `.0` dropped so `94` beats `94.0`. */
function trimNumber(value: number): string {
  const rounded = round1(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * How the median sits against its budget.
 *
 * Deliberately keyed on the sign of `delta` and not on the pass-rate verdict:
 * a metric can have its median inside budget while too few runs hold it, and
 * printing "-178ms over" for a metric that is 178ms *under* its budget is the
 * kind of error that sends a reader to fix the wrong thing. The pass-rate
 * verdict is a separate column.
 */
export function metricDelta(metric: string, delta: number): string {
  if (delta <= 0) return 'in budget';
  const rounded = metric === 'cls' ? delta.toFixed(3) : `${Math.round(delta)}ms`;
  return `+${rounded} over`;
}

/** Byte counts the way Lighthouse writes them: powers of 1024, no decimals. */
export function formatBytes(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return ABSENT;
  if (value < 1024) return `${Math.round(value)}B`;
  if (value < 1024 ** 2) return `${Math.round(value / 1024)}KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)}MB`;
  return `${(value / 1024 ** 3).toFixed(1)}GB`;
}

/**
 * An insight's estimated saving, preferring the figure that is actually comparable.
 *
 * A finding can be priced in time, in bytes, or not at all. Showing `-` for the
 * byte-priced ones threw away real numbers - a 206KB unused-JS estimate is the
 * largest single number in most reports - so bytes are the fallback rather than
 * an empty cell. Genuinely unpriced findings get `ABSENT`.
 */
export function savingsLabel(ms: number | null, bytes: number | null): string {
  if (ms !== null && ms !== undefined && Number.isFinite(ms) && ms > 0) return metricValue('tbt', ms);
  if (bytes !== null && bytes !== undefined && Number.isFinite(bytes) && bytes > 0) {
    return formatBytes(bytes);
  }
  return ABSENT;
}

/** How many runs a budget held, as `in/total`, or `ABSENT` when unmeasured. */
export function passCount(gap: {
  passRate?: number;
  runsMeasured?: number;
  overBudgetRuns?: number;
}): string {
  if (gap.runsMeasured === undefined || gap.overBudgetRuns === undefined) return ABSENT;
  return `${gap.runsMeasured - gap.overBudgetRuns}/${gap.runsMeasured}`;
}

/** `min`, `max` and the interquartile range, skipping whatever is not recorded. */
export function spreadLine(stats: {
  median: number;
  min?: number;
  max?: number;
  p25?: number;
  p75?: number;
  p95?: number;
  stddev?: number;
  metric?: string;
}): string {
  const metric = stats.metric ?? 'score';
  const parts: string[] = [];
  if (stats.p25 !== undefined && stats.p75 !== undefined) {
    parts.push(`p25 ${metricValue(metric, stats.p25)}`);
    parts.push(`p75 ${metricValue(metric, stats.p75)}`);
  }
  if (stats.p95 !== undefined) parts.push(`p95 ${metricValue(metric, stats.p95)}`);
  if (stats.min !== undefined && stats.max !== undefined) {
    parts.push(`range ${metricValue(metric, stats.min)}–${metricValue(metric, stats.max)}`);
  }
  if (stats.stddev !== undefined) parts.push(`stddev ${stats.stddev.toFixed(1)}`);
  return parts.join(' · ');
}

/* ------------------------------- environment -------------------------------- */

const MOBILE_DEVICE = /\(([^()]*(?:\([^()]*\))?[^()]*)\)/;

/**
 * The device a run was emulated as, pulled out of the network user agent.
 *
 * PSI echoes the UA it emulated the page's network stack with, and on mobile
 * that string is the only place the device model appears - `moto g power
 * (2022)` is not in `configSettings` anywhere. Extracted rather than shown raw
 * because the interesting part is the model, and the UA is 200 characters of
 * build numbers wrapped around it.
 */
export function deviceLabel(environment: RunEnvironment): string {
  const ua = environment.networkUserAgent;
  if (ua) {
    const match = MOBILE_DEVICE.exec(ua);
    const inside = match?.[1];
    if (inside) {
      const parts = inside.split(';').map((part) => part.trim()).filter(Boolean);
      // The last segment is the device on Android ("...; moto g power (2022)")
      // but a CPU model on desktop ("Macintosh; Intel Mac OS X 10_15_7"), which
      // is not a device name and is already covered by the form factor.
      const candidate = parts[parts.length - 1];
      const isMobile = (environment.formFactor ?? '').toLowerCase() === 'mobile';
      if (candidate && isMobile && !/^(linux|android|x11|windows)$/i.test(candidate)) {
        return candidate;
      }
    }
  }
  return environment.formFactor ?? ABSENT;
}

/**
 * One line describing the conditions a number was measured under.
 *
 * The CPU index is the load-bearing item: it is the one field that varies
 * between audits for reasons unrelated to the page, so a score that moves with
 * it has not improved. Lighthouse's own `benchmarkIndex` counts higher on
 * slower hardware, hence "slower is higher".
 *
 * Throttling is deliberately absent, because PSI does not echo it. Naming a
 * throttle model we did not read back would be the exact kind of confident
 * guess this report exists to avoid.
 */
export function environmentLine(environment: RunEnvironment | undefined): string {
  if (!environment) return 'not recorded';
  const parts: string[] = [];
  const device = deviceLabel(environment);
  if (device !== ABSENT) parts.push(device);
  if (environment.benchmarkIndex !== undefined) {
    parts.push(`CPU index ${Math.round(environment.benchmarkIndex)} (higher = slower)`);
  }
  if (environment.locale) parts.push(environment.locale);
  if (environment.categories?.length) parts.push(`${environment.categories.join(' + ')} only`);
  if (parts.length > 0) return parts.join(' · ');

  // Nothing but possibly a Lighthouse version. Say so, rather than printing the
  // version as though it were the measurement condition: a report that cannot
  // name its device is not comparable to one that can, and saying only
  // "Lighthouse 13.5.0" would let that difference pass unnoticed.
  return environment.lighthouseVersion && environment.lighthouseVersion !== 'unknown'
    ? `${lighthouseLabel(environment.lighthouseVersion)}, device not recorded`
    : 'not recorded';
}

/** `Lighthouse 13.5.0`, for a header that already says the strategy. */
export function lighthouseLabel(version: string | undefined): string {
  return version && version !== 'unknown' ? `Lighthouse ${version}` : 'Lighthouse (version unknown)';
}

/* ---------------------------------- metrics -------------------------------- */

/** Short labels for the metrics a report is graded on, in reading order. */
export const METRIC_ROWS: Array<{ key: MetricKey; label: string }> = [
  { key: 'fcp', label: 'FCP' },
  { key: 'lcp', label: 'LCP' },
  { key: 'speedIndex', label: 'Speed index' },
  { key: 'tbt', label: 'TBT' },
  { key: 'cls', label: 'CLS' },
];

/** Wrap a URL so a long path does not smear the header across the terminal. */
export function shortenUrl(url: string, width: number): string {
  if (url.length <= width) return url;
  // Keep the tail of the path, which is the part that distinguishes one page
  // from another, and drop the scheme and host.
  const withoutScheme = url.replace(/^https?:\/\//, '');
  if (withoutScheme.length <= width) return withoutScheme;
  return `…${withoutScheme.slice(withoutScheme.length - (width - 1))}`;
}
