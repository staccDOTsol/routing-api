import { describe, expect, it } from '@jest/globals'
import {
  isTransientRpcError,
  maskRpcUrl,
  scrubRpcError,
} from '../../../../lib/handlers/evm/provider/InstrumentedEVMProvider'

const URL = 'https://lb.drpc.live/robinhood/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd'
const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd'

describe('rpc provider errors', () => {
  it('masks the key in a keyed endpoint and leaves a plain one alone', () => {
    expect(maskRpcUrl(URL)).toEqual('https://lb.drpc.live/robinhood/***')
    expect(maskRpcUrl('https://staccpad.fun/rpc/8453')).toEqual('https://staccpad.fun/rpc/8453')
  })

  it('scrubs the endpoint from an ethers transport error and from the error it wraps', () => {
    const inner: any = new Error(`timeout (requestMethod="POST", timeout=5000, url="${URL}", code=TIMEOUT)`)
    inner.url = URL
    inner.code = 'TIMEOUT'
    const outer: any = new Error('missing response')
    outer.error = inner
    scrubRpcError(outer, URL)
    expect(JSON.stringify([inner.message, inner.stack, inner.url, outer.message])).not.toContain(KEY)
    expect(inner.url).toEqual('https://lb.drpc.live/robinhood/***')
  })

  it('retries what failed in transit and never a revert', () => {
    expect(isTransientRpcError({ code: 'TIMEOUT' })).toBe(true)
    expect(isTransientRpcError({ code: 'SERVER_ERROR', reason: 'bad response', status: 502 })).toBe(true)
    expect(isTransientRpcError({ code: 'SERVER_ERROR', reason: 'missing response' })).toBe(true)
    expect(isTransientRpcError({ code: 'SERVER_ERROR', reason: 'bad response', status: 404 })).toBe(false)
    const reverted = { code: 'SERVER_ERROR', reason: 'processing response error', error: { message: 'execution reverted' } }
    expect(isTransientRpcError(reverted)).toBe(false)
    const upstream = { code: 'SERVER_ERROR', reason: 'processing response error', error: { message: 'upstream failed: timeout' } }
    expect(isTransientRpcError(upstream)).toBe(true)
    expect(isTransientRpcError({ code: 'CALL_EXCEPTION' })).toBe(false)
  })
})
