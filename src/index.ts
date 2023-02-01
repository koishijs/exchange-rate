import { Context, Schema } from 'koishi'

export const name = 'exchange-rate'

export interface Config { }

export const Config: Schema<Config> = Schema.object({})

export async function apply(ctx: Context) {
  let _symbols = await ctx.http.get('https://api.exchangerate.host/symbols')
  const symbols = Object.keys(_symbols.symbols)

  // write your plugin here
  ctx.command('exchange', '汇率查询')
    .example('20 usd to cny')
    .example('exchange -f usd -a 20')
    .option('amount', '-a <amount:number>')
    .option('from', '-f <currency>')
    .option('to', '-t <currency>', { fallback: 'CNY' })
    .shortcut(/([0-9]+(?:\.?[0-9]+)?)[\s]?([A-Za-z0-9-]{3,10})\sto\s([A-Za-z0-9-]{3,10})/, {
      options: {
        amount: '$1',
        from: '$2',
        to: '$3'
      }
    })
    .action(async ({ options }) => {
      let { from, to, amount } = options
      from = from.toUpperCase()
      to = to.toUpperCase()
      if (symbols.includes(from) && symbols.includes(to) && from !== to) {
        let r = await ctx.http.get(`https://api.exchangerate.host/convert`, {
          params: { from, to, amount }
        })
        if (r.info.rate) return `${amount} ${from} = ${r.result} ${to} (仅供参考)`
      }
      // let r = await ctx.http.get(`https://api.exchangerate.host/latest`, {
      //   params: { base: from, symbols: 'EUR', source: 'crypto', amount }
      // })
      // // if (!r.info.rate) return '货币不存在'
      // let eur = r.rates.EUR
      // let r2 = await ctx.http.get(`https://api.exchangerate.host/latest`, {
      //   params: { base: 'EUR', symbols: to, source: symbols.includes(to) ? 'ecb' : 'crypto' }
      // })
      // console.log(r, r2)
      // let target = Math.floor(1 / eur * r2.rates[to] * 100000) / 100000
      // return `${amount} ${from} = ${target} ${to} (仅供参考)`
    })
}
