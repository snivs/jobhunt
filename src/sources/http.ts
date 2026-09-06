import type { SourceConfig } from "../config/index.js";
import type { Logger } from "../logging/index.js";

export class SourceHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = "SourceHttpError";
  }
}

/** Sliding-window rate limiter honoring per-second / per-minute / per-hour ceilings and concurrency. */
export class RateLimiter {
  private timestamps: number[] = [];
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limits: SourceConfig["rate_limits"]) {}

  private windowAllows(now: number): boolean {
    const within = (ms: number) => this.timestamps.filter((t) => now - t < ms).length;
    const { requests_per_second: s, requests_per_minute: m, requests_per_hour: h } = this.limits;
    if (s > 0 && within(1000) >= Math.max(1, Math.floor(s))) return false;
    if (s > 0 && s < 1 && within(1000 / s) >= 1) return false;
    if (m > 0 && within(60_000) >= m) return false;
    if (h > 0 && within(3_600_000) >= h) return false;
    return true;
  }

  async acquire(): Promise<() => void> {
    const concurrency = Math.max(1, this.limits.concurrency);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 3_600_000);
      if (this.active < concurrency && this.windowAllows(now)) {
        this.active++;
        this.timestamps.push(now);
        return () => {
          this.active--;
          const next = this.waiters.shift();
          if (next) next();
        };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

export interface HttpClientOptions {
  config: SourceConfig;
  logger: Logger;
  userAgent?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** HTTP client with per-source rate limiting, retry with exponential backoff and Retry-After support. */
export class HttpClient {
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  readonly requests = { total: 0, retries: 0 };

  constructor(private readonly opts: HttpClientOptions) {
    this.limiter = new RateLimiter(opts.config.rate_limits);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(url, { ...init, headers: { Accept: "application/json", ...(init.headers ?? {}) } });
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SourceHttpError(`Invalid JSON from ${url}: ${text.slice(0, 120)}`, res.status, false, 1);
    }
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const { retry } = this.opts.config;
    let attempt = 0;
    let backoff = retry.initial_backoff_ms;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const release = await this.limiter.acquire();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);
      try {
        this.requests.total++;
        const res = await this.fetchImpl(url, {
          ...init,
          signal: controller.signal,
          headers: { "User-Agent": this.opts.userAgent ?? "jobhunt/0.1 (+https://github.com/snivs/jobhunt; respectful job aggregator)", ...(init.headers ?? {}) },
        });
        if (res.ok) return res;
        const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
        const bodySnippet = (await res.text().catch(() => "")).slice(0, 200);
        if (!retryable || attempt >= retry.max_retries) {
          throw new SourceHttpError(`HTTP ${res.status} from ${url}: ${bodySnippet}`, res.status, retryable, attempt + 1);
        }
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff;
        this.opts.logger.warn("retrying request", { url, status: res.status, attempt: attempt + 1, wait_ms: waitMs });
        await sleep(Math.min(waitMs, retry.max_backoff_ms || waitMs));
      } catch (err) {
        if (err instanceof SourceHttpError) throw err;
        const isAbort = err instanceof Error && err.name === "AbortError";
        if (attempt >= retry.max_retries) {
          throw new SourceHttpError(`${isAbort ? "Timeout" : "Network error"} for ${url}: ${err instanceof Error ? err.message : String(err)}`, null, true, attempt + 1);
        }
        this.opts.logger.warn("retrying after network error", { url, attempt: attempt + 1, wait_ms: backoff, error: err instanceof Error ? err.message : String(err) });
        await sleep(Math.min(backoff, retry.max_backoff_ms || backoff));
      } finally {
        clearTimeout(timer);
        release();
      }
      attempt++;
      this.requests.retries++;
      backoff = Math.min(backoff * retry.backoff_multiplier, retry.max_backoff_ms || backoff * retry.backoff_multiplier);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
