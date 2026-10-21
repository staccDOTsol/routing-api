import { GasPrice, IGasPriceProvider, ITokenProvider, TokenAccessor } from '@uniswap/smart-order-router'
import { ProviderConfig } from '@uniswap/smart-order-router/build/main/providers/provider'
import { ITokenFeeFetcher, TokenFeeMap } from '@uniswap/smart-order-router/build/main/providers/token-fee-fetcher'

const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * The gas price of the last few seconds. The router asks for it once per quote, in a round trip of its own before
 * anything else, and only uses it to estimate what a route costs: it never goes into the transaction. The stock
 * cache is keyed by block number, so on a chain with 0.1 s blocks it never hits.
 */
export class RecentGasPriceProvider extends IGasPriceProvider {
  private recent?: { at: number; pending: Promise<GasPrice> }

  constructor(private inner: IGasPriceProvider, private ttlMs: number = 10_000) {
    super()
  }

  override getGasPrice(latestBlockNumber: number, requestBlockNumber?: number): Promise<GasPrice> {
    // a quote pinned to a block of its own is asking about that block, not about now
    if (requestBlockNumber !== undefined) return this.inner.getGasPrice(latestBlockNumber, requestBlockNumber)
    if (this.recent && Date.now() - this.recent.at < this.ttlMs) return this.recent.pending
    const pending = this.inner.getGasPrice(latestBlockNumber, requestBlockNumber)
    this.recent = { at: Date.now(), pending }
    pending.catch(() => {
      if (this.recent?.pending === pending) this.recent = undefined
    })
    return pending
  }
}

/** For a chain with no fee-on-transfer detector deployed: nothing to ask, so nothing is asked (and nothing fails). */
export class NoTokenFeeFetcher implements ITokenFeeFetcher {
  async fetchFees(): Promise<TokenFeeMap> {
    return {}
  }
}

/**
 * The native currency is not a token: v4 pool lists carry it as the zero address, and looking that up on chain
 * (symbol(), decimals() on address zero) fails on every quote, two calls and two error logs each time. The router
 * builds native pools from the chain's native currency itself and never reads this entry.
 */
export class SkipNativeTokenProvider implements ITokenProvider {
  constructor(private inner: ITokenProvider) {}

  getTokens(addresses: string[], providerConfig?: ProviderConfig): Promise<TokenAccessor> {
    return this.inner.getTokens(
      addresses.filter((a) => a.toLowerCase() !== ZERO),
      providerConfig
    )
  }
}
