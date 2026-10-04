import { ethers } from 'ethers'
import { InstrumentedEVMProvider } from '../handlers/evm/provider/InstrumentedEVMProvider'
import { deriveProviderName } from '../handlers/evm/provider/ProviderName'

const TIMEOUT_MS = 5_000
const providers = new Map<number, ethers.providers.StaticJsonRpcProvider>()

/**
 * The chain's RPC for the xgas handlers (omni, xswap, claim tax): the same retrying, key-masking provider the
 * router uses, one per chain per Lambda instance. A bare ethers provider waits 120 s on a dead endpoint, longer
 * than the Lambda lives. Null when no WEB3_RPC_<chainId> is configured.
 */
export function rpcProvider(chainId: number): ethers.providers.StaticJsonRpcProvider | null {
  const url = process.env[`WEB3_RPC_${chainId}`]
  if (!url) return null
  let provider = providers.get(chainId)
  if (!provider) {
    provider = new InstrumentedEVMProvider({ url: { url, timeout: TIMEOUT_MS }, network: chainId, name: deriveProviderName(url) })
    providers.set(chainId, provider)
  }
  return provider
}
