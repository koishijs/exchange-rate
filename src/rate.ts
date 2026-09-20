export type RateErrorKind = 'unsupported' | 'unavailable'

export class RateError extends Error {
  constructor(
    readonly kind: RateErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'RateError'
  }
}

export interface HttpClient {
  get<T>(url: string, config?: { timeout?: number }): Promise<T>
}

export interface RateResolverOptions {
  cacheTtl: number
  timeout: number
  maxCacheEntries: number
}

export interface ExchangeRate {
  rate: number
  date?: string
}

interface CacheEntry extends ExchangeRate {
  expiresAt: number
}

const RATE_URL = 'https://api.frankfurter.dev/v2/rate'

function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const candidate = error as { status?: unknown, response?: { status?: unknown } }
  const status = candidate.response?.status ?? candidate.status
  return typeof status === 'number' ? status : undefined
}

function isValidRateResponse(value: unknown, base: string, quote: string): value is Required<ExchangeRate> & { base: string, quote: string } {
  if (!value || typeof value !== 'object') return false
  const response = value as Record<string, unknown>
  return response.base === base
    && response.quote === quote
    && typeof response.date === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(response.date)
    && typeof response.rate === 'number'
    && Number.isFinite(response.rate)
    && response.rate > 0
}

export class RateResolver {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<ExchangeRate>>()

  constructor(
    private readonly http: HttpClient,
    private readonly options: RateResolverOptions,
  ) {}

  async getRate(base: string, quote: string): Promise<ExchangeRate> {
    if (base === quote) return { rate: 1 }

    const key = `${base}/${quote}`
    const now = Date.now()
    const cached = this.cache.get(key)
    if (cached) {
      if (cached.expiresAt > now) {
        this.cache.delete(key)
        this.cache.set(key, cached)
        return { rate: cached.rate, date: cached.date }
      }
      this.cache.delete(key)
    }

    const pending = this.inFlight.get(key)
    if (pending) return pending

    const request = this.fetchRate(base, quote)
    this.inFlight.set(key, request)
    try {
      return await request
    } finally {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key)
    }
  }

  dispose(): void {
    this.cache.clear()
    this.inFlight.clear()
  }

  private async fetchRate(base: string, quote: string): Promise<ExchangeRate> {
    try {
      const response = await this.http.get<unknown>(`${RATE_URL}/${base}/${quote}`, {
        timeout: this.options.timeout,
      })
      if (!isValidRateResponse(response, base, quote)) {
        throw new RateError('unavailable', 'Received an invalid exchange-rate response.')
      }

      const result = { rate: response.rate, date: response.date }
      this.setCache(`${base}/${quote}`, result)
      return result
    } catch (error) {
      if (error instanceof RateError) throw error
      if (getHttpStatus(error) === 400 || getHttpStatus(error) === 404) {
        throw new RateError('unsupported', 'The requested currency pair is not supported.')
      }
      throw new RateError('unavailable', 'The exchange-rate service is unavailable.')
    }
  }

  private setCache(key: string, result: Required<ExchangeRate>): void {
    const maxEntries = Number.isFinite(this.options.maxCacheEntries)
      ? Math.max(1, Math.floor(this.options.maxCacheEntries))
      : 1
    const ttl = Number.isFinite(this.options.cacheTtl) ? Math.max(0, this.options.cacheTtl) : 0
    if (ttl === 0) return

    this.cache.delete(key)
    this.cache.set(key, { ...result, expiresAt: Date.now() + ttl })
    while (this.cache.size > maxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) return
      this.cache.delete(oldest)
    }
  }
}
