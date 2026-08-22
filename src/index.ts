import { Context, Schema } from 'koishi'
import { BridgeResolver } from './bridge'
import { CryptoProvider, ExchangeCatalog } from './catalog'
import { CryptoResolver, CryptoTicker } from './crypto'
import { ExchangeQuery, exchangeQueryPattern, parseExchangeQuery } from './parser'
import { ExchangeRate, RateError, RateResolver } from './rate'

export const name = 'exchange-rate'
export const inject = ['http']

export interface Config {
  cacheTtl: number
  timeout: number
  maxCacheEntries: number
  precision: number
  proxy: string
  cryptoCacheTtl: number
  cryptoPrecision: number
  catalogRefreshInterval: number
}

export const Config: Schema<Config> = Schema.object({
  cacheTtl: Schema.number().min(0).default(60 * 60 * 1000).description('汇率缓存时间（毫秒）'),
  timeout: Schema.number().min(1).default(10 * 1000).description('请求超时（毫秒）'),
  maxCacheEntries: Schema.number().min(1).default(256).description('最大缓存条目数'),
  precision: Schema.number().min(0).max(8).default(4).description('法币结果小数位数'),
  proxy: Schema.string().default('').description('Binance 和 OKX 请求使用的代理地址'),
  cryptoCacheTtl: Schema.number().min(0).default(5 * 1000).description('加密货币行情缓存时间（毫秒）'),
  cryptoPrecision: Schema.number().min(0).max(12).default(2).description('加密货币行情小数位数'),
  catalogRefreshInterval: Schema.number().min(0).default(6 * 60 * 60 * 1000).description('交易对目录刷新间隔（毫秒，0 为禁用）'),
})

function formatNumber(value: number, precision: number): string {
  const fixed = value.toFixed(precision)
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}

export function formatExchangeResult(query: ExchangeQuery, result: ExchangeRate, precision: number): string {
  const digits = Math.max(0, Math.min(8, Math.floor(precision)))
  const converted = query.amount * result.rate
  if (!Number.isFinite(converted)) {
    throw new RateError('unavailable', 'The exchange result is outside the supported range.')
  }

  const amount = formatNumber(query.amount, digits)
  const convertedAmount = formatNumber(converted, digits)
  const operator = query.base === query.quote ? '=' : '≈'
  return `${amount} ${query.base} ${operator} ${convertedAmount} ${query.quote}`
}

export function formatCryptoResult(query: ExchangeQuery, ticker: CryptoTicker, precision: number): string {
  const { amount } = query
  if (!Number.isFinite(amount) || amount < 0
    || !Number.isFinite(ticker.bid) || ticker.bid <= 0
    || !Number.isFinite(ticker.ask) || ticker.ask <= 0
    || ticker.bid > ticker.ask) {
    throw new RateError('unavailable', 'The crypto exchange result is outside the supported range.')
  }

  const digits = Math.max(0, Math.min(12, Math.floor(precision)))
  const bid = amount * ticker.bid
  const ask = amount * ticker.ask
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    throw new RateError('unavailable', 'The crypto exchange result is outside the supported range.')
  }
  const mid = bid + (ask - bid) / 2
  if (!Number.isFinite(mid)) {
    throw new RateError('unavailable', 'The crypto exchange result is outside the supported range.')
  }

  if (isTightCryptoSpread(ticker.bid, ticker.ask)) {
    const fixedMid = mid.toFixed(digits)
    const formattedMid = Number(fixedMid) === 0 ? formatSignificant(mid, 6) : fixedMid
    return `${formatNumber(amount, 12)} ${query.base} ≈ ${formattedMid} ${query.quote}`
  }

  const fixedBid = bid.toFixed(digits)
  const fixedAsk = ask.toFixed(digits)
  let formattedBid = fixedBid
  let formattedAsk = fixedAsk
  if (Number(fixedBid) === 0 || Number(fixedAsk) === 0 || (bid !== ask && fixedBid === fixedAsk)) {
    for (let significantDigits = 6; significantDigits <= 15; significantDigits += 1) {
      formattedBid = formatSignificant(bid, significantDigits)
      formattedAsk = formatSignificant(ask, significantDigits)
      if (bid === ask || formattedBid !== formattedAsk) break
    }
    if (bid !== ask && formattedBid === formattedAsk) {
      formattedBid = bid.toString()
      formattedAsk = ask.toString()
    }
  }
  return `${formatNumber(query.amount, 12)} ${query.base} ≈ ${formattedBid} / ${formattedAsk} ${query.quote}`
}

function isTightCryptoSpread(bid: number, ask: number): boolean {
  const decimals = [bid, ask].map((value) => {
    const [coefficient, exponent = '0'] = value.toString().split(/e/i)
    const decimalPlaces = coefficient.includes('.') ? coefficient.length - coefficient.indexOf('.') - 1 : 0
    return { coefficient: BigInt(coefficient.replace('.', '')), exponent: Number(exponent) - decimalPlaces }
  })
  const scale = Math.min(decimals[0].exponent, decimals[1].exponent)
  const scaledBid = decimals[0].coefficient * 10n ** BigInt(decimals[0].exponent - scale)
  const scaledAsk = decimals[1].coefficient * 10n ** BigInt(decimals[1].exponent - scale)
  return (scaledAsk - scaledBid) * 20_000n <= 10n * (scaledAsk + scaledBid)
}

function formatSignificant(value: number, precision: number): string {
  const [mantissa, exponent] = value.toPrecision(precision).split('e')
  const trimmed = mantissa.includes('.') ? mantissa.replace(/\.?0+$/, '') : mantissa
  return exponent === undefined ? trimmed : `${trimmed}e${Number(exponent)}`
}

function createCryptoClient(ctx: Context, endpoint: string, proxy: string) {
  const options = proxy ? { endpoint, proxyAgent: proxy } : { endpoint }
  return ctx.http.extend(options as { endpoint: string })
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('exchange-rate')
  const binance = createCryptoClient(ctx, 'https://api.binance.com', config.proxy)
  const okx = createCryptoClient(ctx, 'https://www.okx.com', config.proxy)
  const catalog = new ExchangeCatalog({ binance, okx, frankfurter: ctx.http }, config)
  const resolver = new RateResolver(ctx.http, config)
  const crypto = new CryptoResolver({ binance, okx }, catalog, {
    cryptoCacheTtl: config.cryptoCacheTtl,
    timeout: config.timeout,
    maxCacheEntries: config.maxCacheEntries,
  })
  const bridge = new BridgeResolver(catalog, crypto, resolver)
  let catalogReady: Promise<void> | undefined

  const initializeCatalog = () => {
    if (catalogReady) return catalogReady
    const attempt = catalog.preload()
    const shared = attempt.catch((error) => {
      logger.warn('Exchange-rate catalog refresh failed.', error)
      if (catalogReady === shared) catalogReady = undefined
    })
    catalogReady = shared
    return shared
  }
  const initializeProvider = async (provider: CryptoProvider | 'frankfurter') => {
    try {
      await catalog.refreshProvider(provider)
    } catch (error) {
      logger.warn(`Exchange-rate ${provider} catalog refresh failed.`, error)
    }
  }
  const refreshCatalog = () => catalog.refresh().catch((error) => {
    logger.warn('Exchange-rate catalog refresh failed.', error)
  })
  const handleFiatQuery = async (query: ExchangeQuery) => {
    try {
      return formatExchangeResult(query, await resolver.getRate(query.base, query.quote), config.precision)
    } catch (error) {
      if (error instanceof RateError && error.kind === 'unsupported') {
        logger.warn('Exchange-rate service rejected a currency pair.', error)
        return '暂不支持该货币对，请检查货币代码。'
      }

      logger.warn('Exchange-rate service is unavailable.', error)
      return '汇率服务暂时不可用，请稍后再试。'
    }
  }
  const handleQuery = async (input?: string) => {
    if (!input) return
    const query = parseExchangeQuery(input)
    if (!query) return
    if (catalog.isFiat(query.base) && catalog.isFiat(query.quote)) {
      return handleFiatQuery(query)
    }

    const result = await formatCryptoProviders(
      query,
      catalog,
      bridge,
      config.cryptoPrecision,
      initializeProvider,
      (message) => logger.warn(message),
    )
    if (result.fiat) return handleFiatQuery(query)
    if (result.fiatUnavailable) return '汇率目录暂时不可用，请稍后再试。'
    return result.text
  }

  ctx.on('ready', () => {
    void initializeCatalog()
    if (config.catalogRefreshInterval > 0) {
      ctx.setInterval(() => {
        void refreshCatalog()
      }, config.catalogRefreshInterval)
    }
  })
  ctx.on('dispose', () => {
    resolver.dispose()
    crypto.dispose()
    catalog.dispose()
  })
  ctx.command('exchange [query:text]', '汇率查询')
    .example('exchange 20 usd to cny')
    .example('exchange -f usd -a 20')
    .option('amount', '-a <amount:number>')
    .option('from', '-f <currency>')
    .option('to', '-t <currency>', { fallback: 'CNY' })
    .shortcut(exchangeQueryPattern, { args: ['$1'] })
    .action(async ({ options }, query) => {
      if (query) return handleQuery(query)
      const { amount, from, to } = options ?? {}
      if (amount === undefined || !from || !to) return
      return handleQuery(`${amount}${from} to ${to}`)
    })
}

interface CryptoProviderResult {
  catalogUnavailable?: true
  fiat?: true
  fiatUnavailable?: true
  text?: string
}

async function formatCryptoProviders(
  query: ExchangeQuery,
  catalog: ExchangeCatalog,
  bridge: BridgeResolver,
  precision: number,
  initializeProvider: (provider: CryptoProvider | 'frankfurter') => Promise<void>,
  warn: (message: string) => void,
): Promise<{ fiat: boolean, fiatUnavailable: boolean, text: string }> {
  const providers: [CryptoProvider, string][] = [['binance', 'BN'], ['okx', 'OKX']]
  const results = await Promise.all(providers.map(async ([provider, label]): Promise<CryptoProviderResult> => {
    await initializeProvider(provider)
    if (!catalog.isReady(provider)) return { catalogUnavailable: true, text: `${label}: 查询失败` }

    const direct = catalog.hasPair(provider, query.base, query.quote)
    const baseKind = catalog.getAssetKind(query.base)
    const quoteKind = catalog.getAssetKind(query.quote)
    if (!direct && (baseKind === undefined || quoteKind === undefined || baseKind !== quoteKind)) {
      await initializeProvider('frankfurter')
      if (catalog.isFiat(query.base) && catalog.isFiat(query.quote)) return { fiat: true }
      if (!catalog.isReady('frankfurter') && baseKind === undefined && quoteKind === undefined) {
        return { fiatUnavailable: true }
      }
    }

    try {
      return { text: `${label}: ${formatCryptoResult(query, await bridge.getTicker(provider, query.base, query.quote), precision)}` }
    } catch (error) {
      if (error instanceof RateError && error.kind === 'unsupported') {
        return { text: `${label}: 不支持 ${query.base}/${query.quote}` }
      }
      warn(`Crypto ticker unavailable for ${provider}.`)
      return { text: `${label}: 查询失败` }
    }
  }))
  if (results.some((result) => result.fiat)) return { fiat: true, fiatUnavailable: false, text: '' }
  if (results.every((result) => result.catalogUnavailable)) {
    await initializeProvider('frankfurter')
    if (catalog.isFiat(query.base) && catalog.isFiat(query.quote)) {
      return { fiat: true, fiatUnavailable: false, text: '' }
    }
  }
  if (results.some((result) => result.fiatUnavailable)) return { fiat: false, fiatUnavailable: true, text: '' }
  return { fiat: false, fiatUnavailable: false, text: results.map((result) => result.text).join('\n') }
}

export { BridgeResolver } from './bridge'
export { AssetKind, ExchangeCatalog } from './catalog'
export { CryptoResolver, CryptoTicker, parseBinanceTicker, parseOkxTicker } from './crypto'
export { exchangeQueryPattern, parseExchangeQuery } from './parser'
export { ExchangeRate, RateError, RateResolver } from './rate'
