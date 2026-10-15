import { RateError } from './rate'

export interface HistoryPoint {
  date: string
  rate: number
}

export interface HistoryCandle {
  date: string
  open: number
  high: number
  low: number
  close: number
}

export interface HistoryHttpClient {
  get<T>(url: string, config?: { timeout?: number }): Promise<T>
}

export interface CryptoHistoryHttpClient {
  get<T>(url: string, config?: { timeout?: number, params?: Record<string, string> }): Promise<T>
}

export interface HistoryOptions {
  timeout: number
  days: number
}

interface SeriesRecord {
  date: string
  base: string
  quote: string
  rate: number
}

const RATES_URL = 'https://api.frankfurter.dev/v2/rates'
const datePattern = /^\d{4}-\d{2}-\d{2}$/

function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const candidate = error as { status?: unknown, response?: { status?: unknown } }
  const status = candidate.response?.status ?? candidate.status
  return typeof status === 'number' ? status : undefined
}

function isSeriesRecord(value: unknown): value is SeriesRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.date === 'string' && datePattern.test(record.date)
    && typeof record.base === 'string' && typeof record.quote === 'string'
    && typeof record.rate === 'number' && Number.isFinite(record.rate) && record.rate > 0
}

export async function fetchHistoryRates(
  http: HistoryHttpClient,
  base: string,
  quote: string,
  options: HistoryOptions,
): Promise<HistoryPoint[]> {
  const to = new Date()
  const from = new Date(to.getTime() - Math.max(2, Math.floor(options.days)) * 86_400_000)
  const iso = (date: Date) => date.toISOString().slice(0, 10)
  const url = `${RATES_URL}?from=${iso(from)}&to=${iso(to)}&base=${base}&quotes=${quote}`

  try {
    const response = await http.get<unknown>(url, { timeout: options.timeout })
    if (!Array.isArray(response) || !response.every(isSeriesRecord)) {
      throw new RateError('unavailable', 'Received an invalid exchange-rate history response.')
    }

    const series = (response as SeriesRecord[])
      .filter((record) => record.base === base && record.quote === quote)
      .sort((left, right) => left.date.localeCompare(right.date))
      .map(({ date, rate }) => ({ date, rate }))
    if (series.length < 2) {
      throw new RateError('unsupported', 'The requested currency pair has no history.')
    }
    return series
  } catch (error) {
    if (error instanceof RateError) throw error
    if (getHttpStatus(error) === 400 || getHttpStatus(error) === 404) {
      throw new RateError('unsupported', 'The requested currency pair is not supported.')
    }
    throw new RateError('unavailable', 'The exchange-rate service is unavailable.')
  }
}

function formatRate(value: number): string {
  const fixed = value.toFixed(4)
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/

function isKlineRow(value: unknown): value is [number, string, string, string, string] {
  if (!Array.isArray(value) || value.length < 5) return false
  if (typeof value[0] !== 'number' || !Number.isFinite(value[0])) return false
  return [value[1], value[2], value[3], value[4]].every(
    (item) => typeof item === 'string' && decimalPattern.test(item) && Number(item) > 0,
  )
}

export async function fetchCryptoCandles(
  http: CryptoHistoryHttpClient,
  symbol: string,
  options: HistoryOptions,
): Promise<HistoryCandle[]> {
  const days = Math.max(2, Math.floor(options.days))
  // 短区间（≤7 天）日 K 太稀，切换为小时 K。
  const intraday = options.days <= 7
  const interval = intraday ? '1h' : '1d'
  const limit = intraday ? days * 24 : Math.min(1000, days)
  try {
    const response = await http.get<unknown>('/api/v3/klines', {
      timeout: options.timeout,
      params: { symbol, interval, limit: String(limit) },
    })
    if (!Array.isArray(response) || !response.every(isKlineRow) || response.length < 2) {
      throw new RateError('unavailable', 'Received an invalid crypto klines response.')
    }
    return (response as [number, string, string, string, string][])
      .map(([openTime, open, high, low, close]) => ({
        date: new Date(openTime).toISOString().slice(0, 10),
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
      }))
      .sort((left, right) => left.date.localeCompare(right.date))
  } catch (error) {
    if (error instanceof RateError) throw error
    if (getHttpStatus(error) === 400 || getHttpStatus(error) === 404) {
      throw new RateError('unsupported', 'The requested crypto pair is not supported.')
    }
    throw new RateError('unavailable', 'The crypto service is unavailable.')
  }
}

// 反向交易对（如用 ETHBTC 查 BTC/ETH）：价格取倒数，并交换 high/low。
export function invertCandles(candles: HistoryCandle[]): HistoryCandle[] {
  return candles.map(({ date, open, high, low, close }) => ({
    date,
    open: 1 / open,
    high: 1 / low,
    low: 1 / high,
    close: 1 / close,
  }))
}

export interface ChartTheme {
  width: number
  height: number
  padding: { left: number, right: number, top: number, bottom: number }
  upColor: string
  downColor: string
  textColor: string
  mutedColor: string
  gridColor: string
}

// 默认绿涨红跌；红涨绿跌时由调用方交换 upColor/downColor。
export const defaultTheme: ChartTheme = {
  width: 640,
  height: 360,
  padding: { left: 72, right: 48, top: 64, bottom: 52 },
  upColor: '#1a7f37',
  downColor: '#cf222e',
  textColor: '#1f2328',
  mutedColor: '#656d76',
  gridColor: '#d0d7de',
}

interface ChartFrame {
  py: (v: number) => number
  source: string
}

// 页面框架：白底、全局字体、Y 轴网格/刻度、底部首尾日期。
function buildFrame(min: number, max: number, firstDate: string, lastDate: string, theme: ChartTheme): ChartFrame {
  const { width: W, height: H } = theme
  const { left: PAD_L, right: PAD_R, top: PAD_T, bottom: PAD_B } = theme.padding
  const span = max - min || max * 0.001 || 1
  const py = (v: number) => PAD_T + (1 - (v - min) / span) * (H - PAD_T - PAD_B)
  const ticks = [max, min + span / 2, min]
  const gridLine = (v: number) => `#place(dx: ${PAD_L}pt, dy: ${py(v).toFixed(1)}pt)[#line(length: ${(W - PAD_L - PAD_R).toFixed(1)}pt, stroke: 0.5pt + rgb("${theme.gridColor}"))]
#place(dx: 0pt, dy: ${(py(v) - 7).toFixed(1)}pt)[#box(width: ${(PAD_L - 6).toFixed(1)}pt)[#align(right)[#text(size: 12pt, fill: rgb("${theme.mutedColor}"))[${formatRate(v)}]]]]`
  const dateLabel = (alignment: string, date: string) => `#place(${alignment}, dx: ${alignment.includes('right') ? -PAD_R : PAD_L}pt, dy: -16pt)[#text(size: 12pt, fill: rgb("${theme.mutedColor}"))[${date.slice(5)}]]`
  return {
    py,
    source: `#set page(width: ${W}pt, height: ${H}pt, margin: 0pt)
#place(dx: 0pt, dy: 0pt)[#rect(width: ${W}pt, height: ${H}pt, fill: rgb("#ffffff"), stroke: none)]
#set text(font: "Noto Sans SC", size: 12pt, fill: rgb("${theme.textColor}"))
${ticks.map((v) => gridLine(v)).join('\n')}
${dateLabel('bottom + left', firstDate)}
${dateLabel('bottom + right', lastDate)}
`,
  }
}

// 第一行：交易对、现价、区间涨跌幅；右上角日期范围。
function buildHeader(base: string, quote: string, last: number, change: number, lineColor: string, firstDate: string, lastDate: string, theme: ChartTheme): string {
  const { left: PAD_L, right: PAD_R } = theme.padding
  const changeText = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`
  return `#place(top + left, dx: ${PAD_L}pt, dy: 16pt)[#text(size: 20pt, weight: 600)[${base}/${quote}]#h(12pt)#text(size: 20pt, weight: 600, fill: rgb("${lineColor}"))[${formatRate(last)}]#h(8pt)#text(size: 13pt, fill: rgb("${lineColor}"))[${changeText}]]
#place(top + right, dx: -${PAD_R}pt, dy: 22pt)[#text(size: 11pt, fill: rgb("${theme.mutedColor}"))[${firstDate} ~ ${lastDate}]]
`
}

export function buildChartSource(base: string, quote: string, series: HistoryPoint[], theme: ChartTheme = defaultTheme, liveRate?: number): string {
  const rates = series.map((point) => point.rate)
  if (liveRate !== undefined && Number.isFinite(liveRate) && liveRate > 0) {
    rates[rates.length - 1] = liveRate
  }
  const min = Math.min(...rates)
  const max = Math.max(...rates)
  const { width: W, height: H } = theme
  const { left: PAD_L, right: PAD_R, bottom: PAD_B } = theme.padding
  const plotW = W - PAD_L - PAD_R
  const lastIndex = series.length - 1
  const { py, source: frame } = buildFrame(min, max, series[0].date, series[lastIndex].date, theme)
  const px = (i: number) => PAD_L + (i / lastIndex) * plotW
  const point = (i: number, v: number) => `(${px(i).toFixed(1)}pt, ${py(v).toFixed(1)}pt)`

  const up = rates[lastIndex] >= rates[0]
  const lineColor = up ? theme.upColor : theme.downColor
  const change = (rates[lastIndex] / rates[0] - 1) * 100

  const moves = series.slice(1).map(({ rate }, i) => `curve.line(${point(i + 1, rate)})`)
  const areaMoves = [...moves, `curve.line((${px(lastIndex).toFixed(1)}pt, ${(H - PAD_B).toFixed(1)}pt))`]

  return `${frame}${buildHeader(base, quote, rates[lastIndex], change, lineColor, series[0].date, series[lastIndex].date, theme)}
#place(dx: 0pt, dy: 0pt)[#curve(
  curve.move(${point(0, rates[0])}),
  ${areaMoves.join(',\n  ')},
  fill: rgb("${lineColor}").transparentize(88%),
)]
#place(dx: 0pt, dy: 0pt)[#curve(
  curve.move(${point(0, rates[0])}),
  ${moves.join(',\n  ')},
  stroke: 1.5pt + rgb("${lineColor}"),
)]
#place(dx: ${(px(0) - 1.5).toFixed(1)}pt, dy: ${(py(rates[0]) - 1.5).toFixed(1)}pt)[#circle(radius: 1.5pt, fill: rgb("${lineColor}"))]
#place(dx: ${(px(lastIndex) - 1.5).toFixed(1)}pt, dy: ${(py(rates[lastIndex]) - 1.5).toFixed(1)}pt)[#circle(radius: 1.5pt, fill: rgb("${lineColor}"))]
`
}

export function buildCandlestickSource(base: string, quote: string, candles: HistoryCandle[], theme: ChartTheme = defaultTheme): string {
  const min = Math.min(...candles.map(({ low }) => low))
  const max = Math.max(...candles.map(({ high }) => high))
  const { width: W } = theme
  const { left: PAD_L } = theme.padding
  const plotW = W - theme.padding.left - theme.padding.right
  const lastIndex = candles.length - 1
  const { py, source: frame } = buildFrame(min, max, candles[0].date, candles[lastIndex].date, theme)

  // 最后一根是进行中的日 K，close 即实时价；区间涨跌对比首根 open。
  const lastClose = candles[lastIndex].close
  const up = lastClose >= candles[0].open
  const lineColor = up ? theme.upColor : theme.downColor
  const change = (lastClose / candles[0].open - 1) * 100

  const slot = plotW / candles.length
  const bodyW = Math.max(1.5, slot * 0.6)
  const bodies = candles.map(({ open, high, low, close }, i) => {
    const color = close >= open ? theme.upColor : theme.downColor
    const x = PAD_L + (i + 0.5) * slot
    const wickTop = py(high)
    const bodyTop = py(Math.max(open, close))
    const bodyH = Math.max(0.6, Math.abs(py(open) - py(close)))
    return `#place(dx: ${(x - 0.3).toFixed(1)}pt, dy: ${wickTop.toFixed(1)}pt)[#line(angle: 90deg, length: ${(py(low) - wickTop).toFixed(1)}pt, stroke: 0.6pt + rgb("${color}"))]
#place(dx: ${(x - bodyW / 2).toFixed(1)}pt, dy: ${bodyTop.toFixed(1)}pt)[#rect(width: ${bodyW.toFixed(1)}pt, height: ${bodyH.toFixed(1)}pt, fill: rgb("${color}"), stroke: none)]`
  }).join('\n')

  return `${frame}${buildHeader(base, quote, lastClose, change, lineColor, candles[0].date, candles[lastIndex].date, theme)}
${bodies}
`
}
