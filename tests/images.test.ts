import { describe, expect, it } from 'vitest';
import { imageChecks, imagesOf, snippetAttr } from '../src/images.js';
import { defaultScreen } from '../src/insights.js';
import type { AggregatedReport, Insight, LcpDetail, NetworkRequest } from '../src/types.js';

const MOBILE = defaultScreen('mobile');

function insight(id: string, items: unknown[]): Insight {
  return {
    id,
    title: id,
    description: '',
    score: 0,
    scoreDisplayMode: 'metricSavings',
    group: 'opportunity',
    savingsMs: null,
    savingsBytes: null,
    firstPartyItems: 0,
    thirdPartyItems: 0,
    itemHosts: [],
    items,
  };
}

function imgNode(snippet: string, rect: { top: number; left?: number; width?: number; height?: number }, selector = 'img.x') {
  const left = rect.left ?? 0;
  const width = rect.width ?? 200;
  const height = rect.height ?? 100;
  return {
    type: 'node',
    lhId: `page-${selector}-${rect.top}-${left}`,
    selector,
    snippet,
    boundingRect: { top: rect.top, bottom: rect.top + height, left, right: left + width, width, height },
  };
}

function deliveryRow(url: string, intrinsic: string, displayed: string, totalBytes: number, wastedBytes: number) {
  return {
    url,
    totalBytes,
    wastedBytes,
    subItems: {
      type: 'subitems',
      items: [
        {
          reason: `This image file is larger than it needs to be (${intrinsic}) for its displayed dimensions (${displayed}). Use responsive images to reduce the image download size.`,
          wastedBytes,
        },
      ],
    },
  };
}

const check = (insights: Insight[], extra: { requests?: NetworkRequest[]; lcp?: LcpDetail | null; strategy?: 'mobile' | 'desktop' } = {}) =>
  imageChecks({
    insights,
    requests: extra.requests,
    strategy: extra.strategy ?? 'mobile',
    lcp: extra.lcp ?? null,
  }).findings;

describe('snippetAttr', () => {
  it('reads quoted and bare attributes, and misses absent ones', () => {
    const snippet = '<img loading="lazy" decoding="async" hidden srcset="a.webp 200w">';
    expect(snippetAttr(snippet, 'loading')).toBe('lazy');
    expect(snippetAttr(snippet, 'hidden')).toBe('');
    expect(snippetAttr(snippet, 'sizes')).toBeUndefined();
  });

  it('does not match an attribute name inside another one', () => {
    expect(snippetAttr('<img data-sizes="x">', 'sizes')).toBeUndefined();
  });
});

describe('oversized images, corrected for pixel density', () => {
  it('clears an image that is right for a 1.75x screen, whatever Lighthouse says it wastes', () => {
    // The real hero: 750px for 412 CSS px. Lighthouse calls 33 KB of it waste
    // because it compares against CSS pixels; a 1.75x phone needs 721px.
    const [finding] = check([
      insight('image-delivery-insight', [deliveryRow('https://a.test/hero.webp', '750x1616', '412x943', 50_000, 34_000)]),
    ]);
    expect(finding?.kind).toBe('oversized');
    expect(finding?.real).toBe(false);
    expect(finding?.detail).toMatch(/leave this image alone/);
    expect(finding?.bytes).toBeUndefined();
  });

  it('keeps an image that is still too big after the correction, with an honest saving', () => {
    const [finding] = check([
      insight('image-delivery-insight', [deliveryRow('https://a.test/logo.webp', '714x159', '251x56', 17_842, 15_629)]),
    ]);
    expect(finding?.real).toBe(true);
    expect(finding?.detail).toMatch(/714px wide where 440px is enough/);
    // 714/440 = 1.62x too wide, so ~62% of the bytes go; less than Lighthouse's 88%.
    expect(finding?.bytes).toBeGreaterThan(10_000);
    expect(finding?.bytes).toBeLessThan(15_629);
  });

  it('uses a 1x screen on desktop', () => {
    const [finding] = check(
      [insight('image-delivery-insight', [deliveryRow('https://a.test/hero.webp', '750x1616', '412x943', 50_000, 34_000)])],
      { strategy: 'desktop' },
    );
    expect(finding?.real).toBe(true);
  });

  it('passes a non-size reason through as a format finding', () => {
    const [finding] = check([
      insight('image-delivery-insight', [
        { url: 'https://a.test/p.png', totalBytes: 90_000, subItems: { items: [{ reason: 'Using a modern image format could save 40 KiB', wastedBytes: 40_000 }] } },
      ]),
    ]);
    expect(finding?.kind).toBe('compression');
    expect(finding?.bytes).toBe(40_000);
  });

  it('lists real problems before the ones it cleared', () => {
    const findings = check([
      insight('image-delivery-insight', [
        deliveryRow('https://a.test/hero.webp', '750x1616', '412x943', 50_000, 34_000),
        deliveryRow('https://a.test/logo.webp', '714x159', '251x56', 17_842, 15_629),
      ]),
    ]);
    expect(findings.map((f) => f.url)).toEqual(['https://a.test/logo.webp', 'https://a.test/hero.webp']);
  });
});

describe('srcset without sizes', () => {
  it('flags an img whose width-descriptor srcset has no sizes', () => {
    const node = imgNode('<img loading="lazy" srcset="/a-200.webp 200w, /a-800.webp 800w" src="/a.webp">', { top: 3000 });
    const findings = check([insight('image-delivery-insight', [{ url: 'https://a.test/a.webp', node }])]);
    const finding = findings.find((f) => f.kind === 'srcsetWithoutSizes');
    expect(finding?.url).toBe('https://a.test/a.webp');
    expect(finding?.detail).toMatch(/assumes the image is 100vw/);
    expect(finding?.detail).toMatch(/721px-wide/);
  });

  it('leaves an img with sizes, and a density-descriptor srcset, alone', () => {
    const withSizes = imgNode('<img srcset="/a-200.webp 200w" sizes="200px">', { top: 100 }, 'img.a');
    const density = imgNode('<img srcset="/a.webp 1x, /a@2x.webp 2x">', { top: 100 }, 'img.b');
    const findings = check([insight('image-delivery-insight', [{ node: withSizes }, { node: density }])]);
    expect(findings.filter((f) => f.kind === 'srcsetWithoutSizes')).toEqual([]);
  });
});

describe('loading attribute against the fold', () => {
  it('flags an eager image below the fold', () => {
    const node = imgNode('<img src="/logo.webp">', { top: 3576 });
    const [finding] = check([insight('dom-size-insight', [{ node }])]);
    expect(finding?.kind).toBe('eagerOffscreen');
    expect(finding?.detail).toMatch(/below the 823px fold/);
  });

  it('flags a lazy image inside the first fold', () => {
    const node = imgNode('<img loading="lazy" src="/hero.webp">', { top: 55 });
    const [finding] = check([insight('dom-size-insight', [{ node }])]);
    expect(finding?.kind).toBe('lazyInFirstFold');
  });

  it('does not tell you to lazy-load the LCP element', () => {
    const snippet = '<img src="/hero.webp" fetchpriority="high">';
    const node = imgNode(snippet, { top: 900 }, 'img.hero');
    const lcp: LcpDetail = { isText: false, selector: 'img.hero', snippet, phases: {}, bottleneck: 'resource' };
    expect(check([insight('lcp-breakdown-insight', [node])], { lcp })).toEqual([]);
  });

  it('ignores a hidden element and a lazy one below the fold', () => {
    const hidden = imgNode('<img src="/x.webp">', { top: 0, width: 0, height: 0 }, 'img.hidden');
    const lazy = imgNode('<img loading="lazy" src="/y.webp">', { top: 5000 }, 'img.lazy');
    expect(check([insight('dom-size-insight', [{ node: hidden }, { node: lazy }])])).toEqual([]);
  });

  it('counts an element once even when several insights carry it', () => {
    const node = imgNode('<img src="/logo.webp">', { top: 3576 });
    const findings = check([insight('a', [{ node }]), insight('b', [{ node }])]);
    expect(findings.filter((f) => f.kind === 'eagerOffscreen')).toHaveLength(1);
  });
});

describe('fetchpriority', () => {
  it('flags more than one high-priority image', () => {
    const a = imgNode('<img fetchpriority="high" src="/a.webp">', { top: 0 }, 'img.a');
    const b = imgNode('<img fetchpriority="high" src="/b.webp">', { top: 400 }, 'img.b');
    const findings = check([insight('x', [{ node: a }, { node: b }])]);
    const finding = findings.find((f) => f.kind === 'multipleHighPriority');
    expect(finding?.detail).toMatch(/2 images carry fetchpriority="high" \(img\.a, img\.b\)/);
  });
});

describe('heavy images', () => {
  const request = (url: string, transferSize: number, mimeType?: string): NetworkRequest => ({
    url,
    resourceType: 'Image',
    transferSize,
    party: 'first',
    ...(mimeType ? { mimeType } : {}),
  });

  it('flags an SVG heavy enough to be an embedded bitmap, and a large raster', () => {
    const findings = check([], {
      requests: [
        request('https://static.guvi.in/tools/devops.svg', 576_081),
        request('https://static.guvi.in/tools/aiml.svg', 6_257),
        request('https://a.test/photo.jpg', 200_000, 'image/jpeg'),
        request('https://a.test/small.jpg', 60_000, 'image/jpeg'),
      ],
    });
    expect(findings.map((f) => f.url)).toEqual([
      'https://static.guvi.in/tools/devops.svg',
      'https://a.test/photo.jpg',
    ]);
    expect(findings[0]?.detail).toMatch(/embeds a bitmap/);
  });

  it('falls back to third-party rows when the report has no request table', () => {
    const rows = [
      {
        entity: 'guvi.in',
        transferSize: 580_000,
        subItems: { items: [{ url: 'https://static.guvi.in/tools/devops.svg', transferSize: 576_081, resourceType: 'Image' }] },
      },
    ];
    const findings = check([insight('third-parties-insight', rows)]);
    expect(findings.map((f) => f.url)).toEqual(['https://static.guvi.in/tools/devops.svg']);
  });
});

describe('imagesOf', () => {
  it('returns the stored checks when the report has them', () => {
    const images = { screen: MOBILE, findings: [] };
    expect(imagesOf({ images } as unknown as AggregatedReport)).toBe(images);
  });

  it('works them out for a report stored before image checks existed', () => {
    const report = {
      strategy: 'mobile',
      environment: { lighthouseVersion: '13' },
      lcp: null,
      requests: null,
      insights: [insight('image-delivery-insight', [deliveryRow('https://a.test/logo.webp', '714x159', '251x56', 17_842, 15_629)])],
    } as unknown as AggregatedReport;
    const images = imagesOf(report);
    expect(images.screen.source).toBe('default');
    expect(images.findings[0]?.real).toBe(true);
  });
});
