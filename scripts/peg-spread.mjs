#!/usr/bin/env node
// Quote one omni-peg claim token against the gas token on every ETH-gas chain it lives on, both directions,
// and rank the gaps. usage: node scripts/peg-spread.mjs <claim> [ethIn=0.0005] [claimsIn=0.01]
const API = process.env.ROUTER_URL ?? 'https://xn644o3px9.execute-api.us-east-2.amazonaws.com/prod/quote'
const CHAINS = { 4663: 'Robinhood', 8453: 'Base', 42161: 'Arbitrum', 10: 'Optimism', 130: 'Unichain', 81457: 'Blast', 1868: 'Soneium' }
const [claim, ethIn = '0.0005', claimsIn = '0.01'] = process.argv.slice(2)
if (!claim) throw new Error('usage: peg-spread.mjs <claim address> [ethIn] [claimsIn]')
const wei = (s) => BigInt(Math.round(Number(s) * 1e9)) * 10n ** 9n

async function quote(chainId, tokenIn, tokenOut, amount) {
  const q = new URLSearchParams({ tokenInAddress: tokenIn, tokenInChainId: chainId, tokenOutAddress: tokenOut, tokenOutChainId: chainId, amount: amount.toString(), type: 'exactIn', protocols: 'v4' })
  const r = await fetch(`${API}?${q}`, { headers: { 'x-universal-router-version': '2.0' } })
  const d = await r.json().catch(() => ({}))
  return r.ok ? Number(d.quoteDecimals) : null
}

const rows = []
for (const [id, name] of Object.entries(CHAINS)) {
  const got = await quote(id, 'ETH', claim, wei(ethIn)) // claims for ethIn
  const back = await quote(id, claim, 'ETH', wei(claimsIn)) // eth for claimsIn
  rows.push({ id, name, buy: got ? Number(ethIn) / got : null, sell: back ? back / Number(claimsIn) : null })
}
const f = (n) => (n == null ? 'no route' : n.toFixed(6))
console.log(`ETH per claim (buy ${ethIn} ETH worth / sell ${claimsIn} claims)\n`)
console.log('chain'.padEnd(11), 'buy at'.padEnd(11), 'sell at')
for (const r of rows) console.log(r.name.padEnd(11), f(r.buy).padEnd(11), f(r.sell))
const buys = rows.filter((r) => r.buy).sort((a, b) => a.buy - b.buy)
const sells = rows.filter((r) => r.sell).sort((a, b) => b.sell - a.sell)
if (buys.length && sells.length) {
  const [b, s] = [buys[0], sells[0]]
  console.log(`\ncheapest buy: ${b.name} ${f(b.buy)}   best sell: ${s.name} ${f(s.sell)}`)
  console.log(`gross spread: ${(((s.sell - b.buy) / b.buy) * 100).toFixed(2)}% (before the claim's transfer tax, bridge cost and gas)`)
}
