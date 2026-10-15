import { RateError } from './rate'

export interface HistoryPoint {
  date: string
  rate: number
}

export interface HistoryHttpClient {
  get<T>(url: string, config?: { timeout?: number }): Promise<T>
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

export function buildChartSource(base: string, quote: string, series: HistoryPoint[], theme: ChartTheme = defaultTheme, liveRate?: number): string {
  const rates = series.map((point) => point.rate)
  if (liveRate !== undefined && Number.isFinite(liveRate) && liveRate > 0) {
    rates[rates.length - 1] = liveRate
  }
  const min = Math.min(...rates)
  const max = Math.max(...rates)
  const span = max - min || max * 0.001 || 1
  const { width: W, height: H } = theme
  const { left: PAD_L, right: PAD_R, top: PAD_T, bottom: PAD_B } = theme.padding
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B
  const px = (i: number) => PAD_L + (i / (series.length - 1)) * plotW
  const py = (v: number) => PAD_T + (1 - (v - min) / span) * plotH
  const point = (i: number, v: number) => `(${px(i).toFixed(1)}pt, ${py(v).toFixed(1)}pt)`

  const up = rates[rates.length - 1] >= rates[0]
  const lineColor = up ? theme.upColor : theme.downColor
  const change = (rates[rates.length - 1] / rates[0] - 1) * 100
  const changeText = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`

  const moves = series.slice(1).map(({ rate }, i) => `curve.line(${point(i + 1, rate)})`)
  const areaMoves = [...moves, `curve.line((${px(series.length - 1).toFixed(1)}pt, ${(H - PAD_B).toFixed(1)}pt))`]

  const gridLine = (v: number, label: string) => `#place(dx: ${PAD_L}pt, dy: ${py(v).toFixed(1)}pt)[#line(length: ${plotW.toFixed(1)}pt, stroke: 0.5pt + rgb("${theme.gridColor}"))]
#place(dx: 0pt, dy: ${(py(v) - 7).toFixed(1)}pt)[#box(width: ${(PAD_L - 6).toFixed(1)}pt)[#align(right)[#text(size: 12pt, fill: rgb("${theme.mutedColor}"))[${label}]]]]`
  const ticks = [max, min + span / 2, min]
  const tickLabels = [formatRate(max), formatRate(min + span / 2), formatRate(min)]

  const dateLabel = (i: number, alignment: string) => `#place(${alignment}, dx: ${alignment.includes('right') ? -PAD_R : PAD_L}pt, dy: -16pt)[#text(size: 12pt, fill: rgb("${theme.mutedColor}"))[${series[i].date.slice(5)}]]`
  const lastIndex = series.length - 1

  return `#set page(width: ${W}pt, height: ${H}pt, margin: 0pt)
#place(dx: 0pt, dy: 0pt)[#rect(width: ${W}pt, height: ${H}pt, fill: rgb("#ffffff"), stroke: none)]
#set text(font: "Noto Sans SC", size: 12pt, fill: rgb("${theme.textColor}"))
#place(top + left, dx: ${PAD_L}pt, dy: 16pt)[#text(size: 20pt, weight: 600)[${base}/${quote}]#h(12pt)#text(size: 20pt, weight: 600, fill: rgb("${lineColor}"))[${formatRate(rates[lastIndex])}]#h(8pt)#text(size: 13pt, fill: rgb("${lineColor}"))[${changeText}]]
#place(top + right, dx: -${PAD_R}pt, dy: 22pt)[#text(size: 11pt, fill: rgb("${theme.mutedColor}"))[${series[0].date} ~ ${series[lastIndex].date}]]
${ticks.map((v, i) => gridLine(v, tickLabels[i])).join('\n')}
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
${dateLabel(0, 'bottom + left')}
${dateLabel(lastIndex, 'bottom + right')}
`
}
