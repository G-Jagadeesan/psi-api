import type { Strategy } from './types.js';

export const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_ATTEMPTS = 4;

export class PsiError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'PsiError';
    this.code = code;
    this.status = status;
  }
}

export class UrlValidationError extends PsiError {
  readonly warnings: string[];

  constructor(message: string, warnings: string[] = []) {
    super('INVALID_URL', message);
    this.name = 'UrlValidationError';
    this.warnings = warnings;
  }
}

export interface ValidatedUrl {
  url: string;
  warnings: string[];
}

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
  /\.local$/i,
  /\.internal$/i,
  /\.test$/i,
  /\.localhost$/i,
];

/**
 * Validate that a URL is something PSI can actually reach: public http(s).
 * Returns human-readable warnings for hosts PSI will not be able to load
 * (localhost / private ranges) so the caller can surface them without failing.
 */
export function validateTargetUrl(input: string): ValidatedUrl {
  const raw = (input ?? '').trim();

  if (!raw) {
    throw new UrlValidationError('url is required');
  }
  if (/^file:/i.test(raw)) {
    throw new UrlValidationError('file: URLs are not supported; PSI can only fetch public http(s) URLs');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UrlValidationError(`not a valid URL: ${raw}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlValidationError(
      `unsupported protocol "${parsed.protocol}" - only http and https are supported`,
    );
  }

  const warnings: string[] = [];
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(parsed.hostname))) {
    warnings.push(
      `"${parsed.hostname}" looks like a local or private host. PSI runs Google's bots in the public ` +
        `cloud and cannot reach it - the run will report an error page (usually score 0). Point this at ` +
        `a deployed public URL.`,
    );
  }

  return { url: parsed.toString(), warnings };
}

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export interface PsiCallOptions {
  url: string;
  strategy?: Strategy;
  categories?: string[];
  apiKey?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so backoff does not really sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injected for tests so jitter is deterministic. */
  randomImpl?: () => number;
  /** Base delay for the exponential backoff. */
  backoffBaseMs?: number;
  onRetry?: (info: RetryInfo) => void;
  /** Aborts the whole call including retries. */
  signal?: AbortSignal;
}

export interface PsiCallResult {
  raw: unknown;
  url: string;
  strategy: Strategy;
  categories: string[];
  attempts: number;
  durationMs: number;
  fetchedAt: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Exponential backoff with full jitter, bounded so a run cannot hang. */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  random: () => number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, 60_000);
  }
  const exponential = Math.min(baseMs * 2 ** (attempt - 1), 30_000);
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return date - Date.now();
  return undefined;
}

function extractApiError(body: unknown, status: number): { code: string; message: string } {
  const err = (body as { error?: { code?: number; message?: string; status?: string } } | null)?.error;
  if (err && typeof err === 'object') {
    return {
      code: typeof err.code === 'number' ? String(err.code) : (err.status ?? String(status)),
      message: err.message ?? 'PSI request failed',
    };
  }
  if (typeof err === 'string') {
    return { code: String(status), message: err };
  }
  return { code: String(status), message: `PSI request failed with HTTP ${status}` };
}

/**
 * Run PSI once (plus retries) and return the full raw JSON response.
 * Every PSI failure mode is surfaced as a PsiError with the upstream message.
 */
export async function runPsiCall(options: PsiCallOptions): Promise<PsiCallResult> {
  const {
    url,
    strategy = 'mobile',
    categories = ['performance'],
    apiKey,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    fetchImpl = globalThis.fetch,
    sleepImpl = defaultSleep,
    randomImpl = Math.random,
    backoffBaseMs = 1000,
    onRetry,
    signal,
  } = options;

  const startedAt = Date.now();
  const params = new URLSearchParams({
    url,
    strategy,
    category: categories.join(','),
  });
  if (apiKey) params.set('key', apiKey);

  const endpoint = `${PSI_ENDPOINT}?${params.toString()}`;

  if (!apiKey) {
    const warn =
      'PSI_API_KEY is not set - using the shared anonymous quota (very low, and easily exhausted). ' +
      'Set PSI_API_KEY in psi-api/.env for reliable runs.';
    onRetry?.({ attempt: 0, maxAttempts, delayMs: 0, reason: warn });
  }

  let lastError: PsiError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      throw new PsiError('ABORTED', 'PSI call aborted');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    let response: Response;
    let body: unknown;

    try {
      response = await fetchImpl(endpoint, { signal: controller.signal });

      if (!response.ok) {
        body = await response.json().catch(() => null);
        const { code, message } = extractApiError(body, response.status);
        const error = new PsiError(code, message, response.status);
        if (!isRetryableStatus(response.status) || attempt === maxAttempts) {
          throw error;
        }
        lastError = error;
        const delayMs = backoffDelay(
          attempt,
          backoffBaseMs,
          randomImpl,
          parseRetryAfter(response.headers?.get?.('retry-after') ?? null),
        );
        onRetry?.({ attempt, maxAttempts, delayMs, reason: `HTTP ${response.status}: ${message}` });
        await sleepImpl(delayMs);
        continue;
      }

      body = await response.json();
    } catch (error) {
      if (error instanceof PsiError) throw error;

      const isAbort = controller.signal.aborted;
      if (signal?.aborted) {
        throw new PsiError('ABORTED', 'PSI call aborted');
      }
      const reason = isAbort
        ? `timed out after ${timeoutMs}ms`
        : `network error: ${error instanceof Error ? error.message : String(error)}`;
      const wrapped = new PsiError(isAbort ? 'TIMEOUT' : 'NETWORK_ERROR', reason);

      if (attempt === maxAttempts) throw wrapped;
      lastError = wrapped;
      const delayMs = backoffDelay(attempt, backoffBaseMs, randomImpl);
      onRetry?.({ attempt, maxAttempts, delayMs, reason });
      await sleepImpl(delayMs);
      continue;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }

    return {
      raw: body,
      url,
      strategy,
      categories,
      attempts: attempt,
      durationMs: Date.now() - startedAt,
      fetchedAt: new Date().toISOString(),
    };
  }

  throw lastError ?? new PsiError('UNKNOWN', 'PSI call failed for an unknown reason');
}
