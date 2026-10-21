import { Protocol } from '@uniswap/router-sdk'
import { ChainId, Currency, CurrencyAmount, TradeType } from '@uniswap/sdk-core'
import {
  AlphaRouter,
  AlphaRouterConfig,
  CachedRoute,
  CachedRoutes,
  getAddressLowerCase,
  INTENT,
  log,
  metric,
  MetricLoggerUnit,
  RouteWithValidQuote,
  SupportedRoutes,
  SwapOptions,
  SwapRoute,
  SwapType,
} from '@uniswap/smart-order-router'
import { NATIVE_OVERHEAD } from '@uniswap/smart-order-router/build/main/routers/alpha-router/gas-models/gas-costs'
import { buildSwapMethodParameters, buildTrade } from '@uniswap/smart-order-router/build/main/util/methodParameters'
import { Pair } from '@uniswap/v2-sdk'
import { Pool as V3Pool } from '@uniswap/v3-sdk'
import { Pool as V4Pool } from '@uniswap/v4-sdk'
import { BigNumber } from 'ethers'

/**
 * A repeat pair skips route discovery.
 *
 * A quote spends most of its time finding routes: listing pools, reading their state, building the gas models,
 * pricing every candidate route at every split. On a Lambda with a third of a vCPU that is close to a second,
 * and a swap form asks again on every keystroke. The best routes the last search found for a pair are kept here,
 * in the Lambda instance's memory, and the next quote for that pair only prices those again on chain: one
 * multicall to the quoter at the current block, the pool state read beside it, the split chosen again for the
 * new amount. No price is remembered. What is remembered is which routes to ask, the gas models and the gas
 * price, and only for HOT_ROUTE_MAX_AGE_MS (and that many blocks where the block time is known), because these
 * pools are thin and a better route can appear at any time. Any failure, and any quote that finds no liquidity on
 * the remembered routes, falls through to the full search.
 *
 * Upstream's own route cache (RoutesDB) does not do this job here: it is only read when a request names every
 * protocol including `mixed`, it is refreshed by invoking a second Lambda per pair, and a stored route lives for
 * 24 hours.
 */
const ENABLED = process.env.HOT_ROUTES !== 'off'
const HOT_ROUTE_MAX_AGE_MS = 15_000
// the same 15 seconds in blocks; a chain not listed is held to the clock alone
const HOT_ROUTE_BLOCKS: { [chainId: number]: number } = {
  [ChainId.ROBINHOOD]: 150, // 0.1 s blocks
  [ChainId.ARBITRUM_ONE]: 60, // 0.25 s
  [ChainId.BNB]: 20, // 0.75 s
  [ChainId.UNICHAIN]: 15, // 1 s
  [ChainId.BASE]: 8, // 2 s
  [ChainId.OPTIMISM]: 8,
  [ChainId.POLYGON]: 8,
  [ChainId.AVALANCHE]: 10,
  [ChainId.MAINNET]: 2, // 12 s
}
// the winners of the last search and the next best candidates: enough to split a different amount well,
// few enough to price in one call
const MAX_ROUTES_PER_PAIR = 6
const MAX_PAIRS = 300

type GasModels = { v2GasModel: any; v3GasModel: any; v4GasModel: any; mixedRouteGasModel: any }
type HotEntry = {
  routes: CachedRoute<SupportedRoutes>[]
  protocols: Protocol[]
  blockNumber: number
  at: number
  gasPriceWei: BigNumber
  gasModels: GasModels
}

const entries = new Map<string, HotEntry>()

/** Test hook. */
export function resetHotRoutes() {
  entries.clear()
}

export function hotRouteKey(
  chainId: ChainId,
  currencyIn: Currency,
  currencyOut: Currency,
  tradeType: TradeType,
  protocols: Protocol[]
): string {
  return [chainId, getAddressLowerCase(currencyIn), getAddressLowerCase(currencyOut), tradeType, [...protocols].sort().join(',')].join(':')
}

/** Only a plain quote takes the short path: anything that changes what the full search would do goes to the full search. */
export function hotRouteEligible(swapConfig?: SwapOptions, config?: Partial<AlphaRouterConfig>): boolean {
  if (!ENABLED || !config || !config.protocols || config.protocols.length === 0) return false
  if (config.intent === INTENT.CACHING || config.blockNumber !== undefined || config.gasToken) return false
  if (config.enableFeeOnTransferFeeFetching || config.debugRouting || config.cachedRoutesRouteIds) return false
  if (config.hooksOptions !== undefined || (config.poolsToManuallyRouteThrough?.length ?? 0) > 0) return false
  if (config.forceCrossProtocol || config.forceMixedRoutes || (config.minSplits ?? 1) > 1) return false
  if (!swapConfig) return true
  if (swapConfig.type !== SwapType.UNIVERSAL_ROUTER || swapConfig.simulate) return false
  // a portion changes the amount that is routed; leave those to the full path
  return !swapConfig.fee && !swapConfig.flatFee
}

/**
 * The routes worth asking again: the winners first, then the other candidates of the search by what they paid
 * per unit at the largest share they could fill.
 */
export function routesToRemember(
  winners: CachedRoute<SupportedRoutes>[],
  candidates: RouteWithValidQuote[],
  tradeType: TradeType,
  max: number = MAX_ROUTES_PER_PAIR
): CachedRoute<SupportedRoutes>[] {
  const routes = [...winners]
  const seen = new Set(routes.map((r) => r.routeId))
  const largest = new Map<number, { cached: CachedRoute<SupportedRoutes>; candidate: RouteWithValidQuote }>()
  for (const candidate of candidates) {
    let cached: CachedRoute<SupportedRoutes>
    try {
      cached = new CachedRoute({ route: candidate.route, percent: candidate.percent })
    } catch {
      continue
    }
    const held = largest.get(cached.routeId)
    if (!held || candidate.percent > held.candidate.percent) largest.set(cached.routeId, { cached, candidate })
  }
  const better = (a: RouteWithValidQuote, b: RouteWithValidQuote) => {
    // quote per percent, cross-multiplied; exact-in wants more out, exact-out wants less in
    const [x, y] = [a.quoteAdjustedForGas.multiply(b.percent), b.quoteAdjustedForGas.multiply(a.percent)]
    if (x.equalTo(y)) return 0
    return x.greaterThan(y) === (tradeType === TradeType.EXACT_INPUT) ? -1 : 1
  }
  const rest = [...largest.values()].filter((r) => !seen.has(r.cached.routeId))
  try {
    rest.sort((a, b) => better(a.candidate, b.candidate))
  } catch {
    // quotes in different currencies cannot be ranked; keep the search order
  }
  for (const r of rest) {
    if (routes.length >= max) break
    routes.push(r.cached)
  }
  return routes.slice(0, Math.max(max, winners.length))
}

export class HotRouteAlphaRouter extends AlphaRouter {
  private captured?: { gasPriceWei: BigNumber; gasModels: GasModels }
  private candidates: RouteWithValidQuote[] = []

  constructor(params: ConstructorParameters<typeof AlphaRouter>[0]) {
    super(params)
    if (!ENABLED) return
    // The full search builds the gas models (two rounds of pool reads) and prices every candidate route.
    // Keep both as they pass, for the short path of the next quote.
    const self = this as any
    const buildGasModels = self.getGasModels.bind(this)
    self.getGasModels = async (gasPriceWei: BigNumber, ...rest: any[]) => {
      const gasModels: GasModels = await buildGasModels(gasPriceWei, ...rest)
      this.captured = { gasPriceWei, gasModels }
      return gasModels
    }
    for (const name of ['v2Quoter', 'v3Quoter', 'v4Quoter', 'mixedQuoter']) {
      const quoter = self[name]
      if (!quoter?.getRoutesThenQuotes) continue
      const getRoutesThenQuotes = quoter.getRoutesThenQuotes.bind(quoter)
      quoter.getRoutesThenQuotes = async (...args: any[]) => {
        const result = await getRoutesThenQuotes(...args)
        if (result?.routesWithValidQuotes) this.candidates.push(...result.routesWithValidQuotes)
        return result
      }
    }
  }

  public override async route(
    amount: CurrencyAmount<Currency>,
    quoteCurrency: Currency,
    tradeType: TradeType,
    swapConfig?: SwapOptions,
    partialRoutingConfig: Partial<AlphaRouterConfig> = {}
  ): Promise<SwapRoute | null> {
    const [currencyIn, currencyOut] =
      tradeType === TradeType.EXACT_INPUT ? [amount.currency, quoteCurrency] : [quoteCurrency, amount.currency]
    const key = hotRouteEligible(swapConfig, partialRoutingConfig)
      ? hotRouteKey(this.chainId, currencyIn, currencyOut, tradeType, partialRoutingConfig.protocols!)
      : undefined

    if (key && entries.has(key)) {
      const before = Date.now()
      try {
        const hot = await this.routeFromMemory(key, currencyIn, currencyOut, amount, quoteCurrency, tradeType, swapConfig, partialRoutingConfig)
        if (hot) {
          metric.putMetric('HotRouteHit', 1, MetricLoggerUnit.Count)
          metric.putMetric('HotRouteLatency', Date.now() - before, MetricLoggerUnit.Milliseconds)
          return hot
        }
      } catch (err: any) {
        log.warn({ err: String(err?.message ?? err).slice(0, 300) }, 'hot route could not be priced, running the full search')
      }
      entries.delete(key)
      metric.putMetric('HotRouteFallback', 1, MetricLoggerUnit.Count)
    }

    this.captured = undefined
    this.candidates = []
    const swapRoute = await super.route(amount, quoteCurrency, tradeType, swapConfig, partialRoutingConfig)
    if (key && swapRoute && this.captured && !swapRoute.hitsCachedRoute) {
      try {
        this.remember(key, currencyIn, currencyOut, amount, tradeType, partialRoutingConfig.protocols!, swapRoute, this.captured)
      } catch (err: any) {
        log.warn({ err: String(err?.message ?? err).slice(0, 300) }, 'hot route not remembered')
      }
    }
    return swapRoute
  }

  private remember(
    key: string,
    currencyIn: Currency,
    currencyOut: Currency,
    amount: CurrencyAmount<Currency>,
    tradeType: TradeType,
    protocols: Protocol[],
    swapRoute: SwapRoute,
    gas: { gasPriceWei: BigNumber; gasModels: GasModels }
  ) {
    const blockNumber = swapRoute.blockNumber.toNumber()
    const winners = CachedRoutes.fromRoutesWithValidQuotes(
      swapRoute.route,
      this.chainId,
      currencyIn,
      currencyOut,
      [...protocols].sort(),
      blockNumber,
      tradeType,
      amount.toExact()
    )
    if (!winners || winners.routes.length === 0) return
    const routes = routesToRemember(winners.routes, this.candidates, tradeType)
    if (!entries.has(key) && entries.size >= MAX_PAIRS) entries.delete(entries.keys().next().value!)
    entries.delete(key) // re-insert, so the map stays ordered by last search
    entries.set(key, { routes, protocols, blockNumber, at: Date.now(), ...gas })
  }

  private async routeFromMemory(
    key: string,
    currencyIn: Currency,
    currencyOut: Currency,
    amount: CurrencyAmount<Currency>,
    quoteCurrency: Currency,
    tradeType: TradeType,
    swapConfig: SwapOptions | undefined,
    partialRoutingConfig: Partial<AlphaRouterConfig>
  ): Promise<SwapRoute | null> {
    const entry = entries.get(key)!
    if (Date.now() - entry.at > HOT_ROUTE_MAX_AGE_MS) return null
    const blockNumber = await this.provider.getBlockNumber()
    const blocks = HOT_ROUTE_BLOCKS[this.chainId]
    const age = blockNumber - entry.blockNumber
    if (age < 0 || (blocks !== undefined && age > blocks)) return null

    metric.setProperty('chainId', this.chainId)
    metric.setProperty('pair', `${currencyIn.symbol}/${currencyOut.symbol}`)
    metric.putMetric(`QuoteRequestedForChain${this.chainId}`, 1, MetricLoggerUnit.Count)

    const routingConfig = { ...partialRoutingConfig, blockNumber } as AlphaRouterConfig
    const providerConfig = {
      ...routingConfig,
      additionalGasOverhead: NATIVE_OVERHEAD(this.chainId, amount.currency, quoteCurrency),
    }
    const cached = new CachedRoutes({
      routes: entry.routes,
      chainId: this.chainId,
      currencyIn,
      currencyOut,
      protocolsCovered: entry.protocols,
      blockNumber: entry.blockNumber,
      tradeType,
      originalAmount: amount.toExact(),
    })

    // Every pool the remembered routes touch, read at the same block while the quotes are in flight: the refresh
    // after the quotes is then answered from the pool cache instead of one more round trip per pool.
    const poolsRead = this.readPools(entry.routes, routingConfig)

    const self = this as any
    const { gasModels, gasPriceWei } = entry
    const best = await self.getSwapRouteFromCache(
      currencyIn,
      currencyOut,
      cached,
      blockNumber,
      amount,
      quoteCurrency,
      tradeType,
      routingConfig,
      gasModels.v3GasModel,
      gasModels.v4GasModel,
      gasModels.mixedRouteGasModel,
      gasPriceWei,
      gasModels.v2GasModel,
      swapConfig,
      providerConfig
    )
    if (!best || !best.routes || best.routes.length === 0) return null

    await poolsRead
    await this.refreshPools(best.routes, routingConfig, this.v2PoolProvider, this.v3PoolProvider, this.v4PoolProvider)

    const trade = buildTrade(currencyIn, currencyOut, tradeType, best.routes)
    const methodParameters = swapConfig ? buildSwapMethodParameters(trade, swapConfig, this.chainId) : undefined
    return {
      quote: best.quote,
      quoteGasAdjusted: best.quoteGasAdjusted,
      estimatedGasUsed: best.estimatedGasUsed,
      estimatedGasUsedQuoteToken: best.estimatedGasUsedQuoteToken,
      estimatedGasUsedUSD: best.estimatedGasUsedUSD,
      estimatedGasUsedGasToken: best.estimatedGasUsedGasToken,
      gasPriceWei,
      route: best.routes,
      trade,
      methodParameters,
      blockNumber: BigNumber.from(blockNumber),
      hitsCachedRoute: true,
    }
  }

  private readPools(routes: CachedRoute<SupportedRoutes>[], routingConfig: AlphaRouterConfig): Promise<unknown> {
    const v4: [Currency, Currency, number, number, string][] = []
    const v3: [any, any, number][] = []
    const v2: [any, any][] = []
    for (const r of routes) {
      const route = r.route as any
      for (const pool of (route.pools ?? route.pairs ?? []) as any[]) {
        if (pool instanceof V4Pool) v4.push([pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks])
        else if (pool instanceof V3Pool) v3.push([pool.token0, pool.token1, pool.fee])
        else if (pool instanceof Pair) v2.push([pool.token0, pool.token1])
      }
    }
    return Promise.all([
      v4.length ? this.v4PoolProvider.getPools(v4, routingConfig).catch(() => undefined) : undefined,
      v3.length ? this.v3PoolProvider.getPools(v3, routingConfig).catch(() => undefined) : undefined,
      v2.length ? this.v2PoolProvider.getPools(v2, routingConfig).catch(() => undefined) : undefined,
    ])
  }
}
