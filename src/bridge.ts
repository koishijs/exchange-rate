import { CryptoProvider, ExchangeCatalog } from './catalog'
import { CryptoResolver, CryptoTicker } from './crypto'
import { RateError, RateResolver } from './rate'

export class BridgeResolver {
  constructor(
    private readonly catalog: ExchangeCatalog,
    private readonly crypto: CryptoResolver,
    private readonly rates: RateResolver,
  ) {}

  async getTicker(provider: CryptoProvider, base: string, quote: string): Promise<CryptoTicker> {
    if (!this.catalog.isReady(provider)) {
      throw new RateError('unavailable', 'The crypto catalog is unavailable.')
    }
    if (this.catalog.hasPair(provider, base, quote)) {
      return this.crypto.getTicker(provider, base, quote)
    }

    const baseKind = this.catalog.getAssetKind(base)
    const quoteKind = this.catalog.getAssetKind(quote)
    if (base === quote && baseKind !== undefined) {
      return { bid: 1, ask: 1 }
    }
    if (baseKind === 'crypto' && quoteKind === 'fiat') {
      return this.combine(await Promise.all([
        this.getCryptoLeg(provider, base, 'USDT'),
        this.getFiatLeg('USD', quote),
      ]))
    }
    if (baseKind === 'fiat' && quoteKind === 'crypto') {
      return this.combine(await Promise.all([
        this.getFiatLeg(base, 'USD'),
        this.getCryptoLeg(provider, 'USDT', quote),
      ]))
    }
    if (baseKind === 'crypto' && quoteKind === 'crypto') {
      return this.combine(await Promise.all([
        this.getCryptoLeg(provider, base, 'USDT'),
        this.getCryptoLeg(provider, 'USDT', quote),
      ]))
    }

    throw new RateError('unsupported', 'The requested currency pair is not supported.')
  }

  private async getCryptoLeg(provider: CryptoProvider, base: string, quote: string): Promise<CryptoTicker> {
    if (base === quote) return { bid: 1, ask: 1 }
    if (!this.catalog.hasPair(provider, base, quote)) {
      throw new RateError('unsupported', 'The requested crypto pair is not supported.')
    }
    return this.crypto.getTicker(provider, base, quote)
  }

  private async getFiatLeg(base: string, quote: string): Promise<CryptoTicker> {
    if (base === quote) return { bid: 1, ask: 1 }
    if (!this.catalog.isReady('frankfurter')) {
      throw new RateError('unavailable', 'The exchange-rate catalog is unavailable.')
    }
    const { rate } = await this.rates.getRate(base, quote)
    return { bid: rate, ask: rate }
  }

  private combine([first, second]: [CryptoTicker, CryptoTicker]): CryptoTicker {
    const result = {
      bid: first.bid * second.bid,
      ask: first.ask * second.ask,
    }
    if (!Number.isFinite(result.bid) || !Number.isFinite(result.ask)
      || result.bid <= 0 || result.ask <= 0 || result.bid > result.ask) {
      throw new RateError('unavailable', 'Received an invalid bridged crypto ticker response.')
    }
    return result
  }
}
