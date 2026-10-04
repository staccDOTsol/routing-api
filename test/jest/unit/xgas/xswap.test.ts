import { describe, expect, it } from '@jest/globals'
import { ethers } from 'ethers'
import Joi from '@hapi/joi'
import { memoOf, quoteXSwap, wantHash, XSwapQuoteJoi } from '../../../../lib/xgas/xswap'
import { QuoteResponseSchemaJoi } from '../../../../lib/handlers/schema'

const XMONEY = '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E'
const TO = '0x1111111111111111111111111111111111111111'
// window, bidding, bondBps, feeBps all answer 30
const provider = { call: async () => ethers.utils.hexZeroPad('0x1e', 32) } as unknown as ethers.providers.Provider
Object.assign(provider, { _isProvider: true })

describe('xswap', () => {
  it('hashes a native order the way the solver does', () => {
    const o = { dstChainId: 8453, kind: 'native' as const, amount: '1000', to: TO }
    expect(wantHash(o)).toEqual(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['uint256', 'uint8', 'address', 'uint256', 'address'],
          [8453, 0, ethers.constants.AddressZero, '1000', TO]
        )
      )
    )
    expect(memoOf(o)).toEqual(`{"dstChainId":8453,"kind":"native","amount":"1000","to":"${TO}"}`)
  })

  it('quotes X Money out to another chain as an intent', async () => {
    const q = await quoteXSwap(
      {
        tokenInAddress: XMONEY,
        tokenInChainId: 4663,
        tokenOutAddress: 'ETH',
        tokenOutChainId: 8453,
        amount: '1000',
        type: 'exactOut',
        xmoneyAmount: '20000',
        recipient: TO,
      },
      provider
    )
    if (!('routing' in q)) throw new Error(q.detail)
    expect(q.side).toEqual('out')
    expect(q.maxFee).toEqual('60') // 30 bps of 20000
    expect(q.steps.map((s) => s.label)).toHaveLength(2)
    const res = Joi.alternatives().try(XSwapQuoteJoi, QuoteResponseSchemaJoi).validate(q, { allowUnknown: true, stripUnknown: true })
    expect(res.error).toBeUndefined()
    expect(res.value.steps[1].data).toEqual(q.steps[1].data)
  })

  it('quotes another chain into X Money as an ask', async () => {
    const q = await quoteXSwap(
      {
        tokenInAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        tokenInChainId: 8453,
        tokenOutAddress: XMONEY,
        tokenOutChainId: 4663,
        amount: '5000000',
        type: 'exactIn',
        xmoneyAmount: '20000',
      },
      provider
    )
    if (!('routing' in q)) throw new Error(q.detail)
    expect(q.side).toEqual('in')
    expect(q.order.kind).toEqual('erc20')
    expect(q.steps).toHaveLength(1)
  })

  it('rejects a crosschain pair with no X Money side', async () => {
    const q = await quoteXSwap(
      { tokenInAddress: 'ETH', tokenInChainId: 1, tokenOutAddress: 'ETH', tokenOutChainId: 8453, amount: '1', type: 'exactIn' },
      provider
    )
    expect(q).toMatchObject({ statusCode: 400, errorCode: 'XSWAP_NEEDS_XMONEY' })
  })
})
