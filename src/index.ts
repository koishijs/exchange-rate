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
      if (symbols.includes(from) && symbols.includes(to)) {
        let r = await ctx.http.get(`https://api.exchangerate.host/convert`, {
          params: { from, to, amount }
        })
        if (r.info.rate) return `${amount} ${from} = ${r.result} ${to} (仅供参考)`
      }
      if (symbols.includes(to)) {
        let r = await ctx.http.get(`https://api.exchangerate.host/convert`, {
          params: { to: 'EUR', source: 'crypto', amount, from }
        })
        if (!r.info.rate) return '货币不存在'
        let r2 = await ctx.http.get(`https://api.exchangerate.host/convert`, {
          params: { from: 'EUR', to, amount: r.result }
        })
        return `${amount} ${from} = ${r2.result} ${to} (虚拟货币转现实货币, 仅供参考)`
      } else {
        let r = await ctx.http.get(`https://api.exchangerate.host/latest`, {
          params: { base: to, source: 'crypto', amount }
        })
        if (r.base !== to) return '货币不存在'
        if (!r.rates[from]) return '输入货币不存在'
        return `${amount} ${from} = ${r.rates[from]} ${to} (虚拟货币转虚拟货币, 仅供参考)`
      }
    })
}
