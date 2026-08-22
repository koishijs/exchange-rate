export interface ExchangeQuery {
  amount: number
  base: string
  quote: string
}

const aliases: Record<string, string> = {
  '$': 'USD',
  'US$': 'USD',
  '美元': 'USD',
  RMB: 'CNY',
  'CN¥': 'CNY',
  '￥': 'CNY',
  '¥': 'CNY',
  '人民币': 'CNY',
  '£': 'GBP',
  '英镑': 'GBP',
  '€': 'EUR',
  '欧元': 'EUR',
  'JP¥': 'JPY',
  '円': 'JPY',
  '日元': 'JPY',
  'HK$': 'HKD',
  '港币': 'HKD',
  '港元': 'HKD',
}

const aliasPattern = Object.keys(aliases)
  .sort((left, right) => right.length - left.length)
  .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')
const currencyPattern = `(?:${aliasPattern}|[A-Z]{2,10})`
const amountPattern = '(?:0|[1-9]\\d*)(?:\\.\\d{1,12})?'
const whitespacePattern = '[ \\t]*'
export const exchangeQueryPattern = new RegExp(
  `^(${whitespacePattern}(?:(?<baseBefore>${currencyPattern})${whitespacePattern}(?<amountBefore>${amountPattern})|(?<amountAfter>${amountPattern})${whitespacePattern}(?<baseAfter>${currencyPattern}))${whitespacePattern}to${whitespacePattern}(?<quote>${currencyPattern})${whitespacePattern})$`,
  'i',
)

function normalizeCurrency(value: string): string | null {
  const normalized = value.normalize('NFKC')
  const upperCase = normalized.toUpperCase()
  return aliases[upperCase] ?? aliases[normalized] ?? (/^[A-Z]{2,10}$/.test(upperCase) ? upperCase : null)
}

function isSafeDecimal(value: string): boolean {
  const [integer, fraction] = value.split('.')
  const maximum = String(Number.MAX_SAFE_INTEGER)
  if (integer.length < maximum.length) return true
  if (integer.length > maximum.length || integer > maximum) return false
  return !fraction || /^0+$/.test(fraction)
}

export function parseExchangeQuery(input: string): ExchangeQuery | null {
  if (/[\r\n]/.test(input)) return null
  const match = exchangeQueryPattern.exec(input)
  if (!match?.groups) return null

  const amountText = match.groups.amountBefore ?? match.groups.amountAfter
  const baseText = match.groups.baseBefore ?? match.groups.baseAfter
  const amount = Number(amountText)
  const base = normalizeCurrency(baseText)
  const quote = normalizeCurrency(match.groups.quote)

  if (!isSafeDecimal(amountText) || !Number.isFinite(amount) || amount < 0 || !base || !quote) {
    return null
  }

  return { amount, base, quote }
}
