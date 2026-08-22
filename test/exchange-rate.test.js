const assert = require('node:assert/strict')
const test = require('node:test')
const { Argv, Context } = require('koishi')

const {
  BridgeResolver,
  CryptoResolver,
  ExchangeCatalog,
  RateError,
  RateResolver,
  apply,
  formatCryptoResult,
  formatExchangeResult,
  parseBinanceTicker,
  parseExchangeQuery,
  parseOkxTicker,
} = require('../lib/index.js')

const options = {
  cacheTtl: 60_000,
  timeout: 10_000,
  maxCacheEntries: 256,
}

const config = {
  ...options,
  precision: 4,
  proxy: '',
  cryptoCacheTtl: 5_000,
  cryptoPrecision: 2,
  catalogRefreshInterval: 6 * 60 * 60 * 1000,
}

const currencies = [
  { iso_code: 'USD', name: 'United States Dollar' },
  { iso_code: 'GBP', name: 'British Pound' },
  { iso_code: 'EUR', name: 'Euro' },
]

const binanceCatalog = {
  symbols: [
    { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true },
    { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true },
    { symbol: 'ETHBTC', baseAsset: 'ETH', quoteAsset: 'BTC', status: 'TRADING', permissions: ['SPOT'] },
    { symbol: 'BTCBUSD', baseAsset: 'BTC', quoteAsset: 'BUSD', status: 'BREAK', isSpotTradingAllowed: true },
    { symbol: 'BTCUPUSDT', baseAsset: 'BTCUP', quoteAsset: 'USDT', status: 'TRADING', permissions: ['MARGIN'] },
  ],
}

const okxCatalog = {
  data: [
    { instId: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live', instType: 'SPOT' },
    { instId: 'ETH-USDT', baseCcy: 'ETH', quoteCcy: 'USDT', state: 'live', instType: 'SPOT' },
    { instId: 'ETH-BTC', baseCcy: 'ETH', quoteCcy: 'BTC', state: 'live', instType: 'SPOT' },
    { instId: 'BTC-USDC', baseCcy: 'BTC', quoteCcy: 'USDC', state: 'suspend', instType: 'SPOT' },
    { instId: 'BTC-USDT-SWAP', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live', instType: 'SWAP' },
  ],
}

function rateResponse(base, quote, rate) {
  return { base, quote, date: '2026-08-21', rate }
}

function createCatalog(clients = {}) {
  return new ExchangeCatalog({
    binance: clients.binance ?? { get: async () => binanceCatalog },
    okx: clients.okx ?? { get: async () => okxCatalog },
    frankfurter: clients.frankfurter ?? { get: async () => currencies },
  }, options)
}

function createCommandHarness({
  frankfurterGet = async (url) => url.includes('/currencies') ? currencies : rateResponse('USD', 'GBP', 0.8),
  binanceGet = async (url) => url.includes('exchangeInfo') ? binanceCatalog : { symbol: 'BTCUSDT', bidPrice: '67234.12', askPrice: '67235.08' },
  okxGet = async (url) => url.includes('instruments') ? okxCatalog : { code: '0', data: [{ instId: 'BTC-USDT', bidPx: '67234.10', askPx: '67235.10' }] },
  configOverrides = {},
} = {}) {
  const middlewares = []
  const events = {}
  const extensions = []
  const intervals = []
  const warnings = []
  const commands = []
  const http = {
    get: (...args) => frankfurterGet(...args),
    extend: (options) => {
      extensions.push(options)
      return {
        get: options.endpoint.includes('binance')
          ? (...args) => binanceGet(...args)
          : (...args) => okxGet(...args),
      }
    },
  }
  apply({
    http,
    logger: () => ({ warn: (...args) => warnings.push(args) }),
    on: (name, handler) => { events[name] = handler },
    setInterval: (handler, interval) => intervals.push({ handler, interval }),
    middleware: (handler) => middlewares.push(handler),
    command: (definition, description) => {
      const command = { definition, description, examples: [], options: [], shortcuts: [], action: undefined }
      const builder = {
        example: (example) => { command.examples.push(example); return builder },
        option: (name, declaration, config) => { command.options.push({ name, declaration, config }); return builder },
        shortcut: (matcher, config) => { command.shortcuts.push({ matcher, config }); return builder },
        action: (handler) => { command.action = handler; return builder },
      }
      commands.push(command)
      return builder
    },
  }, { ...config, ...configOverrides })
  assert.equal(middlewares.length, 0)
  assert.equal(commands.length, 1)
  return { command: commands[0], events, extensions, intervals, warnings }
}

function executeQuery(setup, query, options = {}) {
  return setup.command.action({ options }, query)
}

function createKoishiCommandContext() {
  const ctx = new Context()
  let rateCalls = 0
  const http = {
    get: async (url) => {
      if (url.includes('/currencies')) return currencies
      rateCalls += 1
      assert.equal(url, 'https://api.frankfurter.dev/v2/rate/USD/CNY')
      return rateResponse('USD', 'CNY', 7)
    },
    extend: (options) => ({
      get: async (url) => options.endpoint.includes('binance')
        ? (url.includes('exchangeInfo') ? binanceCatalog : { symbol: 'BTCUSDT', bidPrice: '1', askPrice: '1' })
        : (url.includes('instruments') ? okxCatalog : { code: '0', data: [{ instId: 'BTC-USDT', bidPx: '1', askPx: '1' }] }),
    }),
  }
  ctx.http = http
  apply(ctx, config)

  const execute = async (content) => {
    const session = {
      stripped: { content, hasAt: false, appel: false },
      resolve(response, params) {
        if (typeof response !== 'string') return response
        const argv = Argv.parse(`exchange ${params[1]}`)
        argv.session = session
        ctx.$commander.resolveCommand(argv)
        return argv.command.execute({ ...argv, session })
      },
    }
    ctx.bail('before-attach', session)
    return session.response ? session.response() : undefined
  }
  const executeCommand = async (content) => {
    const session = {
      stripped: { content, hasAt: false, appel: false },
      resolve: (value) => value,
    }
    const argv = Argv.parse(content)
    argv.session = session
    ctx.$commander.resolveCommand(argv)
    return argv.command.execute({ ...argv, session })
  }
  return { execute, executeCommand, getRateCalls: () => rateCalls }
}

test('parser accepts aliases and 2-10 letter asset codes', () => {
  assert.deepEqual(parseExchangeQuery('123usd to gbp'), { amount: 123, base: 'USD', quote: 'GBP' })
  assert.deepEqual(parseExchangeQuery('US$ 12.5 to 人民币'), { amount: 12.5, base: 'USD', quote: 'CNY' })
  assert.deepEqual(parseExchangeQuery('￥0.5toJP¥'), { amount: 0.5, base: 'CNY', quote: 'JPY' })
  assert.deepEqual(parseExchangeQuery('英镑1toEUR'), { amount: 1, base: 'GBP', quote: 'EUR' })
  assert.deepEqual(parseExchangeQuery('1btc to usdt'), { amount: 1, base: 'BTC', quote: 'USDT' })
  assert.deepEqual(parseExchangeQuery('1abcdefghij to xy'), { amount: 1, base: 'ABCDEFGHIJ', quote: 'XY' })
})

test('parser rejects invalid, unsafe, excessively precise, multiline, and oversized codes', () => {
  for (const input of [
    'please convert 123usd to gbp',
    '123 usd to gbp now',
    '-1usd to gbp',
    '1e3usd to gbp',
    '１２ USD to CNY',
    '1ＢＴＣ to USDT',
    '9007199254740992usd to gbp',
    '9007199254740991.1usd to gbp',
    '0.0000000000001usd to gbp',
    '123usd\nto gbp',
    '123usd\r\nto gbp',
    '123usd to gbp\n',
    '1a to abcdefghijk',
    'usd to gbp',
  ]) {
    assert.equal(parseExchangeQuery(input), null, input)
  }
})

test('resolver preserves response dates, caches successful rates, and skips HTTP for identical currencies', async () => {
  let calls = 0
  const resolver = new RateResolver({
    get: async () => {
      calls += 1
      return rateResponse('USD', 'GBP', 0.8)
    },
  }, options)

  assert.deepEqual(await resolver.getRate('USD', 'GBP'), { rate: 0.8, date: '2026-08-21' })
  assert.deepEqual(await resolver.getRate('USD', 'GBP'), { rate: 0.8, date: '2026-08-21' })
  assert.deepEqual(await resolver.getRate('USD', 'USD'), { rate: 1 })
  assert.equal(calls, 1)
})

test('resolver deduplicates concurrent HTTP requests and classifies failures', async () => {
  let calls = 0
  let resolveRequest
  const response = new Promise((resolve) => { resolveRequest = resolve })
  const resolver = new RateResolver({
    get: () => {
      calls += 1
      return response
    },
  }, options)
  const first = resolver.getRate('EUR', 'JPY')
  const second = resolver.getRate('EUR', 'JPY')
  assert.equal(calls, 1)
  resolveRequest(rateResponse('EUR', 'JPY', 160))
  assert.deepEqual(await Promise.all([first, second]), [
    { rate: 160, date: '2026-08-21' },
    { rate: 160, date: '2026-08-21' },
  ])

  const unavailable = new RateResolver({ get: async () => rateResponse('EUR', 'USD', 0) }, options)
  await assert.rejects(unavailable.getRate('USD', 'EUR'), (error) => error instanceof RateError && error.kind === 'unavailable')
})

test('catalog filters providers, deduplicates initialization, and preserves snapshots on refresh failure', async () => {
  let binanceCalls = 0
  let failRefresh = false
  const catalog = createCatalog({
    binance: {
      get: async () => {
        binanceCalls += 1
        if (failRefresh) throw new Error('offline')
        return binanceCatalog
      },
    },
  })
  const initialization = catalog.init()
  assert.equal(catalog.preload(), initialization)
  await initialization
  assert.equal(binanceCalls, 1)
  assert.equal(catalog.getPair('binance', 'BTC', 'USDT').id, 'BTCUSDT')
  assert.equal(catalog.getReversePair('okx', 'BTC', 'ETH').id, 'ETH-BTC')
  assert.equal(catalog.getPair('binance', 'BTC', 'BUSD'), undefined)
  assert.equal(catalog.getPair('okx', 'BTC', 'USDC'), undefined)
  assert.equal(catalog.isFiat('USD'), true)
  assert.equal(catalog.isReady('binance'), true)
  assert.equal(catalog.isReady('okx'), true)
  assert.equal(catalog.isReady('frankfurter'), true)
  assert.equal(catalog.isKnownAsset('BTC'), true)
  assert.equal(catalog.isKnownAsset('UNKNOWN'), false)

  failRefresh = true
  await assert.rejects(catalog.refresh())
  assert.equal(catalog.getPair('binance', 'BTC', 'USDT').id, 'BTCUSDT')
})

test('catalog refreshes providers independently while preserving full refresh deduplication', async () => {
  let resolveBinance
  const binance = new Promise((resolve) => { resolveBinance = resolve })
  const catalog = createCatalog({ binance: { get: async () => binance } })
  const pendingBinance = catalog.refreshProvider('binance')
  await catalog.refreshProvider('frankfurter')
  assert.equal(catalog.isReady('frankfurter'), true)
  assert.equal(catalog.isReady('binance'), false)
  resolveBinance(binanceCatalog)
  await pendingBinance
  assert.equal(catalog.isReady('binance'), true)
})

test('catalog isolates a Frankfurter failure from successful crypto provider snapshots', async () => {
  const catalog = createCatalog({ frankfurter: { get: async () => [{ iso_code: 'US' }] } })
  await assert.rejects(catalog.init(), AggregateError)
  assert.equal(catalog.isReady('binance'), true)
  assert.equal(catalog.isReady('okx'), true)
  assert.equal(catalog.isReady('frankfurter'), false)
  assert.equal(catalog.getPair('binance', 'BTC', 'USDT').id, 'BTCUSDT')
  assert.equal(catalog.getPair('okx', 'BTC', 'USDT').id, 'BTC-USDT')
})

test('crypto resolver uses catalog direction, validates responses, and caches concurrent requests', async () => {
  const catalog = createCatalog()
  await catalog.init()
  let calls = 0
  let resolveRequest
  const response = new Promise((resolve) => { resolveRequest = resolve })
  const crypto = new CryptoResolver({
    binance: {
      get: () => {
        calls += 1
        return response
      },
    },
    okx: { get: async () => ({ code: '0', data: [{ instId: 'ETH-BTC', bidPx: '0.05', askPx: '0.06' }] }) },
  }, catalog, { ...options, cryptoCacheTtl: 60_000 })
  const first = crypto.getTicker('binance', 'BTC', 'USDT')
  const second = crypto.getTicker('binance', 'USDT', 'BTC')
  assert.equal(calls, 1)
  resolveRequest({ symbol: 'BTCUSDT', bidPrice: '67234.12', askPrice: '67235.08' })
  assert.deepEqual(await Promise.all([first, second]), [
    { bid: 67234.12, ask: 67235.08 },
    { bid: 1 / 67235.08, ask: 1 / 67234.12 },
  ])
  await crypto.getTicker('binance', 'BTC', 'USDT')
  assert.equal(calls, 1)
  assert.deepEqual(await crypto.getTicker('okx', 'BTC', 'ETH'), {
    bid: 1 / 0.06,
    ask: 1 / 0.05,
  })
  assert.equal(parseBinanceTicker({ symbol: 'BTCUSDT', bidPrice: '2', askPrice: '1' }, 'BTCUSDT'), undefined)
  assert.equal(parseOkxTicker({ code: '0', data: [{ instId: 'BTC-USDT', bidPx: '2', askPx: '1' }] }, 'BTC-USDT'), undefined)

  let ttlCalls = 0
  const noCache = new CryptoResolver({
    binance: {
      get: async () => {
        ttlCalls += 1
        return { symbol: 'BTCUSDT', bidPrice: '1', askPrice: '2' }
      },
    },
    okx: { get: async () => ({ code: '0', data: [{ instId: 'BTC-USDT', bidPx: '1', askPx: '2' }] }) },
  }, catalog, { ...options, cacheTtl: 60_000, cryptoCacheTtl: 0 })
  await noCache.getTicker('binance', 'BTC', 'USDT')
  await noCache.getTicker('binance', 'BTC', 'USDT')
  assert.equal(ttlCalls, 2)

  const invalid = new CryptoResolver({
    binance: { get: async () => ({ symbol: 'BTCUSDT', bidPrice: 1, askPrice: '2' }) },
    okx: { get: async () => ({ code: '1', data: [] }) },
  }, catalog, { ...options, cryptoCacheTtl: 0 })
  await assert.rejects(invalid.getTicker('binance', 'BTC', 'USDT'), (error) => error instanceof RateError && error.kind === 'unavailable')
  await assert.rejects(invalid.getTicker('okx', 'BTC', 'USDT'), (error) => error instanceof RateError && error.kind === 'unavailable')
  await assert.rejects(invalid.getTicker('binance', 'BTC', 'EUR'), (error) => error instanceof RateError && error.kind === 'unsupported')
})

test('formatters retain concise fiat output and adapt crypto output to the spread', () => {
  assert.equal(
    formatExchangeResult({ amount: 12, base: 'USD', quote: 'GBP' }, { rate: 0.82305, date: '2026-08-21' }, 4),
    '12 USD ≈ 9.8766 GBP',
  )
  assert.equal(
    formatExchangeResult({ amount: 12, base: 'USD', quote: 'USD' }, { rate: 1 }, 4),
    '12 USD = 12 USD',
  )
  assert.equal(
    formatCryptoResult({ amount: 1, base: 'BTC', quote: 'USDT' }, { bid: 67234.1, ask: 67235 }, 2),
    '1 BTC ≈ 67234.55 USDT',
  )
  assert.equal(
    formatCryptoResult({ amount: 1, base: 'BTC', quote: 'USDT' }, { bid: 0.9995, ask: 1.0005 }, 2),
    '1 BTC ≈ 1.00 USDT',
  )
  assert.equal(
    formatCryptoResult({ amount: 0, base: 'BTC', quote: 'USDT' }, { bid: 0.9995, ask: 1.0005 }, 2),
    '0 BTC ≈ 0 USDT',
  )
  assert.equal(
    formatCryptoResult({ amount: 0.000001, base: 'BTC', quote: 'USDT' }, { bid: 0.9995, ask: 1.0005 }, 2),
    '0.000001 BTC ≈ 0.000001 USDT',
  )
  assert.equal(
    formatCryptoResult({ amount: 1, base: 'BTC', quote: 'USDT' }, { bid: 0.0000009995, ask: 0.0000010005 }, 12).includes('/'),
    false,
  )
  assert.equal(
    formatCryptoResult({ amount: 1, base: 'BTC', quote: 'BTC' }, { bid: 1, ask: 1 }, 2),
    '1 BTC ≈ 1.00 BTC',
  )
  assert.equal(
    formatCryptoResult({ amount: 1, base: 'BTC', quote: 'USDT' }, { bid: 0.9994, ask: 1.0006 }, 2),
    '1 BTC ≈ 0.9994 / 1.0006 USDT',
  )
  const slightlyWideSpreadBps = 10.0000000005
  const slightlyWideAsk = (20_000 + slightlyWideSpreadBps) / (20_000 - slightlyWideSpreadBps)
  assert.equal(
    formatCryptoResult({ amount: 1, base: 'BTC', quote: 'USDT' }, { bid: 1, ask: slightlyWideAsk }, 2).includes('/'),
    true,
  )
  assert.equal(
    formatCryptoResult({ amount: 1e-12, base: 'BTC', quote: 'USDT' }, { bid: 1e308, ask: 1e308 }, 2).includes('/'),
    false,
  )
  assert.equal(
    formatCryptoResult({ amount: 1, base: 'BTC', quote: 'USDT' }, { bid: Number.MIN_VALUE, ask: Number.MIN_VALUE }, 2),
    '1 BTC ≈ 4.94066e-324 USDT',
  )
})

test('crypto formatter rejects invalid amounts and tickers', () => {
  for (const [amount, ticker] of [
    [-1, { bid: 1, ask: 1 }],
    [Infinity, { bid: 1, ask: 1 }],
    [1, { bid: 0, ask: 1 }],
    [1, { bid: 1, ask: Infinity }],
    [1, { bid: 2, ask: 1 }],
  ]) {
    assert.throws(
      () => formatCryptoResult({ amount, base: 'BTC', quote: 'USDT' }, ticker, 2),
      (error) => error instanceof RateError && error.kind === 'unavailable',
    )
  }
})

test('command registration uses the shared anchored shortcut without middleware', async () => {
  const setup = createCommandHarness({ configOverrides: { proxy: 'http://127.0.0.1:7890', catalogRefreshInterval: 123 } })
  assert.equal(setup.command.definition, 'exchange [query:text]')
  assert.deepEqual(setup.command.options, [
    { name: 'amount', declaration: '-a <amount:number>', config: undefined },
    { name: 'from', declaration: '-f <currency>', config: undefined },
    { name: 'to', declaration: '-t <currency>', config: { fallback: 'CNY' } },
  ])
  assert.equal(setup.command.shortcuts.length, 1)
  const shortcut = setup.command.shortcuts[0]
  assert.equal(shortcut.matcher.source.startsWith('^'), true)
  assert.equal(shortcut.matcher.source.endsWith('$'), true)
  assert.deepEqual(shortcut.config, { args: ['$1'] })
  assert.equal(shortcut.matcher.exec('12usd to gbp')[1], '12usd to gbp')
  assert.deepEqual(setup.extensions, [
    { endpoint: 'https://api.binance.com', proxyAgent: 'http://127.0.0.1:7890' },
    { endpoint: 'https://www.okx.com', proxyAgent: 'http://127.0.0.1:7890' },
  ])
  setup.events.ready()
  assert.deepEqual(setup.intervals.map(({ interval }) => interval), [123])
  await Promise.resolve()
})

test('real Koishi Context executes shortcut and legacy fallback once', async () => {
  const setup = createKoishiCommandContext()
  const shortcut = await setup.execute('20 usd to cny')
  assert.equal(shortcut[0].attrs.content, '20 USD ≈ 140 CNY')
  assert.equal(setup.getRateCalls(), 1)

  const legacy = await setup.executeCommand('exchange -a 0 -f USD')
  assert.equal(legacy, '0 USD ≈ 0 CNY')
  assert.equal(setup.getRateCalls(), 1)

  assert.equal(await setup.execute('please convert 20 usd to cny'), undefined)
  assert.equal(await setup.execute('hello'), undefined)
  assert.equal(setup.getRateCalls(), 1)
})

test('command preserves fiat conversion and handles a shortcut query once', async () => {
  let rateCalls = 0
  const setup = createCommandHarness({
    frankfurterGet: async (url, requestOptions) => {
      if (url.endsWith('/currencies')) {
        assert.deepEqual(requestOptions, { timeout: 10_000 })
        return currencies
      }
      rateCalls += 1
      assert.equal(url, 'https://api.frankfurter.dev/v2/rate/USD/GBP')
      assert.deepEqual(requestOptions, { timeout: 10_000 })
      return rateResponse('USD', 'GBP', 0.8)
    },
  })
  const query = setup.command.shortcuts[0].matcher.exec('12usd to gbp')[1]
  assert.equal(await executeQuery(setup, query), '12 USD ≈ 9.6 GBP')
  assert.equal(rateCalls, 1)
})

test('seeded fiat commands do not wait for crypto catalogs', async () => {
  let cryptoRequests = 0
  const setup = createCommandHarness({
    binanceGet: async () => {
      cryptoRequests += 1
      return new Promise(() => {})
    },
    okxGet: async () => {
      cryptoRequests += 1
      return new Promise(() => {})
    },
  })
  assert.equal(await executeQuery(setup, '1usd to gbp'), '1 USD ≈ 0.8 GBP')
  assert.equal(cryptoRequests, 0)
})

test('command shares the router with old options and accepts zero amounts', async () => {
  let rateCalls = 0
  const setup = createCommandHarness({
    frankfurterGet: async (url) => {
      if (url.endsWith('/currencies')) return currencies
      rateCalls += 1
      assert.equal(url, 'https://api.frankfurter.dev/v2/rate/USD/CNY')
      return rateResponse('USD', 'CNY', 7)
    },
  })
  assert.equal(await executeQuery(setup, undefined, { amount: 0, from: 'usd', to: 'CNY' }), '0 USD ≈ 0 CNY')
  assert.equal(rateCalls, 1)
})

test('command skips incomplete legacy options without requests', async () => {
  let calls = 0
  const setup = createCommandHarness({
    frankfurterGet: async () => { calls += 1; return currencies },
    binanceGet: async () => { calls += 1; return binanceCatalog },
    okxGet: async () => { calls += 1; return okxCatalog },
  })
  assert.equal(await executeQuery(setup, undefined, { from: 'USD', to: 'CNY' }), undefined)
  assert.equal(await executeQuery(setup, undefined, { amount: 1, to: 'CNY' }), undefined)
  assert.equal(calls, 0)
})

test('command keeps fiat routing and crypto catalogs independent of Frankfurter failure', async () => {
  const setup = createCommandHarness({
    frankfurterGet: async (url) => {
      if (url.endsWith('/currencies')) throw new Error('Frankfurter unavailable')
      return rateResponse('USD', 'GBP', 0.8)
    },
  })
  assert.equal(
    await executeQuery(setup, '1btc to usdt'),
    'BN: 1 BTC ≈ 67234.60 USDT\nOKX: 1 BTC ≈ 67234.60 USDT',
  )
  assert.equal(await executeQuery(setup, '12usd to gbp'), '12 USD ≈ 9.6 GBP')
  assert.deepEqual(setup.warnings, [])
})

test('command retries a failed Frankfurter catalog and avoids crypto fallback for unresolved fiat pairs', async () => {
  let currencyCalls = 0
  const setup = createCommandHarness({
    frankfurterGet: async (url) => {
      if (url.endsWith('/currencies')) {
        currencyCalls += 1
        if (currencyCalls === 1) throw new Error('Frankfurter unavailable')
        return [...currencies, { iso_code: 'AUD' }, { iso_code: 'CAD' }]
      }
      assert.equal(url, 'https://api.frankfurter.dev/v2/rate/AUD/CAD')
      return rateResponse('AUD', 'CAD', 0.9)
    },
    configOverrides: { catalogRefreshInterval: 0 },
  })
  assert.equal(await executeQuery(setup, '1aud to cad'), '汇率目录暂时不可用，请稍后再试。')
  assert.equal(await executeQuery(setup, '1aud to cad'), '1 AUD ≈ 0.9 CAD')
  assert.equal(currencyCalls, 2)
  assert.equal(setup.warnings[0][0], 'Exchange-rate frankfurter catalog refresh failed.')
})

test('all unavailable crypto catalogs still classify non-seeded fiat through Frankfurter', async () => {
  let currencyCalls = 0
  let rateCalls = 0
  const setup = createCommandHarness({
    frankfurterGet: async (url) => {
      if (url.endsWith('/currencies')) {
        currencyCalls += 1
        return [...currencies, { iso_code: 'AUD' }, { iso_code: 'CAD' }]
      }
      rateCalls += 1
      assert.equal(url, 'https://api.frankfurter.dev/v2/rate/AUD/CAD')
      return rateResponse('AUD', 'CAD', 0.9)
    },
    binanceGet: async () => { throw new Error('Binance unavailable') },
    okxGet: async () => { throw new Error('OKX unavailable') },
  })
  assert.equal(await executeQuery(setup, '1aud to cad'), '1 AUD ≈ 0.9 CAD')
  assert.equal(currencyCalls, 1)
  assert.equal(rateCalls, 1)
})

test('command isolates catalog and ticker failures and avoids unknown-asset ticker requests', async () => {
  let tickerCalls = 0
  const setup = createCommandHarness({
    binanceGet: async (url) => {
      if (url.includes('exchangeInfo')) throw new Error('Binance unavailable')
      tickerCalls += 1
      return binanceCatalog
    },
    okxGet: async (url) => url.includes('instruments')
      ? okxCatalog
      : { code: '0', data: [{ instId: 'BTC-USDT', bidPx: 'bad', askPx: '67235.10' }] },
  })
  assert.equal(await executeQuery(setup, '1btc to usdt'), 'BN: 查询失败\nOKX: 查询失败')
  assert.equal(await executeQuery(setup, '1unknown to usdt'), 'BN: 查询失败\nOKX: 不支持 UNKNOWN/USDT')
  assert.equal(tickerCalls, 0)
  assert.equal(setup.warnings[0][0], 'Exchange-rate binance catalog refresh failed.')
})

test('command does not route invalid explicit queries', async () => {
  let calls = 0
  const setup = createCommandHarness({ frankfurterGet: async () => { calls += 1; return currencies } })
  assert.equal(await executeQuery(setup, 'hello'), undefined)
  assert.equal(calls, 0)
})

async function createBridge({
  binance = binanceCatalog,
  okx = okxCatalog,
  frankfurter = currencies,
  binanceTicker,
  okxTicker,
  rate,
} = {}) {
  const catalog = new ExchangeCatalog({
    binance: { get: async () => binance },
    okx: { get: async () => okx },
    frankfurter: { get: async () => frankfurter },
  }, options)
  await catalog.init()
  const crypto = new CryptoResolver({
    binance: { get: binanceTicker },
    okx: { get: okxTicker },
  }, catalog, { ...options, cryptoCacheTtl: 60_000 })
  const rates = new RateResolver({ get: rate }, options)
  return { bridge: new BridgeResolver(catalog, crypto, rates), catalog }
}

test('catalog classifies USDT as crypto and recognizes either pair direction', async () => {
  const catalog = createCatalog()
  await catalog.init()
  assert.equal(catalog.getAssetKind('USD'), 'fiat')
  assert.equal(catalog.getAssetKind('USDT'), 'crypto')
  assert.equal(catalog.getAssetKind('BTC'), 'crypto')
  assert.equal(catalog.getAssetKind('UNKNOWN'), undefined)
  assert.equal(catalog.hasPair('binance', 'BTC', 'USDT'), true)
  assert.equal(catalog.hasPair('binance', 'USDT', 'BTC'), true)
  assert.equal(catalog.hasPair('binance', 'BTC', 'CNY'), false)
})

test('bridge composes crypto, fiat, and USDT identity routes independently per provider', async () => {
  const noDirectBinance = { ...binanceCatalog, symbols: binanceCatalog.symbols.filter((pair) => pair.symbol !== 'ETHBTC') }
  const noDirectOkx = { ...okxCatalog, data: okxCatalog.data.filter((pair) => pair.instId !== 'ETH-BTC') }
  const calls = { binance: 0, okx: 0, rate: 0 }
  const { bridge } = await createBridge({
    binance: noDirectBinance,
    okx: noDirectOkx,
    binanceTicker: async (_url, { params }) => {
      calls.binance += 1
      return params.symbol === 'ETHUSDT'
        ? { symbol: 'ETHUSDT', bidPrice: '2', askPrice: '3' }
        : { symbol: 'BTCUSDT', bidPrice: '10', askPrice: '11' }
    },
    okxTicker: async (_url, { params }) => {
      calls.okx += 1
      return params.instId === 'ETH-USDT'
        ? { code: '0', data: [{ instId: 'ETH-USDT', bidPx: '4', askPx: '5' }] }
        : { code: '0', data: [{ instId: 'BTC-USDT', bidPx: '20', askPx: '22' }] }
    },
    rate: async (url) => {
      calls.rate += 1
      const [, base, quote] = url.match(/([^/]+)\/([^/]+)$/)
      const rates = { 'USD/CNY': 7, 'CNY/USD': 0.1 }
      return rateResponse(base, quote, rates[`${base}/${quote}`])
    },
  })

  assert.deepEqual(await bridge.getTicker('binance', 'BTC', 'CNY'), { bid: 70, ask: 77 })
  assert.deepEqual(await bridge.getTicker('binance', 'CNY', 'BTC'), { bid: 0.1 * (1 / 11), ask: 0.1 * (1 / 10) })
  assert.deepEqual(await bridge.getTicker('binance', 'ETH', 'BTC'), { bid: 2 * (1 / 11), ask: 3 * (1 / 10) })
  assert.deepEqual(await bridge.getTicker('binance', 'USDT', 'CNY'), { bid: 7, ask: 7 })
  assert.deepEqual(await bridge.getTicker('binance', 'CNY', 'USDT'), { bid: 0.1, ask: 0.1 })
  assert.deepEqual(await bridge.getTicker('binance', 'BTC', 'BTC'), { bid: 1, ask: 1 })
  assert.deepEqual(await bridge.getTicker('okx', 'BTC', 'CNY'), { bid: 140, ask: 154 })
  assert.equal(calls.binance, 2)
  assert.equal(calls.okx, 1)
  assert.equal(calls.rate, 2)
})

test('bridge gives direct pairs priority and does not fall back after ticker failure', async () => {
  const directBinance = {
    ...binanceCatalog,
    symbols: [...binanceCatalog.symbols, {
      symbol: 'BTCCNY', baseAsset: 'BTC', quoteAsset: 'CNY', status: 'TRADING', isSpotTradingAllowed: true,
    }],
  }
  let rateCalls = 0
  const { bridge } = await createBridge({
    binance: directBinance,
    binanceTicker: async () => ({ symbol: 'BTCCNY', bidPrice: 'bad', askPrice: '2' }),
    okxTicker: async () => ({ code: '0', data: [{ instId: 'BTC-USDT', bidPx: '1', askPx: '2' }] }),
    rate: async () => {
      rateCalls += 1
      return rateResponse('USD', 'CNY', 7)
    },
  })
  await assert.rejects(bridge.getTicker('binance', 'BTC', 'CNY'), (error) => error instanceof RateError && error.kind === 'unavailable')
  assert.equal(rateCalls, 0)
})

test('bridge rejects missing crypto legs and propagates Frankfurter readiness and rate failures', async () => {
  const noEthUsdt = { ...binanceCatalog, symbols: binanceCatalog.symbols.filter((pair) => pair.symbol !== 'ETHUSDT') }
  let tickerCalls = 0
  const missing = await createBridge({
    binance: noEthUsdt,
    binanceTicker: async () => {
      tickerCalls += 1
      return { symbol: 'BTCUSDT', bidPrice: '1', askPrice: '2' }
    },
    okxTicker: async () => ({ code: '0', data: [{ instId: 'BTC-USDT', bidPx: '1', askPx: '2' }] }),
    rate: async () => rateResponse('USD', 'CNY', 7),
  })
  await assert.rejects(missing.bridge.getTicker('binance', 'ETH', 'CNY'), (error) => error instanceof RateError && error.kind === 'unsupported')
  assert.equal(tickerCalls, 0)

  let notReadyRateCalls = 0
  const notReadyCatalog = createCatalog({ frankfurter: { get: async () => { throw new Error('offline') } } })
  await assert.rejects(notReadyCatalog.init())
  const notReadyCrypto = new CryptoResolver({
    binance: { get: async () => ({ symbol: 'BTCUSDT', bidPrice: '1', askPrice: '2' }) },
    okx: { get: async () => ({ code: '0', data: [{ instId: 'BTC-USDT', bidPx: '1', askPx: '2' }] }) },
  }, notReadyCatalog, { ...options, cryptoCacheTtl: 60_000 })
  const notReadyRates = new RateResolver({
    get: async () => {
      notReadyRateCalls += 1
      return rateResponse('USD', 'CNY', 7)
    },
  }, options)
  const notReady = new BridgeResolver(notReadyCatalog, notReadyCrypto, notReadyRates)
  await assert.rejects(notReady.getTicker('binance', 'BTC', 'CNY'), (error) => error instanceof RateError && error.kind === 'unavailable')
  assert.equal(notReadyRateCalls, 0)

  const unavailable = await createBridge({
    binanceTicker: async () => ({ symbol: 'BTCUSDT', bidPrice: '1', askPrice: '2' }),
    okxTicker: async () => ({ code: '0', data: [{ instId: 'BTC-USDT', bidPx: '1', askPx: '2' }] }),
    rate: async () => { throw new Error('offline') },
  })
  await assert.rejects(unavailable.bridge.getTicker('binance', 'BTC', 'CNY'), (error) => error instanceof RateError && error.kind === 'unavailable')

  const unsupported = await createBridge({
    binanceTicker: async () => ({ symbol: 'BTCUSDT', bidPrice: '1', askPrice: '2' }),
    okxTicker: async () => ({ code: '0', data: [{ instId: 'BTC-USDT', bidPx: '1', askPx: '2' }] }),
    rate: async () => { throw { response: { status: 404 } } },
  })
  await assert.rejects(unsupported.bridge.getTicker('binance', 'BTC', 'CNY'), (error) => error instanceof RateError && error.kind === 'unsupported')
})

test('bridge reuses crypto and FX caches, and crypto formatting preserves small nonzero results', async () => {
  let tickerCalls = 0
  let rateCalls = 0
  const { bridge } = await createBridge({
    binanceTicker: async () => {
      tickerCalls += 1
      return { symbol: 'BTCUSDT', bidPrice: '10', askPrice: '11' }
    },
    okxTicker: async () => ({ code: '0', data: [{ instId: 'BTC-USDT', bidPx: '1', askPx: '2' }] }),
    rate: async () => {
      rateCalls += 1
      return rateResponse('USD', 'CNY', 7)
    },
  })
  await bridge.getTicker('binance', 'BTC', 'CNY')
  await bridge.getTicker('binance', 'BTC', 'CNY')
  assert.equal(tickerCalls, 1)
  assert.equal(rateCalls, 1)
  assert.equal(
    formatCryptoResult({ amount: 1, base: 'BTC', quote: 'USDT' }, { bid: 0.000001, ask: 0.000002 }, 2),
    '1 BTC ≈ 0.000001 / 0.000002 USDT',
  )
  assert.equal(
    formatCryptoResult({ amount: 1, base: 'BTC', quote: 'USDT' }, { bid: 1e-20, ask: 1.00001e-20 }, 2),
    '1 BTC ≈ 1.00001e-20 USDT',
  )
  assert.equal(
    formatCryptoResult({ amount: 1, base: 'CNY', quote: 'BTC' }, { bid: 0.00000184, ask: 0.00000185 }, 2),
    '1 CNY ≈ 0.00000184 / 0.00000185 BTC',
  )
  assert.equal(
    formatCryptoResult({ amount: 1, base: 'CNY', quote: 'BTC' }, { bid: 1.1e-12, ask: 1.2e-12 }, 2),
    '1 CNY ≈ 1.1e-12 / 1.2e-12 BTC',
  )
  assert.equal(
    formatCryptoResult({ amount: 1, base: 'BTC', quote: 'USDT' }, { bid: 1e-20, ask: 2e-20 }, 2),
    '1 BTC ≈ 1e-20 / 2e-20 USDT',
  )
})
