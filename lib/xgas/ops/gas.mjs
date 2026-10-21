// Anything to gas: a token on chain A becomes chain B's gas token at the same address, with no gas on B.
//
// The delivery is not ours. It is Relay (relay.link), a third party: the wallet pays into Relay's deposit
// contract on chain A, and Relay's solver sends the gas on chain B out of its own funds a few seconds later.
// Nothing on either chain ties the two together, so the plan says so, and this module only does what it can
// actually stand behind:
//
//   - the transaction Relay returns must be one of two shapes this file knows, addressed to a contract pinned
//     here (never an address taken from the answer), spending exactly the amount typed, for exactly this owner;
//   - the approval is written here, for that exact amount, and skipped when it is already in place;
//   - approval and deposit are run in order, from the owner, against the latest state before they are returned,
//     and where the chain reports logs the deposit must show up in Relay's contract under the quoted order id.
//
// Anything else Relay answers with (a signature step, a third transaction, another target) is refused.
//
// Chains are whatever Relay serves, read from its own list every ten minutes (a built-in copy stands in until
// the first answer). Any of them can be the destination. To be the origin a chain must also be one this server
// can read, with Relay's deposit contract at one of the pinned addresses; otherwise the answer is NO_OP.
//
// Speed: a plan is two round trips. Relay's quote, the wallet's balances and allowances (one batch), the gas price
// and the optional reads all leave together; the test run follows. Optional reads are dropped when they are slow.
// The megalauncher's topUpGas (staccpad omniPeg.ts) is the one-token, one-origin version of this.
import { randomBytes } from 'node:crypto';
import { decodeErrorResult, decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAddress, isAddress, parseAbi, toHex } from 'viem';

export const id = 'gas';

// ───────────────────────── fixed facts ─────────────────────────

const RELAY = 'https://api.relay.link';
/** Relay's deposit contracts (protocol v2 "depository") and the proxies it uses when a token must be swapped first. */
const DEPOSITORY = getAddress('0x4cd00e387622c35bddb9b4c962c136462338bc31');
const APPROVAL_PROXY = getAddress('0xccc88a9d1b4ed6b0eaba998850414b24f1c315be');
/** The second deployment, on the few chains where the first address was not available (Cronos, Metis, Mantle, Linea). */
const DEPOSITORY_2 = getAddress('0x59916da825d2d2ec1bf878d71c88826f6633ecca');
const APPROVAL_PROXY_2 = getAddress('0x8754bc615047de01228a7527b712806a71a8dc9a');
const PINNED = new Map([[DEPOSITORY.toLowerCase(), APPROVAL_PROXY], [DEPOSITORY_2.toLowerCase(), APPROVAL_PROXY_2]]);
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ZERO = '0x0000000000000000000000000000000000000000';
/** Stands in for the wallet when a quote is asked for before one is connected. No transaction is built for it. */
const NOBODY = '0x000000000000000000000000000000000000dEaD';
/** The xGas chain is the vault module's, and Relay does not serve it. */
const XGAS = 466302;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const RELAY_ABI = parseAbi([
  'struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }',
  'function depositNative(address depositor, bytes32 id) payable',
  'function depositErc20(address depositor, address token, uint256 amount, bytes32 id)',
  'function transferAndMulticall(address[] tokens, uint256[] amounts, Call3Value[] calls, address refundTo, address nftRecipient, bytes metadata) payable returns (bytes)',
  'event RelayNativeDeposit(address from, uint256 amount, bytes32 id)',
  'event RelayErc20Deposit(address from, address token, uint256 amount, bytes32 id)',
]);
const MC3 = parseAbi([
  'struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3Value(Call3Value[] calls) payable returns (Result[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);
const ERRORS = parseAbi([
  'error Error(string)',
  'error Panic(uint256)',
  'error TransferFromFailed()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
]);
const ERROR_TEXT = {
  TransferFromFailed: 'the token could not be moved (not enough of it, or not allowed yet)',
  ERC20InsufficientBalance: 'the wallet does not hold enough of the token',
  ERC20InsufficientAllowance: 'the allowance is smaller than the amount',
};

// ───────────────────────── small pieces ─────────────────────────

function fail(code, detail, status = 422, cause) {
  const e = new Error(detail);
  e.planError = true;
  e.code = code;
  e.detail = detail;
  e.status = status;
  if (cause) e.cause = cause;
  return e;
}
/** "Not something this module can do": the dispatcher asks the next module, or says nothing can make the trade. */
const noOp = (detail) => fail('NO_OP', detail, 404);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const digits = (s) => typeof s === 'string' && /^[0-9]{1,77}$/.test(s);
const isHex = (s) => typeof s === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(s);
/** Printable, one line, bounded: symbols come from contracts anyone can deploy. */
const clean = (v, max = 32) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** Resolves to `fallback` when `promise` is slow or fails. For reads a plan is better with but fine without. */
function within(promise, ms, fallback = null) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

function human(value, decimals, sig = 5) {
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (!frac) return whole.toString();
  const lead = whole === 0n ? frac.match(/^0*/)[0].length : 0;
  const cut = frac.slice(0, lead + sig).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole.toString();
}
const money = (usd) => {
  const n = Math.abs(Number(usd));
  if (!Number.isFinite(n)) return null;
  return n > 0 && n < 0.01 ? 'under $0.01' : `$${n.toFixed(2)}`;
};

const isToken = (t) => !!t && typeof t === 'object' && t.kind === 'token' && Number.isSafeInteger(t.chainId) && t.chainId > 0
  && (t.address === 'NATIVE' || (typeof t.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(t.address)));

// ───────────────────────── chains ─────────────────────────

/**
 * What stands in until Relay's own list arrives, and whenever it cannot be fetched: [name, gas token]. Each was
 * checked by hand on 2026-10-03 (Relay lists the first depository there, and its code was found on the chain).
 */
const BUILT_IN = {
  1: ['Ethereum', 'ETH'], 10: ['Optimism', 'ETH'], 56: ['BNB Chain', 'BNB'], 100: ['Gnosis', 'xDAI'], 130: ['Unichain', 'ETH'],
  137: ['Polygon', 'POL'], 146: ['Sonic', 'S'], 480: ['World Chain', 'ETH'], 999: ['HyperEVM', 'HYPE'], 1135: ['Lisk', 'ETH'],
  1868: ['Soneium', 'ETH'], 2020: ['Ronin', 'RON'], 4326: ['MegaETH', 'ETH'], 4663: ['Robinhood Chain', 'ETH'], 8453: ['Base', 'ETH'],
  33139: ['ApeChain', 'APE'], 34443: ['Mode', 'ETH'], 42161: ['Arbitrum', 'ETH'], 42220: ['Celo', 'CELO'], 43114: ['Avalanche', 'AVAX'],
  57073: ['Ink', 'ETH'], 80094: ['Berachain', 'BERA'], 81457: ['Blast', 'ETH'], 534352: ['Scroll', 'ETH'], 747474: ['Katana', 'ETH'],
  7777777: ['Zora', 'ETH'],
};
let chains = new Map(Object.entries(BUILT_IN).map(([k, [name, symbol]]) => [Number(k), { id: Number(k), name, symbol, decimals: 18, depository: DEPOSITORY, proxy: APPROVAL_PROXY, deposits: true }]));
let chainsAt = 0;
let chainsLoading = null;
const CHAINS_TTL = 10 * 60_000;

/** Relay's chain list as this module needs it. A contract address is kept only when it is one pinned above. */
async function loadChains() {
  const r = await fetch(`${RELAY}/chains`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
  const j = r.ok ? await r.json() : null;
  const next = new Map();
  for (const c of Array.isArray(j?.chains) ? j.chains : []) {
    if (!c || c.vmType !== 'evm' || !Number.isSafeInteger(c.id) || c.id <= 0 || c.id === XGAS || c.disabled === true) continue;
    const dep = typeof c.protocol?.v2?.depository === 'string' ? c.protocol.v2.depository.toLowerCase() : '';
    const proxy = PINNED.get(dep) || null;
    const listed = c.contracts?.v3?.approvalProxy || c.contracts?.approvalProxy;
    const decimals = Number(c.currency?.decimals);
    next.set(c.id, {
      id: c.id,
      name: BUILT_IN[c.id]?.[0] || clean(String(c.displayName || c.name || ''), 32) || `Chain ${c.id}`,
      symbol: clean(String(c.currency?.symbol || ''), 12) || BUILT_IN[c.id]?.[1] || 'gas',
      decimals: Number.isInteger(decimals) && decimals > 0 && decimals <= 36 ? decimals : 18,
      depository: proxy ? getAddress(dep) : null,
      // the proxy is only used when Relay's own list names the one that belongs to this depository
      proxy: proxy && same(listed, proxy) ? proxy : null,
      deposits: c.depositEnabled !== false,
    });
  }
  if (next.size < 10) throw new Error('Relay answered with a chain list too short to believe');
  chains = next;
  chainsAt = Date.now();
}
/** Start a refresh when the list is old. Never throws; resolves when the list in hand is the best there is. */
function refreshChains() {
  if (Date.now() - chainsAt < CHAINS_TTL) return Promise.resolve();
  chainsLoading ??= loadChains().catch(() => { chainsAt = Date.now() - CHAINS_TTL + 60_000; /* try again in a minute */ }).finally(() => { chainsLoading = null; });
  return chainsLoading;
}
refreshChains();

// ───────────────────────── chain access ─────────────────────────
// Reads go straight to dRPC with the server's key when DRPC_KEY is set and dRPC has a name for the chain, and
// through the staccpad proxy otherwise, or when the direct call fails. The keyed URL is built in `direct` and
// goes nowhere else: no error carries a URL, and nothing here logs.

const SLUGS = {
  4663: 'robinhood', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 130: 'unichain', 81457: 'blast', 1868: 'soneium',
  1: 'ethereum', 56: 'bsc', 137: 'polygon', 43114: 'avalanche', 57073: 'ink', 4326: 'megaeth', 7777777: 'zora',
};
const KEY = /^[A-Za-z0-9_-]{8,200}$/.test(process.env.DRPC_KEY || '') ? process.env.DRPC_KEY : null;
const direct = (chainId) => (KEY && SLUGS[chainId] ? `https://lb.drpc.live/${SLUGS[chainId]}/${KEY}` : null);
const proxy = (chainId) => (chainId === 4663 ? 'https://staccpad.fun/rpc' : `https://staccpad.fun/rpc/${chainId}`);
const DIRECT_MS = 3_500;
const PROXY_MS = 6_000; // two round trips at their slowest still fit inside the dispatcher's patience
const resting = new Map(); // chainId -> until when the direct upstream is left alone after failing
const noRoute = new Map(); // chainId -> until when "no upstream serves this chain" is remembered
// chainId -> until when "this chain answers" is remembered. The built-in chains were each read through the proxy
// when the table was made, so a first quote there does not wait on a probe; a route that has since gone shows
// up as NO_OP the moment a wallet's plan tries to read it.
const readableUntil = new Map(Object.keys(BUILT_IN).map((k) => [Number(k), Date.now() + 24 * 60 * 60_000]));
const simOff = new Map(); // chainId -> until when eth_simulateV1 is not tried again
const simSeen = new Set(); // chains where eth_simulateV1 has answered

/**
 * The node ran the call and this is its verdict (a revert, a method or parameters it does not take, a simulated
 * transaction it would not accept), as opposed to an upstream that could not serve the request.
 */
const verdict = (e) => !!e && typeof e === 'object' && (e.code === 3 || e.code === -32601 || e.code === -32602 || (e.code <= -38000 && e.code > -39000) || typeof e.data === 'string' || /revert/i.test(String(e.message || '')));

async function send(url, body, ms) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(ms) });
    const j = await r.json().catch(() => null);
    return { status: r.status, j: j && typeof j === 'object' && !Array.isArray(j) ? j : null };
  } catch {
    return { status: 0, j: null };
  }
}
/** One JSON-RPC call: the node's { result } or { error }. Throws (with no URL in it) when no upstream answered. */
async function rpc(chainId, method, params) {
  if (noRoute.get(chainId) > Date.now()) throw Object.assign(new Error(`no upstream serves chain ${chainId}`), { noRoute: true });
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const url = direct(chainId);
  if (url && !(resting.get(chainId) > Date.now())) {
    const { status, j } = await send(url, body, DIRECT_MS);
    if (status === 200 && j && (j.result !== undefined || verdict(j.error))) return j;
    // a method the chain's nodes do not serve is not a sick upstream; anything else rests it for half a minute
    if (method !== 'eth_simulateV1') resting.set(chainId, Date.now() + 30_000);
  }
  const began = Date.now();
  let { status, j } = await send(proxy(chainId), body, PROXY_MS);
  // a proxy that fails at once (a restart, a dropped connection) is asked once more; one that stalled is not
  if (!j && status !== 404 && Date.now() - began < 1_500) {
    await new Promise((r) => setTimeout(r, 200));
    ({ status, j } = await send(proxy(chainId), body, PROXY_MS));
  }
  if (status === 404 && !url) {
    noRoute.set(chainId, Date.now() + 5 * 60_000);
    throw Object.assign(new Error(`no upstream serves chain ${chainId}`), { noRoute: true });
  }
  if (j && (j.result !== undefined || (j.error && typeof j.error === 'object'))) return j;
  throw new Error(`chain ${chainId} did not answer`);
}

/** True once the chain has answered anything at all; throws (noRoute) when no upstream serves it. */
async function readable(chainId) {
  if (readableUntil.get(chainId) > Date.now()) return true;
  await rpc(chainId, 'eth_chainId', []);
  readableUntil.set(chainId, Date.now() + 60 * 60_000);
  return true;
}

function reason(data, message) {
  if (typeof data === 'string' && data.length >= 10) {
    try {
      const d = decodeErrorResult({ abi: ERRORS, data });
      if (d.errorName === 'Error') return clean(String(d.args?.[0] ?? ''), 160) || 'no reason given';
      return ERROR_TEXT[d.errorName] || d.errorName;
    } catch { /* not one we know */ }
    return `the contract answered with error code ${data.slice(0, 10)}`;
  }
  if (/insufficient funds/i.test(String(message))) return 'the wallet does not hold enough for the amount plus the network fee';
  return message && !/^execution reverted$/i.test(message) ? clean(String(message).replace(/0x[0-9a-fA-F]{40}/g, (a) => short(a)), 160) : 'the contract refused it without a reason';
}

/** One simulated block of calls through eth_simulateV1: the per-call results, or null when the chain does not serve it. */
async function simulateBlock(chainId, calls) {
  if (simOff.get(chainId) > Date.now()) return null;
  let j;
  try { j = await rpc(chainId, 'eth_simulateV1', [{ blockStateCalls: [{ calls }], validation: false }, 'latest']); } catch (e) { if (e?.noRoute) throw e; return null; }
  const out = j.result?.[0]?.calls;
  if (Array.isArray(out) && out.length === calls.length) { simSeen.add(chainId); return out; }
  // the node refused the block as a whole (the sender cannot pay for it): served, and the answer is no
  if (j.error && j.error.code <= -38000 && j.error.code > -39000) { simSeen.add(chainId); return calls.map(() => ({ status: '0x0', error: j.error })); }
  // not served here. A chain that has answered before is asked again next time; one that never has is left alone for a while.
  if (!simSeen.has(chainId)) simOff.set(chainId, Date.now() + 10 * 60_000);
  return null;
}

/** An eth_call the Robinhood proxy cannot answer from memory: an override that changes nothing makes it unlike any before. */
const unlike = (chainId) => (chainId === 4663 ? [{ [`0x${randomBytes(20).toString('hex')}`]: { nonce: '0x1' } }] : []);

/**
 * View calls, answered together by the chain as it is now: [{ status: 'success', result } | { status: 'failure' }].
 * One eth_simulateV1 block where the chain serves it (the one read the Robinhood proxy never keeps a copy of),
 * otherwise one eth_call each, side by side.
 */
async function readAll(chainId, contracts) {
  const calls = contracts.map((c) => ({ to: c.address, data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args || [] }) }));
  const decode = (c, data) => { try { return { status: 'success', result: decodeFunctionResult({ abi: c.abi, functionName: c.functionName, data }) }; } catch { return { status: 'failure' }; } };
  const block = await simulateBlock(chainId, calls);
  if (block) return block.map((r, i) => (r.status === '0x1' ? decode(contracts[i], r.returnData || '0x') : { status: 'failure' }));
  return Promise.all(calls.map(async (call, i) => {
    const j = await rpc(chainId, 'eth_call', [call, 'latest', ...unlike(chainId)]);
    return typeof j.result === 'string' ? decode(contracts[i], j.result) : { status: 'failure' };
  }));
}
const good = (r) => r && r.status === 'success';

/**
 * Run `txs` in order as `from` against the latest state.
 *   1. eth_simulateV1: one simulated block, every call from the owner, logs included.
 *   2. one transaction: eth_call.
 *   3. several, on a chain that does not serve eth_simulateV1 (Blast, Avalanche): one eth_call in which Multicall3's
 *      code stands at the owner's own address, so each call still comes from the owner. No logs.
 * Returns { logs: boolean, runs } or null when the chain could not run it at all.
 */
async function simulate(chainId, from, txs) {
  const calls = txs.map((t) => ({ from, to: t.to, data: t.data, value: toHex(BigInt(t.value)) }));
  const block = await simulateBlock(chainId, calls).catch(() => null);
  if (block) {
    return {
      logs: true,
      runs: block.map((c) => ({
        ok: c.status === '0x1',
        data: c.returnData || '0x',
        logs: Array.isArray(c.logs) ? c.logs : [],
        gas: c.gasUsed ? BigInt(c.gasUsed) : 0n,
        why: c.status === '0x1' ? null : reason(c.error?.data ?? c.returnData, c.error?.message),
      })),
    };
  }
  try {
    if (calls.length === 1) {
      const j = await rpc(chainId, 'eth_call', [calls[0], 'latest', ...unlike(chainId)]);
      if (typeof j.result === 'string') return { logs: false, runs: [{ ok: true, data: j.result, logs: [], gas: 0n, why: null }] };
      if (verdict(j.error)) return { logs: false, runs: [{ ok: false, data: '0x', logs: [], gas: 0n, why: reason(j.error.data, j.error.message) }] };
      return null;
    }
    const code = await codeAt(chainId, MULTICALL3);
    if (!code) return null;
    const data = encodeFunctionData({ abi: MC3, functionName: 'aggregate3Value', args: [txs.map((t) => ({ target: t.to, allowFailure: true, value: BigInt(t.value), callData: t.data }))] });
    const total = txs.reduce((n, t) => n + BigInt(t.value), 0n);
    const j = await rpc(chainId, 'eth_call', [{ from, to: from, data, value: toHex(total) }, 'latest', { [from]: { code } }]);
    if (typeof j.result !== 'string') return null;
    const res = decodeFunctionResult({ abi: MC3, functionName: 'aggregate3Value', data: j.result });
    return { logs: false, runs: res.map((r) => ({ ok: r.success, data: r.returnData, logs: [], gas: 0n, why: r.success ? null : reason(r.returnData) })) };
  } catch {
    return null;
  }
}

const codes = new Map(); // `${chainId}:${address}` -> code, for contracts whose code never changes; absence is not remembered
async function codeAt(chainId, address) {
  const k = `${chainId}:${address.toLowerCase()}`;
  if (!codes.has(k)) {
    const j = await rpc(chainId, 'eth_getCode', [address, 'latest']);
    if (typeof j.result !== 'string' || j.result.length <= 2) return null;
    codes.set(k, j.result);
  }
  return codes.get(k);
}

const metas = new Map(); // `${chainId}:${token}` -> { decimals, symbol }: a token's own answer, which does not change

// ───────────────────────── Relay ─────────────────────────

const RELAY_ERRORS = {
  AMOUNT_TOO_LOW: ['AMOUNT_TOO_LOW', 'That amount is too small to cover the delivery. Try a little more.'],
  AMOUNT_TOO_HIGH: ['AMOUNT_TOO_HIGH', 'That is more than Relay will carry on this route in one go. Try a smaller amount.'],
  NO_SWAP_ROUTES_FOUND: ['NO_ROUTE', 'Relay has no way to turn that token into gas on that chain right now.'],
  NO_QUOTES: ['NO_ROUTE', 'Relay has no way to turn that token into gas on that chain right now.'],
  UNSUPPORTED_ROUTE: ['NO_ROUTE', 'Relay does not serve that route.'],
  UNSUPPORTED_CURRENCY: ['NO_ROUTE', 'Relay does not take that token.'],
  INSUFFICIENT_LIQUIDITY: ['NO_LIQUIDITY', 'Relay does not have enough of that gas token on hand right now. Try a smaller amount.'],
  SWAP_IMPACT_TOO_HIGH: ['PRICE_IMPACT', 'That token would lose too much of its value on the way. Try a smaller amount or a different token.'],
  INSUFFICIENT_FUNDS: ['INSUFFICIENT_BALANCE', 'Your wallet does not hold that much of the token.'],
  SANCTIONED_WALLET_ADDRESS: ['REFUSED', 'Relay will not serve this wallet.'],
  SANCTIONED_CURRENCY: ['REFUSED', 'Relay will not serve this token.'],
};

/**
 * Relay allows 50 quotes a minute from one address without an API key (its docs, 2026-10), and every visitor's
 * quote leaves from this one server. So: identical requests share an answer (4 s when a transaction hangs off it,
 * 12 s when it is only a price), the server keeps count and stops short of the limit, leaving the last of it to
 * wallets that are about to sign, and RELAY_API_KEY, when set, is sent as x-api-key for the higher limit.
 */
const RELAY_KEY = /^[\x21-\x7e]{8,200}$/.test(process.env.RELAY_API_KEY || '') ? process.env.RELAY_API_KEY : null;
const PER_MINUTE = RELAY_KEY ? 540 : 46;
const sent = []; // when each quote of the last minute left
const quotes = new Map(); // request -> { at, p }
function relayQuote(body, forWallet) {
  const key = JSON.stringify(body);
  const hit = quotes.get(key);
  if (hit && Date.now() - hit.at < (forWallet ? 4_000 : 12_000)) return hit.p;
  while (sent.length && Date.now() - sent[0] > 60_000) sent.shift();
  if (sent.length >= (forWallet ? PER_MINUTE : Math.floor(PER_MINUTE * 0.75))) return Promise.reject(fail('RELAY_BUSY', 'Relay is busy. Try again in a few seconds.', 503));
  sent.push(Date.now());
  const p = (async () => {
    let r;
    try {
      r = await fetch(`${RELAY}/quote`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...(RELAY_KEY ? { 'x-api-key': RELAY_KEY } : {}) }, body: key, signal: AbortSignal.timeout(9_000) });
    } catch (e) {
      throw fail('RELAY_UNREACHABLE', 'Relay did not answer. Try again in a moment.', 503);
    }
    const j = await r.json().catch(() => null);
    if (r.ok && j && Array.isArray(j.steps)) return j;
    if (j?.errorCode === 'UNSUPPORTED_CHAIN') throw noOp('Relay does not serve that chain.');
    const known = RELAY_ERRORS[j?.errorCode];
    if (known) throw fail(known[0], known[1], 422);
    if (r.status === 429) throw fail('RELAY_BUSY', 'Relay is busy. Try again in a few seconds.', 503);
    throw fail('RELAY_REFUSED', 'Relay could not quote this right now.', r.status >= 500 ? 503 : 422, new Error(`${r.status} ${clean(String(j?.errorCode || ''), 60)} ${clean(String(j?.message || ''), 200)}`));
  })();
  if (quotes.size > 300) quotes.delete(quotes.keys().next().value);
  quotes.set(key, { at: Date.now(), p });
  p.catch(() => quotes.delete(key));
  return p;
}

const refuse = (why) => fail('RELAY_SHAPE', 'Relay answered with a transaction this page does not recognize, so it was refused. Nothing was sent.', 502, new Error(why));

/**
 * Hold Relay's answer to what was asked. Returns the one deposit transaction, the spender an ERC-20 must allow,
 * and the amounts, or throws. Nothing from the answer is trusted as an address to call: the only targets accepted
 * are the origin chain's depository and its proxy, both from the pinned set above.
 */
function readQuote(q, { user, origin, dest, currencyIn, native, exactIn, amount }) {
  const d = q.details;
  if (!d || typeof d !== 'object') throw refuse('no details');
  const cin = d.currencyIn, cout = d.currencyOut;
  if (!cin?.currency || !cout?.currency || !digits(cin.amount) || !digits(cout.amount)) throw refuse('no amounts');
  if (Number(cin.currency.chainId) !== origin.id || !same(cin.currency.address, currencyIn)) throw refuse('pays in another currency');
  if (Number(cout.currency.chainId) !== dest.id || !same(cout.currency.address, ZERO)) throw refuse('delivers another currency');
  if (!same(d.sender, user) || !same(d.recipient, user)) throw refuse('another sender or recipient');
  const amountIn = BigInt(cin.amount);
  const amountOut = BigInt(cout.amount);
  if (exactIn ? amountIn !== amount : amountOut < amount) throw refuse('another amount');
  if (amountIn === 0n || amountOut === 0n) throw refuse('zero amount');
  const minOut = digits(cout.minimumAmount) && BigInt(cout.minimumAmount) <= amountOut ? BigInt(cout.minimumAmount) : null;

  // the order Relay will fill: every payout and every refund must name this wallet
  const order = q.protocol?.v2;
  const orderId = typeof order?.orderId === 'string' && /^0x[0-9a-fA-F]{64}$/.test(order.orderId) ? order.orderId.toLowerCase() : null;
  const od = order?.orderData;
  if (od) {
    const pays = od.output?.payments;
    if (!Array.isArray(pays) || !pays.length || !pays.every((p) => same(p.recipient, user) && same(p.currency, ZERO))) throw refuse('order pays someone else');
    for (const inp of Array.isArray(od.inputs) ? od.inputs : []) {
      for (const rf of Array.isArray(inp.refunds) ? inp.refunds : []) if (!same(rf.recipient, user)) throw refuse('order refunds someone else');
    }
  }
  if (order?.paymentDetails?.depository && !same(order.paymentDetails.depository, origin.depository)) throw refuse('another depository');
  const solverGets = digits(order?.paymentDetails?.amount) ? BigInt(order.paymentDetails.amount) : null;

  // steps: [deposit], or [approve, deposit] for an ERC-20. One transaction each, on the origin chain, from the wallet.
  const steps = q.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 2) throw refuse(`${steps?.length} steps`);
  const item = (s, name) => {
    if (!s || s.id !== name || s.kind !== 'transaction' || !Array.isArray(s.items) || s.items.length !== 1) throw refuse(`step ${name}`);
    const t = s.items[0]?.data;
    if (!t || Number(t.chainId) !== origin.id || !same(t.from, user) || !isAddress(t.to || '') || !isHex(t.data) || !digits(String(t.value ?? '0'))) throw refuse(`step ${name} data`);
    return { to: getAddress(t.to), data: t.data, value: BigInt(t.value ?? '0') };
  };
  const dep = item(steps[steps.length - 1], 'deposit');
  if (native && steps.length !== 1) throw refuse('approval for a gas token');
  if (steps.length === 2) {
    const ap = item(steps[0], 'approve');
    let a;
    try { a = decodeFunctionData({ abi: ERC20, data: ap.data }); } catch { throw refuse('approve data'); }
    if (!same(ap.to, currencyIn) || ap.value !== 0n || a.functionName !== 'approve' || !same(a.args[0], dep.to)) throw refuse('approve target');
  }

  let call;
  try { call = decodeFunctionData({ abi: RELAY_ABI, data: dep.data }); } catch { throw refuse('deposit data'); }
  let shape;
  if (same(dep.to, origin.depository)) {
    // straight into the depository: every argument is checked
    if (native) {
      if (call.functionName !== 'depositNative' || !same(call.args[0], user) || dep.value !== amountIn) throw refuse('depositNative arguments');
      if (orderId && call.args[1].toLowerCase() !== orderId) throw refuse('order id');
    } else {
      if (call.functionName !== 'depositErc20' || !same(call.args[0], user) || !same(call.args[1], currencyIn) || call.args[2] !== amountIn || dep.value !== 0n) throw refuse('depositErc20 arguments');
      if (orderId && call.args[3].toLowerCase() !== orderId) throw refuse('order id');
    }
    shape = 'direct';
  } else if (origin.proxy && same(dep.to, origin.proxy) && !native) {
    // the token is swapped on chain A first. The proxy may pull this token and this amount and nothing else;
    // what it does with it is only accepted after the test run shows it landing in the depository.
    if (call.functionName !== 'transferAndMulticall' || dep.value !== 0n) throw refuse('proxy call');
    const [tokens, amounts] = call.args;
    if (tokens.length !== 1 || amounts.length !== 1 || !same(tokens[0], currencyIn) || amounts[0] !== amountIn) throw refuse('proxy pulls something else');
    if (!orderId) throw refuse('no order id to look for');
    shape = 'swap-first';
  } else {
    throw refuse(`deposit goes to ${dep.to}`);
  }
  return { shape, deposit: dep, spender: dep.to, amountIn, amountOut, minOut, orderId, solverGets, details: d, solver: typeof od?.solver === 'string' && isAddress(od.solver) ? getAddress(od.solver) : null };
}

/** The depository's own event for this order, or null. Proof that the money ends up where the quote said. */
function depositSeen(logs, r, owner, depository) {
  for (const log of logs) {
    if (!same(log.address, depository)) continue;
    try {
      const e = decodeEventLog({ abi: RELAY_ABI, data: log.data, topics: log.topics });
      if (e.eventName !== 'RelayNativeDeposit' && e.eventName !== 'RelayErc20Deposit') continue;
      if (e.args.id.toLowerCase() !== r.orderId || !same(e.args.from, owner)) continue;
      return e.args.amount;
    } catch { /* another event */ }
  }
  return null;
}
/**
 * Everything the run moved out of the wallet: [{ token, value }]. An ERC-20 transfer has three topics and its
 * value in the data; anything else under the Transfer topic (an NFT has four topics) is reported with value null.
 */
function spentIn(logs, owner) {
  const out = [];
  const from = `0x${owner.slice(2).toLowerCase().padStart(64, '0')}`;
  for (const log of logs) {
    const t = log.topics;
    if (!Array.isArray(t) || t[0] !== TRANSFER || String(t[1]).toLowerCase() !== from) continue;
    const erc20 = t.length === 3 && typeof log.data === 'string' && log.data.length === 66;
    out.push({ token: log.address, value: erc20 ? BigInt(log.data) : null });
  }
  return out;
}

// ───────────────────────── plan ─────────────────────────

/** Sync and pure: both chains are ones Relay serves, by the list in hand. Anything unknown is simply not ours. */
export function match(input, output) {
  return isToken(input) && isToken(output) && output.address === 'NATIVE' && input.chainId !== output.chainId
    && chains.has(input.chainId) && chains.has(output.chainId);
}

export async function plan({ input, output, owner, slippage }) {
  if (!isToken(input) || !isToken(output) || output.address !== 'NATIVE' || input.chainId === output.chainId) throw noOp('This turns a token on one chain into the gas token of another chain.');
  // the first plan after a start waits a moment for Relay's list; after that the list in hand is used as it is
  await within(refreshChains(), chainsAt ? 0 : 2_000);
  const origin = chains.get(input.chainId);
  const dest = chains.get(output.chainId);
  if (!origin || !dest) throw noOp('Relay does not serve that chain.');
  if (!origin.depository || !origin.deposits) throw noOp(`Relay does not take deposits on ${origin.name} in a form this page can check.`);
  if (owner !== null && owner !== undefined && !isAddress(owner)) throw fail('BAD_OWNER', 'That wallet address is not valid.', 400);
  const who = owner ? getAddress(owner) : null;
  const typed = (t) => (digits(t?.amount) && !/^0+$/.test(t.amount) ? BigInt(t.amount) : null);
  const exactIn = typed(input) !== null;
  const amount = exactIn ? typed(input) : typed(output);
  if (amount === null) throw fail('AMOUNT_REQUIRED', 'Type an amount first.', 400);
  try {
    return await build({ input, output, origin, dest, owner: who, slippage, exactIn, amount });
  } catch (e) {
    if (e?.planError) throw e;
    if (e?.noRoute) throw noOp(`This page cannot read ${origin.name}, so it will not build a transaction there.`);
    throw fail('UPSTREAM_UNAVAILABLE', `${origin.name} could not be read just now. Try again in a moment.`, 503, e);
  }
}

async function build({ input, output, origin, dest, owner, slippage, exactIn, amount }) {
  const native = input.address === 'NATIVE';
  const tokenIn = native ? null : getAddress(input.address);
  const currencyIn = native ? ZERO : tokenIn;
  const user = owner || NOBODY;
  const metaKey = `${origin.id}:${currencyIn.toLowerCase()}`;

  // ── round one: everything that does not depend on anything else leaves together ──
  const bps = Number.isFinite(slippage) && slippage > 0 && slippage <= 50 ? Math.round(slippage * 100) : 0;
  const quoteP = relayQuote({
    user, recipient: user, originChainId: origin.id, destinationChainId: dest.id, originCurrency: currencyIn, destinationCurrency: ZERO,
    amount: amount.toString(), tradeType: exactIn ? 'EXACT_INPUT' : 'EXACT_OUTPUT', ...(bps >= 1 ? { slippageTolerance: String(bps) } : {}),
  }, !!owner);
  quoteP.catch(() => {}); // awaited below; a failed read must not leave it unhandled meanwhile

  // one batch on the origin chain: what the token says it is, and what the wallet holds and has allowed
  const batch = [
    ...(owner ? [{ address: MULTICALL3, abi: MC3, functionName: 'getEthBalance', args: [owner] }] : []),
    ...(native ? [] : [
      { address: tokenIn, abi: ERC20, functionName: 'decimals' },
      { address: tokenIn, abi: ERC20, functionName: 'symbol' },
      ...(owner ? [
        { address: tokenIn, abi: ERC20, functionName: 'balanceOf', args: [owner] },
        { address: tokenIn, abi: ERC20, functionName: 'allowance', args: [owner, origin.depository] },
        ...(origin.proxy ? [{ address: tokenIn, abi: ERC20, functionName: 'allowance', args: [owner, origin.proxy] }] : []),
      ] : []),
    ]),
  ];
  // a quote for a token already known needs nothing from the chain, only to know the chain can be read at all
  // (a quote that turns into "cannot do that" the moment a wallet connects is worse than no quote)
  const needChain = owner || (!native && !metas.has(metaKey));
  const readsP = needChain ? readAll(origin.id, batch).then((res) => { readableUntil.set(origin.id, Date.now() + 60 * 60_000); return res; }) : Promise.resolve(null);
  readsP.catch(() => {});
  const canReadP = needChain ? null : within(readable(origin.id).then(() => true, (e) => !e?.noRoute), 1_200, true);
  const priceP = owner ? within(rpc(origin.id, 'eth_gasPrice', []).then((j) => (typeof j.result === 'string' ? BigInt(j.result) : null)), 2_500) : null;
  const thereP = owner ? within(rpc(dest.id, 'eth_getBalance', [owner, 'latest']).then((j) => (typeof j.result === 'string' ? BigInt(j.result) : null)), 1_500) : null;
  const codeP = owner ? Promise.all([codeAt(origin.id, origin.depository), origin.proxy ? codeAt(origin.id, origin.proxy) : null]) : null;
  codeP?.catch(() => {});

  const reads = await readsP;
  if (canReadP && !(await canReadP)) throw noOp(`This page cannot read ${origin.name}, so it will not build a transaction there.`);
  let i = 0;
  let gasBalance = null;
  if (owner) {
    const b = reads[i++];
    gasBalance = good(b) ? b.result : await rpc(origin.id, 'eth_getBalance', [owner, 'latest']).then((j) => BigInt(j.result));
  }
  let meta = native ? { decimals: origin.decimals, symbol: origin.symbol } : metas.get(metaKey);
  let held = null, allowDirect = 0n, allowProxy = 0n;
  if (!native && reads) {
    const [dec, sym] = [reads[i++], reads[i++]];
    if (!meta) {
      if (!good(dec) || dec.result > 36) throw fail('NOT_A_TOKEN', `There is no token at ${short(tokenIn)} on ${origin.name}.`, 404);
      meta = { decimals: Number(dec.result), symbol: clean(good(sym) ? String(sym.result) : '') || short(tokenIn) };
      if (metas.size > 2_000) metas.delete(metas.keys().next().value);
      metas.set(metaKey, meta);
    }
    if (owner) {
      const [bal, a1] = [reads[i++], reads[i++]];
      const a2 = origin.proxy ? reads[i++] : null;
      if (!good(bal) || !good(a1)) throw new Error('the wallet could not be read');
      held = bal.result;
      allowDirect = a1.result;
      allowProxy = good(a2) ? a2.result : 0n;
    }
  }

  const pic = (t) => (typeof t.logo === 'string' && /^(https:\/\/|data:image\/)/.test(t.logo) && t.logo.length <= 16_000 ? t.logo : null);
  const tIn = {
    chainId: origin.id, address: native ? 'NATIVE' : tokenIn, symbol: meta.symbol, name: clean(input.name, 64) || meta.symbol, decimals: meta.decimals, logo: pic(input),
    tags: Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === 'string' && t.length <= 24).slice(0, 8) : [],
  };
  const tOut = { chainId: dest.id, address: 'NATIVE', symbol: dest.symbol, name: clean(output.name, 64) || dest.symbol, decimals: dest.decimals, logo: pic(output), tags: ['native'] };
  const inAmt = (v) => `${human(v, meta.decimals)} ${meta.symbol}`;
  const outAmt = (v) => `${human(v, dest.decimals)} ${dest.symbol}`;

  const q = await quoteP;
  const r = readQuote(q, { user, origin, dest, currencyIn, native, exactIn, amount });

  const legs = [];
  const facts = [];
  const warnings = [];
  let depositTx = null;
  let approveTxs = [];
  let checked = null;

  if (owner) {
    const have = native ? gasBalance : held;
    if (have < r.amountIn) throw fail('INSUFFICIENT_BALANCE', `You hold ${inAmt(have)} on ${origin.name} and this needs ${inAmt(r.amountIn)}.`);
    if (gasBalance === 0n) throw fail('NO_GAS_ON_ORIGIN', `You need a little ${origin.symbol} on ${origin.name} to send this, and you hold none.`);
    const [depCode, proxyCode] = await codeP;
    if (!(r.shape === 'direct' ? depCode : proxyCode && depCode)) throw fail('RELAY_NOT_DEPLOYED', `Relay's contract was not found on ${origin.name}, so nothing was prepared.`, 503);

    // ── round two: the test run ──
    const allowance = r.shape === 'direct' ? allowDirect : allowProxy;
    depositTx = { chainId: origin.id, to: r.deposit.to, value: r.deposit.value.toString(), data: r.deposit.data };
    const approve = (v) => ({ chainId: origin.id, to: tokenIn, value: '0', data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [r.spender, v] }) });
    if (!native && allowance < r.amountIn) approveTxs = [approve(r.amountIn)];

    let sim = await simulate(origin.id, owner, [...approveTxs, depositTx]);
    // Tokens in the USDT mould refuse to change a non-zero allowance: clear it first, then set it.
    if (sim && approveTxs.length === 1 && !sim.runs[0].ok && allowance > 0n) {
      approveTxs = [approve(0n), approve(r.amountIn)];
      sim = await simulate(origin.id, owner, [...approveTxs, depositTx]);
    }
    if (!sim) throw fail('SIMULATION_UNAVAILABLE', `${origin.name} could not test this transaction just now, so nothing was prepared. Try again in a moment.`, 503);
    const bad = sim.runs.find((x) => !x.ok);
    if (bad) throw fail('WOULD_REVERT', `A test run of this exact transaction failed: ${bad.why}. Nothing was sent.`);

    const run = sim.runs[sim.runs.length - 1];
    if (sim.logs) {
      const landed = depositSeen(run.logs, r, owner, origin.depository);
      const floor = r.shape === 'direct' ? r.amountIn : r.solverGets;
      if (r.orderId && (landed === null || (floor !== null && landed < floor))) {
        throw fail('WOULD_REVERT', 'A test run of this transaction did not end with your payment in Relay\'s deposit contract under the quoted order. Nothing was sent.');
      }
      if (!native) {
        const spent = spentIn(run.logs, owner);
        const total = spent.reduce((n, s) => n + (s.value ?? 0n), 0n);
        if (spent.some((s) => s.value === null || !same(s.token, tokenIn)) || total !== r.amountIn) {
          throw fail('WOULD_REVERT', 'A test run of this transaction moved something other than the amount you typed out of your wallet. Nothing was sent.');
        }
      }
    } else if (r.shape !== 'direct') {
      throw fail('CANNOT_VERIFY_ROUTE', `This token has to be swapped on ${origin.name} first, and that chain cannot show a test run in enough detail to check it. Try a token Relay takes directly, such as ${origin.symbol} or USDC.`);
    }

    const gas = sim.runs.reduce((n, x) => n + x.gas, 0n);
    const price = await priceP;
    if (gas > 0n && price !== null) {
      const fee = gas * price;
      const need = fee + (native ? r.amountIn : 0n);
      if (gasBalance < need) {
        throw fail('NO_GAS_ON_ORIGIN', native
          ? `After the network fee (about ${human(fee, origin.decimals, 3)} ${origin.symbol}) you can send at most ${human(gasBalance > fee ? gasBalance - fee : 0n, origin.decimals)} ${origin.symbol}.`
          : `You need about ${human(fee, origin.decimals, 3)} ${origin.symbol} on ${origin.name} for the network fee, and you hold ${human(gasBalance, origin.decimals, 3)}.`);
      }
      facts.push({ label: `Network fee on ${origin.name}`, value: `about ${human(fee, origin.decimals, 3)} ${origin.symbol}`, sub: 'You still pay this one yourself, on the chain you are sending from.' });
    }
    checked = sim.logs
      ? 'These exact transactions were run from your wallet against the live chain, and the payment showed up in Relay\'s deposit contract under this order.'
      : 'These exact transactions were run from your wallet against the live chain.';
  }

  // ── legs ──
  const approveNote = 'This exact amount, not unlimited.';
  if (!native) {
    if (!owner) {
      legs.push({ kind: 'approve', chainId: origin.id, label: `Allow Relay to take exactly ${inAmt(r.amountIn)}`, in: null, out: null, feeNative: null, note: approveNote, exec: { type: 'tx', tx: null } });
    } else {
      approveTxs.forEach((tx, n) => {
        const clearing = approveTxs.length === 2 && n === 0;
        legs.push({
          kind: 'approve', chainId: origin.id,
          label: clearing ? `Clear the old ${meta.symbol} allowance for Relay` : `Allow Relay to take exactly ${inAmt(r.amountIn)}`,
          in: null, out: null, feeNative: null,
          note: clearing ? 'This token only lets an allowance be changed from zero.' : approveNote,
          exec: { type: 'tx', tx },
        });
      });
    }
  }
  const seconds = Number(r.details.timeEstimate);
  const eta = Number.isFinite(seconds) && seconds > 0 ? (seconds < 90 ? `about ${Math.max(1, Math.round(seconds))} second${Math.round(seconds) === 1 ? '' : 's'}` : `about ${Math.round(seconds / 60)} minutes`) : 'a few seconds';
  legs.push({
    kind: 'bridge',
    chainId: origin.id,
    label: `Pay ${inAmt(r.amountIn)} to Relay on ${origin.name}`,
    in: { token: tIn, amount: r.amountIn.toString() },
    out: { token: tOut, amount: r.amountOut.toString() },
    feeNative: null,
    note: `Relay then sends ${outAmt(r.amountOut)} to your address on ${dest.name}, usually in ${eta}. You sign nothing on ${dest.name}.`,
    exec: { type: 'tx', tx: depositTx },
  });

  // ── facts ──
  const usdIn = Number(r.details.currencyIn?.amountUsd);
  const usdOut = Number(r.details.currencyOut?.amountUsd);
  const cost = Number.isFinite(usdIn) && Number.isFinite(usdOut) && usdIn > 0 ? usdIn - usdOut : null;
  const head = [
    {
      label: 'Delivered by',
      value: 'Relay, a third party',
      sub: `You pay into Relay's deposit contract on ${origin.name}. Relay's solver${r.solver ? ` (${short(r.solver)})` : ''} then sends the gas from its own funds on ${dest.name}. No contract links the two: you are trusting Relay to deliver, or to refund you.`,
      tone: 'warn',
    },
    { label: 'Arrives', value: eta.replace(/^about /, 'In about ').replace(/^a few/, 'In a few'), sub: `Relay's estimate. It lands at ${owner ? short(owner) : 'your own address'} on ${dest.name}.` },
    ...(r.minOut !== null && r.minOut < r.amountOut
      ? [{ label: 'At least', value: outAmt(r.minOut), sub: `Relay's order says that if it cannot deliver this much it refunds your ${meta.symbol} on ${origin.name}. The refund is Relay's to make.` }]
      : []),
    ...(cost !== null && money(cost)
      ? [{ label: 'Cost of the trip', value: `${money(cost)}${usdIn > 0 ? ` (${((cost / usdIn) * 100).toFixed(1)}%)` : ''}`, sub: `Relay's fee, the price difference, and the gas its solver spends on ${dest.name}, by Relay's own dollar figures.`, ...(usdIn > 0 && cost / usdIn > 0.1 ? { tone: 'warn' } : {}) }]
      : []),
    ...(r.shape === 'swap-first'
      ? [{ label: 'Route', value: `Swapped on ${origin.name} first`, sub: `Relay does not take ${meta.symbol} directly, so its router swaps it before the deposit. The same transaction does both.` }]
      : []),
  ];
  const there = thereP ? await thereP : null;
  if (there !== null) head.push({ label: `Gas on ${dest.name} now`, value: outAmt(there), sub: there === 0n ? 'None, which is what this fixes.' : 'What your address already holds there.' });
  facts.unshift(...head);
  if (checked) facts.push({ label: 'Checked', value: 'Test run passed', sub: checked, tone: 'ok' });

  warnings.push(`Relay is a third party and this page has not audited it. Your ${meta.symbol} leaves your wallet first and the gas arrives after. If it does not arrive, the refund comes from Relay.`);
  if (cost !== null && usdIn > 0 && cost / usdIn > 0.1) warnings.push(`This small amount loses about ${((cost / usdIn) * 100).toFixed(0)}% to the cost of the trip. A larger amount loses much less.`);

  return {
    routing: 'PLAN',
    op: id,
    headline: `${inAmt(r.amountIn)} on ${origin.name} becomes ${outAmt(r.amountOut)} of gas on ${dest.name}`,
    pay: { label: `${meta.symbol} on ${origin.name}`, amount: r.amountIn.toString(), token: tIn },
    receive: { label: `${dest.symbol} on ${dest.name} (gas)`, amount: r.amountOut.toString(), token: tOut },
    legs,
    facts,
    warnings,
    contracts: [
      ...(native ? [] : [{ chainId: origin.id, address: tokenIn, name: `${meta.symbol} (the token you allow)` }]),
      r.shape === 'direct' ? { chainId: origin.id, address: origin.depository, name: 'Relay depository' } : { chainId: origin.id, address: origin.proxy, name: 'Relay approval proxy' },
      ...(r.shape === 'direct' ? [] : [{ chainId: origin.id, address: origin.depository, name: 'Relay depository (where the swap pays in)' }]),
    ],
  };
}

export async function catalog() {
  return [];
}

export function register() {}
