export type CryptoProvider = 'binance' | 'okx'
export type CatalogProvider = CryptoProvider | 'frankfurter'
export type AssetKind = 'fiat' | 'crypto'

export interface CatalogHttpClient {
  get<T>(url: string, config?: { timeout?: number }): Promise<T>
}

export interface CatalogPair {
  id: string
  base: string
  quote: string
}

export interface CatalogClients {
  binance: CatalogHttpClient
  okx: CatalogHttpClient
  frankfurter: CatalogHttpClient
}

export interface CatalogOptions {
  timeout: number
}

const BINANCE_EXCHANGE_INFO = '/api/v3/exchangeInfo'
const OKX_INSTRUMENTS = '/api/v5/public/instruments?instType=SPOT'
const FRANKFURTER_CURRENCIES = 'https://api.frankfurter.dev/v2/currencies'
const assetPattern = /^[A-Z0-9]{1,20}$/
const instrumentPattern = /^[A-Z0-9-]{3,42}$/
const fiatPattern = /^[A-Z]{3}$/
const seededFiat = new Set(['CNY', 'EUR', 'GBP', 'HKD', 'JPY', 'USD'])

function pairKey(base: string, quote: string): string {
  return `${base}/${quote}`
}

function isAssetCode(value: unknown): value is string {
  return typeof value === 'string' && assetPattern.test(value)
}

function isFiatCode(value: unknown): value is string {
  return typeof value === 'string' && fiatPattern.test(value)
}

function isBinanceSpotSymbol(value: Record<string, unknown>): boolean {
  return value.isSpotTradingAllowed === true
    || (Array.isArray(value.permissions) && value.permissions.includes('SPOT'))
}

function parseBinancePairs(value: unknown): CatalogPair[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { symbols?: unknown }).symbols)) {
    throw new TypeError('Received an invalid Binance exchange-info response.')
  }

  const pairs: CatalogPair[] = []
  for (const item of (value as { symbols: unknown[] }).symbols) {
    if (!item || typeof item !== 'object') continue
    const symbol = item as Record<string, unknown>
    if (symbol.status !== 'TRADING' || !isBinanceSpotSymbol(symbol)) continue
    if (!isAssetCode(symbol.symbol) || !isAssetCode(symbol.baseAsset) || !isAssetCode(symbol.quoteAsset)) continue
    pairs.push({ id: symbol.symbol, base: symbol.baseAsset, quote: symbol.quoteAsset })
  }
  return pairs
}

function parseOkxPairs(value: unknown): CatalogPair[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { data?: unknown }).data)) {
    throw new TypeError('Received an invalid OKX instruments response.')
  }

  const pairs: CatalogPair[] = []
  for (const item of (value as { data: unknown[] }).data) {
    if (!item || typeof item !== 'object') continue
    const instrument = item as Record<string, unknown>
    if (instrument.state !== 'live' || instrument.instType !== 'SPOT') continue
    if (typeof instrument.instId !== 'string' || !instrumentPattern.test(instrument.instId)
      || !isAssetCode(instrument.baseCcy) || !isAssetCode(instrument.quoteCcy)) continue
    pairs.push({ id: instrument.instId, base: instrument.baseCcy, quote: instrument.quoteCcy })
  }
  return pairs
}

function parseFiatCodes(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    throw new TypeError('Received an invalid Frankfurter currencies response.')
  }

  const fiat = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const code = (item as Record<string, unknown>).iso_code
    if (isFiatCode(code)) fiat.add(code)
  }
  if (fiat.size === 0) {
    throw new TypeError('Received an empty Frankfurter currencies response.')
  }
  return fiat
}

function buildPairs(pairs: CatalogPair[]): Map<string, CatalogPair> {
  const result = new Map<string, CatalogPair>()
  for (const pair of pairs) result.set(pairKey(pair.base, pair.quote), pair)
  return result
}

export class ExchangeCatalog {
  private binance = new Map<string, CatalogPair>()
  private okx = new Map<string, CatalogPair>()
  private fiat = new Set<string>()
  private readonly ready: Record<CatalogProvider, boolean> = {
    binance: false,
    okx: false,
    frankfurter: false,
  }
  private readonly pending: Partial<Record<CatalogProvider, Promise<void>>> = {}
  private refreshPending?: Promise<void>

  constructor(
    private readonly clients: CatalogClients,
    private readonly options: CatalogOptions,
  ) {}

  init(): Promise<void> {
    return this.refresh()
  }

  preload(): Promise<void> {
    return this.init()
  }

  refresh(): Promise<void> {
    if (this.refreshPending) return this.refreshPending

    const pending = this.refreshProviders(['binance', 'okx', 'frankfurter'])
    this.refreshPending = pending
    void pending.then(
      () => { if (this.refreshPending === pending) this.refreshPending = undefined },
      () => { if (this.refreshPending === pending) this.refreshPending = undefined },
    )
    return pending
  }

  refreshProvider(provider: CatalogProvider): Promise<void> {
    const current = this.pending[provider]
    if (current) return current

    const pending = this.fetchProvider(provider)
    this.pending[provider] = pending
    void pending.then(
      () => { if (this.pending[provider] === pending) delete this.pending[provider] },
      () => { if (this.pending[provider] === pending) delete this.pending[provider] },
    )
    return pending
  }

  dispose(): void {
    this.refreshPending = undefined
    for (const provider of ['binance', 'okx', 'frankfurter'] as CatalogProvider[]) {
      delete this.pending[provider]
    }
    this.binance = new Map()
    this.okx = new Map()
    this.fiat = new Set()
    this.ready.binance = false
    this.ready.okx = false
    this.ready.frankfurter = false
  }

  isReady(provider: CatalogProvider): boolean {
    return this.ready[provider]
  }

  getPair(provider: CryptoProvider, base: string, quote: string): CatalogPair | undefined {
    return this[provider].get(pairKey(base, quote))
  }

  getReversePair(provider: CryptoProvider, base: string, quote: string): CatalogPair | undefined {
    return this[provider].get(pairKey(quote, base))
  }

  hasPair(provider: CryptoProvider, base: string, quote: string): boolean {
    return this.getPair(provider, base, quote) !== undefined
      || this.getReversePair(provider, base, quote) !== undefined
  }

  isFiat(asset: string): boolean {
    return this.fiat.has(asset) || seededFiat.has(asset)
  }

  getAssetKind(asset: string): AssetKind | undefined {
    if (asset === 'USDT') return 'crypto'
    if (this.isFiat(asset)) return 'fiat'
    return [...this.binance.values(), ...this.okx.values()].some((pair) => pair.base === asset || pair.quote === asset)
      ? 'crypto'
      : undefined
  }

  isKnownAsset(asset: string): boolean {
    return this.getAssetKind(asset) !== undefined
  }

  private async refreshProviders(providers: CatalogProvider[]): Promise<void> {
    const results = await Promise.allSettled(providers.map((provider) => this.refreshProvider(provider)))
    const failures = results
      .map((result, index) => result.status === 'rejected'
        ? new Error(`${providers[index]} catalog refresh failed.`, { cause: result.reason })
        : undefined)
      .filter((error): error is Error => error !== undefined)
    if (failures.length) {
      throw new AggregateError(failures, 'One or more exchange-rate catalogs failed to refresh.')
    }
  }

  private fetchProvider(provider: CatalogProvider): Promise<void> {
    if (provider === 'binance') return this.refreshBinance()
    if (provider === 'okx') return this.refreshOkx()
    return this.refreshFrankfurter()
  }

  private async refreshBinance(): Promise<void> {
    const response = await this.clients.binance.get<unknown>(BINANCE_EXCHANGE_INFO, { timeout: this.options.timeout })
    const pairs = buildPairs(parseBinancePairs(response))
    this.binance = pairs
    this.ready.binance = true
  }

  private async refreshOkx(): Promise<void> {
    const response = await this.clients.okx.get<unknown>(OKX_INSTRUMENTS, { timeout: this.options.timeout })
    const pairs = buildPairs(parseOkxPairs(response))
    this.okx = pairs
    this.ready.okx = true
  }

  private async refreshFrankfurter(): Promise<void> {
    const response = await this.clients.frankfurter.get<unknown>(FRANKFURTER_CURRENCIES, { timeout: this.options.timeout })
    const fiat = parseFiatCodes(response)
    this.fiat = fiat
    this.ready.frankfurter = true
  }
}

export {
  BINANCE_EXCHANGE_INFO,
  FRANKFURTER_CURRENCIES,
  OKX_INSTRUMENTS,
  parseBinancePairs,
  parseFiatCodes,
  parseOkxPairs,
}
