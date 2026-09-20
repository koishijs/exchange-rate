import { CatalogPair, CryptoProvider, ExchangeCatalog } from './catalog'
import { RateError } from './rate'

export interface CryptoHttpClient {
  get<T>(url: string, config?: { timeout?: number, params?: Record<string, string> }): Promise<T>
}

export interface CryptoClients {
  binance: CryptoHttpClient
  okx: CryptoHttpClient
}

export interface CryptoResolverOptions {
  cryptoCacheTtl: number
  timeout: number
  maxCacheEntries: number
}

export interface CryptoTicker {
  bid: number
  ask: number
}

interface CacheEntry extends CryptoTicker {
  expiresAt: number
}

const BINANCE_BOOK_TICKER = '/api/v3/ticker/bookTicker'
const OKX_TICKER = '/api/v5/market/ticker'
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/

function parsePositiveDecimal(value: unknown): number | undefined {
  if (typeof value !== 'string' || !decimalPattern.test(value)) return undefined
  const result = Number(value)
  return Number.isFinite(result) && result > 0 ? result : undefined
}

function parseBinanceTicker(value: unknown, id: string): CryptoTicker | undefined {
  if (!value || typeof value !== 'object') return undefined
  const response = value as Record<string, unknown>
  if (response.symbol !== id) return undefined
  const bid = parsePositiveDecimal(response.bidPrice)
  const ask = parsePositiveDecimal(response.askPrice)
  return bid && ask && bid <= ask ? { bid, ask } : undefined
}

function parseOkxTicker(value: unknown, id: string): CryptoTicker | undefined {
  if (!value || typeof value !== 'object') return undefined
  const response = value as Record<string, unknown>
  if (response.code !== '0' || !Array.isArray(response.data) || response.data.length !== 1) return undefined
  const ticker = response.data[0]
  if (!ticker || typeof ticker !== 'object') return undefined
  const item = ticker as Record<string, unknown>
  if (item.instId !== id) return undefined
  const bid = parsePositiveDecimal(item.bidPx)
  const ask = parsePositiveDecimal(item.askPx)
  return bid && ask && bid <= ask ? { bid, ask } : undefined
}

export class CryptoResolver {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<CryptoTicker>>()

  constructor(
    private readonly clients: CryptoClients,
    private readonly catalog: ExchangeCatalog,
    private readonly options: CryptoResolverOptions,
  ) {}

  async getTicker(provider: CryptoProvider, base: string, quote: string): Promise<CryptoTicker> {
    const direct = this.catalog.getPair(provider, base, quote)
    const reverse = direct ? undefined : this.catalog.getReversePair(provider, base, quote)
    const pair = direct ?? reverse
    if (!pair) {
      throw new RateError('unsupported', 'The requested crypto pair is not supported.')
    }

    const direction = direct ? 'forward' : 'reverse'
    const key = `${provider}:${pair.id}`
    const cached = this.getCached(key)
    if (cached) return this.applyDirection(cached, direction)

    const pending = this.inFlight.get(key)
    if (pending) return this.applyDirection(await pending, direction)

    const request = this.fetchTicker(provider, pair)
    this.inFlight.set(key, request)
    try {
      return this.applyDirection(await request, direction)
    } finally {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key)
    }
  }

  dispose(): void {
    this.cache.clear()
    this.inFlight.clear()
  }

  private getCached(key: string): CryptoTicker | undefined {
    const cached = this.cache.get(key)
    if (!cached) return undefined
    if (cached.expiresAt <= Date.now()) {
      this.cache.delete(key)
      return undefined
    }
    this.cache.delete(key)
    this.cache.set(key, cached)
    return { bid: cached.bid, ask: cached.ask }
  }

  private async fetchTicker(provider: CryptoProvider, pair: CatalogPair): Promise<CryptoTicker> {
    try {
      const result = provider === 'binance'
        ? parseBinanceTicker(await this.clients.binance.get<unknown>(BINANCE_BOOK_TICKER, {
          timeout: this.options.timeout,
          params: { symbol: pair.id },
        }), pair.id)
        : parseOkxTicker(await this.clients.okx.get<unknown>(OKX_TICKER, {
          timeout: this.options.timeout,
          params: { instId: pair.id },
        }), pair.id)
      if (!result) {
        throw new RateError('unavailable', 'Received an invalid crypto ticker response.')
      }

      this.setCache(`${provider}:${pair.id}`, result)
      return result
    } catch (error) {
      if (error instanceof RateError) throw error
      throw new RateError('unavailable', 'The crypto ticker service is unavailable.')
    }
  }

  private applyDirection(ticker: CryptoTicker, direction: 'forward' | 'reverse'): CryptoTicker {
    const result = direction === 'forward'
      ? ticker
      : { bid: 1 / ticker.ask, ask: 1 / ticker.bid }
    if (!Number.isFinite(result.bid) || !Number.isFinite(result.ask)
      || result.bid <= 0 || result.ask <= 0 || result.bid > result.ask) {
      throw new RateError('unavailable', 'Received an invalid crypto ticker response.')
    }
    return result
  }

  private setCache(key: string, ticker: CryptoTicker): void {
    const maxEntries = Number.isFinite(this.options.maxCacheEntries)
      ? Math.max(1, Math.floor(this.options.maxCacheEntries))
      : 1
    const ttl = Number.isFinite(this.options.cryptoCacheTtl) ? Math.max(0, this.options.cryptoCacheTtl) : 0
    if (ttl === 0) return

    this.cache.delete(key)
    this.cache.set(key, { ...ticker, expiresAt: Date.now() + ttl })
    while (this.cache.size > maxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) return
      this.cache.delete(oldest)
    }
  }
}

export {
  BINANCE_BOOK_TICKER,
  OKX_TICKER,
  parseBinanceTicker,
  parseOkxTicker,
}
