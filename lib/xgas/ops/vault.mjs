// USDG to X Money and back, through the xGas vault on Robinhood Chain.
//
// The vault is not a pool. It holds USDG and mints X Money against it at reserve / supply, and burns X Money
// for USDG at the same number. Four trades come out of that, and they are not equally swap-like:
//
//   USDG -> X Money (ERC-20, Robinhood)   vault.enterRollupToL2          one transaction, lands in it
//   X Money (ERC-20, Robinhood) -> USDG   vault.exitRollup               one transaction, lands in it
//   USDG -> X Money (gas, xGas chain)     EarlyDepositor.deposit, or     one transaction, lands about a minute later
//                                         vault.enterRollup once the vault points at chain 466302
//   X Money (gas, xGas chain) -> USDG     ArbSys.withdrawEth, then a     three transactions over days: only the
//                                         wait, a claim, an exitRollup   first one can be built here
//
// Every address below is the live deployment (xgas-app src/contracts/l4-deployment.json). Before a transaction
// is returned it is run, from the owner, against the latest state through eth_simulateV1; a run that fails is
// refused with the reason.
//
// Chain reads: Robinhood straight from dRPC with the server's key when DRPC_KEY is set, through the staccpad
// proxy otherwise or when the direct call fails; the xGas chain from its own RPC. The proxy keeps eth_call,
// multicall, balance and code answers for a while (seconds fresh, then up to two minutes stale while it
// refreshes; code for good). Fine for a page, not for deciding what a wallet signs: a balance from before the
// last transaction, or "no code" for a wallet that has since been deployed. The one read it never keeps is
// eth_simulateV1, so the reads that decide a plan are sent as one simulated block of view calls, and balances
// and code come from ArbInfo, the Arbitrum precompile, inside the same block.
//
// Speed: a plan is two round trips, the reads and then the test run. The gas price and the other optional reads
// leave with the first and are dropped when they are slow.
import { randomBytes } from 'node:crypto';
import { decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, isAddress, parseAbi, toHex } from 'viem';

export const id = 'vault';

// ───────────────────────── fixed facts ─────────────────────────

const RH = 4663;
const L4 = 466302;

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const XMONEY = '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E'; // the vault and the X Money ERC-20 are one contract
const EARLY_DEPOSITOR = getAddress('0x36e52831ba473e9374bad7cc22ed942a99b4d431');
const L4_INBOX = '0xa7087693676F2Ca8e5e9563A6859952258688146'; // chain 466302's inbox on Robinhood
const ROLLUP = '0x5868266C0c0663f4bc39329B525884f137BAD93E';
const ARBSYS = '0x0000000000000000000000000000000000000064';
const ARBINFO = '0x0000000000000000000000000000000000000065'; // on Robinhood and on xGas: both are Arbitrum chains
const FANOUT = '0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e';

const BPS = 10_000n;
const SCALE = 10n ** 12n; // USDG has 6 decimals, X Money 18
/** BoLD on an Arbitrum parent counts its windows in Ethereum blocks. 12 s each; missed slots only make it longer. */
const L1_BLOCK_SECONDS = 12;
/** Past this a quiet validator is not "between checkpoints", it is idle, and exits wait on it. */
const IDLE_AFTER_SECONDS = 6 * 3600;

const ALPHA = 'xGas is highly alpha, untested, unaudited software. Its contracts can have bugs and funds can be lost. Only use amounts you can afford to lose.';

const T_USDG = { chainId: RH, address: USDG, symbol: 'USDG', name: 'Global Dollar', decimals: 6, logo: null, tags: ['stable'] };
const T_XM = { chainId: RH, address: XMONEY, symbol: 'xMoney', name: 'X Money', decimals: 18, logo: null, tags: ['xmoney'] };
const T_XM_L4 = { chainId: L4, address: 'NATIVE', symbol: 'xMoney', name: 'X Money on xGas', decimals: 18, logo: null, tags: ['xmoney', 'native'] };

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
]);
const VAULT = parseAbi([
  'function enterRollup(uint256 usdgAmount, address l3Recipient) returns (uint256 xMoneyBridged)',
  'function enterRollupToL2(uint256 usdgAmount) returns (uint256 xMoneyMinted)',
  'function exitRollup(uint256 xMoneyAmount) returns (uint256 usdgOut)',
  'function getReserveNAV() view returns (uint256 navRay, uint256 usdgReserve, uint256 circulatingXMoney)',
  'function inbox() view returns (address)',
  'function l3GasLimit() view returns (uint256)',
  'function l3MaxFeePerGas() view returns (uint256)',
  'function isBridgeSystem(address) view returns (bool)',
  'function BURN_BPS() view returns (uint256)',
  'function FANOUT_RAKE_BPS() view returns (uint256)',
  'event RollupEntered(address indexed user, address indexed l3Recipient, uint256 usdgIn, uint256 xMoneyBridged, uint256 usdgRaked, uint256 xMoneyBurned, uint256 retryableId)',
]);
const EARLY = parseAbi([
  'function deposit(uint256 usdgAmount, address l3Recipient) returns (uint256 retryableId)',
  'function INBOX() view returns (address)',
  'function defaultGasLimit() view returns (uint256)',
  'function defaultMaxFeePerGas() view returns (uint256)',
  'event EarlyDeposit(address indexed sender, address indexed l3Recipient, uint256 indexed retryableId, uint256 usdgIn, uint256 xMoneyMinted, uint256 l3Deposit, uint256 l2CallValue, uint256 bridgeReceived, uint256 gasLimit, uint256 maxFeePerGas)',
]);
const ARBSYS_ABI = parseAbi(['function withdrawEth(address destination) payable returns (uint256)']);
const ARBINFO_ABI = parseAbi(['function getBalance(address account) view returns (uint256)', 'function getCode(address account) view returns (bytes)']);
const ROLLUP_ABI = parseAbi([
  'function chainId() view returns (uint256)',
  'function inbox() view returns (address)',
  'function confirmPeriodBlocks() view returns (uint64)',
  'function latestConfirmed() view returns (bytes32)',
  'function anyTrustFastConfirmer() view returns (address)',
  'function getValidators() view returns (address[])',
  'function latestStakedAssertion(address) view returns (bytes32)',
  'function getAssertion(bytes32) view returns ((uint64 firstChildBlock, uint64 secondChildBlock, uint64 createdAtBlock, bool isFirstChild, uint8 status, bytes32 configHash))',
]);
const SAFE = parseAbi(['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)']);

/** Everything these contracts can answer a failed call with, and what it means in plain words. */
const ERRORS = parseAbi([
  'error Error(string)',
  'error Panic(uint256)',
  'error InvalidAmount()',
  'error InsufficientBalance()',
  'error BridgeNotSet()',
  'error DepositBelowL4Fee(uint256 xMoneyNet, uint256 l4Fee)',
  'error DepositBelowL3Fee(uint256 xMoneyNet, uint256 l3Fee)',
  'error ZeroRecipient()',
  'error ZeroAmount()',
  'error Reentrancy()',
  'error GasParamsOutOfBounds(uint256 gasLimit, uint256 maxFeePerGas)',
  'error DepositTooSmall(uint256 l3Deposit, uint256 gasPrepay)',
  'error UnexpectedUsdgIn(uint256 expected, uint256 received)',
  'error InboxBalanceMismatch(uint256 before, uint256 afterwards)',
  'error Leftover(uint256 xMoney)',
  'error TokenCallFailed(address token)',
  'error RecipientIsContract(address recipient)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error SafeERC20FailedOperation(address token)',
]);
const ERROR_TEXT = {
  InvalidAmount: 'the amount is zero',
  ZeroAmount: 'the amount is zero',
  InsufficientBalance: 'the wallet does not hold that much X Money',
  BridgeNotSet: 'the vault is not connected to the xGas chain',
  DepositBelowL4Fee: 'the amount is too small to cover the delivery fee on xGas',
  DepositBelowL3Fee: 'the amount is too small to cover the delivery fee on xGas',
  DepositTooSmall: 'the amount is too small to cover the delivery fee on xGas',
  RecipientIsContract: 'the receiving address is a contract wallet, which nobody could reach on xGas',
  TokenCallFailed: 'the USDG could not be moved (not enough USDG, or not allowed yet)',
  ERC20InsufficientBalance: 'the wallet does not hold enough of the token',
  ERC20InsufficientAllowance: 'the allowance is smaller than the amount',
  SafeERC20FailedOperation: 'the USDG could not be moved (not enough USDG, or not allowed yet)',
};

// ───────────────────────── small pieces ─────────────────────────

/** An expected failure: the dispatcher shows `detail` as is. */
function fail(code, detail, status = 422, cause) {
  const e = new Error(detail);
  e.planError = true;
  e.code = code;
  e.detail = detail;
  e.status = status;
  if (cause) e.cause = cause;
  return e;
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;

/** Base units to a short decimal for a sentence: at most `sig` digits after the leading zeros. Exact, no floats. */
function human(value, decimals, sig = 6) {
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (!frac) return whole.toString();
  const lead = whole === 0n ? frac.match(/^0*/)[0].length : 0;
  const cut = frac.slice(0, lead + sig).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole.toString();
}
const usdg = (v) => `${human(v, 6)} USDG`;
const xm = (v) => `${human(v, 18)} X Money`;
const pct = (bps) => `${Number(bps) / 100}%`;
const FANOUT_NAME = `the Fanout contract (${short(FANOUT)})`;

function duration(seconds) {
  const mins = Math.max(1, Math.round(seconds / 60));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h ? `${d} day${d === 1 ? '' : 's'} ${h} h` : `${d} day${d === 1 ? '' : 's'}`;
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`;
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** The Token the page shows, built from what is pinned here; only the logo and tags come from the caller. */
function token(base, thing) {
  const logo = typeof thing?.logo === 'string' && /^(https:\/\/|data:image\/)/.test(thing.logo) && thing.logo.length <= 16_000 ? thing.logo : base.logo;
  const tags = Array.isArray(thing?.tags) && thing.tags.every((t) => typeof t === 'string' && t.length <= 24) ? thing.tags.slice(0, 8) : base.tags;
  return { ...base, logo, tags };
}

const isToken = (t) => !!t && typeof t === 'object' && t.kind === 'token';
const isUsdg = (t) => isToken(t) && t.chainId === RH && same(t.address, USDG);
const isXm = (t) => isToken(t) && t.chainId === RH && same(t.address, XMONEY);
const isXmL4 = (t) => isToken(t) && t.chainId === L4 && t.address === 'NATIVE';

function direction(input, output) {
  if (isUsdg(input) && isXm(output)) return 'enter';
  if (isXm(input) && isUsdg(output)) return 'exit';
  if (isUsdg(input) && isXmL4(output)) return 'enter-l4';
  if (isXmL4(input) && isUsdg(output)) return 'exit-l4';
  return null;
}

// ───────────────────────── chain access ─────────────────────────
// The keyed URL is built in `direct` and goes nowhere else: no error carries a URL, and nothing here logs.

const KEY = /^[A-Za-z0-9_-]{8,200}$/.test(process.env.DRPC_KEY || '') ? process.env.DRPC_KEY : null;
const direct = (chainId) => (KEY && chainId === RH ? `https://lb.drpc.live/robinhood/${KEY}` : null);
const proxy = (chainId) => (chainId === RH ? 'https://staccpad.fun/rpc' : 'https://xgas.dev/rpc');
const DIRECT_MS = 3_500;
const PROXY_MS = 6_000; // two round trips at their slowest still fit inside the dispatcher's patience
let restingUntil = 0; // after the direct upstream fails it is left alone until then

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
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const url = direct(chainId);
  if (url && restingUntil < Date.now()) {
    const { status, j } = await send(url, body, DIRECT_MS);
    if (status === 200 && j && (j.result !== undefined || verdict(j.error))) return j;
    restingUntil = Date.now() + 30_000;
  }
  const began = Date.now();
  let { j } = await send(proxy(chainId), body, PROXY_MS);
  // a proxy that fails at once (a restart, a dropped connection) is asked once more; one that stalled is not
  if (!j && Date.now() - began < 1_500) {
    await new Promise((r) => setTimeout(r, 200));
    ({ j } = await send(proxy(chainId), body, PROXY_MS));
  }
  if (j && (j.result !== undefined || (j.error && typeof j.error === 'object'))) return j;
  throw new Error(`chain ${chainId} did not answer`);
}

/** Resolves to `fallback` when `promise` is slow or fails. For reads a plan is better with but fine without. */
function within(promise, ms, fallback = null) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

/** One simulated block of calls through eth_simulateV1: the per-call results, or null when it was not served. */
async function simulateBlock(chainId, calls) {
  let j;
  try { j = await rpc(chainId, 'eth_simulateV1', [{ blockStateCalls: [{ calls }], validation: false }, 'latest']); } catch { return null; }
  const out = j.result?.[0]?.calls;
  if (Array.isArray(out) && out.length === calls.length) return out;
  // the node refused the block as a whole (the sender cannot pay for it): served, and the answer is no
  if (j.error && j.error.code <= -38000 && j.error.code > -39000) return calls.map(() => ({ status: '0x0', error: j.error }));
  return null;
}

/** An eth_call the Robinhood proxy cannot answer from memory: an override that changes nothing makes it unlike any before. */
const unlike = (chainId) => (chainId === RH ? [{ [`0x${randomBytes(20).toString('hex')}`]: { nonce: '0x1' } }] : []);

/**
 * View calls, answered together by the chain as it is now: [{ status: 'success', result } | { status: 'failure' }].
 * One eth_simulateV1 block, or, when that is not served, one eth_call each, side by side.
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
const reads = (contracts) => readAll(RH, contracts);
const good = (r) => r && r.status === 'success';
/** The gas price, as a plan's optional extra: null when it is slow. */
const gasPrice = (chainId) => within(rpc(chainId, 'eth_gasPrice', []).then((j) => (typeof j.result === 'string' ? BigInt(j.result) : null)), 2_500);

function reason(data, message) {
  if (typeof data === 'string' && data.length >= 10) {
    try {
      const d = decodeErrorResult({ abi: ERRORS, data });
      if (d.errorName === 'Error') return String(d.args?.[0] ?? 'no reason given').slice(0, 160);
      return ERROR_TEXT[d.errorName] || d.errorName;
    } catch { /* not one of ours */ }
    return `the contract answered with error code ${data.slice(0, 10)}`;
  }
  if (/insufficient funds/i.test(String(message))) return 'the wallet does not hold enough for the amount plus the network fee';
  return message && !/^execution reverted$/i.test(message) ? String(message).slice(0, 160) : 'the contract refused it without a reason';
}

/**
 * Run `txs` in order as `from` against the latest state. One simulated block (eth_simulateV1), so a deposit is
 * tested on top of its own approval. A single transaction falls back to eth_call. Returns null when the chain
 * could not run it at all, which the caller treats as "do not hand out a transaction".
 */
async function simulate(chainId, from, txs) {
  const calls = txs.map((t) => ({ from, to: t.to, data: t.data, value: toHex(BigInt(t.value)) }));
  const block = await simulateBlock(chainId, calls);
  if (block) {
    return block.map((c) => ({
      ok: c.status === '0x1',
      data: c.returnData || '0x',
      logs: Array.isArray(c.logs) ? c.logs : [],
      gas: c.gasUsed ? BigInt(c.gasUsed) : 0n,
      why: c.status === '0x1' ? null : reason(c.error?.data ?? c.returnData, c.error?.message),
    }));
  }
  if (calls.length !== 1) return null;
  try {
    const j = await rpc(chainId, 'eth_call', [calls[0], 'latest', ...unlike(chainId)]);
    if (typeof j.result === 'string') return [{ ok: true, data: j.result, logs: null, gas: 0n, why: null }];
    if (verdict(j.error)) return [{ ok: false, data: '0x', logs: null, gas: 0n, why: reason(j.error.data, j.error.message) }];
  } catch { /* unreachable */ }
  return null;
}

// ───────────────────────── the vault's numbers ─────────────────────────

/** XMoney._deposit and _grossXMoneyFor, line for line, against the reserve and supply just read. */
function enterMath(usdgIn, s) {
  const rake = (usdgIn * s.rakeBps) / BPS;
  const toReserve = usdgIn - rake;
  const gross = s.circulating === 0n || s.reserve === 0n ? toReserve * SCALE : (toReserve * s.circulating) / s.reserve;
  const burn = (gross * s.burnBps) / BPS;
  return { rake, burn, net: gross - burn };
}
/** XMoney.exitRollup. */
function exitMath(xIn, s) {
  const gross = s.circulating === 0n ? 0n : (xIn * s.reserve) / s.circulating;
  const rake = (gross * s.rakeBps) / BPS;
  return { rake, out: gross - rake };
}

/** One batch: the backing, the fee constants, where deposits route, and what the owner holds and has allowed. */
async function readState(owner) {
  const who = owner || '0x0000000000000000000000000000000000000000';
  const res = await reads([
    { address: XMONEY, abi: VAULT, functionName: 'getReserveNAV' },
    { address: XMONEY, abi: VAULT, functionName: 'BURN_BPS' },
    { address: XMONEY, abi: VAULT, functionName: 'FANOUT_RAKE_BPS' },
    { address: XMONEY, abi: VAULT, functionName: 'inbox' },
    { address: XMONEY, abi: VAULT, functionName: 'isBridgeSystem', args: [L4_INBOX] },
    { address: XMONEY, abi: VAULT, functionName: 'l3GasLimit' },
    { address: XMONEY, abi: VAULT, functionName: 'l3MaxFeePerGas' },
    { address: EARLY_DEPOSITOR, abi: EARLY, functionName: 'INBOX' },
    { address: EARLY_DEPOSITOR, abi: EARLY, functionName: 'defaultGasLimit' },
    { address: EARLY_DEPOSITOR, abi: EARLY, functionName: 'defaultMaxFeePerGas' },
    { address: USDG, abi: ERC20, functionName: 'balanceOf', args: [who] },
    { address: XMONEY, abi: ERC20, functionName: 'balanceOf', args: [who] },
    { address: USDG, abi: ERC20, functionName: 'allowance', args: [who, XMONEY] },
    { address: USDG, abi: ERC20, functionName: 'allowance', args: [who, EARLY_DEPOSITOR] },
    { address: ROLLUP, abi: ROLLUP_ABI, functionName: 'chainId' },
    { address: ROLLUP, abi: ROLLUP_ABI, functionName: 'inbox' },
    { address: ARBINFO, abi: ARBINFO_ABI, functionName: 'getBalance', args: [who] },
    { address: ARBINFO, abi: ARBINFO_ABI, functionName: 'getCode', args: [who] },
  ]);
  const [nav, burnBps, rakeBps, vaultInbox, inboxExempt, vGas, vFee, eInbox, eGas, eFee, usdgBal, xmBal, allowVault, allowEarly, rChain, rInbox, ethBal, code] = res;
  if (![nav, burnBps, rakeBps].every(good)) throw new Error('the vault could not be read');
  if (owner && ![usdgBal, xmBal, allowVault, allowEarly].every(good)) throw new Error('the wallet could not be read');
  const held = (r) => (owner && good(r) ? r.result : 0n);
  const [navRay, reserve, circulating] = nav.result;

  // Which contract reaches chain 466302 today. The rollup itself says which inbox is its own; the vault may still
  // point at the retired chain's, and until its switch executes deposits go through EarlyDepositor instead.
  const wired = good(rChain) && rChain.result === BigInt(L4) && good(rInbox) && same(rInbox.result, L4_INBOX);
  let route = null;
  if (wired && good(vaultInbox) && same(vaultInbox.result, L4_INBOX) && good(vGas) && good(vFee)) {
    route = { via: 'vault', spender: XMONEY, name: 'the vault', gasLimit: vGas.result, maxFee: vFee.result, taxed: false, allowance: held(allowVault) };
  } else if (wired && good(eInbox) && same(eInbox.result, L4_INBOX) && good(eGas) && good(eFee)) {
    // the helper's transfer into the inbox pays X Money's transfer burn until the vault lists that inbox as its bridge
    route = { via: 'early', spender: EARLY_DEPOSITOR, name: 'the xGas depositor', gasLimit: eGas.result, maxFee: eFee.result, taxed: !(good(inboxExempt) && inboxExempt.result === true), allowance: held(allowEarly) };
  }
  return {
    navRay, reserve, circulating, burnBps: burnBps.result, rakeBps: rakeBps.result, route,
    usdg: held(usdgBal), xm: held(xmBal), allowVault: held(allowVault),
    eth: owner && good(ethBal) ? ethBal.result : null,
    kind: owner ? (good(code) ? accountKind(code.result) : 'unknown') : null,
  };
}

/** EOA, EIP-7702 delegated EOA (0xef0100 + 20 bytes), or a contract wallet, from the code at the address on Robinhood. */
function accountKind(code) {
  if (!code || code === '0x') return 'eoa';
  return code.toLowerCase().startsWith('0xef0100') && code.length === 2 + 23 * 2 ? 'eip7702' : 'contract';
}

/**
 * How long a withdrawal from xGas waits, read from the rollup: the challenge window, who can skip it, and when a
 * validator last posted. Null when the rollup could not be read.
 */
async function loadWindow() {
  const rd = (functionName, args = []) => ({ address: ROLLUP, abi: ROLLUP_ABI, functionName, args });
  const [period, fast, validators, confirmed] = await reads([rd('confirmPeriodBlocks'), rd('anyTrustFastConfirmer'), rd('getValidators'), rd('latestConfirmed')]);
  if (!good(period)) return null;
  const value = { blocks: Number(period.result), seconds: Number(period.result) * L1_BLOCK_SECONDS, fast: null, ageAtRead: null, readAt: Date.now() };
  try {
    const vals = good(validators) ? validators.result : [];
    const fastAddr = good(fast) && !/^0x0{40}$/.test(fast.result) ? fast.result : null;
    const more = vals.length || fastAddr ? await reads([
      ...vals.map((v) => rd('latestStakedAssertion', [v])),
      ...(fastAddr ? [{ address: fastAddr, abi: SAFE, functionName: 'getOwners' }, { address: fastAddr, abi: SAFE, functionName: 'getThreshold' }] : []),
    ]) : [];
    if (fastAddr) {
      const [owners, threshold] = more.slice(vals.length);
      value.fast = good(owners) && good(threshold) ? { address: fastAddr, of: owners.result.length, need: Number(threshold.result) } : { address: fastAddr, of: null, need: null };
    }
    const hashes = [...new Set([good(confirmed) ? confirmed.result : null, ...more.slice(0, vals.length).map((r) => (good(r) ? r.result : null))].filter((h) => h && !/^0x0+$/.test(h)))];
    const [nodes, head] = await Promise.all([hashes.length ? reads(hashes.map((h) => rd('getAssertion', [h]))) : [], rpc(RH, 'eth_getBlockByNumber', ['latest', false])]);
    const newest = nodes.filter(good).reduce((a, r) => (r.result.createdAtBlock > a ? r.result.createdAtBlock : a), 0n);
    // a Robinhood block header carries the Ethereum block it was built on
    const l1 = head.result?.l1BlockNumber;
    if (newest > 0n && typeof l1 === 'string') value.ageAtRead = Math.max(0, Number(BigInt(l1) - newest)) * L1_BLOCK_SECONDS;
  } catch { /* the window alone is still worth showing */ }
  return value;
}
let windowCache = { at: 0, value: null };
let windowLoading = null;
/** The window, with how long ago the last checkpoint was as of now. A copy under a minute old is used as it is; an older one is used while a new one loads. */
function exitWindow() {
  const age = Date.now() - windowCache.at;
  if (!windowCache.value || age >= 60_000) {
    windowLoading ??= loadWindow().then((value) => { if (value) windowCache = { at: Date.now(), value }; return value; }).finally(() => { windowLoading = null; });
    windowLoading.catch(() => {});
  }
  const pending = windowCache.value && age < 10 * 60_000 ? Promise.resolve(windowCache.value) : windowLoading;
  return pending.then((w) => {
    if (!w) return null;
    const ageSeconds = w.ageAtRead === null ? null : w.ageAtRead + Math.round((Date.now() - w.readAt) / 1000);
    return { ...w, ageSeconds, idle: ageSeconds === null ? null : ageSeconds > IDLE_AFTER_SECONDS };
  });
}
exitWindow().catch(() => {}); // warm before the first withdrawal is planned

// ───────────────────────── plan ─────────────────────────

const approveLeg = (spender, name, amount, owner) => ({
  kind: 'approve',
  chainId: RH,
  label: `Allow ${name} to take exactly ${usdg(amount)}`,
  in: null,
  out: null,
  feeNative: null,
  note: 'This exact amount, not unlimited.',
  exec: { type: 'tx', tx: owner ? { chainId: RH, to: USDG, value: '0', data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender, amount] }) } : null },
});

const backingFact = (s) => ({
  label: 'What backs it',
  value: `1 X Money = ${human(s.navRay, 18, 6)} USDG`,
  sub: `${usdg(s.reserve)} held by the vault, divided by ${xm(s.circulating)} in circulation. A division, not a forecast.`,
});
const vaultFact = { label: 'Where the rate comes from', value: 'A vault, not a pool', sub: 'The vault sets the rate when your transaction lands: its USDG divided by the X Money in circulation. There is no minimum-received setting, and the rate only moves when someone else enters, exits or burns.' };

/** A rough network fee from the test run and the gas price asked for alongside the reads. Never fails the plan. */
async function feeFact(priceP, runs, symbol) {
  const gas = runs.reduce((n, r) => n + (r.gas || 0n), 0n);
  const price = gas === 0n ? null : await priceP;
  if (price === null) return { fact: null, fee: 0n };
  return { fact: { label: 'Network fee', value: `about ${human(gas * price, 18, 3)} ${symbol}`, sub: 'From a test run of these exact transactions.' }, fee: gas * price };
}

/** The Robinhood transactions are paid in ETH there. A wallet that plainly cannot pay is told so before it signs. */
async function feeOnRobinhood(eth, priceP, runs) {
  const f = await feeFact(priceP, runs, 'ETH');
  if (eth !== null && eth < f.fee) {
    throw fail('NO_GAS', `You need a little ETH on Robinhood Chain for the network fee: about ${human(f.fee, 18, 3)} ETH, and you hold ${human(eth, 18, 3)}.`);
  }
  return f.fact;
}

function assertRan(runs) {
  if (!runs) throw fail('SIMULATION_UNAVAILABLE', 'The chain could not test this transaction just now, so nothing was prepared. Try again in a moment.', 503);
  const bad = runs.find((r) => !r.ok);
  if (bad) throw fail('WOULD_REVERT', `A test run of this exact transaction failed: ${bad.why}. Nothing was sent.`);
}

function amountOf(input) {
  const a = input?.amount;
  if (typeof a !== 'string' || !/^[0-9]{1,77}$/.test(a) || /^0+$/.test(a)) throw fail('AMOUNT_REQUIRED', 'Type the amount you are paying first.', 400);
  return BigInt(a);
}

export function match(input, output) {
  return direction(input, output) !== null;
}

export async function plan({ input, output, owner }) {
  const dir = direction(input, output);
  if (!dir) throw fail('NOT_A_VAULT_PAIR', 'The vault only turns USDG into X Money and back.', 404);
  if (owner !== null && owner !== undefined && !isAddress(owner)) throw fail('BAD_OWNER', 'That wallet address is not valid.', 400);
  const who = owner ? getAddress(owner) : null;
  const amount = amountOf(input);
  try {
    if (dir === 'enter') return await planEnter(amount, who, input, output);
    if (dir === 'exit') return await planExit(amount, who, input, output);
    if (dir === 'enter-l4') return await planEnterL4(amount, who, input, output);
    return await planExitL4(amount, who, input, output);
  } catch (e) {
    if (e?.planError) throw e;
    throw fail('UPSTREAM_UNAVAILABLE', 'Robinhood Chain could not be read just now. Try again in a moment.', 503, e);
  }
}

/** USDG -> X Money, the ERC-20 on Robinhood. Minted straight to the caller, in the same transaction. */
async function planEnter(amount, owner, input, output) {
  const priceP = owner ? gasPrice(RH) : null;
  const s = await readState(owner);
  const m = enterMath(amount, s);
  if (m.net === 0n) throw fail('AMOUNT_TOO_SMALL', 'That is too little USDG to mint any X Money.');
  if (owner && s.usdg < amount) throw fail('INSUFFICIENT_BALANCE', `You hold ${usdg(s.usdg)} on Robinhood Chain and this needs ${usdg(amount)}.`);

  const needsApprove = !owner || s.allowVault < amount;
  const enterTx = { chainId: RH, to: XMONEY, value: '0', data: encodeFunctionData({ abi: VAULT, functionName: 'enterRollupToL2', args: [amount] }) };
  const legs = [];
  if (needsApprove) legs.push(approveLeg(XMONEY, 'the vault', amount, owner));

  let received = m.net;
  let fee = null;
  if (owner) {
    const runs = await simulate(RH, owner, legs.map((l) => l.exec.tx).concat(enterTx));
    assertRan(runs);
    received = decodeFunctionResult({ abi: VAULT, functionName: 'enterRollupToL2', data: runs[runs.length - 1].data });
    fee = await feeOnRobinhood(s.eth, priceP, runs);
  }
  const tIn = token(T_USDG, input);
  const tOut = token(T_XM, output);
  legs.push({
    kind: 'vault-enter',
    chainId: RH,
    label: `Turn ${usdg(amount)} into X Money at the vault`,
    in: { token: tIn, amount: amount.toString() },
    out: { token: tOut, amount: received.toString() },
    feeNative: null,
    note: 'The vault keeps your USDG and mints X Money to your wallet in the same transaction.',
    exec: { type: 'tx', tx: owner ? enterTx : null },
  });

  return {
    routing: 'PLAN',
    op: id,
    headline: `${usdg(amount)} becomes ${xm(received)} at the vault's backing rate`,
    pay: { label: 'USDG on Robinhood Chain', amount: amount.toString(), token: tIn },
    receive: { label: 'X Money on Robinhood Chain', amount: received.toString(), token: tOut },
    legs,
    facts: [
      backingFact(s),
      { label: 'Fee', value: pct(s.rakeBps + s.burnBps), sub: `${usdg(m.rake)} (${pct(s.rakeBps)}) goes to ${FANOUT_NAME}, and ${xm(m.burn)} (${pct(s.burnBps)}) of the new X Money is burned.` },
      { label: 'Speed', value: 'One transaction', sub: 'The X Money is in your wallet when it confirms.', tone: 'ok' },
      vaultFact,
      ...(fee ? [fee] : []),
      ...(owner ? [{ label: 'Checked', value: 'Test run passed', sub: 'These exact transactions were run from your wallet against the live chain.', tone: 'ok' }] : []),
    ],
    warnings: [ALPHA, 'X Money burns 0.01% of every transfer between wallets. Entering and exiting the vault are not transfers and do not pay it.'],
    contracts: [
      { chainId: RH, address: USDG, name: 'USDG' },
      { chainId: RH, address: XMONEY, name: 'X Money vault' },
    ],
  };
}

/** X Money (ERC-20 on Robinhood) -> USDG. Burned from the caller, USDG paid in the same transaction. */
async function planExit(amount, owner, input, output) {
  const priceP = owner ? gasPrice(RH) : null;
  const s = await readState(owner);
  const m = exitMath(amount, s);
  if (m.out === 0n) throw fail('AMOUNT_TOO_SMALL', 'That is too little X Money to redeem for any USDG.');
  if (owner && s.xm < amount) throw fail('INSUFFICIENT_BALANCE', `You hold ${xm(s.xm)} on Robinhood Chain and this needs ${xm(amount)}.`);

  const exitTx = { chainId: RH, to: XMONEY, value: '0', data: encodeFunctionData({ abi: VAULT, functionName: 'exitRollup', args: [amount] }) };
  let received = m.out;
  let fee = null;
  if (owner) {
    const runs = await simulate(RH, owner, [exitTx]);
    assertRan(runs);
    received = decodeFunctionResult({ abi: VAULT, functionName: 'exitRollup', data: runs[0].data });
    fee = await feeOnRobinhood(s.eth, priceP, runs);
  }
  const tIn = token(T_XM, input);
  const tOut = token(T_USDG, output);
  return {
    routing: 'PLAN',
    op: id,
    headline: `${xm(amount)} redeems for ${usdg(received)} at the vault's backing rate`,
    pay: { label: 'X Money on Robinhood Chain', amount: amount.toString(), token: tIn },
    receive: { label: 'USDG on Robinhood Chain', amount: received.toString(), token: tOut },
    legs: [{
      kind: 'vault-exit',
      chainId: RH,
      label: `Redeem ${xm(amount)} for USDG at the vault`,
      in: { token: tIn, amount: amount.toString() },
      out: { token: tOut, amount: received.toString() },
      feeNative: null,
      note: 'The vault burns your X Money and pays USDG in the same transaction. No approval is needed.',
      exec: { type: 'tx', tx: owner ? exitTx : null },
    }],
    facts: [
      backingFact(s),
      { label: 'Fee', value: pct(s.rakeBps), sub: `${usdg(m.rake)} of what you redeem goes to ${FANOUT_NAME}.` },
      { label: 'Speed', value: 'One transaction', sub: 'The USDG is in your wallet when it confirms.', tone: 'ok' },
      vaultFact,
      ...(fee ? [fee] : []),
      ...(owner ? [{ label: 'Checked', value: 'Test run passed', sub: 'This exact transaction was run from your wallet against the live chain.', tone: 'ok' }] : []),
    ],
    warnings: [ALPHA],
    contracts: [{ chainId: RH, address: XMONEY, name: 'X Money vault' }],
  };
}

/** USDG -> X Money as the gas token of the xGas chain. One transaction on Robinhood; the chain credits it after. */
async function planEnterL4(amount, owner, input, output) {
  const priceP = owner ? gasPrice(RH) : null;
  // is the xGas chain answering? asked alongside, and not waited on for long
  const upP = within(rpc(L4, 'eth_blockNumber', []).then((j) => typeof j.result === 'string'), 1_500, false);
  const s = await readState(owner);
  const kind = s.kind;
  const r = s.route;
  if (!r) throw fail('NO_ROUTE_TO_XGAS', 'No deposit route reaches the xGas chain right now, so nothing was prepared.', 503);
  if (kind === 'unknown') throw fail('UPSTREAM_UNAVAILABLE', 'Your wallet could not be read on Robinhood Chain just now. Try again in a moment.', 503);
  if (kind === 'contract') throw fail('CONTRACT_WALLET', 'Your wallet is a contract wallet. X Money sent to the same address on xGas could not be reached, so this was refused.');
  if (owner && s.usdg < amount) throw fail('INSUFFICIENT_BALANCE', `You hold ${usdg(s.usdg)} on Robinhood Chain and this needs ${usdg(amount)}.`);

  const m = enterMath(amount, s);
  const inboxBurn = r.taxed ? (m.net * s.burnBps) / BPS : 0n;
  const deposited = m.net - inboxBurn;
  const prepay = r.gasLimit * r.maxFee;
  if (deposited <= prepay) throw fail('AMOUNT_TOO_SMALL', `That is too small to cover the ${xm(prepay)} delivery fee on xGas. Send more.`);

  const needsApprove = !owner || r.allowance < amount;
  const depositTx = !owner ? null : r.via === 'early'
    ? { chainId: RH, to: EARLY_DEPOSITOR, value: '0', data: encodeFunctionData({ abi: EARLY, functionName: 'deposit', args: [amount, owner] }) }
    : { chainId: RH, to: XMONEY, value: '0', data: encodeFunctionData({ abi: VAULT, functionName: 'enterRollup', args: [amount, owner] }) };
  const legs = [];
  if (needsApprove) legs.push(approveLeg(r.spender, r.name, amount, owner));

  // what the delivery message carries to the wallet on xGas; the unused part of the prepaid gas is refunded on top
  let credited = deposited - prepay;
  let fee = null;
  if (owner) {
    const runs = await simulate(RH, owner, legs.map((l) => l.exec.tx).concat(depositTx));
    assertRan(runs);
    const seen = creditedIn(runs[runs.length - 1].logs, r.via, owner);
    if (seen === null) throw fail('WOULD_REVERT', 'A test run of this deposit did not show X Money being sent to your address on xGas. Nothing was sent.');
    credited = seen;
    fee = await feeOnRobinhood(s.eth, priceP, runs);
  }
  const tIn = token(T_USDG, input);
  const tOut = token(T_XM_L4, output);
  const l4Up = await upP;

  legs.push({
    kind: 'vault-enter',
    chainId: RH,
    label: `Send ${usdg(amount)} into the vault for X Money on xGas`,
    in: { token: tIn, amount: amount.toString() },
    out: { token: tOut, amount: credited.toString() },
    feeNative: null,
    note: 'The vault mints X Money and sends it to your address on the xGas chain, where it is the gas token. It usually lands about a minute after this confirms.',
    exec: { type: 'tx', tx: depositTx },
  });

  const feeBps = s.rakeBps + s.burnBps + (r.taxed ? s.burnBps : 0n);
  return {
    routing: 'PLAN',
    op: id,
    headline: `${usdg(amount)} becomes ${xm(credited)} as gas on the xGas chain`,
    pay: { label: 'USDG on Robinhood Chain', amount: amount.toString(), token: tIn },
    receive: { label: 'X Money on the xGas chain (its gas token)', amount: credited.toString(), token: tOut },
    legs,
    facts: [
      backingFact(s),
      {
        label: 'Fee',
        value: `${pct(feeBps)} plus up to ${xm(prepay)}`,
        sub: `${usdg(m.rake)} goes to ${FANOUT_NAME}, ${xm(m.burn + inboxBurn)} is burned${r.taxed ? ' (the entry burn, and the transfer burn on the way into the bridge)' : ''}, and ${xm(prepay)} prepays the delivery on xGas. The unused part of that prepayment is refunded to you there.`,
      },
      { label: 'Speed', value: 'About a minute', sub: 'One transaction on Robinhood Chain. The xGas chain credits your address shortly after; nothing more to sign.', tone: l4Up ? 'ok' : 'warn' },
      { label: 'Where it lands', value: 'The xGas chain, not Robinhood', sub: 'It arrives as the gas token of chain 466302 at the same address as your wallet. Getting it back to Robinhood is a withdrawal that takes days.', tone: 'warn' },
      { label: 'Sent through', value: r.via === 'early' ? 'EarlyDepositor' : 'The vault itself', sub: r.via === 'early' ? 'The vault still points at the retired xGas chain, so deposits go through a helper contract that mints from the vault and forwards to the new chain.' : 'The vault mints and forwards to the xGas chain in one call.' },
      vaultFact,
      ...(fee ? [fee] : []),
      ...(owner ? [{ label: 'Checked', value: 'Test run passed', sub: 'These exact transactions were run from your wallet against the live chain.', tone: 'ok' }] : []),
    ],
    warnings: [
      ALPHA,
      'This X Money lands on the xGas chain. Bringing it back to Robinhood is a withdrawal of about a week and three steps, not a swap.',
      ...(l4Up ? [] : ['The xGas chain did not answer just now. A deposit would wait in its inbox until the chain is back.']),
      ...(r.via === 'vault' && kind === 'eip7702' ? ['Your wallet runs delegated code (EIP-7702). The X Money still reaches your address, but the small refund of unused delivery gas goes to an aliased address you do not control.'] : []),
    ],
    contracts: [
      { chainId: RH, address: USDG, name: 'USDG' },
      r.via === 'early' ? { chainId: RH, address: EARLY_DEPOSITOR, name: 'xGas EarlyDepositor' } : { chainId: RH, address: XMONEY, name: 'X Money vault' },
    ],
  };
}

/** What the deposit's own event says will be credited to `owner` on xGas, or null when it says nothing of the kind. */
function creditedIn(logs, via, owner) {
  for (const log of logs || []) {
    try {
      if (via === 'early' && same(log.address, EARLY_DEPOSITOR)) {
        const d = decodeEventLog({ abi: EARLY, data: log.data, topics: log.topics });
        if (d.eventName === 'EarlyDeposit' && same(d.args.l3Recipient, owner)) return d.args.l2CallValue;
      } else if (via === 'vault' && same(log.address, XMONEY)) {
        const d = decodeEventLog({ abi: VAULT, data: log.data, topics: log.topics });
        if (d.eventName === 'RollupEntered' && same(d.args.l3Recipient, owner)) return d.args.xMoneyBridged;
      }
    } catch { /* some other event */ }
  }
  return null;
}

/**
 * X Money on the xGas chain -> USDG. This is a rollup withdrawal: only its first step exists today. The plan
 * carries that step, says what the other two are, and how long the wait between them is.
 */
async function planExitL4(amount, owner, input, output) {
  const priceP = owner ? gasPrice(L4) : null;
  const balP = owner
    ? readAll(L4, [{ address: ARBINFO, abi: ARBINFO_ABI, functionName: 'getBalance', args: [owner] }])
      .then((r) => (good(r[0]) ? r[0].result : Promise.reject(new Error('no balance'))))
      .catch(() => rpc(L4, 'eth_getBalance', [owner, 'latest']).then((j) => BigInt(j.result)))
    : null;
  balP?.catch(() => {});
  const [s, w] = await Promise.all([readState(owner), within(exitWindow(), 3_000, null)]);
  // the Outbox pays out of the bridge, and that transfer burns 0.01% like any other
  const exitBurn = (amount * s.burnBps) / BPS;
  const arrives = amount - exitBurn;
  const m = exitMath(arrives, s);
  if (m.out === 0n) throw fail('AMOUNT_TOO_SMALL', 'That is too little X Money to redeem for any USDG.');

  const tIn = token(T_XM_L4, input);
  const tOut = token(T_USDG, output);
  const tMid = token(T_XM, null);
  let fee = null;
  let tx = null;
  if (owner) {
    const bal = await balP;
    if (bal < amount) throw fail('INSUFFICIENT_BALANCE', `You hold ${xm(bal)} on the xGas chain and this needs ${xm(amount)}.`);
    tx = { chainId: L4, to: ARBSYS, value: amount.toString(), data: encodeFunctionData({ abi: ARBSYS_ABI, functionName: 'withdrawEth', args: [owner] }) };
    const runs = await simulate(L4, owner, [tx]);
    assertRan(runs);
    const f = await feeFact(priceP, runs, 'X Money');
    fee = f.fact;
    if (bal < amount + f.fee) throw fail('LEAVE_GAS', `X Money is also the gas on xGas. Leave a little for the network fee: you can withdraw at most ${xm(bal > f.fee ? bal - f.fee : 0n)}.`);
  }

  const wait = w ? `About ${duration(w.seconds)}` : 'Days';
  const fastLine = w?.fast
    ? ` It is usually minutes instead while ${w.fast.need && w.fast.of ? `${w.fast.need} of the ${w.fast.of} keys` : 'the keys'} of the fast-confirm Safe are online, and that speed means trusting those keys.`
    : '';
  return {
    routing: 'PLAN',
    op: id,
    headline: `Start withdrawing ${xm(amount)} from xGas: about ${usdg(m.out)} after the wait and two more steps`,
    pay: { label: 'X Money on the xGas chain', amount: amount.toString(), token: tIn },
    receive: { label: 'USDG on Robinhood Chain, later, after two more steps', amount: m.out.toString(), token: tOut },
    legs: [{
      kind: 'withdraw',
      chainId: L4,
      label: `Burn ${xm(amount)} on xGas to start the withdrawal`,
      in: { token: tIn, amount: amount.toString() },
      out: { token: tMid, amount: arrives.toString() },
      feeNative: null,
      note: 'Step 1 of 3. Your X Money is burned on xGas now and becomes claimable on Robinhood Chain after the wait. Nothing arrives from this step alone.',
      exec: { type: 'tx', tx },
    }],
    facts: [
      { label: 'This is not a swap', value: '3 steps, this is the first', sub: 'Burn on xGas now. Claim the X Money on Robinhood Chain when the wait is over (xgas.dev can do it for you, or your own wallet). Then swap that X Money to USDG here in one step.', tone: 'danger' },
      {
        label: 'How long',
        value: wait,
        sub: w
          ? `${w.blocks} Ethereum blocks, counted from the next checkpoint a validator posts, not from now.${fastLine}`
          : 'The rollup could not be read, so no estimate is given.',
        tone: 'warn',
      },
      ...(w && w.ageSeconds !== null
        ? [{ label: 'Validators', value: w.idle ? `Idle: last checkpoint ${duration(w.ageSeconds)} ago` : `Active: last checkpoint ${duration(w.ageSeconds)} ago`, sub: w.idle ? 'Withdrawals wait for the next checkpoint, and nobody can say when it will be posted.' : 'A withdrawal waits for the next checkpoint before its window starts.', tone: w.idle ? 'danger' : 'ok' }]
        : []),
      backingFact(s),
      { label: 'Fee', value: pct(s.burnBps + s.rakeBps), sub: `${xm(exitBurn)} is burned as it leaves the bridge, and ${usdg(m.rake)} goes to ${FANOUT_NAME} when you redeem.` },
      { label: 'USDG shown', value: `about ${usdg(m.out)}`, sub: 'At today\'s backing. The rate that counts is the one on the day you redeem.' },
      ...(fee ? [fee] : []),
      ...(owner ? [{ label: 'Checked', value: 'Test run passed', sub: 'This exact transaction was run from your wallet against the xGas chain.', tone: 'ok' }] : []),
    ],
    warnings: [
      'This is a withdrawal, not a swap. Signing burns your X Money on xGas right away. There is no cancel and no way to speed it up.',
      'You receive nothing from this step. After the wait you claim X Money on Robinhood Chain, then swap it to USDG. Until you do both, you hold neither.',
      ...(w?.idle ? [`The validators look idle: their last checkpoint was ${duration(w.ageSeconds)} ago. A withdrawal started now waits until one is posted.`] : []),
      ALPHA,
    ],
    contracts: [{ chainId: L4, address: ARBSYS, name: 'ArbSys (xGas system contract)' }],
  };
}

// ───────────────────────── picker ─────────────────────────

/**
 * X Money on the xGas chain is not in any token list (the chain has no list), so it is served here. On the
 * receive side it is only offered against USDG, the one thing the vault takes for it.
 */
export async function catalog(kind, { chainId, input } = {}) {
  if (kind !== 'token') return [];
  if (typeof chainId === 'number' && chainId !== RH && chainId !== L4) return [];
  if (input && !isUsdg(input)) return [];
  return [{ kind: 'token', id: `token:${L4}:native`, label: T_XM_L4.symbol, sub: 'X Money on the xGas chain (its gas token)', ...T_XM_L4 }];
}

export function register() {}
