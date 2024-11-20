import { Context, HTTP, Schema, trimSlash } from 'koishi'

export const name = 'exchange-rate'

export interface Config {
  API: string
  quick: boolean
}

export const Config: Schema<Config> = Schema.object({
  API: Schema.union([
    Schema.const('https://www.mastercard.com').description('Global'),
    Schema.const('https://www.mastercard.com.cn').description('CN'),
  ]).default('https://www.mastercard.com.cn').description('API 地址'),
  quick: Schema.boolean().description('快速查询').default(true),
}) as Schema<Config>

export async function apply(ctx: Context, config: Config) {
  const regexp = /([0-9]+(?:\.?[0-9]+)?)[\s]?([A-Za-z0-9-]{3,10})\sto\s([A-Za-z0-9-]{3,10})/
  const symbols = []

  ctx.command('exchange', '汇率查询')
    .example('20 usd to cny')
    .example('exchange -f usd -a 20')
    .option('amount', '-a <amount:number>')
    .option('from', '-f <currency>')
    .option('to', '-t <currency>', { fallback: 'CNY' })
    .action(async ({ options }) => {
      if (!symbols.length) {
        const _symbols = await ctx.http.get(`${trimSlash(config.API)}/settlement/currencyrate/settlement-currencies`)
        symbols.push(..._symbols.data.currencies.map(v => v.alphaCd))
      }

      let { from, to, amount } = options
      from = from.toUpperCase()
      to = to.toUpperCase()
      if (symbols.includes(from) && symbols.includes(to) && from !== to) {
        const r = await ctx.http.get(`${trimSlash(config.API)}/settlement/currencyrate/conversion-rate`, {
          params: {
            fxDate: '0000-00-00',
            transCurr: from,
            crdhldBillCurr: to,
            bankFee: '0',
            transAmt: amount
          }
        }).catch((err) => {
          if (HTTP.Error.is(err)) {
            ctx.logger.warn(
              `${err.response?.status}: ${JSON.stringify(err)}.`,
            )
          } else {
            ctx.logger.error(`${err.message}.`)
          }
          return err
        })

        if (r?.data) return `${amount} ${from} = ${r.data.crdhldBillAmt} ${to} (仅供参考)`
      }
    })

  if (config.quick) {
    ctx.middleware((session, next) => {
      const elements = session.elements
      const selfId = session.bot.selfId
      const prefix: string | string[] = session.app.config.prefix.valueOf()

      if (!elements || !elements.length) {
        return next()
      }
      if (elements[0].type === 'at' && elements[0].attrs?.id === selfId) {
        elements.shift()
      }
      if (elements[0].type !== 'text') {
        return next()
      }

      let msg: string = elements[0].attrs.content.trim()
      if (typeof prefix === 'string') {
        if (msg.startsWith(prefix)) {
          msg = msg.substring(prefix.length, msg.length)
        }
      } else if (Array.isArray(prefix)) {
        for (const pre of prefix) {
          if (msg.startsWith(pre)) {
            msg = msg.substring(pre.length, msg.length)
          }
        }
      }

      const expr = msg.match(regexp)
      if (!expr) return next()
      return session.execute({ name: 'exchange', options: { amount: expr[1], from: expr[2], to: expr[3] } })
    })
  }
}
