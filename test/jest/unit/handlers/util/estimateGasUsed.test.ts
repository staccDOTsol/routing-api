import { describe, it, expect } from '@jest/globals'
import { ChainId } from '@uniswap/sdk-core'
import { adhocCorrectGasUsed } from '../../../../../lib/util/estimateGasUsed'
import { BigNumber } from '@ethersproject/bignumber'
import {
  CELO_UPPER_SWAP_GAS_LIMIT,
  MONAD_UPPER_SWAP_GAS_LIMIT,
  ZKSYNC_UPPER_SWAP_GAS_LIMIT,
} from '../../../../../lib/util/gasLimit'

describe('estimateGasUsed', () => {
  it('returns normal gas for mainnet', () => {
    const estimatedGasUsed = BigNumber.from(100)
    expect(adhocCorrectGasUsed(estimatedGasUsed, ChainId.MAINNET)).toBe(estimatedGasUsed)
  })

  it('returns normal gas for zkSync on mobile', () => {
    const estimatedGasUsed = ZKSYNC_UPPER_SWAP_GAS_LIMIT.add(1)
    expect(adhocCorrectGasUsed(estimatedGasUsed, ChainId.ZKSYNC)).toBe(estimatedGasUsed)
  })

  it('returns normal gas for zkSync on extension', () => {
    const estimatedGasUsed = ZKSYNC_UPPER_SWAP_GAS_LIMIT.add(1)
    expect(adhocCorrectGasUsed(estimatedGasUsed, ChainId.ZKSYNC)).toBe(estimatedGasUsed)
  })

  it('returns upper limit gas for zkSync on mobile', () => {
    const estimatedGasUsed = ZKSYNC_UPPER_SWAP_GAS_LIMIT.sub(1)
    expect(adhocCorrectGasUsed(estimatedGasUsed, ChainId.ZKSYNC)).toBe(ZKSYNC_UPPER_SWAP_GAS_LIMIT)
  })

  it('returns upper limit gas for zkSync on extension', () => {
    const estimatedGasUsed = ZKSYNC_UPPER_SWAP_GAS_LIMIT.sub(1)
    expect(adhocCorrectGasUsed(estimatedGasUsed, ChainId.ZKSYNC)).toBe(ZKSYNC_UPPER_SWAP_GAS_LIMIT)
  })

  it('returns upper limit gas for celo on mobile', () => {
    const estimatedGasUsed = CELO_UPPER_SWAP_GAS_LIMIT.sub(1)
    expect(adhocCorrectGasUsed(estimatedGasUsed, ChainId.CELO)).toBe(CELO_UPPER_SWAP_GAS_LIMIT)
  })

  it('returns upper limit gas for celo on extension', () => {
    const estimatedGasUsed = CELO_UPPER_SWAP_GAS_LIMIT.sub(1)
    expect(adhocCorrectGasUsed(estimatedGasUsed, ChainId.CELO)).toBe(CELO_UPPER_SWAP_GAS_LIMIT)
  })

  it('returns normal gas for celo on mobile', () => {
    const estimatedGasUsed = CELO_UPPER_SWAP_GAS_LIMIT.add(1)
    expect(adhocCorrectGasUsed(estimatedGasUsed, ChainId.CELO)).toBe(estimatedGasUsed)
  })

  it('returns normal gas for celo on extension', () => {
    const estimatedGasUsed = CELO_UPPER_SWAP_GAS_LIMIT.add(1)
    expect(adhocCorrectGasUsed(estimatedGasUsed, ChainId.CELO)).toBe(estimatedGasUsed)
  })

  it('returns upper limit gas for monad', () => {
    const estimatedGasUsed = MONAD_UPPER_SWAP_GAS_LIMIT.sub(1)
    expect(adhocCorrectGasUsed(estimatedGasUsed, ChainId.MONAD_TESTNET)).toBe(MONAD_UPPER_SWAP_GAS_LIMIT)
  })
})
