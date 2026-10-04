import Joi from '@hapi/joi'
import { BigNumber, ethers } from 'ethers'
import { rpcProvider } from './rpc'

/**
 * Crosschain legs go through xgas.dev XSwap: X Money escrowed on Robinhood (4663), a bonded solver delivers on the
 * far chain. Lockstep with xgas-app/mcp/src/tools/xswap.mjs: same want hash, same memo, same contracts.
 * XSwap is an auction, so the X Money side is a ceiling (out) or a floor (in), never a pool price.
 */
export const XSWAP_HOME_CHAIN_ID = 4663
export const XGAS_L4_CHAIN_ID = 466302

export const XSWAP_CHAIN_IDS = [
  1, 8453, 42161, 10, 137, 56, 43114, 324, 59144, 534352, 5000, 81457, 100, 42170, 1101, 250, 130, 7777777, 34443,
  1135, 57073, 1868, 146, 80094, 2741, 33139, 480, 167000, 1284, 42220, 252, 1750, 1088, 13371, 2020, 999, 747474,
  1923, 4663,
]

const cfg = () => ({
  intents: process.env.XSWAP_INTENTS ?? '0x5D78651C728c15b715d5f6727bE40C1c3a02B53d',
  asks: process.env.XSWAP_ASKS ?? '0xa999BC26e184b83CECb3cF5b9640C438C5aDc8a3',
  xmoney: process.env.XSWAP_XMONEY ?? '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E',
  rpc: process.env.WEB3_RPC_4663 ?? 'https://rpc.mainnet.chain.robinhood.com',
})

const TERMS_ABI = [
  'function window() view returns (uint64)',
  'function bidding() view returns (uint64)',
  'function bondBps() view returns (uint16)',
  'function feeBps() view returns (uint16)',
]
const INTENTS = new ethers.utils.Interface([
  'function open(bytes32 id, uint256 amount, uint64 deadline, bytes32 want, string memo)',
])
const ASKS = new ethers.utils.Interface([
  'function ask(bytes32 id, uint256 floorPay, uint64 deadline, bytes32 give, string memo)',
])
const ERC20 = new ethers.utils.Interface(['function approve(address spender, uint256 amount)'])

const KIND = { native: 0, erc20: 1 } as const
const ZERO = ethers.constants.AddressZero
const NATIVE_ALIASES = new Set(['eth', 'native', ZERO, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'])

export type XSwapOrder = { dstChainId: number; kind: 'native' | 'erc20'; token?: string; amount: string; to: string }
export type XSwapStep = { label: string; chainId: number; to: string; value: string; data: string }
export type XSwapTerms = { window_s: number; bidding_s: number; bond_bps: number; fee_bps: number }
export type XSwapQuote = {
  routing: 'XSWAP'
  side: 'out' | 'in'
  id: string
  order: XSwapOrder
  hash: string
  xmoney: string
  xmoneyRole: 'escrow ceiling' | 'floor'
  maxFee: string
  deadline: number
  terms: XSwapTerms
  steps: XSwapStep[]
}
export type XSwapError = { statusCode: 400; errorCode: string; detail: string }

/** The hash every solver recomputes: chain, kind, token, amount, recipient. */
export function wantHash(o: XSwapOrder): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['uint256', 'uint8', 'address', 'uint256', 'address'],
      [o.dstChainId, KIND[o.kind], o.token ?? ZERO, o.amount, o.to]
    )
  )
}
/** The memo is the order in the clear, key order matching the MCP so both produce the same string. */
export const memoOf = (o: XSwapOrder) =>
  JSON.stringify({ dstChainId: o.dstChainId, kind: o.kind, token: o.token, amount: o.amount, to: o.to })

const isXMoney = (chainId: number, token: string) =>
  chainId === XSWAP_HOME_CHAIN_ID && token.toLowerCase() === cfg().xmoney.toLowerCase()

function orderFor(chainId: number, token: string, amount: string, to: string): XSwapOrder {
  return NATIVE_ALIASES.has(token.toLowerCase())
    ? { dstChainId: chainId, kind: 'native', amount, to }
    : { dstChainId: chainId, kind: 'erc20', token: ethers.utils.getAddress(token), amount, to }
}

async function terms(contract: string, provider: ethers.providers.Provider): Promise<XSwapTerms> {
  const c = new ethers.Contract(contract, TERMS_ABI, provider)
  const [w, b, bond, fee] = await Promise.all([c.window(), c.bidding(), c.bondBps(), c.feeBps()])
  return { window_s: Number(w), bidding_s: Number(b), bond_bps: Number(bond), fee_bps: Number(fee) }
}

export type XSwapRequest = {
  tokenInAddress: string
  tokenInChainId: number
  tokenOutAddress: string
  tokenOutChainId: number
  amount: string
  type: 'exactIn' | 'exactOut'
  xmoneyAmount?: string
  recipient?: string
  deadline?: string
}

export async function quoteXSwap(
  req: XSwapRequest,
  provider: ethers.providers.Provider = rpcProvider(XSWAP_HOME_CHAIN_ID) ??
    new ethers.providers.StaticJsonRpcProvider(cfg().rpc, XSWAP_HOME_CHAIN_ID)
): Promise<XSwapQuote | XSwapError> {
  const bad = (errorCode: string, detail: string): XSwapError => ({ statusCode: 400, errorCode, detail })
  const { intents, asks, xmoney } = cfg()
  const out = isXMoney(req.tokenInChainId, req.tokenInAddress)
  const into = isXMoney(req.tokenOutChainId, req.tokenOutAddress)
  if (!out && !into) {
    return bad('XSWAP_NEEDS_XMONEY', `Crosschain quotes settle in X Money (${xmoney}) on chain ${XSWAP_HOME_CHAIN_ID}: one side must be it`)
  }
  const farChain = out ? req.tokenOutChainId : req.tokenInChainId
  if (!XSWAP_CHAIN_IDS.includes(farChain)) {
    return bad('XSWAP_CHAIN_UNREACHABLE', `No XSwap solver reaches chain ${farChain}`)
  }
  // The far-chain amount is the order; the X Money amount is the other number an auction needs and has no pool to derive it from.
  if (req.type !== (out ? 'exactOut' : 'exactIn')) {
    return bad('XSWAP_AMOUNT_SIDE', `amount must be the far-chain asset: use type=${out ? 'exactOut' : 'exactIn'}`)
  }
  if (!req.xmoneyAmount || BigNumber.from(req.xmoneyAmount).lte(0)) {
    return bad('XSWAP_NEEDS_XMONEY_AMOUNT', `xmoneyAmount is required: the ${out ? 'escrow ceiling' : 'floor'} in X Money wei`)
  }
  if (out && (!req.recipient || !ethers.utils.isAddress(req.recipient))) {
    return bad('XSWAP_NEEDS_RECIPIENT', 'recipient is required: it is part of the hash solvers deliver against')
  }

  const xm = BigNumber.from(req.xmoneyAmount)
  const order = out
    ? orderFor(farChain, req.tokenOutAddress, req.amount, ethers.utils.getAddress(req.recipient!))
    : orderFor(farChain, req.tokenInAddress, req.amount, ZERO) // the buyer names the recipient after winning
  const hash = wantHash(order)
  const memo = memoOf(order)
  const minutes = Math.max(out ? 5 : 10, req.deadline ? Math.ceil(Number(req.deadline) / 60) : out ? 60 : 120)
  const deadline = Math.floor(Date.now() / 1000) + minutes * 60
  const id = ethers.utils.hexlify(ethers.utils.randomBytes(32))
  const t = await terms(out ? intents : asks, provider)

  const steps: XSwapStep[] = out
    ? [
        {
          label: 'Approve the escrow for the X Money ceiling (skip if already allowed)',
          chainId: XSWAP_HOME_CHAIN_ID,
          to: xmoney,
          value: '0',
          data: ERC20.encodeFunctionData('approve', [intents, xm]),
        },
        {
          label: 'Open the intent',
          chainId: XSWAP_HOME_CHAIN_ID,
          to: intents,
          value: '0',
          data: INTENTS.encodeFunctionData('open', [id, xm, deadline, hash, memo]),
        },
      ]
    : [
        {
          label: 'Post the ask',
          chainId: XSWAP_HOME_CHAIN_ID,
          to: asks,
          value: '0',
          data: ASKS.encodeFunctionData('ask', [id, xm, deadline, hash, memo]),
        },
      ]

  return {
    routing: 'XSWAP',
    side: out ? 'out' : 'in',
    id,
    order,
    hash,
    xmoney: xm.toString(),
    xmoneyRole: out ? 'escrow ceiling' : 'floor',
    maxFee: xm.mul(t.fee_bps).div(10_000).toString(),
    deadline,
    terms: t,
    steps,
  }
}

const str = Joi.string().required()
/** Every key listed: the handler validates responses with stripUnknown. */
export const XSwapQuoteJoi = Joi.object({
  routing: Joi.string().valid('XSWAP').required(),
  side: Joi.string().valid('out', 'in').required(),
  id: str,
  order: Joi.object({
    dstChainId: Joi.number().required(),
    kind: Joi.string().valid('native', 'erc20').required(),
    token: Joi.string().optional(),
    amount: str,
    to: str,
  }).required(),
  hash: str,
  xmoney: str,
  xmoneyRole: str,
  maxFee: str,
  deadline: Joi.number().required(),
  terms: Joi.object({
    window_s: Joi.number().required(),
    bidding_s: Joi.number().required(),
    bond_bps: Joi.number().required(),
    fee_bps: Joi.number().required(),
  }).required(),
  steps: Joi.array()
    .items(Joi.object({ label: str, chainId: Joi.number().required(), to: str, value: str, data: str }))
    .required(),
})
