import { describe, expect, it } from 'vitest';
import { UrlValidationError, backoffDelay, runPsiCall, validateTargetUrl } from '../src/psiClient.js';
import { PSI_ERROR_BODY, fakeResponse, fixtureRaw } from './helpers.js';

describe('validateTargetUrl', () => {
  it('accepts public http and https urls', () => {
    expect(validateTargetUrl('https://example.com').url).toBe('https://example.com/');
    expect(validateTargetUrl('http://example.com/a?b=c').url).toBe('http://example.com/a?b=c');
    expect(validateTargetUrl('  https://guvi.co/courses  ').url).toBe('https://guvi.co/courses');
  });

  it('rejects an empty url', () => {
    expect(() => validateTargetUrl('')).toThrow(UrlValidationError);
  });

  it('rejects file: urls', () => {
    expect(() => validateTargetUrl('file:///C:/app/index.html')).toThrow(/file: URLs are not supported/);
  });

  it('rejects other protocols', () => {
    expect(() => validateTargetUrl('ftp://example.com')).toThrow(/only http and https/);
    expect(() => validateTargetUrl('javascript:alert(1)')).toThrow(/only http and https/);
  });

  it('rejects a non-url', () => {
    expect(() => validateTargetUrl('not a url')).toThrow(/not a valid URL/);
  });

  it('warns but does not throw for localhost', () => {
    const result = validateTargetUrl('http://localhost:5173/');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/cannot reach/);
  });

  it.each([
    ['http://127.0.0.1:3000', 'loopback'],
    ['http://10.0.0.5', 'private 10/8'],
    ['http://192.168.1.10', 'private 192.168/16'],
    ['http://172.16.4.1', 'private 172.16/12'],
    ['http://169.254.1.1', 'link local'],
    ['http://[::1]:8080', 'ipv6 loopback'],
    ['http://myapp.local', '.local'],
    ['http://api.internal', '.internal'],
    ['http://staging.test', '.test'],
  ])('warns for %s (%s)', (url) => {
    expect(validateTargetUrl(url).warnings).toHaveLength(1);
  });

  it('does not warn for a public host that merely looks numeric', () => {
    expect(validateTargetUrl('https://192.168.1.1.nip.io').warnings).toEqual([]);
    expect(validateTargetUrl('https://localhost.co').warnings).toEqual([]);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and stays inside the jitter band', () => {
    const low = backoffDelay(1, 1000, () => 0);
    const high = backoffDelay(1, 1000, () => 1);
    expect(low).toBe(500);
    expect(high).toBe(1000);

    expect(backoffDelay(2, 1000, () => 0)).toBe(1000);
    expect(backoffDelay(3, 1000, () => 0)).toBe(2000);
    expect(backoffDelay(4, 1000, () => 0)).toBe(4000);
    expect(backoffDelay(10, 1000, () => 0)).toBe(15000);
  });

  it('honours Retry-After when present', () => {
    expect(backoffDelay(1, 1000, () => 0, 7500)).toBe(7500);
  });

  it('caps a huge Retry-After', () => {
    expect(backoffDelay(1, 1000, () => 0, 999_999)).toBe(60_000);
  });
});

describe('runPsiCall', () => {
  const noSleep = async () => {};
  const fixedRandom = () => 0.5;

  it('returns the raw body on success', async () => {
    const fetchImpl = (async () => fakeResponse(fixtureRaw)) as unknown as typeof fetch;
    const result = await runPsiCall({ url: 'https://example.com', fetchImpl, sleepImpl: noSleep });
    expect(result.raw).toBe(fixtureRaw);
    expect(result.attempts).toBe(1);
    expect(result.strategy).toBe('mobile');
    expect(result.categories).toEqual(['performance']);
  });

  it('sends url, strategy, categories and key', async () => {
    let requested = '';
    const fetchImpl = (async (input: string) => {
      requested = input;
      return fakeResponse(fixtureRaw);
    }) as unknown as typeof fetch;

    await runPsiCall({
      url: 'https://example.com/',
      strategy: 'desktop',
      categories: ['performance', 'accessibility'],
      apiKey: 'KEY123',
      fetchImpl,
      sleepImpl: noSleep,
      // Pin the nonce so the assertion below stays deterministic.
      cacheBustIdImpl: () => 'testnonce',
    });

    const parsed = new URL(requested);
    expect(parsed.origin + parsed.pathname).toBe('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    expect(parsed.searchParams.get('url')).toBe('https://example.com/?psi_nonce=testnonce');
    expect(parsed.searchParams.get('strategy')).toBe('desktop');
    expect(parsed.searchParams.get('category')).toBe('performance,accessibility');
    expect(parsed.searchParams.get('key')).toBe('KEY123');
  });

  it('omits the key when none is configured', async () => {
    let requested = '';
    const fetchImpl = (async (input: string) => {
      requested = input;
      return fakeResponse(fixtureRaw);
    }) as unknown as typeof fetch;

    await runPsiCall({ url: 'https://example.com', fetchImpl, sleepImpl: noSleep });
    expect(new URL(requested).searchParams.has('key')).toBe(false);
  });

  it('retries a 429 and succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 3 ? fakeResponse(PSI_ERROR_BODY, { status: 429 }) : fakeResponse(fixtureRaw);
    }) as unknown as typeof fetch;

    const delays: number[] = [];
    const result = await runPsiCall({
      url: 'https://example.com',
      fetchImpl,
      sleepImpl: async (ms) => {
        delays.push(ms);
      },
      randomImpl: fixedRandom,
    });

    expect(calls).toBe(3);
    expect(result.attempts).toBe(3);
    expect(delays).toEqual([750, 1500]);
  });

  it('retries 5xx responses', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 2
        ? fakeResponse({ error: { code: 503, message: 'backend error' } }, { status: 503 })
        : fakeResponse(fixtureRaw);
    }) as unknown as typeof fetch;

    const result = await runPsiCall({ url: 'https://example.com', fetchImpl, sleepImpl: noSleep });
    expect(calls).toBe(2);
    expect(result.attempts).toBe(2);
  });

  it('retries network errors', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('fetch failed');
      return fakeResponse(fixtureRaw);
    }) as unknown as typeof fetch;

    const result = await runPsiCall({ url: 'https://example.com', fetchImpl, sleepImpl: noSleep });
    expect(calls).toBe(3);
    expect(result.raw).toBe(fixtureRaw);
  });

  it('gives up after 4 attempts and surfaces the PSI message', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return fakeResponse(PSI_ERROR_BODY, { status: 429 });
    }) as unknown as typeof fetch;

    await expect(
      runPsiCall({ url: 'https://example.com', fetchImpl, sleepImpl: noSleep, randomImpl: fixedRandom }),
    ).rejects.toMatchObject({
      code: '429',
      message: "Quota exceeded for quota metric 'Queries'",
      status: 429,
    });
    expect(calls).toBe(4);
  });

  it('does not retry a 4xx that is not a rate limit', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return fakeResponse({ error: { code: 400, message: 'Invalid URL' } }, { status: 400 });
    }) as unknown as typeof fetch;

    await expect(runPsiCall({ url: 'https://example.com', fetchImpl, sleepImpl: noSleep })).rejects.toMatchObject(
      { code: '400', message: 'Invalid URL' },
    );
    expect(calls).toBe(1);
  });

  it('reports progress on each retry', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 2 ? fakeResponse(PSI_ERROR_BODY, { status: 429 }) : fakeResponse(fixtureRaw);
    }) as unknown as typeof fetch;

    const seen: string[] = [];
    await runPsiCall({
      url: 'https://example.com',
      fetchImpl,
      sleepImpl: noSleep,
      onRetry: ({ reason }) => seen.push(reason),
    });
    expect(seen.some((reason) => reason.includes('429'))).toBe(true);
  });

  it('warns when there is no api key but still runs', async () => {
    const reasons: string[] = [];
    const fetchImpl = (async () => fakeResponse(fixtureRaw)) as unknown as typeof fetch;
    await runPsiCall({
      url: 'https://example.com',
      fetchImpl,
      sleepImpl: noSleep,
      onRetry: ({ reason }) => reasons.push(reason),
    });
    expect(reasons.join(' ')).toMatch(/PSI_API_KEY is not set/);
  });

  it('surfaces a timeout as a TIMEOUT error after exhausting attempts', async () => {
    const fetchImpl = ((_input: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    await expect(
      runPsiCall({
        url: 'https://example.com',
        fetchImpl,
        sleepImpl: noSleep,
        timeoutMs: 5,
        maxAttempts: 2,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('stops immediately when the caller aborts', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return fakeResponse(PSI_ERROR_BODY, { status: 429 });
    }) as unknown as typeof fetch;

    await runPsiCall({
      url: 'https://example.com',
      fetchImpl,
      sleepImpl: async () => {
        controller.abort();
      },
      signal: controller.signal,
    }).catch(() => undefined);

    expect(calls).toBe(1);
  });
});

describe('cache busting', () => {
  it('appends a unique param per call so PSI cannot serve a cached report', async () => {
    const seen: string[] = [];
    const impl = (async (input: string) => {
      seen.push(String(input));
      return fakeResponse({ ...fixtureRaw, analysisUTCTimestamp: '2026-01-01T00:00:00.000Z' });
    }) as unknown as typeof fetch;

    await runPsiCall({ url: 'https://example.com/', fetchImpl: impl, cacheBustIdImpl: () => 'aaa' });
    await runPsiCall({ url: 'https://example.com/', fetchImpl: impl, cacheBustIdImpl: () => 'bbb' });

    const requested = seen.map((u) => new URL(u).searchParams.get('url'));
    expect(requested[0]).toBe('https://example.com/?psi_nonce=aaa');
    expect(requested[1]).toBe('https://example.com/?psi_nonce=bbb');
    expect(requested[0]).not.toBe(requested[1]);
  });

  it('appends with & when the target URL already has a query string', async () => {
    const seen: string[] = [];
    const impl = (async (input: string) => {
      seen.push(String(input));
      return fakeResponse(fixtureRaw);
    }) as unknown as typeof fetch;

    await runPsiCall({ url: 'https://example.com/p?page=2', fetchImpl: impl, cacheBustIdImpl: () => 'x' });

    expect(new URL(seen[0]).searchParams.get('url')).toBe('https://example.com/p?page=2&psi_nonce=x');
  });

  it('keeps the reported url clean and exposes the busted url separately', async () => {
    const impl = (async () =>
      fakeResponse({ ...fixtureRaw, analysisUTCTimestamp: '2026-01-01T00:00:00.000Z' })) as unknown as typeof fetch;

    const result = await runPsiCall({ url: 'https://example.com/', fetchImpl: impl, cacheBustIdImpl: () => 'zz' });

    expect(result.url).toBe('https://example.com/');
    expect(result.requestedUrl).toBe('https://example.com/?psi_nonce=zz');
    expect(result.analysisUTCTimestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('leaves the url untouched when cache busting is disabled', async () => {
    const seen: string[] = [];
    const impl = (async (input: string) => {
      seen.push(String(input));
      return fakeResponse(fixtureRaw);
    }) as unknown as typeof fetch;

    const result = await runPsiCall({ url: 'https://example.com/', fetchImpl: impl, cacheBust: false });

    expect(new URL(seen[0]).searchParams.get('url')).toBe('https://example.com/');
    expect(result.requestedUrl).toBe('https://example.com/');
  });

  it('reports a null timestamp when the response omits one', async () => {
    const impl = (async () => fakeResponse({ lighthouseResult: {} })) as unknown as typeof fetch;
    const result = await runPsiCall({ url: 'https://example.com/', fetchImpl: impl });
    expect(result.analysisUTCTimestamp).toBeNull();
  });
});
