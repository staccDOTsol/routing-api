// Local harness: the real quote handler with the deployed Lambda's environment (read in-process, never printed).
import { execSync } from 'child_process'
const FN = 'RoutingAPIStack-RoutingLamb-RoutingLambda2C4DF0900-DLsZTE6GdBbk'
const env = JSON.parse(
  execSync(`aws lambda get-function-configuration --region us-east-2 --function-name ${FN} --query Environment.Variables --output json`, { encoding: 'utf8' })
)
for (const [k, v] of Object.entries(env)) if (k !== 'NODE_OPTIONS') process.env[k] = String(v)
// local .env wins for anything it sets (the RPC URLs being worked on); nothing from it is ever printed
{
  const parsed = require('dotenv').parse(require('fs').readFileSync(require('path').join(__dirname, '.env')))
  for (const [k, v] of Object.entries(parsed)) if (v) process.env[k] = String(v)
}
const SECRET = process.env.DRPC_KEY ?? '\u0000'
const hide = (x: string) => x.split(SECRET).join('***')
process.env.AWS_REGION = 'us-east-2'
process.env.AWS_DEFAULT_REGION = 'us-east-2'
process.env.AWS_LAMBDA_FUNCTION_NAME = FN
process.env.AWS_EMF_ENVIRONMENT = 'Local'
if (process.env.ROUTED) process.env.ROUTED_CHAIN_IDS = process.env.ROUTED
// quiet console: bunyan writes to stdout, keep only level >= QUIET_LEVEL
const QUIET = Number(process.env.QUIET_LEVEL ?? 100)
const rawWrite = process.stdout.write.bind(process.stdout)
const origWrite = (chunk: any, ...rest: any[]) => rawWrite(typeof chunk === 'string' ? hide(chunk) : chunk, ...rest)
const rawErr = process.stderr.write.bind(process.stderr)
;(process.stderr as any).write = (chunk: any, ...rest: any[]) => rawErr(typeof chunk === 'string' ? hide(chunk) : chunk, ...rest)
;(process.stdout as any).write = (chunk: any, ...rest: any[]) => {
  const s = String(chunk)
  if (s.startsWith('{"name"') || s.startsWith('{"_aws"') || s.startsWith('{"LogGroup"')) {
    try {
      const j = JSON.parse(s)
      if ((j.level ?? 0) >= QUIET) return origWrite(`[L${j.level}] ${String(j.msg).slice(0, 300)} ${j.err ? String(j.err.message).slice(0, 600) : ''}\n`)
    } catch {}
    return true
  }
  return origWrite(chunk, ...rest)
}
const mem = () => {
  const m = process.memoryUsage()
  return `rss=${(m.rss / 1e6).toFixed(0)}MB heap=${(m.heapUsed / 1e6).toFixed(0)}MB`
}
const trace: string[] = []
if (process.env.TRACE) {
  const { JsonRpcProvider } = require('@ethersproject/providers')
  const orig = JsonRpcProvider.prototype.send
  JsonRpcProvider.prototype.send = async function (method: string, params: any[]) {
    const t = Date.now()
    const p0 = params?.[0] ?? {}
    let tag = method === 'eth_call' || method === 'eth_estimateGas' ? ` to=${String(p0.to).slice(0, 10)} sel=${String(p0.data).slice(0, 10)} len=${String(p0.data ?? '').length} blk=${params?.[1]}` : ''
    if (method === 'eth_call' && String(p0.data).startsWith('0x1749e1e3')) {
      try {
        const { ethers } = require('ethers')
        const calls = new ethers.utils.Interface(['function multicall((address target, uint256 gasLimit, bytes callData)[] calls)']).decodeFunctionData('multicall', p0.data)[0]
        const kinds: any = {}
        for (const c of calls) { const k = `${c.target.slice(0, 8)}:${c.callData.slice(0, 10)}`; kinds[k] = (kinds[k] ?? 0) + 1 }
        tag += ` sub=${calls.length} gas=${calls[0]?.gasLimit?.toString()} kinds=${JSON.stringify(kinds).slice(0, 110)}`
      } catch {}
    }
    try {
      const r = await orig.call(this, method, params)
      trace.push(`+${t - tReq}ms ${method}${tag} -> ok ${Date.now() - t}ms`)
      return r
    } catch (e: any) {
      trace.push(`+${t - tReq}ms ${method}${tag} -> FAIL ${Date.now() - t}ms ${String(e?.message).slice(0, 80)}`)
      throw e
    }
  }
}
let tReq = Date.now()
async function main() {
  const t0 = Date.now()
  const { quoteHandler } = require('./lib/handlers/index')
  let queries = process.argv.slice(2)
  if (queries[0] === 'survey') return survey(quoteHandler, queries.slice(1))
  let i = 0
  for (const qs of queries) {
    const params: any = {}
    const headers: any = {}
    for (const kv of qs.split('&')) {
      const [k, v] = kv.split('=')
      if (k.startsWith('h:')) headers[k.slice(2)] = decodeURIComponent(v)
      else params[k] = decodeURIComponent(v)
    }
    const t = Date.now()
    tReq = t
    trace.length = 0
    const cpu0 = process.cpuUsage()
    const res = await quoteHandler(
      { queryStringParameters: params, headers, body: null } as any,
      { awsRequestId: `local-${i++}-${Date.now()}`, getRemainingTimeInMillis: () => 20000 } as any
    )
    let body: any
    try { body = JSON.parse(res.body) } catch { body = res.body }
    const brief = body && body.quote
      ? { quote: body.quote, quoteDecimals: body.quoteDecimals, routeString: body.routeString, sim: body.simulationStatus, gas: body.gasUseEstimate, block: body.blockNumber, mp: body.methodParameters ? { to: body.methodParameters.to, value: body.methodParameters.value, calldataLen: body.methodParameters.calldata.length } : undefined, extra: Object.fromEntries(Object.entries(body).filter(([k]) => /fee|tax|recipient|minimum|mode|routing/i.test(k))) }
      : body
    const cpuMs = ((process.cpuUsage(cpu0).user + process.cpuUsage(cpu0).system) / 1000).toFixed(0)
    if (process.env.BRIEF) origWrite(`[${res.statusCode}] ${params.tokenInChainId} ${String(params.tokenInAddress).slice(0, 6)}>${String(params.tokenOutAddress).slice(0, 6)} wall ${Date.now() - t}ms cpu ${cpuMs}ms ${mem()} ${body?.quote ? 'quote=' + body.quoteDecimals + ' ' + String(body.routeString).replace(/\[0x[0-9a-fA-F]{6,}\]/g, '').slice(0, 90) + (body.methodParameters ? ' mp.to=' + body.methodParameters.to.slice(0, 10) : '') : JSON.stringify(body).slice(0, 140)}\n`)
    else origWrite(`\n=== ${qs}\n[${res.statusCode}] ${Date.now() - t}ms cpu ${cpuMs}ms (since start ${Date.now() - t0}ms) ${mem()}\n${JSON.stringify(brief, null, 1)}\n`)
    if (process.env.TRACE === 'sum') {
      // one line per kind of read: count, sub-calls, total and slowest latency
      const agg: any = {}
      for (const l of trace) {
        const m = /^\+(\d+)ms (\S+)(.*?) -> (ok|FAIL) (\d+)ms/.exec(l)
        if (!m) continue
        const sub = /sub=(\d+) gas=(\d+) kinds=\{"([^"]+)"/.exec(m[3])
        const key = sub ? `multicall ${sub[3].split(':')[1]} gas=${sub[2]}` : `${m[2]}${/sel=(0x[0-9a-f]{8})/.exec(m[3])?.[0] ? ' ' + /sel=(0x[0-9a-f]{8})/.exec(m[3])![1] : ''}`
        const a = (agg[key] = agg[key] ?? { n: 0, sub: 0, ms: 0, max: 0, fail: 0, bytes: 0 })
        a.n++; a.sub += sub ? Number(sub[1]) : 0; a.ms += Number(m[5]); a.max = Math.max(a.max, Number(m[5])); if (m[4] === 'FAIL') a.fail++
        a.bytes += Number(/len=(\d+)/.exec(m[3])?.[1] ?? 0) / 2
      }
      const rows = Object.entries(agg).sort((x: any, y: any) => y[1].ms - x[1].ms).slice(0, 9)
      origWrite(`  RPC ${trace.length} calls: ` + rows.map(([k, a]: any) => `[${k}: n=${a.n}${a.sub ? ' sub=' + a.sub : ''} max=${a.max}ms${a.fail ? ' fail=' + a.fail : ''} ${(a.bytes / 1024).toFixed(0)}KB]`).join(' ') + '\n')
    } else if (process.env.TRACE) origWrite(`RPC trace (${trace.length} calls):\n  ${trace.join('\n  ')}\n`)
    if (process.env.DUMP) require('fs').writeFileSync(`${process.env.DUMP}.${i}.json`, JSON.stringify(body, null, 1))
  }
}
// every canonical peg pool in the feed: quote token -> claim, and ETH -> claim for claims with no ETH pool
async function survey(quoteHandler: any, args: string[]) {
  const axios = require('axios')
  const feed = (await axios.get('https://staccpad.fun/api/markets', { timeout: 15000 })).data
  const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
  const ZERO = '0x0000000000000000000000000000000000000000'
  const pools = feed.markets.filter((m: any) => m.pool && String(m.pool.poolManager).toLowerCase() === PM && (args.includes('hooks') ? true : m.pool.kind === 'peg'))
  const only = args.find((a) => a.startsWith('only='))?.slice(5).toLowerCase()
  const reqs: { label: string; qs: string; m: any }[] = []
  const hasEth = new Set(pools.filter((m: any) => m.pool.quoteToken === ZERO).map((m: any) => m.vaultAddress.toLowerCase()))
  const doneEth = new Set<string>()
  for (const m of pools) {
    const claim = m.vaultAddress
    if (only && !claim.toLowerCase().includes(only) && !String(m.pool.quoteSymbol).toLowerCase().includes(only)) continue
    const q = m.pool.quoteToken === ZERO ? 'ETH' : m.pool.quoteToken
    const amt = m.pool.quoteToken === ZERO ? '100000000000000' : m.pool.quoteDecimals === 6 ? '100000' : '1000000000000000'
    if (!args.includes('sellonly')) reqs.push({ label: `${m.pool.quoteSymbol}->claim`, qs: `tokenInAddress=${q}&tokenInChainId=4663&tokenOutAddress=${claim}&tokenOutChainId=4663&amount=${amt}&type=exactIn`, m })
    if (args.includes('sell') || args.includes('sellonly')) reqs.push({ label: `claim->${m.pool.quoteSymbol}`, qs: `tokenInAddress=${claim}&tokenInChainId=4663&tokenOutAddress=${q}&tokenOutChainId=4663&amount=1000000000000000&type=exactIn`, m })
    if (!hasEth.has(claim.toLowerCase()) && !doneEth.has(claim.toLowerCase())) {
      doneEth.add(claim.toLowerCase())
      reqs.push({ label: `ETH->claim(no ETH pool)`, qs: `tokenInAddress=ETH&tokenInChainId=4663&tokenOutAddress=${claim}&tokenOutChainId=4663&amount=100000000000000&type=exactIn`, m })
    }
    if (args.includes('ethall') && m.pool.quoteToken !== ZERO) reqs.push({ label: `ETH->claim`, qs: `tokenInAddress=ETH&tokenInChainId=4663&tokenOutAddress=${claim}&tokenOutChainId=4663&amount=100000000000000&type=exactIn`, m })
  }
  origWrite(`survey: ${reqs.length} requests over ${pools.length} pools\n`)
  const tally: any = {}
  let i = 0
  for (const r of reqs) {
    const params: any = {}
    for (const kv of r.qs.split('&')) { const [k, v] = kv.split('='); params[k] = v }
    const t = Date.now()
    let res: any, body: any
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await quoteHandler({ queryStringParameters: params, headers: {}, body: null } as any, { awsRequestId: `survey-${i++}-${Date.now()}`, getRemainingTimeInMillis: () => 20000 } as any)
      try { body = JSON.parse(res.body) } catch { body = res.body }
      if (res.statusCode !== 500) break
    }
    let direct = ''
    if (res.statusCode !== 200 && !r.label.startsWith('ETH->claim(')) {
      // is the direct pool really empty for this amount? ask the on-chain quoter
      const { ethers } = require('ethers')
      const prov = new ethers.providers.StaticJsonRpcProvider(process.env.WEB3_RPC_4663, 4663)
      const quoter = new ethers.Contract('0x8dc178efb8111bb0973dd9d722ebeff267c98f94', ['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)'], prov)
      const claim = r.m.vaultAddress, quote = r.m.pool.quoteToken
      const [c0, c1] = BigInt(claim) < BigInt(quote) ? [claim, quote] : [quote, claim]
      const tokenIn = r.label.startsWith('claim->') ? claim : quote
      for (let a = 0; a < 3 && !direct; a++) {
        try {
          const out = await quoter.callStatic.quoteExactInputSingle({ poolKey: { currency0: c0, currency1: c1, fee: r.m.pool.fee, tickSpacing: r.m.pool.tickSpacing, hooks: r.m.pool.hook }, zeroForOne: tokenIn.toLowerCase() === c0.toLowerCase(), exactAmount: params.amount, hookData: '0x' })
          direct = ` DIRECT-QUOTER-OK(${out.amountOut.toString()}) <<< API MISSED A ROUTE`
        } catch (e: any) {
          const d = String(e?.error?.error?.data ?? e?.error?.data ?? e?.data ?? e?.message ?? '')
          if (d.includes('7a5ed734')) direct = ' direct=NotEnoughLiquidity'
          else if (a === 2) direct = ` direct=ERR(${d.slice(0, 80)})`
        }
      }
    }
    const key = `${res.statusCode}${body?.errorCode ? ' ' + body.errorCode : ''}${direct.includes('MISSED') ? ' MISSED' : ''}`
    tally[key] = (tally[key] ?? 0) + 1
    origWrite(`${String(res.statusCode).padEnd(4)} ${String(Date.now() - t).padStart(5)}ms ${r.label.padEnd(24)} ${String(r.m.ticker).slice(0, 26).padEnd(26)} claim=${r.m.vaultAddress.slice(0, 10)} fee=${r.m.pool.fee} liq=${r.m.activeLiquidity ?? '?'} ${body?.quote ? 'quote=' + body.quoteDecimals + ' ' + String(body.routeString).replace(/\[0x[0-9a-f]{60}/g, '[0x').slice(0, 150) : JSON.stringify(body).slice(0, 160)}\n`)
  }
  origWrite(`TALLY ${JSON.stringify(tally)} ${mem()}\n`)
}
main().then(() => process.exit(0), (e) => { console.error('HARNESS FAILED', e); process.exit(1) })
