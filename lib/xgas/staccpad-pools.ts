import { ChainId, Currency, Token } from '@uniswap/sdk-core'
import {
  getAddressLowerCase,
  IV4PoolProvider,
  IV4SubgraphProvider,
  log,
  nativeOnChain,
  V4SubgraphPool,
} from '@uniswap/smart-order-router'
import { ProviderConfig } from '@uniswap/smart-order-router/build/main/providers/provider'
import { BASES_TO_CHECK_TRADES_AGAINST } from '@uniswap/smart-order-router/build/main/providers/caching-subgraph-provider'
import { V4PoolConstruct } from '@uniswap/smart-order-router/build/main/providers/v4/pool-provider'
import axios from 'axios'
import JSBI from 'jsbi'

/**
 * staccpad.fun's AMMs as a pool list for Robinhood (4663). Its peg pools are plain v4 pools on the canonical
 * PoolManager (a claim token against ETH, USDG or another token), so the stock router can quote them; it only
 * has to be told they exist. The site already publishes every market at /api/markets: that is the index.
 * Pools on staccpad's own PoolManager are left out: the canonical quoter cannot see them.
 */
const FEED = process.env.STACCPAD_MARKETS_URL ?? 'https://staccpad.fun/api/markets'
const CANONICAL_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ZERO = '0x0000000000000000000000000000000000000000'
const TTL_MS = 60_000
const RETRY_MS = 10_000
const FEED_TIMEOUT_MS = 4_000
// a claim has a handful of pools; this only bounds the reads if the feed ever lists far more
const MAX_CONNECTORS = 8
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

type FeedToken = { id: string; symbol: string; decimals: number }
export type FeedPool = { claim: FeedToken; quote: FeedToken; fee: number; tickSpacing: number; hooks: string }

/** One market of the feed as a pool key, or null when it is not a canonical-PoolManager pool we can describe. */
export function parseMarket(m: any): FeedPool | null {
  const p = m?.pool
  if (!p || String(p.poolManager).toLowerCase() !== CANONICAL_POOL_MANAGER) return null
  const claim = String(m.vaultAddress ?? '')
  const quote = String(p.quoteToken ?? '')
  const hooks = String(p.hook ?? ZERO)
  const fee = Number(p.fee)
  const tickSpacing = Number(p.tickSpacing)
  const decimals = Number(p.quoteDecimals ?? 18)
  if (!ADDRESS.test(claim) || !ADDRESS.test(quote) || !ADDRESS.test(hooks)) return null
  if (claim.toLowerCase() === quote.toLowerCase()) return null
  if (!Number.isInteger(fee) || fee < 0 || !Number.isInteger(tickSpacing) || tickSpacing <= 0) return null
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null
  return {
    claim: { id: claim.toLowerCase(), symbol: String(m.ticker ?? 'CLAIM').slice(0, 20), decimals: 18 },
    quote: { id: quote.toLowerCase(), symbol: String(p.quoteSymbol ?? '').slice(0, 20), decimals },
    fee,
    tickSpacing,
    hooks: hooks.toLowerCase(),
  }
}

/** Every pool the body lists. Throws when the body carries no market list (the feed answers without one while it warms up). */
export function parseFeed(body: any): FeedPool[] {
  if (!body || !Array.isArray(body.markets)) throw new Error('staccpad feed: no markets in the body')
  const pools: FeedPool[] = []
  for (const m of body.markets) {
    try {
      const pool = parseMarket(m)
      if (pool) pools.push(pool)
    } catch {
      // one malformed market must not cost the rest
    }
  }
  return pools
}

let cache: { at: number; pools: FeedPool[] } = { at: 0, pools: [] }
let inflight: Promise<void> | null = null

function refresh(): Promise<void> {
  if (!inflight) {
    inflight = axios
      .get(FEED, { timeout: FEED_TIMEOUT_MS })
      .then((res) => {
        const pools = parseFeed(res.data)
        // an empty list right after a full one is the feed restarting, not every market closing
        if (pools.length === 0 && cache.pools.length > 0) throw new Error('staccpad feed: empty market list')
        cache = { at: Date.now(), pools }
      })
      .catch((err) => {
        // keep the last list and look again soon: a feed that is down must never take a quote with it
        log.warn({ err: String(err?.message ?? err) }, 'staccpad feed unavailable, keeping the last pool list')
        cache = { at: Date.now() - TTL_MS + RETRY_MS, pools: cache.pools }
      })
      .then(() => {
        inflight = null
      })
  }
  return inflight
}

/** The feed's pools. Fresh for a minute; after that the last list is served at once while one read refreshes it. */
export async function staccpadPools(): Promise<FeedPool[]> {
  if (Date.now() - cache.at < TTL_MS) return cache.pools
  const pending = refresh()
  if (cache.pools.length === 0) await pending
  return cache.pools
}

/** Test hook: forget the list. */
export function resetStaccpadPools() {
  cache = { at: 0, pools: [] }
  inflight = null
}

/**
 * The static list the router would use anyway, plus the staccpad pools of the two tokens being traded.
 * Only pools whose claim is one end of the trade are added (every other market is noise that crowds the router's
 * top-N selection), each read from the chain so it ranks by real liquidity like the static pools do. A claim
 * priced in a token that is not ETH, WETH or USDG is only reachable through that token, so the pools between
 * that token and the bases (and the other end) are looked up too: that is what makes ETH to such a claim a route.
 */
export class StaccpadV4SubgraphProvider implements IV4SubgraphProvider {
  constructor(
    private chainId: ChainId,
    private base: IV4SubgraphProvider,
    private poolProvider: IV4PoolProvider,
    private v4PoolParams: Array<[number, number, string]>
  ) {}

  async getPools(currencyIn?: Currency, currencyOut?: Currency, providerConfig?: ProviderConfig): Promise<V4SubgraphPool[]> {
    const [base, feed] = await Promise.all([
      this.base.getPools(currencyIn, currencyOut, providerConfig).catch(() => [] as V4SubgraphPool[]),
      staccpadPools().catch(() => [] as FeedPool[]),
    ])
    if (!currencyIn || !currencyOut || feed.length === 0) return base
    let ours: V4SubgraphPool[] = []
    try {
      ours = await this.poolsFor(feed, currencyIn, currencyOut, providerConfig)
    } catch (err: any) {
      log.warn({ err: String(err?.message ?? err) }, 'staccpad pools could not be read, quoting with the static list')
    }
    const seen = new Set(base.map((p) => p.id.toLowerCase()))
    return [...base, ...ours.filter((p) => !seen.has(p.id.toLowerCase()))]
  }

  private async poolsFor(
    feed: FeedPool[],
    currencyIn: Currency,
    currencyOut: Currency,
    providerConfig?: ProviderConfig
  ): Promise<V4SubgraphPool[]> {
    const bases: Currency[] = BASES_TO_CHECK_TRADES_AGAINST[this.chainId] ?? []
    const known = new Map<string, Currency>()
    for (const c of [...bases, currencyIn, currencyOut]) known.set(getAddressLowerCase(c), c)
    const ends = [getAddressLowerCase(currencyIn), getAddressLowerCase(currencyOut)]
    const currencyOf = (t: FeedToken): Currency =>
      known.get(t.id) ?? (t.id === ZERO ? nativeOnChain(this.chainId) : new Token(this.chainId, t.id, t.decimals, t.symbol))

    const constructs: V4PoolConstruct[] = []
    const connectors = new Map<string, Currency>()
    for (const p of feed) {
      if (!ends.includes(p.claim.id)) continue
      constructs.push([currencyOf(p.claim), currencyOf(p.quote), p.fee, p.tickSpacing, p.hooks])
      if (!known.has(p.quote.id) && connectors.size < MAX_CONNECTORS) connectors.set(p.quote.id, currencyOf(p.quote))
    }
    if (constructs.length === 0) return []
    for (const q of connectors.values()) {
      for (const other of known.values()) {
        if (other.wrapped.address === q.wrapped.address) continue
        for (const [fee, tickSpacing, hooks] of this.v4PoolParams) constructs.push([q, other, fee, tickSpacing, hooks])
      }
    }

    const pools = (await this.poolProvider.getPools(constructs, providerConfig)).getAllPools()
    const seen = new Set<string>()
    const out: V4SubgraphPool[] = []
    for (const pool of pools) {
      const { poolId } = this.poolProvider.getPoolId(pool.token0, pool.token1, pool.fee, pool.tickSpacing, pool.hooks)
      if (seen.has(poolId)) continue
      seen.add(poolId)
      // as the static list does: liquidity stands in for TVL, it only ranks candidates
      const liquidity = JSBI.toNumber(pool.liquidity)
      out.push({
        id: poolId,
        feeTier: pool.fee.toString(),
        tickSpacing: pool.tickSpacing.toString(),
        hooks: pool.hooks,
        liquidity: pool.liquidity.toString(),
        token0: { id: getAddressLowerCase(pool.token0), symbol: pool.token0.symbol ?? '', decimals: pool.token0.decimals.toString() },
        token1: { id: getAddressLowerCase(pool.token1), symbol: pool.token1.symbol ?? '', decimals: pool.token1.decimals.toString() },
        tvlETH: liquidity,
        tvlUSD: liquidity,
      })
    }
    return out
  }
}
