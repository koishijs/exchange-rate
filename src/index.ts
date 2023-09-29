import { Context, Schema } from 'koishi'

export const name = 'exchange-rate'

export interface Config { }

export const Config: Schema<Config> = Schema.object({})

export async function apply(ctx: Context) {
  let _symbols = await ctx.http.get('https://www.mastercard.com.cn/settlement/currencyrate/settlement-currencies')
  const symbols = _symbols.data.currencies.map(v => v.alphaCd)

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
        let r = await ctx.http.get(`https://www.mastercard.com.cn/settlement/currencyrate/conversion-rate`, {
          params: {
            fxDate: '0000-00-00',
            transCurr: from,
            crdhldBillCurr: to,
            bankFee: '0',
            transAmt: amount
          }
        })
        // console.log(r)
        if (r?.data) return `${amount} ${from} = ${r.data.crdhldBillAmt} ${to} (仅供参考)`
      }
    })
}
