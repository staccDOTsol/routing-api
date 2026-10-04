import { ethers } from 'ethers'
import { Deferrable } from '@ethersproject/properties'
import { TransactionRequest } from '@ethersproject/providers'
import {
  Block,
  BlockTag,
  BlockWithTransactions,
  Filter,
  Log,
  TransactionReceipt,
  TransactionResponse,
} from '@ethersproject/abstract-provider'
import { metric, MetricLoggerUnit } from '@uniswap/smart-order-router'
import { BigNumber, BigNumberish } from '@ethersproject/bignumber'
import { Network, Networkish } from '@ethersproject/networks'
import { ConnectionInfo } from '@ethersproject/web'
import { ProviderName } from './ProviderName'

export type InstrumentedEVMProviderProps = {
  url?: ConnectionInfo | string
  network?: Networkish
  name: ProviderName
}

const RPC_RETRIES = 2
const RPC_RETRY_DELAY_MS = 200
const TRANSIENT_RPC_MESSAGE =
  /upstream|time(d)? ?out|rate limit|too many requests|temporar|unavailable|try again|please retry|header not found|block not found|unknown block/i

/**
 * True when the transport failed (timeout, 5xx, dropped socket, truncated body) or the node behind the proxy did:
 * asking again can succeed. A revert is an answer, never retried.
 */
export function isTransientRpcError(error: any): boolean {
  if (error?.code === 'TIMEOUT') return true
  if (error?.code !== 'SERVER_ERROR') return false
  // a JSON-RPC error object reaches us wrapped by ethers as "processing response error"
  if (error.reason === 'processing response error') return TRANSIENT_RPC_MESSAGE.test(String(error.error?.message ?? ''))
  return error.status === undefined || error.status >= 500 || error.status === 429 || error.status === 408
}

/** The endpoint with its key hidden: a path segment of 20 or more URL-safe characters is a credential. */
export const maskRpcUrl = (url: string) => url.replace(/\/[A-Za-z0-9_-]{20,}(?=[/?#]|$)/g, '/***')

/**
 * ethers copies the endpoint URL into every transport error (message, stack, the `url` field) and then into the
 * error it wraps that one in. With a keyed endpoint that would write the key to the logs, so it is masked here,
 * before anything else sees the error.
 */
export function scrubRpcError(error: any, url: string): any {
  const masked = maskRpcUrl(url)
  if (!url || masked === url) return error
  const seen = new Set<any>()
  const walk = (e: any) => {
    if (!e || typeof e !== 'object' || seen.has(e)) return
    seen.add(e)
    for (const k of ['message', 'stack', 'url']) {
      if (typeof e[k] === 'string' && e[k].includes(url)) {
        try {
          e[k] = e[k].split(url).join(masked)
        } catch {
          // a frozen error keeps its text; nothing else to do
        }
      }
    }
    walk(e.error)
    walk(e.serverError)
  }
  walk(error)
  return error
}

export class InstrumentedEVMProvider extends ethers.providers.StaticJsonRpcProvider {
  private readonly name: ProviderName
  private readonly metricPrefix: string
  private readonly rpcUrl: string

  constructor({ url, network, name }: InstrumentedEVMProviderProps) {
    super(url, network)
    this.name = name
    this.metricPrefix = `RPC_${this.name}_${this.network.chainId}`
    this.rpcUrl = typeof url === 'string' ? url : url?.url ?? ''
  }

  /**
   * A quote is 25 to 70 reads and one failed read fails the quote, so a read that fails in transit (timeout, 5xx,
   * a node that says its upstream failed) is asked again. Errors leave here with the endpoint's key masked.
   */
  override async send(method: string, params: Array<any>): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await super.send(method, params)
      } catch (error) {
        if (attempt >= RPC_RETRIES || method === 'eth_sendRawTransaction' || !isTransientRpcError(error)) {
          throw scrubRpcError(error, this.rpcUrl)
        }
        metric.putMetric(`${this.metricPrefix}_RETRY`, 1, MetricLoggerUnit.Count)
        await new Promise((resolve) => setTimeout(resolve, RPC_RETRY_DELAY_MS * (attempt + 1)))
      }
    }
  }

  override call(transaction: Deferrable<TransactionRequest>, blockTag?: BlockTag | Promise<BlockTag>): Promise<string> {
    const before = Date.now()
    const result = super
      .call(transaction, blockTag)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_CALL_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_CALL_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => {
        metric.putMetric(`${this.metricPrefix}_CALL_REQUESTED`, 1, MetricLoggerUnit.Count)
        metric.putMetric(`${this.metricPrefix}_CALL_LATENCY`, Date.now() - before, MetricLoggerUnit.Milliseconds)
      })

    return result
  }

  override estimateGas(transaction: Deferrable<TransactionRequest>): Promise<BigNumber> {
    return super
      .estimateGas(transaction)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_ESTIMATEGAS_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_ESTIMATEGAS_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_ESTIMATEGAS_REQUESTED`, 1, MetricLoggerUnit.Count))
  }

  override getBalance(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<BigNumber> {
    return super
      .getBalance(addressOrName, blockTag)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_GETBALANCE_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_GETBALANCE_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_GETBALANCE_REQUESTED`, 1, MetricLoggerUnit.Count))
  }

  override getBlock(blockHashOrBlockTag: BlockTag | string | Promise<BlockTag | string>): Promise<Block> {
    return super
      .getBlock(blockHashOrBlockTag)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_GETBLOCK_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_GETBLOCK_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_GETBLOCK_REQUESTED`, 1, MetricLoggerUnit.Count))
  }

  override getBlockNumber(): Promise<number> {
    return super
      .getBlockNumber()
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_GETBLOCKNUMBER_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_GETBLOCKNUMBER_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_GETBLOCKNUMBER_REQUESTED`, 1, MetricLoggerUnit.Count))
  }

  override getBlockWithTransactions(
    blockHashOrBlockTag: BlockTag | string | Promise<BlockTag | string>
  ): Promise<BlockWithTransactions> {
    return super
      .getBlockWithTransactions(blockHashOrBlockTag)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_GETBLOCKWITHTRANSACTION_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_GETBLOCKWITHTRANSACTION_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() =>
        metric.putMetric(`${this.metricPrefix}_GETBLOCKWITHTRANSACTION_REQUESTED`, 1, MetricLoggerUnit.Count)
      )
  }

  override getCode(addressOrName: string | Promise<string>, blockTag?: BlockTag | Promise<BlockTag>): Promise<string> {
    return super
      .getCode(addressOrName, blockTag)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_GETCODE_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_GETCODE_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_GETCODE_REQUESTED`, 1, MetricLoggerUnit.Count))
  }

  override getGasPrice(): Promise<BigNumber> {
    return super
      .getGasPrice()
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_GETGASPRICE_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_GETGASPRICE_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_GETGASPRICE_REQUESTED`, 1, MetricLoggerUnit.Count))
  }

  override getLogs(filter: Filter): Promise<Array<Log>> {
    return super
      .getLogs(filter)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_GETLOGS_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_GETLOGS_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_GETLOGS_REQUESTED`, 1, MetricLoggerUnit.Count))
  }

  override getNetwork(): Promise<Network> {
    return super
      .getNetwork()
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_GETNETWORK_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_GETNETWORK_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_GETNETWORK_REQUESTED`, 1, MetricLoggerUnit.Count))
  }

  override getStorageAt(
    addressOrName: string | Promise<string>,
    position: BigNumberish | Promise<BigNumberish>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<string> {
    return super
      .getStorageAt(addressOrName, position, blockTag)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_GETSTORAGEAT_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_GETSTORAGEAT_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_GETSTORAGEAT_REQUESTED`, 1, MetricLoggerUnit.Count))
  }

  override getTransaction(transactionHash: string): Promise<TransactionResponse> {
    return super
      .getTransaction(transactionHash)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_GETTRANSACTION_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_GETTRANSACTION_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_GETTRANSACTION_REQUESTED`, 1, MetricLoggerUnit.Count))
  }

  override getTransactionCount(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<number> {
    return super
      .getTransactionCount(addressOrName, blockTag)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_GETTRANSACTIONCOUNT_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_GETTRANSACTIONCOUNT_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_GETTRANSACTIONCOUNT_REQUESTED`, 1, MetricLoggerUnit.Count))
  }

  override getTransactionReceipt(transactionHash: string): Promise<TransactionReceipt> {
    return super
      .getTransactionReceipt(transactionHash)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_GETTRANSACTIONRECEIPT_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_GETTRANSACTIONRECEIPT_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() =>
        metric.putMetric(`${this.metricPrefix}_GETTRANSACTIONRECEIPT_REQUESTED`, 1, MetricLoggerUnit.Count)
      )
  }

  override lookupAddress(address: string | Promise<string>): Promise<string | null> {
    return super
      .lookupAddress(address)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_LOOKUPADDRESS_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_LOOKUPADDRESS_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_LOOKUPADDRESS_REQUESTED`, 1, MetricLoggerUnit.Count))
  }

  override resolveName(name: string | Promise<string>): Promise<string | null> {
    return super
      .resolveName(name)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_RESOLVENAME_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_RESOLVENAME_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_RESOLVENAME_REQUESTED`, 1, MetricLoggerUnit.Count))
  }

  override sendTransaction(signedTransaction: string | Promise<string>): Promise<TransactionResponse> {
    return super
      .sendTransaction(signedTransaction)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_SENDTRANSACTION_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_SENDTRANSACTION_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_SENDTRANSACTION_REQUESTED`, 1, MetricLoggerUnit.Count))
  }

  override waitForTransaction(
    transactionHash: string,
    confirmations?: number,
    timeout?: number
  ): Promise<TransactionReceipt> {
    return super
      .waitForTransaction(transactionHash, confirmations, timeout)
      .then(
        (response) => {
          metric.putMetric(`${this.metricPrefix}_WAITFORTRANSACTION_SUCCESS`, 1, MetricLoggerUnit.Count)
          return response
        },
        (error) => {
          metric.putMetric(`${this.metricPrefix}_WAITFORTRANSACTION_FAILURE`, 1, MetricLoggerUnit.Count)
          throw error
        }
      )
      .finally(() => metric.putMetric(`${this.metricPrefix}_WAITFORTRANSACTION_REQUESTED`, 1, MetricLoggerUnit.Count))
  }
}
