import { Currency } from '@uniswap/sdk-core'
import { IV4SubgraphProvider, V4SubgraphPool } from '@uniswap/smart-order-router'
import { ProviderConfig } from '@uniswap/smart-order-router/build/main/providers/provider'
import axios from 'axios'

/**
 * staccpad.fun's AMMs as a pool list for Robinhood (4663). Its peg pools are plain v4 pools on the canonical
 * PoolManager (a claim token against ETH, USDG or another token), so the stock router can quote them; it only
 * has to be told they exist. The site already publishes every market at /api/markets: that is the index.
 * Pools on staccpad's own PoolManager are left out: the canonical quoter cannot see them.
 */
const FEED = process.env.STACCPAD_MARKETS_URL ?? 'https://staccpad.fun/api/markets'
const CANONICAL_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const TTL_MS = 60_000

let cache: { at: number; pools: V4SubgraphPool[] } = { at: 0, pools: [] }

export async function staccpadPools(): Promise<V4SubgraphPool[]> {
  if (Date.now() - cache.at < TTL_MS) return cache.pools
  try {
    const markets: any[] = (await axios.get(FEED, { timeout: 4_000 })).data?.markets ?? []
    const pools: V4SubgraphPool[] = []
    for (const m of markets) {
      const p = m?.pool
      if (!p || String(p.poolManager).toLowerCase() !== CANONICAL_POOL_MANAGER) continue
      if (!/^0x[0-9a-fA-F]{64}$/.test(p.poolId ?? '') || !/^0x[0-9a-fA-F]{40}$/.test(m.vaultAddress ?? '')) continue
      const claim = { id: String(m.vaultAddress).toLowerCase(), symbol: String(m.ticker ?? 'CLAIM').slice(0, 20), decimals: '18' }
      const quote = { id: String(p.quoteToken).toLowerCase(), symbol: String(p.quoteSymbol ?? ''), decimals: String(p.quoteDecimals ?? 18) }
      const [token0, token1] = BigInt(claim.id) < BigInt(quote.id) ? [claim, quote] : [quote, claim]
      // the site's ETH figures stand in for TVL: they only rank candidates, the quote itself comes from the chain
      const tvlETH = Math.max(Number(m.marketCapETH) || 0, 1)
      pools.push({
        id: String(p.poolId).toLowerCase(),
        feeTier: String(p.fee),
        tickSpacing: String(p.tickSpacing),
        hooks: String(p.hook ?? '0x0000000000000000000000000000000000000000').toLowerCase(),
        liquidity: '1000000000000000000',
        token0,
        token1,
        tvlETH,
        tvlUSD: tvlETH * 2500,
      })
    }
    cache = { at: Date.now(), pools }
  } catch {
    cache = { at: Date.now() - TTL_MS + 10_000, pools: cache.pools } // keep the last list, try again in 10s
  }
  return cache.pools
}

/** The static list the router would use anyway, plus every staccpad pool. */
export class StaccpadV4SubgraphProvider implements IV4SubgraphProvider {
  constructor(private base: IV4SubgraphProvider) {}

  async getPools(currencyIn?: Currency, currencyOut?: Currency, providerConfig?: ProviderConfig): Promise<V4SubgraphPool[]> {
    const [base, ours] = await Promise.all([
      this.base.getPools(currencyIn, currencyOut, providerConfig).catch(() => [] as V4SubgraphPool[]),
      staccpadPools(),
    ])
    const seen = new Set(ours.map((p) => p.id))
    return [...ours, ...base.filter((p) => !seen.has(p.id.toLowerCase()))]
  }
}
