/**
 * The evidence behind a finding: its rows, and every request the page made.
 *
 * The findings table says *that* something costs time. The fix needs *which*
 * file, element or chain, and before these views existed the only way to get
 * that was to dump the whole report as JSON and read Lighthouse's raw row
 * shapes by hand - a dozen different ones, nested three levels deep.
 */

import { ABSENT, formatBytes, paint, renderTable, shortenUrl, truncate, wrap } from './render.js';
import type { AggregatedInsight, NetworkRequest, ScreenEmulation } from './types.js';

export interface RowViewOptions {
  width: number;
  useColor: boolean;
  /** Needed to say where an element sits against the fold. */
  screen?: ScreenEmulation;
  /** Rows per insight; nested rows count towards their parent only. */
  limit?: number;
}

type Row = Record<string, unknown>;

const INDENT = '  ';
const MAX_DEPTH = 4;

/** Keys that are structure, or that the row's title already shows. */
const SKIP_KEYS = new Set([
  'type',
  'url',
  'subItems',
  'node',
  'entity',
  'headings',
  'lhId',
  'path',
  'urlProvider',
  // `lcp-breakdown-insight` repeats its label as an identifier.
  'subpart',
]);

function words(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}min`;
  return `${Math.round(ms)}ms`;
}

function formatNumber(key: string, value: number): string {
  if (/bytes$|size$/i.test(key)) return formatBytes(value);
  if (/percent/i.test(key)) return `${Math.round(value)}%`;
  if (/ms$|time$|duration|delay/i.test(key)) return formatMs(value);
  return String(Math.round(value * 100) / 100);
}

/** A Lighthouse typed value (`{type: 'ms', value}` and friends) as text. */
function typedValue(key: string, value: Row): string | undefined {
  switch (value.type) {
    case 'numeric':
    case 'ms':
    case 'bytes': {
      if (typeof value.value !== 'number') return undefined;
      const unitKey = value.type === 'numeric' ? key : value.type;
      return formatNumber(unitKey, value.value);
    }
    case 'text':
    case 'code':
    case 'url':
      return typeof value.value === 'string' ? value.value : undefined;
    case 'link':
      return typeof value.text === 'string' ? value.text : undefined;
    case 'source-location': {
      if (typeof value.url !== 'string') return undefined;
      const line = typeof value.line === 'number' ? `:${value.line + 1}` : '';
      const column = typeof value.column === 'number' ? `:${value.column + 1}` : '';
      return `${value.url}${line}${column}`;
    }
    case 'node':
      return typeof value.selector === 'string' ? value.selector : undefined;
    default:
      return undefined;
  }
}

function scalar(key: string, value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? formatNumber(key, value) : undefined;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return typedValue(key, value as Row);
  return undefined;
}

function entityName(entity: unknown): string | undefined {
  if (typeof entity === 'string') return entity;
  if (entity && typeof entity === 'object' && typeof (entity as Row).text === 'string') {
    return (entity as Row).text as string;
  }
  return undefined;
}

/** Where an element sits, in the terms the lazy-loading decision is made in. */
export function placement(node: Row, screen: ScreenEmulation | undefined): string | undefined {
  const rect = node.boundingRect as Record<string, number> | undefined;
  if (!rect || typeof rect.top !== 'number' || typeof rect.width !== 'number') return undefined;
  const size = `${Math.round(rect.width)}×${Math.round(rect.height ?? 0)}`;
  if (rect.width <= 0 || (rect.height ?? 0) <= 0) return `${size}, not rendered (hidden or collapsed)`;
  const at = `top ${Math.round(rect.top)}px, ${size}`;
  if (!screen) return at;
  if (rect.top >= screen.height) {
    return `${at}, ${Math.round(rect.top - screen.height)}px below the ${screen.height}px fold`;
  }
  if ((rect.left ?? 0) >= screen.width || (rect.right ?? 1) <= 0) return `${at}, off-screen sideways`;
  return `${at}, in the first fold`;
}

/*
 * Every renderer below returns lines without their indent, sized to `width`,
 * and the caller prefixes plain spaces. Prefixing is then safe on a line that
 * starts with a colour code, and nesting is just a narrower width.
 */

const indent = (lines: string[], first: string, rest = ' '.repeat(first.length)): string[] =>
  lines.map((line, index) => `${index === 0 ? first : rest}${line}`);

function nodeLines(node: Row, width: number, options: RowViewOptions): string[] {
  const { useColor, screen } = options;
  const lines: string[] = [];
  const selector = typeof node.selector === 'string' ? node.selector : undefined;
  if (selector) lines.push(`element ${truncate(selector, width - 8)}`);
  const where = placement(node, screen);
  if (where) lines.push(paint('dim', where, useColor));
  if (typeof node.snippet === 'string') lines.push(paint('dim', truncate(node.snippet, width), useColor));
  return lines;
}

interface ChainNode {
  url?: string;
  navStartToEndTime?: number;
  transferSize?: number;
  isLongest?: boolean;
  children?: Record<string, ChainNode>;
}

function treeLines(tree: Row, width: number, options: RowViewOptions): string[] {
  const { useColor } = options;
  const lines: string[] = [];
  const longest = (tree.longestChain as { duration?: number } | undefined)?.duration;
  if (typeof longest === 'number') {
    lines.push(paint('dim', `longest chain ${Math.round(longest)}ms (observed, not simulated)`, useColor));
  }
  const walk = (chains: Record<string, ChainNode> | undefined, depth: number): void => {
    for (const node of Object.values(chains ?? {})) {
      const facts = [
        typeof node.navStartToEndTime === 'number' ? `ends ${Math.round(node.navStartToEndTime)}ms` : '',
        typeof node.transferSize === 'number' ? formatBytes(node.transferSize) : '',
      ].filter(Boolean);
      const branch = `${'  '.repeat(depth)}${depth > 0 ? '└ ' : ''}`;
      const tail = `  ${facts.join(' · ')}${node.isLongest ? '  ← longest' : ''}`;
      const url = shortenUrl(node.url ?? '?', Math.max(20, width - branch.length - tail.length));
      lines.push(`${branch}${url}${paint(node.isLongest ? 'yellow' : 'dim', tail, useColor)}`);
      if (depth < 12) walk(node.children, depth + 1);
    }
  };
  walk(tree.chains as Record<string, ChainNode> | undefined, 0);
  return lines;
}

/** Keys that can name a row when it has no URL, in order of preference. */
const TITLE_KEYS = ['statistic', 'label', 'reason', 'signal', 'source'] as const;

function rowLines(row: Row, width: number, depth: number, options: RowViewOptions): string[] {
  const { useColor } = options;
  if (depth > MAX_DEPTH) return [];

  // Wrappers: Lighthouse 13 nests tables, trees and checklists inside the items.
  if (row.type === 'list-section' && row.value && typeof row.value === 'object') {
    const title = typeof row.title === 'string' ? [paint('bold', row.title, useColor)] : [];
    return [...title, ...rowLines(row.value as Row, width, depth, options)];
  }
  if (row.type === 'network-tree') return treeLines(row, width, options);
  if (row.type === 'table' || row.type === 'opportunity' || row.type === 'list') {
    return ((row.items as Row[] | undefined) ?? []).flatMap((item) => rowLines(item, width, depth, options));
  }
  if (row.type === 'checklist' && row.items && typeof row.items === 'object') {
    return Object.values(row.items as Record<string, Row>).map((check) => {
      const ok = check.value === true;
      return `${paint(ok ? 'green' : 'red', ok ? 'pass' : 'FAIL', useColor)} ${String(check.label ?? '')}`;
    });
  }
  if (row.type === 'node') return nodeLines(row, width, options);

  const url = typeof row.url === 'string' ? row.url : undefined;
  const entity = entityName(row.entity);
  const titleKey = url || entity ? undefined : TITLE_KEYS.find((key) => scalar(key, row[key]) !== undefined);
  const title = url ? shortenUrl(url, width) : (entity ?? (titleKey ? scalar(titleKey, row[titleKey]) : undefined));

  // Sorted by key, so the same kind of row reads the same way every time
  // rather than in whatever order the JSON happened to carry it.
  const facts: string[] = [];
  for (const [key, value] of Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) {
    if (SKIP_KEYS.has(key) || key === titleKey) continue;
    const text = scalar(key, value);
    if (text === undefined || text === '') continue;
    facts.push(key === 'reason' || key === 'label' ? text : `${words(key)} ${text}`);
  }
  if (url && entity) facts.push(entity);

  const lines: string[] = [];
  if (title) {
    // A URL is shortened to one line; prose (a reason, a label) is wrapped, since
    // its end is usually the part that says what to do.
    lines.push(...(url ? [title] : wrap(title, width, '')));
    if (facts.length > 0) lines.push(...indent(wrapFacts(facts, width - 2, useColor), '  '));
  } else if (facts.length > 0) {
    lines.push(...wrapFacts(facts, width, useColor));
  }

  const node = row.node as Row | undefined;
  if (node && typeof node === 'object') lines.push(...indent(nodeLines(node, width - 2, options), '  '));

  const limit = options.limit ?? 25;
  const subItems = (row.subItems as { items?: Row[] } | undefined)?.items ?? [];
  for (const sub of subItems.slice(0, limit)) {
    lines.push(...indent(rowLines(sub, width - 4, depth + 1, options), '  - ', '    '));
  }
  if (subItems.length > limit) {
    lines.push(paint('dim', `  … ${subItems.length - limit} more`, useColor));
  }
  return lines;
}

function wrapFacts(facts: string[], width: number, useColor: boolean): string[] {
  const lines: string[] = [];
  let current = '';
  for (const fact of facts) {
    const piece = truncate(fact, width);
    if (current && current.length + 3 + piece.length > width) {
      lines.push(current);
      current = piece;
    } else {
      current = current ? `${current} · ${piece}` : piece;
    }
  }
  if (current) lines.push(current);
  return lines.map((line) => paint('dim', line, useColor));
}

/** Top-level rows, with the tables Lighthouse 13 wraps them in opened up so each row gets a number. */
function topLevelRows(items: Row[]): Row[] {
  return items.flatMap((row) =>
    row.type === 'table' && Array.isArray(row.items) ? (row.items as Row[]) : [row],
  );
}

/** Every row of one insight, in Lighthouse's order, as readable text. */
export function renderInsightRows(insight: AggregatedInsight, options: RowViewOptions): string[] {
  const { useColor } = options;
  const limit = options.limit ?? 25;
  const stored = (insight.items ?? []) as Row[];
  const items = topLevelRows(stored);
  const missing = Math.max(0, (insight.itemsTotal ?? stored.length) - stored.length);
  const saving =
    (insight.savingsMs ?? 0) > 0
      ? `${Math.round(insight.savingsMs!)}ms`
      : (insight.savingsBytes ?? 0) > 0
        ? formatBytes(insight.savingsBytes)
        : ABSENT;
  const lines = [
    `${paint('bold', insight.id, useColor)}  ${paint('dim', insight.title, useColor)}`,
    paint(
      'dim',
      `${INDENT}saving ${saving} · score ${insight.score ?? ABSENT} · seen ${insight.appearedInRuns}/${insight.runsSucceeded} runs · ` +
        `${insight.firstPartyItems} first-party / ${insight.thirdPartyItems} third-party rows`,
      useColor,
    ),
  ];
  if (items.length === 0) {
    lines.push(paint('dim', `${INDENT}no rows - the finding is the summary above`, useColor));
    return lines;
  }
  const bodyWidth = options.width - INDENT.length - 4;
  items.slice(0, limit).forEach((row, index) => {
    const number = `${String(index + 1).padStart(2)}. `;
    lines.push(...indent(rowLines(row, bodyWidth, 0, options), `${INDENT}${number}`));
  });
  if (items.length > limit) {
    lines.push(paint('dim', `${INDENT}… ${items.length - limit} more row(s) (raise --limit)`, useColor));
  }
  if (missing > 0) {
    lines.push(paint('dim', `${INDENT}… ${missing} more row(s) Lighthouse reported but the report did not keep`, useColor));
  }
  return lines;
}

/* --------------------------------- requests --------------------------------- */

export interface RequestViewOptions {
  width: number;
  useColor: boolean;
  party?: 'any' | 'first' | 'third';
  sortBy?: 'start' | 'size';
  limit?: number;
}

function sizeOf(request: NetworkRequest): number {
  return request.transferSize ?? 0;
}

/** Transfer totals by resource type, largest first. */
export function requestSummary(requests: NetworkRequest[]): {
  count: number;
  bytes: number;
  byParty: Record<'first' | 'third', { count: number; bytes: number }>;
  byType: Array<{ type: string; count: number; bytes: number }>;
} {
  const byParty = { first: { count: 0, bytes: 0 }, third: { count: 0, bytes: 0 } };
  const byType = new Map<string, { count: number; bytes: number }>();
  let bytes = 0;
  for (const request of requests) {
    const size = sizeOf(request);
    bytes += size;
    byParty[request.party].count += 1;
    byParty[request.party].bytes += size;
    const type = request.resourceType ?? 'Other';
    const entry = byType.get(type) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += size;
    byType.set(type, entry);
  }
  return {
    count: requests.length,
    bytes,
    byParty,
    byType: [...byType.entries()]
      .map(([type, entry]) => ({ type, ...entry }))
      .sort((a, b) => b.bytes - a.bytes),
  };
}

const REQUEST_COLUMNS = [
  { key: 'start', label: 'START', align: 'right' as const, min: 6 },
  { key: 'end', label: 'END', align: 'right' as const, min: 6 },
  { key: 'type', label: 'TYPE', min: 10, max: 10 },
  { key: 'priority', label: 'PRIORITY', min: 8, max: 8 },
  { key: 'size', label: 'SIZE', align: 'right' as const, min: 6 },
  { key: 'party', label: 'PARTY', min: 5 },
  { key: 'url', label: 'URL', min: 20, grow: true },
];

/** The request table of the median run, with totals that say where the bytes go. */
export function renderRequests(requests: NetworkRequest[] | null | undefined, options: RequestViewOptions): string[] {
  const { width, useColor } = options;
  if (!requests || requests.length === 0) {
    return [
      paint(
        'dim',
        `${INDENT}no request table in this report - it was stored before requests were kept. Run a new report.`,
        useColor,
      ),
    ];
  }

  const summary = requestSummary(requests);
  const lines = [
    `${paint('bold', 'REQUESTS', useColor)}  ` +
      paint(
        'dim',
        `${summary.count} requests · ${formatBytes(summary.bytes)} transferred · ` +
          `first party ${summary.byParty.first.count} (${formatBytes(summary.byParty.first.bytes)}) · ` +
          `third party ${summary.byParty.third.count} (${formatBytes(summary.byParty.third.bytes)})`,
        useColor,
      ),
    paint(
      'dim',
      `${INDENT}${summary.byType.map((entry) => `${entry.type} ${entry.count} (${formatBytes(entry.bytes)})`).join(' · ')}`,
      useColor,
    ),
  ];

  const party = options.party ?? 'any';
  let shown = requests.filter((request) => party === 'any' || request.party === party);
  if (options.sortBy === 'size') shown = [...shown].sort((a, b) => sizeOf(b) - sizeOf(a));
  const matched = shown.length;
  if (options.limit !== undefined) shown = shown.slice(0, options.limit);

  const ms = (value: number | undefined): string => (value === undefined ? ABSENT : `${Math.round(value)}`);
  lines.push('');
  lines.push(
    ...renderTable(
      REQUEST_COLUMNS,
      shown.map((request) => [
        ms(request.startMs),
        ms(request.endMs),
        request.resourceType ?? ABSENT,
        request.priority ?? ABSENT,
        formatBytes(request.transferSize),
        request.party === 'first' ? 'first' : paint('yellow', 'third', useColor),
        (request.isLinkPreload ? 'preload ' : '') + request.url.replace(/^https?:\/\//, ''),
      ]),
      { width, gap: 2, indent: INDENT, styleLabel: (text) => paint('dim', text, useColor) },
    ),
  );
  lines.push('');
  lines.push(
    paint(
      'dim',
      `${INDENT}START and END are ms after the first request, observed on PSI's own connection. Use them for ` +
        'order, not for comparison with FCP/LCP, which are simulated on a throttled link.',
      useColor,
    ),
  );
  if (matched > shown.length) {
    lines.push(paint('dim', `${INDENT}${matched - shown.length} more hidden by --limit ${options.limit}.`, useColor));
  }
  return lines;
}
