/**
 * Image problems an agent would otherwise have to work out by hand.
 *
 * Lighthouse reports the raw facts - an element's snippet and position, an
 * image's intrinsic and displayed size, every request's size - but not the
 * conclusions that decide the fix. Three of those conclusions are routinely
 * wrong when drawn from the raw figures:
 *
 *   - `image-delivery-insight` measures waste against *CSS* pixels, so an image
 *     that is exactly right for a 1.75x phone reads as 60-70% wasted.
 *   - `srcset` without `sizes` makes the browser assume the image is 100vw wide,
 *     which no insight names as the cause of the oversized download.
 *   - Lighthouse 13 has no offscreen-image audit, so an eager image far below the
 *     fold is only visible from its position and its `loading` attribute.
 */

import { defaultScreen, elementTagOf } from './insights.js';
import type {
  AggregatedReport,
  ImageChecks,
  ImageFinding,
  ImageFindingKind,
  Insight,
  LcpDetail,
  NetworkRequest,
  ScreenEmulation,
  Strategy,
} from './types.js';

/** Intrinsic width above this multiple of the device-pixel width is real waste. */
export const OVERSIZE_TOLERANCE = 1.3;
export const HEAVY_SVG_BYTES = 50 * 1024;
export const HEAVY_RASTER_BYTES = 150 * 1024;

const LOADABLE_TAGS = new Set(['IMG', 'IFRAME', 'VIDEO']);

const KIND_ORDER: ImageFindingKind[] = [
  'oversized',
  'heavyImage',
  'srcsetWithoutSizes',
  'eagerOffscreen',
  'lazyInFirstFold',
  'multipleHighPriority',
  'compression',
];

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

interface FoundNode {
  node: Record<string, unknown>;
  tag: string | undefined;
  url?: string;
}

export interface ImageCheckInput {
  insights: Insight[];
  requests?: NetworkRequest[];
  screen?: ScreenEmulation;
  strategy: Strategy;
  lcp: LcpDetail | null;
}

/** An attribute's value from a Lighthouse snippet; `''` for a bare attribute. */
export function snippetAttr(snippet: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}(?:="([^"]*)")?(?=[\\s>/])`, 'i').exec(snippet);
  return match ? (match[1] ?? '') : undefined;
}

/** Lighthouse clips long snippets; an attribute missing from a clipped one proves nothing. */
function isCompleteSnippet(snippet: string): boolean {
  return snippet.trimEnd().endsWith('>');
}

function rectOf(node: Record<string, unknown>): Rect | undefined {
  const raw = node.boundingRect as Partial<Rect> | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const { top, bottom, left, right, width, height } = raw;
  if ([top, bottom, left, right, width, height].some((v) => typeof v !== 'number')) return undefined;
  return raw as Rect;
}

/** Every element node carried anywhere in the insights, keyed so each element counts once. */
function collectNodes(insights: Insight[]): FoundNode[] {
  const found = new Map<string, FoundNode>();
  const visit = (value: unknown, url: string | undefined, depth: number): void => {
    if (depth > 6 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, url, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const ownUrl = typeof record.url === 'string' ? record.url : url;
    if (record.type === 'node') {
      const key = String(record.lhId ?? record.path ?? record.selector ?? '');
      if (key && !found.has(key)) {
        found.set(key, { node: record, tag: elementTagOf(record), url: ownUrl });
      } else if (key && ownUrl && !found.get(key)?.url) {
        found.get(key)!.url = ownUrl;
      }
      return;
    }
    for (const entry of Object.values(record)) visit(entry, ownUrl, depth + 1);
  };
  for (const insight of insights) visit(insight.items, undefined, 0);
  return [...found.values()];
}

const kb = (bytes: number): string => `${Math.round(bytes / 1024)} KB`;

function selectorOf(node: Record<string, unknown>): string | undefined {
  return typeof node.selector === 'string' ? node.selector : undefined;
}

/** Findings from `image-delivery-insight`, corrected for device pixel ratio. */
function deliveryFindings(insights: Insight[], screen: ScreenEmulation): ImageFinding[] {
  const delivery = insights.find((insight) => insight.id === 'image-delivery-insight');
  const findings: ImageFinding[] = [];
  for (const row of (delivery?.items ?? []) as Array<Record<string, unknown>>) {
    const url = typeof row.url === 'string' ? row.url : undefined;
    const node = (row.node ?? undefined) as Record<string, unknown> | undefined;
    const selector = node ? selectorOf(node) : undefined;
    const totalBytes = typeof row.totalBytes === 'number' ? row.totalBytes : undefined;
    const subRows = ((row.subItems as { items?: unknown[] } | undefined)?.items ?? []) as Array<
      Record<string, unknown>
    >;
    for (const sub of subRows) {
      const reason = typeof sub.reason === 'string' ? sub.reason : '';
      const wasted = typeof sub.wastedBytes === 'number' ? sub.wastedBytes : undefined;
      const dims = /\((\d+)x(\d+)\)[^(]*\((\d+)x(\d+)\)/.exec(reason);
      if (!dims) {
        if (reason) {
          findings.push({ kind: 'compression', url, selector, detail: reason, bytes: wasted });
        }
        continue;
      }
      const intrinsic = Number(dims[1]);
      const displayed = Number(dims[3]);
      const needed = Math.ceil(displayed * screen.deviceScaleFactor);
      const ratio = needed > 0 ? intrinsic / needed : 0;
      const real = ratio > OVERSIZE_TOLERANCE;
      const finding: ImageFinding = {
        kind: 'oversized',
        url,
        selector,
        real,
        detail: real
          ? `${intrinsic}px wide where ${needed}px is enough (${displayed} CSS px × ${screen.deviceScaleFactor}). ` +
            'Serve a smaller candidate, or fix `sizes` if the image has a srcset.'
          : `${intrinsic}px wide for ${displayed} CSS px is right for a ${screen.deviceScaleFactor}× screen ` +
            `(${needed}px needed). Lighthouse's ${wasted === undefined ? '' : `${kb(wasted)} `}waste figure ` +
            'ignores pixel density - leave this image alone.',
      };
      if (real && totalBytes !== undefined) {
        finding.bytes = Math.round(totalBytes * (1 - 1 / (ratio * ratio)));
      }
      findings.push(finding);
    }
  }
  return findings;
}

function srcsetFindings(nodes: FoundNode[], screen: ScreenEmulation): ImageFinding[] {
  const findings: ImageFinding[] = [];
  const seen = new Set<string>();
  for (const { node, tag, url } of nodes) {
    if (tag !== 'IMG') continue;
    const snippet = typeof node.snippet === 'string' ? node.snippet : '';
    if (!isCompleteSnippet(snippet)) continue;
    const srcset = snippetAttr(snippet, 'srcset');
    if (srcset === undefined || !/\d+w\b/.test(srcset)) continue;
    if (snippetAttr(snippet, 'sizes') !== undefined) continue;
    const key = url ?? String(node.lhId ?? node.selector);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      kind: 'srcsetWithoutSizes',
      url,
      selector: selectorOf(node),
      detail:
        '`srcset` lists widths but there is no `sizes`, so the browser assumes the image is 100vw and ' +
        `downloads the candidate for a ${Math.round(screen.width * screen.deviceScaleFactor)}px-wide image. ` +
        'Add `sizes` for the width it actually renders at.',
    });
  }
  return findings;
}

function positionFindings(nodes: FoundNode[], screen: ScreenEmulation, lcp: LcpDetail | null): ImageFinding[] {
  const findings: ImageFinding[] = [];
  for (const { node, tag, url } of nodes) {
    if (!tag || !LOADABLE_TAGS.has(tag)) continue;
    const rect = rectOf(node);
    const snippet = typeof node.snippet === 'string' ? node.snippet : '';
    if (!rect || rect.width <= 0 || rect.height <= 0 || !isCompleteSnippet(snippet)) continue;

    const loading = (snippetAttr(snippet, 'loading') ?? '').toLowerCase();
    const below = rect.top >= screen.height;
    const sideways = rect.left >= screen.width || rect.right <= 0;
    const selector = selectorOf(node);
    const isLcp = lcp?.selector !== undefined && lcp.selector === selector && lcp.snippet === snippet;

    if ((below || sideways) && loading !== 'lazy' && !isLcp) {
      findings.push({
        kind: 'eagerOffscreen',
        url,
        selector,
        detail:
          `<${tag.toLowerCase()}> at ${below ? `top ${Math.round(rect.top)}px, below the ${screen.height}px fold` : `left ${Math.round(rect.left)}px, off-screen sideways`} ` +
          `loads eagerly. Add loading="lazy".`,
      });
    } else if (!below && !sideways && loading === 'lazy') {
      findings.push({
        kind: 'lazyInFirstFold',
        url,
        selector,
        detail:
          `<${tag.toLowerCase()}> is in the first fold (top ${Math.round(rect.top)}px) but lazy, so it waits ` +
          'for layout before loading. Make it eager.',
      });
    }
  }
  return findings;
}

function priorityFindings(nodes: FoundNode[]): ImageFinding[] {
  const high = nodes.filter(({ node, tag }) => {
    const snippet = typeof node.snippet === 'string' ? node.snippet : '';
    return tag === 'IMG' && (snippetAttr(snippet, 'fetchpriority') ?? '').toLowerCase() === 'high';
  });
  if (high.length < 2) return [];
  return [
    {
      kind: 'multipleHighPriority',
      detail:
        `${high.length} images carry fetchpriority="high" (${high.map(({ node }) => selectorOf(node) ?? '?').join(', ')}). ` +
        'Only the LCP image should; the others compete with it.',
    },
  ];
}

function isSvg(url: string, mimeType?: string): boolean {
  return mimeType === 'image/svg+xml' || /\.svg(?:[?#]|$)/i.test(url);
}

function heavyFindings(insights: Insight[], requests: NetworkRequest[] | undefined): ImageFinding[] {
  const images = new Map<string, { bytes: number; mimeType?: string }>();
  if (requests && requests.length > 0) {
    for (const request of requests) {
      const isImage = request.resourceType === 'Image' || (request.mimeType ?? '').startsWith('image/');
      const bytes = request.transferSize ?? request.resourceSize;
      if (isImage && bytes !== undefined) images.set(request.url, { bytes, mimeType: request.mimeType });
    }
  } else {
    // No request table (older stored runs): fall back to the rows that list image sizes.
    const visit = (value: unknown, depth: number): void => {
      if (depth > 4 || !value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const entry of value) visit(entry, depth + 1);
        return;
      }
      const record = value as Record<string, unknown>;
      const bytes = typeof record.transferSize === 'number' ? record.transferSize : record.totalBytes;
      if (record.resourceType === 'Image' && typeof record.url === 'string' && typeof bytes === 'number') {
        images.set(record.url, { bytes });
      }
      for (const entry of Object.values(record)) visit(entry, depth + 1);
    };
    for (const insight of insights) {
      if (insight.id === 'total-byte-weight' || insight.id === 'third-parties-insight') visit(insight.items, 0);
    }
  }

  const findings: ImageFinding[] = [];
  for (const [url, { bytes, mimeType }] of images) {
    if (isSvg(url, mimeType) && bytes > HEAVY_SVG_BYTES) {
      findings.push({
        kind: 'heavyImage',
        url,
        bytes,
        detail:
          `SVG of ${kb(bytes)} - a vector icon is a few KB, so this almost certainly embeds a bitmap. ` +
          'Export it as WebP/AVIF at its rendered size (or a clean vector), and lazy-load it below the fold.',
      });
    } else if (!isSvg(url, mimeType) && bytes > HEAVY_RASTER_BYTES) {
      findings.push({
        kind: 'heavyImage',
        url,
        bytes,
        detail: `${kb(bytes)} image. Check it is sized for its slot and compressed, and lazy-load it below the fold.`,
      });
    }
  }
  return findings;
}

export function imageChecks(input: ImageCheckInput): ImageChecks {
  const screen = input.screen ?? defaultScreen(input.strategy);
  const nodes = collectNodes(input.insights);
  const findings = [
    ...deliveryFindings(input.insights, screen),
    ...heavyFindings(input.insights, input.requests),
    ...srcsetFindings(nodes, screen),
    ...positionFindings(nodes, screen, input.lcp),
    ...priorityFindings(nodes),
  ];
  // Real problems first, then by size; an oversize that the pixel-density
  // correction cancels goes last, since the right action is to leave it.
  const rank = (finding: ImageFinding): number =>
    finding.kind === 'oversized' && !finding.real ? KIND_ORDER.length : KIND_ORDER.indexOf(finding.kind);
  findings.sort((a, b) => rank(a) - rank(b) || (b.bytes ?? 0) - (a.bytes ?? 0));
  return { screen, findings };
}

/** A report's image checks, worked out from its rows when it was stored without them. */
export function imagesOf(report: AggregatedReport): ImageChecks {
  return (
    report.images ??
    imageChecks({
      insights: report.insights,
      requests: report.requests ?? undefined,
      screen: report.environment.screen,
      strategy: report.strategy,
      lcp: report.lcp,
    })
  );
}
