import { ChainId, Currency, CurrencyAmount } from '@uniswap/sdk-core'
import { SwapOptions, SwapOptionsSwapRouter02, SwapOptionsUniversalRouter, SwapType } from '@uniswap/smart-order-router'
import JSBI from 'jsbi'
import { TradeTypeParam } from './schema/quote-schema'
import { computePortionAmount, parseDeadline, parseSlippageTolerance, populateFeeOptions } from '../shared'
import { PermitSingle } from '@uniswap/permit2-sdk'
import { UNIVERSAL_ROUTER_ADDRESS, UniversalRouterVersion, URVersion } from '@uniswap/universal-router-sdk'
import { utils } from 'ethers'

/**
 * Which layout of the v4 swap actions the router at UNIVERSAL_ROUTER_ADDRESS(version, chainId) decodes: 2.1 added
 * maxHopSlippage to the swap structs, and a router handed the other layout reverts with no reason. Robinhood has a
 * single Universal Router and it is a 2.1 build (it answers eip712Domain()), whatever version the caller names.
 */
export const v4ActionsLayout = (version: UniversalRouterVersion, chainId: ChainId): URVersion =>
  version === UniversalRouterVersion.V2_1 || chainId === ChainId.ROBINHOOD ? URVersion.V2_1 : URVersion.V2_0

export type SwapOptionsUniversalRouterInput = {
  chainId: ChainId
  currencyIn: Currency
  currencyOut: Currency
  tradeType: TradeTypeParam
  universalRouterVersion: UniversalRouterVersion
  amountRaw: string
  slippageTolerance?: string
  enableUniversalRouter?: boolean
  portionBips?: number
  portionRecipient?: string
  portionAmount?: string
  deadline?: string
  recipient?: string
  permitSignature?: string
  permitNonce?: string
  permitExpiration?: string
  permitAmount?: string
  permitSigDeadline?: string
  simulateFromAddress?: string
}

export type SwapOptionsSwapRouter02Input = {
  slippageTolerance?: string
  deadline?: string
  recipient?: string
  permitSignature?: string
  permitNonce?: string
  permitExpiration?: string
  permitAmount?: string
  permitSigDeadline?: string
  simulateFromAddress?: string
}

export type SwapOptionsInput = SwapOptionsUniversalRouterInput & SwapOptionsSwapRouter02Input

export class SwapOptionsFactory {
  static assemble({
    chainId,
    currencyIn,
    currencyOut,
    tradeType,
    universalRouterVersion,
    amountRaw,
    slippageTolerance,
    enableUniversalRouter,
    portionBips,
    portionRecipient,
    portionAmount,
    deadline,
    recipient,
    permitSignature,
    permitNonce,
    permitExpiration,
    permitAmount,
    permitSigDeadline,
    simulateFromAddress,
  }: SwapOptionsInput): SwapOptions | undefined {
    if (enableUniversalRouter) {
      return SwapOptionsFactory.createUniversalRouterOptions({
        chainId,
        currencyIn,
        currencyOut,
        tradeType,
        universalRouterVersion,
        slippageTolerance,
        portionBips,
        portionRecipient,
        portionAmount,
        amountRaw,
        deadline,
        recipient,
        permitSignature,
        permitNonce,
        permitExpiration,
        permitAmount,
        permitSigDeadline,
        simulateFromAddress,
      })
    } else {
      return SwapOptionsFactory.createSwapRouter02Options({
        slippageTolerance,
        deadline,
        recipient,
        permitSignature,
        permitNonce,
        permitExpiration,
        permitAmount,
        permitSigDeadline,
        simulateFromAddress,
      })
    }
  }

  static createUniversalRouterOptions({
    chainId,
    currencyIn,
    currencyOut,
    tradeType,
    universalRouterVersion,
    slippageTolerance,
    portionBips,
    portionRecipient,
    portionAmount,
    amountRaw,
    deadline,
    recipient,
    permitSignature,
    permitNonce,
    permitExpiration,
    permitAmount,
    permitSigDeadline,
    simulateFromAddress,
  }: SwapOptionsUniversalRouterInput): SwapOptionsUniversalRouter | undefined {
    if (!slippageTolerance) {
      return undefined
    }

    const allFeeOptions = populateFeeOptions(
      tradeType,
      portionBips,
      portionRecipient,
      portionAmount ??
        computePortionAmount(CurrencyAmount.fromRawAmount(currencyOut, JSBI.BigInt(amountRaw)), portionBips)
    )

    const swapParams: SwapOptions = {
      type: SwapType.UNIVERSAL_ROUTER,
      version: universalRouterVersion,
      urVersion: v4ActionsLayout(universalRouterVersion, chainId),
      deadlineOrPreviousBlockhash: deadline ? parseDeadline(deadline) : undefined,
      recipient: recipient,
      slippageTolerance: parseSlippageTolerance(slippageTolerance),
      ...allFeeOptions,
    }

    if (permitSignature && permitNonce && permitExpiration && permitAmount && permitSigDeadline) {
      // in case of v4 native input, we might not want to compose permit2 at all, because native currency cannot be issued permit2.
      // however there's still a chance, for v4, a native input has a wrapped pool has best routing. in that case, we still need permit2.
      // for now, SOR v4 routing cannot support native currency input with the wrapped pool routing, although v4-sdk can support that.
      // so we just leave as is here. ud-sdk should be able to tell to not issue permit2 because it could go through the v4 native pool in the route object
      // as part of routing-api response.
      const permit: PermitSingle = {
        details: {
          token: currencyIn.wrapped.address,
          amount: permitAmount,
          expiration: permitExpiration,
          nonce: permitNonce,
        },
        spender: UNIVERSAL_ROUTER_ADDRESS(universalRouterVersion, chainId),
        sigDeadline: permitSigDeadline,
      }

      swapParams.inputTokenPermit = {
        ...permit,
        signature: permitSignature,
      }
    }

    if (simulateFromAddress) {
      swapParams.simulate = { fromAddress: simulateFromAddress }
    }
    return swapParams
  }

  static createSwapRouter02Options({
    slippageTolerance,
    deadline,
    recipient,
    permitSignature,
    permitNonce,
    permitExpiration,
    permitAmount,
    permitSigDeadline,
    simulateFromAddress,
  }: SwapOptionsSwapRouter02Input): SwapOptionsSwapRouter02 | undefined {
    if (!slippageTolerance) {
      return undefined
    }

    let swapParams: SwapOptions | undefined = undefined

    if (deadline && recipient) {
      swapParams = {
        type: SwapType.SWAP_ROUTER_02,
        deadline: parseDeadline(deadline),
        recipient: recipient,
        slippageTolerance: parseSlippageTolerance(slippageTolerance),
      }
    }

    if (permitSignature && ((permitNonce && permitExpiration) || (permitAmount && permitSigDeadline))) {
      const { v, r, s } = utils.splitSignature(permitSignature)

      if (swapParams) {
        swapParams.inputTokenPermit = {
          v: v as 0 | 1 | 27 | 28,
          r,
          s,
          ...(permitNonce && permitExpiration
            ? { nonce: permitNonce!, expiry: permitExpiration! }
            : { amount: permitAmount!, deadline: permitSigDeadline! }),
        }
      }
    }

    if (simulateFromAddress) {
      if (swapParams) {
        swapParams.simulate = { fromAddress: simulateFromAddress }
      }
    }
    return swapParams
  }
}
