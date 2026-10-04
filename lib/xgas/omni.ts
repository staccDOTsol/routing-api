import Joi from '@hapi/joi'
import { CHAIN_TO_ADDRESSES_MAP } from '@uniswap/sdk-core'
import { BigNumber, ethers } from 'ethers'
import { rpcProvider } from './rpc'

/**
 * Crosschain through an omni-peg claim: one claim token at one address on every chain, each chain with its own
 * native/claim v4 pool (1% tier, spacing 200, no hook), and `vault.teleport` moving whole NFTs between chains over
 * LayerZero. The route is: buy n claims with the source chain's gas token, teleport n, sell n for the destination's.
 * Lockstep with staccpad-ai/src/contracts/omniPeg.ts.
 */
const EID: { [chainId: number]: number } = {
  4663: 30416, 8453: 30184, 42161: 30110, 56: 30102, 43114: 30106, 81457: 30243, 57073: 30339, 4326: 30398,
  10: 30111, 137: 30109, 1868: 30340, 130: 30320, 7777777: 30195,
}
const NATIVE_FEE = 10_000
const NATIVE_SPACING = 200
const ZERO = ethers.constants.AddressZero

const QUOTER_ABI = [
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
  'function quoteExactOutputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountIn, uint256 gasEstimate)',
]
const VAULT_ABI = [
  'function unit() view returns (uint256)',
  'function inventoryCount() view returns (uint256)',
  'function quoteTeleport(uint256 n, uint32 dstEid, uint128 nftGas, uint128 claimGas) view returns (uint256)',
  'function teleport(uint256 n, uint32 dstEid, address to, uint128 nftGas, uint128 claimGas) payable returns (uint256[] ids)',
]
// what the far chain needs to mint n NFTs and their claims into a twin that already exists (measured 2026-10-04)
const teleportGas = (n: number) => ({ nftGas: 1_800_000 + (n - 1) * 150_000, claimGas: 600_000 + n * 150_000 })

export type OmniRequest = {
  tokenInChainId: number
  tokenOutChainId: number
  amount: string // whole NFTs to carry across
  via: string // the claim token (same address on every chain)
  recipient?: string
}
export type OmniQuote = {
  routing: 'OMNI'
  via: string
  nfts: number
  claims: string
  buy: { chainId: number; nativeIn: string }
  teleport: { srcEid: number; dstEid: number; feeNative: string; inventory: number; tx: { chainId: number; to: string; value: string; data: string } | null }
  sell: { chainId: number; nativeOut: string }
  taxBps: number
  net: string | null
}
export type OmniError = { statusCode: 400 | 404; errorCode: string; detail: string }

const providerFor = rpcProvider
const poolKey = (claim: string) => ({ currency0: ZERO, currency1: claim, fee: NATIVE_FEE, tickSpacing: NATIVE_SPACING, hooks: ZERO })
const quoter = (chainId: number, provider: ethers.providers.Provider) => {
  const address = (CHAIN_TO_ADDRESSES_MAP as any)[chainId]?.v4QuoterAddress
  return address ? new ethers.Contract(address, QUOTER_ABI, provider) : null
}

export async function quoteOmni(req: OmniRequest): Promise<OmniQuote | OmniError> {
  const bad = (errorCode: string, detail: string, statusCode: 400 | 404 = 400): OmniError => ({ statusCode, errorCode, detail })
  const [src, dst] = [req.tokenInChainId, req.tokenOutChainId]
  if (!EID[src] || !EID[dst]) return bad('OMNI_CHAIN', `The omni peg is not on chain ${EID[src] ? dst : src}`)
  const n = Number(req.amount)
  if (!Number.isInteger(n) || n < 1 || n > 20) return bad('OMNI_AMOUNT', 'amount is whole NFTs to carry across, 1 to 20 per message')
  const via = ethers.utils.getAddress(req.via)
  const [ps, pd] = [providerFor(src), providerFor(dst)]
  if (!ps || !pd) return bad('OMNI_RPC', `No RPC configured for chain ${ps ? dst : src}`)
  const [qs, qd] = [quoter(src, ps), quoter(dst, pd)]
  if (!qs || !qd) return bad('OMNI_QUOTER', `No v4 quoter known on chain ${qs ? dst : src}`)

  const vault = new ethers.Contract(via, VAULT_ABI, ps)
  const TAX_BPS = Number(process.env.OMNI_TAX_BPS ?? 100) // the claim burns this on every transfer, both legs
  let unit: BigNumber, inventory: BigNumber
  try {
    ;[unit, inventory] = await Promise.all([vault.unit(), vault.inventoryCount()])
  } catch {
    return bad('OMNI_NO_MARKET', `${via} is not an omni-peg claim on chain ${src}`, 404)
  }
  if (inventory.lt(n)) return bad('OMNI_INVENTORY', `Only ${inventory.toString()} NFTs sit in the vault on chain ${src}; cannot send ${n}`, 404)

  const claims = unit.mul(n)
  // the pool's transfer to the buyer is taxed, so buy enough that n whole claims arrive; the sale's transfer is taxed too
  const toBuy = claims.mul(10_000).div(10_000 - TAX_BPS).add(1)
  const toPool = claims.mul(10_000 - TAX_BPS).div(10_000)
  const g = teleportGas(n)
  let nativeIn: BigNumber, nativeOut: BigNumber, fee: BigNumber
  try {
    ;[[nativeIn], [nativeOut], fee] = await Promise.all([
      qs.callStatic.quoteExactOutputSingle({ poolKey: poolKey(via), zeroForOne: true, exactAmount: toBuy, hookData: '0x' }),
      qd.callStatic.quoteExactInputSingle({ poolKey: poolKey(via), zeroForOne: false, exactAmount: toPool, hookData: '0x' }),
      vault.quoteTeleport(n, EID[dst], g.nftGas, g.claimGas),
    ])
  } catch (e: any) {
    return bad('OMNI_NO_ROUTE', `A leg has no liquidity for ${n} claim${n === 1 ? '' : 's'}: ${String(e?.reason ?? e?.message ?? e).slice(0, 120)}`, 404)
  }

  const to = req.recipient && ethers.utils.isAddress(req.recipient) ? ethers.utils.getAddress(req.recipient) : null
  // both ends priced in ETH (every omni chain but BNB, Avalanche, Polygon): the round trip nets out in one unit
  const NON_ETH = [56, 43114, 137]
  const sameUnit = !NON_ETH.includes(src) && !NON_ETH.includes(dst)
  return {
    routing: 'OMNI',
    via,
    nfts: n,
    claims: claims.toString(),
    buy: { chainId: src, nativeIn: nativeIn.toString() },
    teleport: {
      srcEid: EID[src],
      dstEid: EID[dst],
      feeNative: fee.toString(),
      inventory: inventory.toNumber(),
      tx: to
        ? { chainId: src, to: via, value: fee.toString(), data: new ethers.utils.Interface(VAULT_ABI).encodeFunctionData('teleport', [n, EID[dst], to, g.nftGas, g.claimGas]) }
        : null,
    },
    sell: { chainId: dst, nativeOut: nativeOut.toString() },
    taxBps: TAX_BPS,
    net: sameUnit ? nativeOut.sub(nativeIn).sub(fee).toString() : null,
  }
}

const str = Joi.string().required()
const num = Joi.number().required()
/** Every key listed: the handler validates responses with stripUnknown. */
export const OmniQuoteJoi = Joi.object({
  routing: Joi.string().valid('OMNI').required(),
  via: str,
  nfts: num,
  claims: str,
  buy: Joi.object({ chainId: num, nativeIn: str }).required(),
  teleport: Joi.object({
    srcEid: num,
    dstEid: num,
    feeNative: str,
    inventory: num,
    tx: Joi.object({ chainId: num, to: str, value: str, data: str }).allow(null).required(),
  }).required(),
  sell: Joi.object({ chainId: num, nativeOut: str }).required(),
  taxBps: num,
  net: Joi.string().allow(null).required(),
})
