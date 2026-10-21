// An NFT in, a loan out. A loan in, the NFT back. Through staccpad's pawn desk.
//
// The desk is one contract with many pools (nft-range src/pawn/StaccpadPawn.sol, v3). A pool lends one quote token
// against one collection: it reads what the collection's own market would pay for the NFT right now (`floorOf`,
// a real sale run and undone), hands over a fixed share of that, keeps the NFT, and mints the borrower a loan NFT.
// The debt grows every second at a rate that moves with how much of the pool is lent. There is no due date. Once
// the debt reaches the pool's share of the sale price, anyone may sell the NFT (`liquidate`).
//
//   NFT  -> loan   collection.approve(desk, id)                       then   desk.pawn(pool, id, minAdvance)
//   loan -> NFT    [WETH.deposit{value}]  [quote.approve(desk, debt)]  then   desk.redeem(loanId)
//
// What this module will not do:
//   * return a transaction it has not run, in order, for that wallet on the chain's current state (eth_simulateV1).
//     The proxy caches eth_call, and a cached run is not a check, so there is no second road;
//   * approve more than the one NFT, or more than the debt plus half an hour of interest at the pool's top rate;
//   * lend through a pool just because it exists. Anyone can open a pool with any terms, on a market quoted in any
//     token. Offered here: pools that pay in WETH or USDG (by address, never by symbol), that leave a new loan at
//     least 10% under its line, and whose reward for selling and top rate are bounded. The oldest such pool with
//     the money wins, so a later pool cannot outbid its way in front of a borrower;
//   * call a loan "yours" without looking. The loan NFT can be sent to anyone; who opened it is read from the
//     desk's own event and said out loud when it is not the wallet that holds it.
//
// Chain reads go to dRPC with the server key when there is one, and through the owner's dRPC proxy otherwise.
// Nothing is ever sent from here.
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, toFunctionSelector, toHex } from 'viem';

export const id = 'pawn';

// ───────────────────────── fixed facts ─────────────────────────

const STACCPAD = 'https://staccpad.fun';
const PROXY = `${STACCPAD}/rpc`;
const HOME = 4663;
const KEY_SHAPE = /^[A-Za-z0-9_-]{8,200}$/;
/** dRPC's own load balancer, reached with the server key. It stays inside this file: never logged, never returned. */
const DIRECT = KEY_SHAPE.test(process.env.DRPC_KEY || '') ? `https://lb.drpc.live/robinhood/${process.env.DRPC_KEY}` : null;

/** StaccpadPawn v3 (staccpad src/contracts/pawn.ts). v1 and v2 are retired and not served. */
const DESK = '0x38C1E08eBF7959Fd5ffA824025437a0cB76b0026';
/** Below the desk's first block: where a search for a loan's opening event may start. */
const DESK_FIRST_BLOCK = 68_400_000;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ZERO = '0x0000000000000000000000000000000000000000';
/** A stand-in sender for reads that must not come from a cache. */
const PROBE = '0x000000000000000000000000000000000000dEaD';

const TW = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
/** The only tokens a loan is offered in. A symbol is whatever its deployer typed; an address is not. */
const VOUCHED = new Map([
  [WETH.toLowerCase(), { symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, tags: ['wrapped'], logo: `${TW}/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png` }],
  [USDG.toLowerCase(), { symbol: 'USDG', name: 'Global Dollar', decimals: 6, tags: ['stable'], logo: null }],
]);
const ETH = { chainId: HOME, address: 'NATIVE', symbol: 'ETH', name: 'Ether', decimals: 18, logo: `${TW}/info/logo.png`, tags: ['native'] };

// Terms a pool must meet to be offered here. The desk itself allows far worse (a loan that can be sold the moment
// it opens, a 10% reward for selling it, 500% a year).
/** A new loan starts at least this far under its line: advance <= 90% of the line. */
const MIN_ROOM_BPS = 1_000;
const MAX_BOUNTY_BPS = 500;
const MAX_TOP_RATE_BPS = 20_000;
const POOLS_PER_COLLECTION = 6;
const MAX_POOLS = 600;
const PER_COLLECTION = 60;
const MAX_LOAN_SCAN = 3_000;
/** Kept back for gas when ETH is wrapped to repay. */
const GAS_RESERVE = 30_000_000_000_000n;
const YEAR = 31_536_000n;

const DESK_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct Terms { uint16 ltvBps; uint16 liqBps; uint16 bountyBps; uint16 baseRateBps; uint16 slope1Bps; uint16 kinkBps; uint16 slope2Bps; }',
  'struct Pool { PoolKey key; address manager; address vault; address collection; address quoteToken; address curve; Terms terms; uint256 free; uint256 totalShares; uint256 totalScaled; uint256 index; uint64 lastAccrue; }',
  'struct Ticket { uint256 poolId; uint256 tokenId; uint256 scaled; uint256 principal; uint64 openedAt; }',
  'function poolsLength() view returns (uint256)',
  'function getPool(uint256 poolId) view returns (Pool)',
  'function getTicket(uint256 ticketId) view returns (Ticket)',
  'function borrowed(uint256 poolId) view returns (uint256)',
  'function rate(uint256 poolId) view returns (uint256 utilBps, uint256 rateBps)',
  'function debtOf(uint256 ticketId) view returns (uint256)',
  'function ownerOf(uint256 ticketId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function nextTicketId() view returns (uint256)',
  'function weth() view returns (address)',
  // not a view on chain (it runs a sale and undoes it); a simulated call is exactly what it is for
  'function floorOf(uint256 poolId, uint256 tokenId) returns (uint256 payout, bool viaCurve)',
  'function pawn(uint256 poolId, uint256 tokenId, uint256 minAdvance) returns (uint256 ticketId, uint256 advance)',
  'function redeem(uint256 ticketId) returns (uint256 paid)',
]);
/** Pawned(uint256 indexed ticketId, uint256 indexed poolId, address indexed owner, uint256 tokenId, uint256 floor, uint256 advance) */
const PAWNED_TOPIC = '0x69917115b69c5ebbc2cf8d995b3443e815f751ee495e7c90b1ff4e345a894f96';
const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const ERC721_ABI = parseAbi([
  'function name() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function approve(address to, uint256 tokenId)',
  'function tokenURI(uint256 tokenId) view returns (string)',
]);
const WETH_ABI = parseAbi(['function deposit() payable']);
const VAULT_ABI = parseAbi(['function allowedIdsRoot() view returns (bytes32)']);
/** A collection with its own buyback curve. A companion id cannot use it and sells into the pool like any other. */
const CURVE_ABI = parseAbi(['function isCompanion(uint256 tokenId) view returns (bool)']);
const MULTICALL_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);

// ───────────────────────── small pieces ─────────────────────────

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isAddress = (s) => typeof s === 'string' && ADDRESS.test(s);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A token or loan id as a BigInt, or null when it is not one. */
function idOf(v) {
  const s = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : v;
  if (typeof s !== 'string' || !/^[0-9]{1,78}$/.test(s)) return null;
  const n = BigInt(s);
  return n < 1n << 256n ? n : null;
}

/** Printable, one line, bounded, no long dashes: names come from contracts anyone can deploy. */
function clean(v, max = 64) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/[\u2013\u2014\u2015]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max);
}
/** https and small data: images only (a Thing travels back in the request body, which is capped). */
function imageUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  if (u.startsWith('data:image/')) return u.length <= 2_000 ? u : null;
  if (u.startsWith('https://')) return u.length <= 600 ? u : null;
  if (u.startsWith('ipfs://') || u.startsWith('ar://')) return `${STACCPAD}/api/img?uri=${encodeURIComponent(u)}`.slice(0, 600);
  if (u.startsWith('/')) return `${STACCPAD}${u}`.slice(0, 600);
  return null;
}

/** Base units as a short number for a sentence: four digits that matter, cut down (or up, for a ceiling). */
function human(value, decimals = 18, up = false) {
  const v = BigInt(value);
  if (v <= 0n) return '0';
  const whole = v / 10n ** BigInt(decimals);
  let places = whole >= 1000n ? 2 : whole >= 1n ? 4 : decimals - v.toString().length + 4;
  places = Math.max(0, Math.min(decimals, places));
  const cut = 10n ** BigInt(decimals - places);
  let n = v / cut;
  if (up && v % cut > 0n) n += 1n;
  const s = n.toString().padStart(places + 1, '0');
  const w = s.slice(0, s.length - places).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const f = places ? s.slice(-places).replace(/0+$/, '') : '';
  return f ? `${w}.${f}` : w;
}
const pct = (bps) => `${(Number(bps) / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
/** Log lines and sentences never carry the key, whatever ends up in them. */
const redact = (s) => (DIRECT ? String(s).split(process.env.DRPC_KEY).join('[key]') : String(s));

/** A length of time in the largest unit that reads naturally. */
function span(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const days = seconds / 86_400;
  const say = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (days >= 730) return say(Math.round(days / 365), 'year');
  if (days >= 60) return say(Math.round(days / 30.4), 'month');
  if (days >= 14) return say(Math.round(days / 7), 'week');
  if (days >= 2) return say(Math.round(days), 'day');
  if (seconds >= 7_200) return say(Math.round(seconds / 3_600), 'hour');
  return say(Math.max(1, Math.round(seconds / 60)), 'minute');
}
const dayOf = (unix) => new Date(Number(unix) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** A refusal the page can show as it is: one plain sentence in `detail`. */
const fail = (code, status, detail) => Object.assign(new Error(detail), { planError: true, code, detail, status });
const UNCHECKED = () => fail('SIM_UNAVAILABLE', 503, 'This could not be tried on the chain just now, so it is not offered. Try again in a moment.');
const UPSTREAM = () => fail('UPSTREAM', 503, 'The pawn desk could not be read just now. Try again in a moment.');

/** One cached value, one refresh at a time. A failed refresh keeps the last good copy. */
function cached({ ttl, load }) {
  let value;
  let at = 0;
  let pending = null;
  let retryAt = 0;
  const refresh = () => {
    pending ||= (async () => {
      try {
        value = await load(value);
        at = Date.now();
        return value;
      } catch (e) {
        retryAt = Date.now() + 10_000;
        throw e;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
  return {
    async get() {
      if (at && Date.now() - at < ttl) return value;
      if (!at) return refresh();
      if (!pending && Date.now() < retryAt) return value;
      try { return await refresh(); } catch { return value; }
    },
  };
}
function keyed({ ttl, load, max = 200 }) {
  const map = new Map();
  return {
    get(key) {
      let c = map.get(key);
      if (!c) {
        if (map.size >= max) map.delete(map.keys().next().value);
        c = cached({ ttl, load: (prev) => load(key, prev) });
        map.set(key, c);
      }
      return c.get();
    },
  };
}

/** At most `max` of these at once. The proxy is shared with the live site. */
function gateOf(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); });
}

/** Give up on `promise` after `ms`. The work behind it carries on and fills its cache for the next caller. */
function within(promise, ms, fallback) {
  let t;
  const late = new Promise((resolve) => { t = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(t));
}

async function fetchJson(url, timeoutMs) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

// ───────────────────────── chain access ─────────────────────────

const gate = gateOf(6);
let rpcSeq = 0;
let directRestsUntil = 0;
const directRefuses = new Map(); // method → until when dRPC is not asked for it

/** POST one call to one upstream: the parsed answer, or null when there is none. */
async function post(url, body, timeoutMs, strict) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
    if (strict && !r.ok) return null; // how a refused key or a spent quota looks
    const j = JSON.parse(await r.text());
    return j && typeof j === 'object' && !Array.isArray(j) && ('result' in j || (j.error && typeof j.error === 'object')) ? j : null;
  } catch {
    return null;
  }
}
const rpcError = (error) => Object.assign(new Error(String(error.message ?? 'rpc error').slice(0, 300)), {
  rpc: { code: error.code, message: String(error.message ?? ''), data: error.data },
});
/** An error that is the chain's own verdict on the call, which a second upstream would only repeat. */
const chainSaid = (error) => error.code === 3 || /revert|insufficient (funds|balance)|out of gas/i.test(String(error.message ?? ''));

/**
 * One JSON-RPC call: dRPC direct when there is a key, the proxy when there is not or when dRPC gives no answer or
 * refuses for a reason of its own (a method, a range, a quota). A JSON-RPC error is thrown with `.rpc`.
 */
function rpc(method, params) {
  return gate(async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcSeq, method, params });
    if (DIRECT && Date.now() >= directRestsUntil && !(directRefuses.get(method) > Date.now())) {
      const j = await post(DIRECT, body, 6_000, true);
      if (j && !j.error) return j.result;
      if (j && chainSaid(j.error)) throw rpcError(j.error);
      // no answer at all: give dRPC a rest. A refusal of its own: stop asking it for this method for a while.
      if (j) directRefuses.set(method, Date.now() + 60_000); else directRestsUntil = Date.now() + 20_000;
    }
    for (let attempt = 0; ; attempt++) {
      const j = await post(PROXY, body, 7_000, false);
      if (j) {
        if (!j.error) return j.result;
        throw rpcError(j.error);
      }
      if (attempt >= 1) throw new Error('Robinhood Chain did not answer');
      await sleep(250);
    }
  });
}

/** A call to make: where, what, and how to read the answer. */
const C = (to, abi, functionName, args = [], value = 0n) => ({ to, abi, functionName, value, data: encodeFunctionData({ abi, functionName, args }) });
function decode(spec, hex) {
  try { return decodeFunctionResult({ abi: spec.abi, functionName: spec.functionName, data: hex }); } catch { return null; }
}
const value = (spec, row) => (row && row.ok ? decode(spec, row.data) : null);

/**
 * Many reads in one eth_call (Multicall3.aggregate3). A read that fails is null. Through the proxy these are
 * answered from a short cache, which is fine for a name and not for a decision: decisions use `simulate`.
 */
async function multicall(specs, chunk = 300) {
  const out = new Array(specs.length).fill(null);
  const parts = [];
  for (let i = 0; i < specs.length; i += chunk) parts.push([i, specs.slice(i, i + chunk)]);
  await Promise.all(parts.map(async ([start, part]) => {
    const data = encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'aggregate3', args: [part.map((s) => ({ target: s.to, allowFailure: true, callData: s.data }))] });
    const rows = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: await rpc('eth_call', [{ to: MULTICALL3, data }, 'latest']) });
    rows.forEach((r, k) => { out[start + k] = r.success ? decode(part[k], r.returnData) : null; });
  }));
  return out;
}

/**
 * Run calls in order, as `from`, on top of the chain's current state, and send nothing (eth_simulateV1: one
 * simulated block, so an approval is in place for the call after it). `pre` and `post` are reads around the
 * `steps`. Each row is { ok, data, error }. When the node cannot do this, the answer is a refusal, never a guess.
 */
async function simulate({ from, pre = [], steps = [], post = [] }) {
  const wire = (c) => ({ from, to: c.to, data: c.data, ...(c.value && BigInt(c.value) > 0n ? { value: toHex(BigInt(c.value)) } : {}) });
  const all = [...pre, ...steps, ...post];
  let res;
  try {
    res = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: all.map(wire) }], validation: false }, 'latest']);
  } catch (e) {
    if (e?.rpc && /insufficient (funds|balance)/i.test(e.rpc.message)) throw fail('NOT_ENOUGH', 400, 'This wallet does not have enough ETH to cover that.');
    throw UNCHECKED();
  }
  const rows = res?.[0]?.calls;
  if (!Array.isArray(rows) || rows.length !== all.length) throw UNCHECKED();
  const out = rows.map((c) => ({ ok: c?.status === '0x1', data: typeof c?.returnData === 'string' ? c.returnData : '0x', error: c?.status === '0x1' ? null : (c?.error || { message: 'execution reverted' }) }));
  const a = pre.length, b = a + steps.length;
  return { pre: out.slice(0, a), steps: out.slice(a, b), post: out.slice(b), block: Number(BigInt(res[0].number ?? 0)) };
}

/** Reads on the chain's state right now, decoded; a failed read is null. Throws when the chain cannot be asked. */
async function readLive(specs, chunk = 120) {
  const parts = [];
  for (let i = 0; i < specs.length; i += chunk) parts.push(specs.slice(i, i + chunk));
  const done = await Promise.all(parts.map(async (part) => (await simulate({ from: PROBE, pre: part })).pre.map((r, k) => value(part[k], r))));
  return done.flat();
}
/** The same, for a list: when the live road is closed, a cached answer beats none. */
async function readNow(specs) {
  if (!specs.length) return [];
  try { return await readLive(specs); } catch { return multicall(specs); }
}

// what a contract said when it refused, in words. Custom errors are matched by selector.
const errors = (...sigs) => new RegExp(`^(${sigs.map((s) => (s.startsWith('0x') ? s : toFunctionSelector(s))).join('|')})`, 'i');
const REASONS = [
  [errors('NoFloor()'), 'its pool is not paying anything for this NFT right now'],
  [errors('InsufficientFree()'), 'the desk does not have that much to lend right now'],
  [errors('Slippage()'), 'the price moved past your limit'],
  [errors('Gated()'), 'this collection cannot be pawned at this desk'],
  [errors('NotTicketOwner()'), 'this wallet does not hold that loan'],
  [errors('UnknownTicket()'), 'that loan is already closed'],
  [errors('UnknownPool()'), 'that desk pool does not exist'],
  // the collection's transfer validator turning away an operator it has not whitelisted
  [errors('0x1de5204e'), 'this collection only lets approved marketplaces move its NFTs, and the pawn desk is not one of them'],
  [errors('ERC721InsufficientApproval(address,uint256)', 'TransferCallerNotOwnerNorApproved()', 'ApprovalCallerNotOwnerNorApproved()'), 'the desk is not allowed to take that NFT'],
  [errors('ERC721IncorrectOwner(address,uint256,address)', 'TransferFromIncorrectOwner()'), 'the wallet does not hold that NFT'],
  [errors('ERC721NonexistentToken(uint256)', 'OwnerQueryForNonexistentToken()'), 'that NFT does not exist'],
  [errors('ERC20InsufficientBalance(address,uint256,uint256)'), 'the wallet does not hold enough to repay'],
  [errors('ERC20InsufficientAllowance(address,uint256,uint256)'), 'the desk is not allowed to take the repayment'],
  [errors('SafeERC20FailedOperation(address)', 'FailedInnerCall()', 'FailedCall()'), 'the repayment could not be taken from the wallet'],
  [/incorrect owner|not token owner|not owner nor approved|caller is not/i, 'the wallet does not hold that NFT, or the desk is not allowed to take it'],
  [/insufficient allowance/i, 'the desk is not allowed to take the repayment'],
  [/exceeds balance|insufficient balance/i, 'the wallet does not hold enough to repay'],
  [/insufficient funds/i, 'the wallet cannot cover it'],
];
/** The raw reason a failed row carries: a revert string, a custom error's selector, or the node's message. */
function rawReason(error) {
  const data = typeof error?.data === 'string' ? error.data : '';
  if (data.startsWith('0x08c379a0')) {
    try { return clean(decodeAbiParameters([{ type: 'string' }], `0x${data.slice(10)}`)[0], 80); } catch { /* fall through */ }
  }
  if (/^0x[0-9a-fA-F]{8}/.test(data)) return data.slice(0, 10).toLowerCase();
  const m = /reverted:?\s*(.*)$/i.exec(String(error?.message || ''));
  return clean(redact(m?.[1] || String(error?.message || '')), 80);
}
function plainReason(error) {
  const raw = rawReason(error);
  for (const [re, words] of REASONS) if (re.test(raw)) return words;
  return raw && !/^execution reverted$/i.test(raw) ? `the contract answered "${raw}"` : 'the contract gave no reason';
}
const refusal = (error) => fail('WOULD_REVERT', 400, `The chain refused this when it was tried: ${plainReason(error)}.`);

// ───────────────────────── the desk's pools ─────────────────────────

const tokenOf = (q) => ({ chainId: HOME, address: q.address, symbol: q.symbol, name: q.name, decimals: q.decimals, logo: q.logo, tags: q.tags });
/** A token as the page's own Thing (the page builds the same id for a token it already knows). */
const tokenThing = (t) => ({ kind: 'token', id: `token:${t.chainId}:${t.address.toLowerCase()}`, label: t.symbol, sub: t.name, ...t });

const topRate = (t) => t.base + t.slope1 + t.slope2;
/** The desk's own rate curve (`_rateAt`), per year in basis points, for a share lent in basis points. */
function rateAt(t, lentBps) {
  if (lentBps <= t.kink) return t.base + (t.kink === 0 ? 0 : Math.floor((t.slope1 * lentBps) / t.kink));
  const rest = 10_000 - t.kink;
  return t.base + t.slope1 + (rest === 0 ? 0 : Math.floor((t.slope2 * (lentBps - t.kink)) / rest));
}
/** Why a pool is not offered here, or null when it is. */
function whyNot(terms, quote) {
  if (!quote.vouched) return 'it pays in a token this site does not vouch for';
  if (terms.ltv === 0 || terms.ltv * 10_000 > terms.liq * (10_000 - MIN_ROOM_BPS)) return 'a new loan there starts too close to being sold';
  if (terms.bounty > MAX_BOUNTY_BPS) return 'its reward for selling a loan is too high';
  if (topRate(terms) > MAX_TOP_RATE_BPS) return 'its top rate is too high';
  return null;
}

/** Everything about pools that never changes after they are opened, read once and added to as pools appear. */
async function describePools(rows, ids) {
  const fresh = rows.map((p, i) => (p ? { id: ids[i], p } : null)).filter(Boolean);
  const meta = await multicall(fresh.flatMap(({ p }) => [
    C(p.quoteToken, ERC20_ABI, 'decimals'), C(p.quoteToken, ERC20_ABI, 'symbol'), C(p.collection, ERC721_ABI, 'name'),
  ]));
  return fresh.map(({ id: poolId, p }, i) => {
    const [decimals, symbol, name] = meta.slice(i * 3, i * 3 + 3);
    const known = VOUCHED.get(p.quoteToken.toLowerCase());
    // a vouched token whose decimals the chain does not confirm is not vouched: decimals decide how every amount reads
    const vouched = !!known && Number(decimals) === known.decimals;
    const quote = vouched
      ? { address: getAddress(p.quoteToken), ...known, vouched: true }
      : { address: getAddress(p.quoteToken), symbol: clean(symbol ?? '', 16) || short(p.quoteToken), name: clean(symbol ?? '', 32) || 'Unknown token', decimals: Number.isInteger(Number(decimals)) && Number(decimals) <= 36 ? Number(decimals) : 18, tags: [], logo: null, vouched: false };
    const terms = { ltv: Number(p.terms.ltvBps), liq: Number(p.terms.liqBps), bounty: Number(p.terms.bountyBps), base: Number(p.terms.baseRateBps), slope1: Number(p.terms.slope1Bps), kink: Number(p.terms.kinkBps), slope2: Number(p.terms.slope2Bps) };
    return {
      id: poolId, collection: getAddress(p.collection), vault: getAddress(p.vault), curve: same(p.curve, ZERO) ? null : getAddress(p.curve),
      name: clean(name ?? '', 48) || short(p.collection), quote, terms, notOffered: whyNot(terms, quote),
    };
  });
}
const deskPools = cached({
  ttl: 60_000,
  load: async (prev) => {
    const known = prev || new Map();
    const [length] = await multicall([C(DESK, DESK_ABI, 'poolsLength')]);
    if (length == null) throw new Error('desk unreadable');
    const n = Math.min(Number(length), MAX_POOLS);
    const ids = [];
    for (let i = 0; i < n; i++) if (!known.has(i)) ids.push(i);
    if (!ids.length) return known;
    const rows = await multicall(ids.map((i) => C(DESK, DESK_ABI, 'getPool', [BigInt(i)])));
    const next = new Map(known);
    for (const p of await describePools(rows, ids)) next.set(p.id, p);
    return next;
  },
});
const allPools = () => deskPools.get().catch(() => { throw UPSTREAM(); });

/** One pool by id, for a loan that sits in a pool past the ones kept in the list. */
const stray = keyed({
  ttl: 3_600_000,
  max: 100,
  load: async (poolId) => {
    const rows = await multicall([C(DESK, DESK_ABI, 'getPool', [BigInt(poolId)])]);
    const [p] = await describePools(rows, [Number(poolId)]);
    if (!p) throw new Error('no such pool');
    return p;
  },
});
async function poolById(poolId) {
  const p = (await allPools()).get(Number(poolId));
  return p || stray.get(Number(poolId)).catch(() => { throw UPSTREAM(); });
}

/** The pools this site will lend through for a collection: oldest first, a handful at most. */
async function offeredFor(collection) {
  const all = [...(await allPools()).values()].filter((p) => same(p.collection, collection)).sort((a, b) => a.id - b.id);
  return { all, offered: all.filter((p) => !p.notOffered).slice(0, POOLS_PER_COLLECTION) };
}

// ───────────────────────── what a pool lends, right now ─────────────────────────

/** The reads that price one pool for some token ids. A pool with no curve pays the same for every id. */
function offerSpecs(p, tokenIds) {
  const ids = p.curve ? tokenIds : tokenIds.slice(0, 1);
  return [
    C(DESK, DESK_ABI, 'getPool', [BigInt(p.id)]),
    C(DESK, DESK_ABI, 'rate', [BigInt(p.id)]),
    C(DESK, DESK_ABI, 'borrowed', [BigInt(p.id)]),
    // the sale that would close a loan deposits the id into the market's vault; a vault with an id list could refuse it
    ...(p.curve ? [] : [C(p.vault, VAULT_ABI, 'allowedIdsRoot')]),
    ...ids.map((t) => C(DESK, DESK_ABI, 'floorOf', [BigInt(p.id), t])),
    ...(p.curve ? ids.map((t) => C(p.curve, CURVE_ABI, 'isCompanion', [t])) : []),
  ];
}
function offersFrom(p, tokenIds, vals) {
  const [state, rate, borrowed] = vals;
  const head = p.curve ? 3 : 4;
  const gated = !p.curve && (vals[3] == null || BigInt(vals[3]) !== 0n);
  return tokenIds.map((tokenId, i) => {
    const floor = vals[head + (p.curve ? i : 0)];
    if (!state || !rate || borrowed == null) return { pool: p, tokenId, ok: false, why: 'unread' };
    const price = floor ? floor[0] : 0n;
    const advance = (price * BigInt(p.terms.ltv)) / 10_000n;
    const why = gated ? 'gated' : advance === 0n ? 'no-price' : advance > state.free ? 'short' : null;
    // the buyback only counts for an id that can use it
    const buyback = !!p.curve && vals[head + tokenIds.length + i] === false;
    return { pool: p, tokenId, ok: !why, why, price, buyback, advance, free: state.free, borrowed, rateBps: Number(rate[1]) };
  });
}
/** For each token id, what every offered pool of the collection would lend on it right now. */
async function offersFor(pools, tokenIds, read = readLive) {
  const specs = pools.map((p) => offerSpecs(p, tokenIds));
  const vals = await read(specs.flat());
  let at = 0;
  const perPool = pools.map((p, i) => { const mine = vals.slice(at, at + specs[i].length); at += specs[i].length; return offersFrom(p, tokenIds, mine); });
  return tokenIds.map((_, t) => perPool.map((rows) => rows[t]));
}
/** The oldest pool that can pay, optionally only in one token. */
const pick = (offers, quote = null) => offers.find((o) => o.ok && (!quote || same(o.pool.quote.address, quote))) || null;

/** The yearly rate right after `advance` more is lent (the desk's own formula on the state just read). */
function rateAfter(o) {
  const total = o.free + o.borrowed;
  const lent = total === 0n ? 0 : Number(((o.borrowed + o.advance) * 10_000n) / total);
  return rateAt(o.pool.terms, Math.min(10_000, lent));
}

// ───────────────────────── a wallet's NFTs and their art ─────────────────────────

/** staccpad's index of a Robinhood wallet's NFTs, by collection. It can lag the chain, so ownership is re-read. */
const walletLists = keyed({
  ttl: 30_000,
  max: 200,
  load: async (owner) => {
    const j = await fetchJson(`${STACCPAD}/api/wallet/${owner}/nfts`, 7_000);
    if (!Array.isArray(j?.nfts)) throw new Error('wallet list unreadable');
    const by = new Map();
    for (const n of j.nfts) {
      if (!isAddress(n?.token) || idOf(n.id) == null) continue;
      const k = n.token.toLowerCase();
      if (!by.has(k)) by.set(k, []);
      by.get(k).push({ id: String(n.id), name: clean(n.name ?? '', 64), image: imageUrl(n.image) });
    }
    return by;
  },
});

/** `ownerOf` over the whole supply: the answer when the index is slow, down or behind. Burned ids are just misses. */
async function scanHeld(collection, owner, want) {
  const [supply] = await multicall([C(collection, ERC721_ABI, 'totalSupply')]);
  if (supply == null || supply > 20_000n) return [];
  const last = Number(supply) + 1;
  const found = [];
  // six reads of 500 at a time, and no further once everything the wallet holds has turned up
  for (let from = 0; from <= last && found.length < want; from += 3_000) {
    const ids = Array.from({ length: Math.min(3_000, last - from + 1) }, (_, i) => BigInt(from + i));
    const owners = await multicall(ids.map((i) => C(collection, ERC721_ABI, 'ownerOf', [i])), 500);
    owners.forEach((o, i) => { if (same(o, owner)) found.push(ids[i].toString()); });
  }
  return found.slice(0, want);
}

/** The ids of each collection that `owner` holds right now: the wallet index, corrected by the chain. */
async function heldBy(owner, collections, listing) {
  if (!collections.length) return new Map();
  // the index answers in a fifth of a second when it is warm and can take ten when it is cold: past a short wait
  // the chain is asked instead, and the index carries on loading for the next time
  const [listed, balances] = await Promise.all([
    within(listing, 700, null).then((m) => m || new Map()),
    readNow(collections.map((c) => C(c, ERC721_ABI, 'balanceOf', [owner]))),
  ]);
  const out = new Map();
  await Promise.all(collections.map(async (collection, i) => {
    const balance = balances[i] ?? 0n;
    if (balance === 0n) return;
    const claimed = (listed.get(collection.toLowerCase()) || []).slice(0, PER_COLLECTION);
    const owners = await readNow(claimed.map((t) => C(collection, ERC721_ABI, 'ownerOf', [BigInt(t.id)])));
    const have = claimed.filter((_, k) => same(owners[k], owner));
    if (BigInt(have.length) < balance && have.length < PER_COLLECTION) {
      const known = new Set(have.map((t) => t.id));
      const more = await scanHeld(collection, owner, Number(balance)).catch(() => []);
      for (const tokenId of more) if (!known.has(tokenId) && have.length < PER_COLLECTION) have.push({ id: tokenId, name: '', image: null });
    }
    if (have.length) out.set(collection, have);
  }));
  return out;
}

/** An NFT's picture, from its own metadata: inline when the collection keeps it on chain, else through staccpad. */
async function pictureAt(uri) {
  if (typeof uri !== 'string' || !uri) return null;
  let meta = null;
  if (uri.startsWith('data:application/json')) {
    const body = uri.slice(uri.indexOf(',') + 1);
    meta = JSON.parse(uri.slice(0, uri.indexOf(',')).includes(';base64') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body));
  } else if (/^(ipfs|ar|https?):\/\//.test(uri) && uri.length <= 2_000) {
    meta = await fetchJson(`${STACCPAD}/api/meta?uri=${encodeURIComponent(uri)}`, 2_500);
  }
  return imageUrl(meta?.image ?? meta?.image_url ?? null);
}
const pictures = new Map(); // "collection:id" → { at, image }; a miss is remembered too, for a shorter while
/** Pictures for a list of NFTs, in order. Null where one cannot be had within a list's patience. */
async function artFor(items) {
  const keyOf = (x) => `${x.collection.toLowerCase()}:${x.tokenId}`;
  const now = Date.now();
  const need = items.filter((x) => { const hit = pictures.get(keyOf(x)); return !hit || now - hit.at > (hit.image ? 3_600_000 : 600_000); }).slice(0, 24);
  if (need.length) {
    await within((async () => {
      const uris = await multicall(need.map((x) => C(x.collection, ERC721_ABI, 'tokenURI', [x.tokenId])));
      await Promise.all(need.map(async (x, i) => {
        const image = await pictureAt(uris[i]).catch(() => null);
        if (pictures.size > 2_000) pictures.clear();
        pictures.set(keyOf(x), { at: Date.now(), image });
      }));
    })().catch(() => {}), 2_000, null);
  }
  return items.map((x) => pictures.get(keyOf(x))?.image ?? null);
}

// ───────────────────────── who opened a loan ─────────────────────────

const blockTimes = new Map();
async function blockTime(n) {
  if (blockTimes.has(n)) return blockTimes.get(n);
  const b = await rpc('eth_getBlockByNumber', [toHex(n), false]);
  const t = Number(BigInt(b.timestamp));
  if (blockTimes.size > 5_000) blockTimes.clear();
  blockTimes.set(n, t);
  return t;
}
const openers = new Map(); // loan id → the wallet that pawned (it never changes)
/**
 * The wallet that opened a loan, from the desk's `Pawned` event. The loan records when it was opened; a few block
 * headers narrow that to a window small enough to ask for its events. Every loan found in the window is remembered.
 */
async function openerOf(loanId, openedAt) {
  const k = String(loanId);
  if (openers.has(k)) return openers.get(k);
  try {
    const head = Number(BigInt(await rpc('eth_blockNumber', [])));
    let lo = DESK_FIRST_BLOCK, hi = head;
    while (hi - lo > 40_000) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await blockTime(mid)) <= Number(openedAt)) lo = mid; else hi = mid;
    }
    const logs = await rpc('eth_getLogs', [{ address: DESK, topics: [PAWNED_TOPIC], fromBlock: toHex(Math.max(DESK_FIRST_BLOCK, lo - 2_000)), toBlock: toHex(Math.min(head, hi + 2_000)) }]);
    for (const l of Array.isArray(logs) ? logs : []) {
      if (l?.topics?.length === 4) openers.set(String(BigInt(l.topics[1])), getAddress(`0x${l.topics[3].slice(26)}`));
    }
  } catch { /* not knowing is said as not knowing */ }
  return openers.get(k) ?? null;
}

// ───────────────────────── a wallet's open loans ─────────────────────────

/** Where a loan stands: what is owed, what its NFT would sell for, and how close the two are. */
function standing(pool, debt, price) {
  const line = (price * BigInt(pool.terms.liq)) / 10_000n;
  const reach = line === 0n ? null : Number((debt * 10_000n) / line) / 100;
  return { line, reach, sellable: price > 0n && debt * 10_000n >= price * BigInt(pool.terms.liq) };
}

/** Every loan NFT `owner` holds, newest first. The desk has no index by holder, so its loans are walked. */
const loanBoards = keyed({
  ttl: 10_000,
  max: 300,
  load: async (owner) => {
    const count = C(DESK, DESK_ABI, 'balanceOf', [owner]);
    const next = C(DESK, DESK_ABI, 'nextTicketId');
    const [held, upTo] = await readNow([count, next]);
    if (held == null || upTo == null) throw new Error('desk unreadable');
    if (held === 0n) return [];
    const last = Number(upTo) - 1;
    const mine = [];
    for (let hi = last; hi >= 1 && BigInt(mine.length) < held && last - hi < MAX_LOAN_SCAN; hi -= 300) {
      const ids = Array.from({ length: Math.min(300, hi) }, (_, i) => BigInt(hi - i));
      const owners = await readNow(ids.map((i) => C(DESK, DESK_ABI, 'ownerOf', [i])));
      owners.forEach((o, i) => { if (same(o, owner)) mine.push(ids[i]); });
    }
    const rows = await readNow(mine.flatMap((i) => [C(DESK, DESK_ABI, 'getTicket', [i]), C(DESK, DESK_ABI, 'debtOf', [i])]));
    const loans = [];
    for (let i = 0; i < mine.length; i++) {
      const [t, debt] = [rows[i * 2], rows[i * 2 + 1]];
      if (!t || debt == null) continue;
      const pool = await poolById(t.poolId).catch(() => null);
      if (pool) loans.push({ loanId: mine[i], pool, tokenId: t.tokenId, debt, openedAt: t.openedAt });
    }
    // loans opened together sit in the same stretch of blocks, so one lookup answers for all of them: asked one
    // after the other, and only for as long as a list can wait
    const whoOpened = (async () => {
      const started = Date.now();
      for (const l of loans) l.opener = Date.now() - started < 2_000 ? await openerOf(l.loanId, l.openedAt) : openers.get(String(l.loanId)) ?? null;
    })();
    const [images] = await Promise.all([artFor(loans.map((l) => ({ collection: l.pool.collection, tokenId: l.tokenId }))), whoOpened]);
    return loans.map((l, i) => {
      const { symbol, decimals } = l.pool.quote;
      const label = `${l.pool.name} #${l.tokenId}`;
      const owed = `${human(l.debt, decimals, true)} ${symbol}`;
      const foreign = l.opener && !same(l.opener, owner);
      return {
        kind: 'ticket', id: `pawn-loan:${HOME}:${l.loanId}`, label,
        sub: foreign ? `Opened by another wallet and sent here. ${owed} to take it` : `Repay ${owed} to get it back`,
        chainId: HOME, ticketId: l.loanId.toString(), collection: l.pool.collection, tokenId: l.tokenId.toString(), image: images[i],
      };
    });
  },
});

// ───────────────────────── catalog ─────────────────────────

/** The wallet's NFTs the desk will lend against right now, with what it lends. Fifteen seconds fresh. */
const lendBoards = keyed({
  ttl: 15_000,
  max: 300,
  load: async (owner) => {
    const listing = walletLists.get(owner).catch(() => null);
    const pools = [...(await allPools()).values()].filter((p) => !p.notOffered);
    const every = [...new Set(pools.map((p) => p.collection))];
    if (!every.length) return [];
    // a desk with nothing left to lend against a collection is not worth walking the wallet for
    const lending = (await Promise.all(every.map(async (collection) => {
      const { offered } = await offeredFor(collection);
      const [probe] = await offersFor(offered, [0n], readNow);
      return probe.some((o) => o.why !== 'unread' && o.why !== 'gated' && o.free > 0n && (o.pool.curve || o.ok)) ? { collection, offered } : null;
    }))).filter(Boolean);
    const held = await heldBy(owner, lending.map((l) => l.collection), listing);
    const things = [];
    await Promise.all([...held].map(async ([collection, tokens]) => {
      const { offered } = lending.find((l) => l.collection === collection);
      const offers = await offersFor(offered, tokens.map((t) => BigInt(t.id)), readNow);
      tokens.forEach((t, i) => {
        const o = pick(offers[i]);
        if (!o) return;
        const label = `${o.pool.name} #${t.id}`;
        things.push({
          kind: 'nft', id: `nft:${HOME}:${collection.toLowerCase()}:${t.id}`,
          label, sub: `Borrow ${human(o.advance, o.pool.quote.decimals)} ${o.pool.quote.symbol} against it`,
          chainId: HOME, collection, tokenId: t.id, name: t.name || label, image: t.image, collectionName: o.pool.name,
        });
      });
    }));
    return things.sort((a, b) => a.collectionName.localeCompare(b.collectionName) || (BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : 1));
  },
});

/** The loan on offer for one NFT: one per token the desk can pay in, the oldest pool that has the money. */
async function loansFor(nft) {
  const tokenId = idOf(nft?.tokenId);
  if (Number(nft?.chainId) !== HOME || !isAddress(nft?.collection) || tokenId == null) return [];
  const { offered } = await offeredFor(nft.collection);
  if (!offered.length) return [];
  const [offers] = await offersFor(offered, [tokenId], readNow);
  const out = [];
  for (const o of offers) {
    if (!o.ok || out.some((x) => same(x.currency.address, o.pool.quote.address))) continue;
    const { symbol, decimals } = o.pool.quote;
    const name = `${o.pool.name} #${tokenId}`;
    out.push({
      kind: 'loan', id: `pawn-offer:${HOME}:${o.pool.collection.toLowerCase()}:${o.pool.quote.address.toLowerCase()}`,
      label: `${human(o.advance, decimals)} ${symbol} now`, sub: `${name} back when you repay. No due date`,
      chainId: HOME, collection: o.pool.collection, currency: tokenThing(tokenOf(o.pool.quote)), image: null,
    });
  }
  return out;
}

/**
 * `nft-owned`: NFTs in `owner`'s wallet the desk will lend against, with what it lends in `sub`.
 * `loan`: given an NFT as `input`, the loan on offer for it.
 * `ticket`: the open loans `owner` holds, each one's NFT and what it costs to get back.
 */
export async function catalog(kind, { owner = null, chainId = null, input = null } = {}) {
  if (chainId != null && Number(chainId) !== HOME) return [];
  if (kind === 'loan') return input?.kind === 'nft' ? loansFor(input) : [];
  if (kind !== 'nft-owned' && kind !== 'ticket') return [];
  if (!isAddress(owner)) return [];
  return (kind === 'ticket' ? loanBoards : lendBoards).get(getAddress(owner));
}

// ───────────────────────── plans ─────────────────────────

export function match(input, output) {
  if (!input || !output || Number(input.chainId) !== HOME || Number(output.chainId) !== HOME) return false;
  if (input.kind === 'nft' && output.kind === 'loan') {
    return isAddress(input.collection) && idOf(input.tokenId) != null && (!isAddress(output.collection) || same(output.collection, input.collection));
  }
  if (input.kind === 'ticket' && output.kind === 'nft') {
    if (idOf(input.ticketId) == null) return false;
    const sameNft = !isAddress(input.collection) || !isAddress(output.collection) || same(input.collection, output.collection);
    const sameId = input.tokenId == null || output.tokenId == null || String(input.tokenId) === String(output.tokenId);
    return sameNft && sameId;
  }
  return false;
}

const tx = (call) => ({ chainId: HOME, to: call.to, value: BigInt(call.value || 0n).toString(), data: call.data });
const leg = (kind, label, { input = null, output = null, note = null, call = null }) => ({
  kind, chainId: HOME, label, in: input, out: output, feeNative: null, note, exec: { type: 'tx', tx: call ? tx(call) : null },
});
const checkedFact = (owner, legs, block) => (owner
  ? { label: 'Checked', value: 'Tried on the live chain for this wallet', sub: `${legs.length === 1 ? 'The step' : `All ${legs.length} steps, in order,`} went through${block ? ` at block ${block}` : ''}.`, tone: 'ok' }
  : { label: 'Checked', value: 'Priced on the live chain', sub: 'Connect a wallet and the steps are built and tried for it.' });
const UNAUDITED = 'The pawn desk is new and unaudited.';

/** Which market sets the sale price, in words. */
const venueOf = (buyback) => (buyback
  ? "the better of what the collection's pool and the collection's own buyback pay for it"
  : "what the collection's pool pays for one NFT");

async function planLoan(nft, loan, owner, slippage) {
  const tokenId = idOf(nft.tokenId);
  const { all, offered } = await offeredFor(nft.collection);
  if (!all.length) throw fail('NO_DESK', 404, 'The pawn desk does not lend against this collection.');
  if (!offered.length) throw fail('NO_DESK', 404, `The pawn desk has a pool for ${all[0].name}, but ${all[0].notOffered}, so it is not offered here.`);
  const collection = offered[0].collection;
  const name = `${offered[0].name} #${tokenId}`;
  const wanted = isAddress(loan?.currency?.address) && offered.some((p) => same(p.quote.address, loan.currency.address)) ? loan.currency.address : null;

  // everything a decision rests on, read from the chain as it is right now
  const ownerOf = C(collection, ERC721_ABI, 'ownerOf', [tokenId]);
  const approvedOne = C(collection, ERC721_ABI, 'getApproved', [tokenId]);
  const approvedAll = C(collection, ERC721_ABI, 'isApprovedForAll', [owner || PROBE, DESK]);
  const nextLoan = C(DESK, DESK_ABI, 'nextTicketId');
  const specs = offered.map((p) => offerSpecs(p, [tokenId]));
  const flat = specs.flat();
  const read = await readLive([ownerOf, approvedOne, approvedAll, nextLoan, ...flat]);
  const [holder, one, every, upTo] = read;
  if (!isAddress(holder)) throw fail('NOT_FOUND', 404, `${name} does not exist.`);
  if (owner && !same(holder, owner)) {
    throw fail('NOT_OWNER', 400, same(holder, DESK) ? `${name} is already pawned.` : `This wallet does not hold ${name}.`);
  }
  let at = 4;
  const offers = offered.map((p, i) => { const mine = read.slice(at, at + specs[i].length); at += specs[i].length; return offersFrom(p, [tokenId], mine)[0]; });
  const o = pick(offers, wanted) || pick(offers);
  if (!o) {
    if (offers.every((x) => x.why === 'unread')) throw UPSTREAM();
    const first = offers.find((x) => x.why !== 'unread') || offers[0];
    if (first.why === 'gated') throw fail('NO_OFFER', 404, `${first.pool.name} cannot be pawned at this desk: its market only takes certain NFTs.`);
    if (first.why === 'short') throw fail('DESK_SHORT', 404, `The desk has ${human(first.free, first.pool.quote.decimals)} ${first.pool.quote.symbol} left to lend against ${first.pool.name}, and this loan needs ${human(first.advance, first.pool.quote.decimals, true)}.`);
    throw fail('NO_OFFER', 404, `The ${first.pool.name} pool is not paying anything for this NFT right now, so the desk cannot lend against it.`);
  }

  const pool = o.pool;
  const t = pool.terms;
  const { symbol: sym, decimals: dec } = pool.quote;
  const token = tokenThing(tokenOf(pool.quote));
  const min = (o.advance * BigInt(Math.round((100 - slippage) * 100))) / 10_000n;
  const approved = !!owner && (same(one, DESK) || every === true);
  const pawnCall = C(DESK, DESK_ABI, 'pawn', [BigInt(pool.id), tokenId, min]);
  const build = (withTx) => [
    ...(approved ? [] : [leg('approve', `Let the pawn desk take ${name}`, {
      note: 'Only this one NFT. Nothing else in the wallet is touched.',
      call: withTx ? C(collection, ERC721_ABI, 'approve', [DESK, tokenId]) : null,
    })]),
    leg('pawn', `Pawn ${name} for ${human(o.advance, dec)} ${sym}`, {
      output: { token, amount: o.advance.toString() },
      note: `${approved ? '' : 'Needs the step before it to land first. '}You get at least ${human(min, dec)} ${sym}, or nothing happens and the NFT stays with you.`,
      call: withTx ? pawnCall : null,
    }),
  ];

  let legs = build(false);
  let advance = o.advance;
  let owed = o.advance;
  let price = o.price;
  let rateBps = rateAfter(o);
  let block = null;
  if (owner) {
    legs = build(true);
    const loanId = upTo ?? 0n;
    const priceNow = C(DESK, DESK_ABI, 'floorOf', [BigInt(pool.id), tokenId]);
    const rateNow = C(DESK, DESK_ABI, 'rate', [BigInt(pool.id)]);
    const debt = C(DESK, DESK_ABI, 'debtOf', [loanId]);
    const loanHolder = C(DESK, DESK_ABI, 'ownerOf', [loanId]);
    const sim = await simulate({ from: getAddress(owner), pre: [priceNow], steps: legs.map((l) => l.exec.tx), post: [ownerOf, rateNow, debt, loanHolder] });
    const bad = sim.steps.find((s) => !s.ok);
    if (bad) throw refusal(bad.error);
    const got = value(pawnCall, sim.steps[sim.steps.length - 1]);
    if (!got || got[1] < min) throw UNCHECKED();
    if (!same(value(ownerOf, sim.post[0]), DESK)) throw fail('WOULD_REVERT', 400, 'The chain refused this when it was tried: the NFT did not reach the desk.');
    advance = got[1];
    owed = advance;
    // the price this very run lent against
    price = value(priceNow, sim.pre[0])?.[0] || price;
    const after = value(rateNow, sim.post[1]);
    if (after) rateBps = Number(after[1]);
    // the loan this run opened, read back in the same run: what it would cost to close at once
    if (got[0] === loanId && same(value(loanHolder, sim.post[3]), owner)) owed = value(debt, sim.post[2]) ?? advance;
    block = sim.block;
    legs[legs.length - 1].label = `Pawn ${name} for ${human(advance, dec)} ${sym}`;
    legs[legs.length - 1].out = { token, amount: advance.toString() };
  }

  // the line: anyone may sell once debt * 10000 >= price * liq, with the price read at that moment
  const venue = venueOf(o.buyback);
  const { line } = standing(pool, owed, price);
  const fall = line === 0n ? 0 : Math.max(0, 100 - Number((owed * 1_000_000n) / line) / 10_000);
  const yearsAt = (bps) => (bps > 0 && owed > 0n ? Math.log(Number(line) / Number(owed)) / (bps / 10_000) : Infinity);
  const byInterest = span(yearsAt(rateBps) * 31_536_000);
  const byTopRate = span(yearsAt(topRate(t)) * 31_536_000);
  const perDay = (owed * BigInt(rateBps)) / 3_650_000n;
  const fallText = `${fall.toFixed(1).replace(/\.0$/, '')}%`;
  // a fresh loan owes what it paid out (a wei less, from rounding): say it with the same digits
  const owedText = `${owed <= advance ? human(advance, dec) : human(owed, dec, true)} ${sym}`;
  const interestText = byInterest ? `about ${byInterest} of interest at today's rate${byTopRate && byTopRate !== byInterest ? ` (about ${byTopRate} at the desk's highest rate)` : ''}` : 'no amount of interest at a 0% rate';

  return {
    routing: 'PLAN', op: id,
    headline: `Borrow ${human(advance, dec)} ${sym} against ${name}`,
    pay: { label: name, amount: null, token: null },
    receive: { label: `${sym} now, ${name} back when you repay`, amount: advance.toString(), token },
    legs,
    facts: [
      { label: 'You receive now', value: `${human(advance, dec)} ${sym}`, sub: `${pct(t.ltv)} of ${human(price, dec)} ${sym}, which is ${venue} right now.`, tone: 'ok' },
      { label: 'To get it back today', value: owedText, sub: 'What you borrowed and nothing on top. There is no fee to open the loan or to close it.' },
      {
        label: 'How that grows', value: `${pct(rateBps)} a year right now`,
        sub: `About ${human(perDay, dec, true)} ${sym} a day, added every second. The rate is not fixed. It follows how much of the desk's money is lent out: ${pct(t.base)} when none is, ${pct(t.base + t.slope1)} at ${pct(t.kink)} lent, ${pct(topRate(t))} when all of it is.`,
        tone: rateBps > 5_000 ? 'warn' : undefined,
      },
      {
        label: 'When anyone can sell it', value: `Once you owe ${pct(t.liq)} of its sale price`,
        sub: `The sale price is ${venue}, at that moment. Today that line is ${human(line, dec)} ${sym} and you would owe ${owedText}. A ${fallText} fall in the sale price crosses it at once. So does ${interestText}.`,
        tone: 'danger',
      },
      { label: 'If it is sold', value: 'The NFT is gone for good', sub: `Whoever triggers the sale keeps ${pct(t.bounty)} of it, your debt is paid from the rest, and anything left over goes to the wallet holding the loan. You keep the ${sym} you borrowed.`, tone: 'danger' },
      { label: 'Due date', value: 'None', sub: 'Nothing to pay on a schedule. Repay whenever you like and the NFT comes straight back. The loan sits in your wallet as an NFT of its own: whoever holds it can repay and take this one, so do not sell or send it by mistake.' },
      checkedFact(owner, legs, block),
    ],
    warnings: [
      `Anyone can sell ${name} once what you owe reaches ${pct(t.liq)} of its sale price (${venue}, at that moment). From here that takes a ${fallText} fall in that price, or ${interestText}. One pool sets that price and a single large trade can move it. If it is sold you keep the ${sym} and lose the NFT.`,
      ...(rateBps > 5_000 ? [`Interest on this loan is ${pct(rateBps)} a year right now.`] : []),
      `${UNAUDITED} Only pawn what you could stand to lose.`,
    ],
    contracts: [
      { chainId: HOME, address: collection, name: `${pool.name} collection` },
      { chainId: HOME, address: DESK, name: 'staccpad pawn desk' },
    ],
  };
}

async function planRepay(loanThing, nft, owner) {
  const loanId = idOf(loanThing.ticketId);
  const closed = () => fail('LOAN_CLOSED', 404, 'That loan is already closed: it was repaid, or its NFT was sold.');

  const ticket = C(DESK, DESK_ABI, 'getTicket', [loanId]);
  const debtNow = C(DESK, DESK_ABI, 'debtOf', [loanId]);
  const loanHolder = C(DESK, DESK_ABI, 'ownerOf', [loanId]);
  const [t, debt, holder] = await readLive([ticket, debtNow, loanHolder]);
  if (!t || debt == null || !isAddress(holder)) throw closed();
  const pool = await poolById(t.poolId);
  const tokenId = t.tokenId;
  const name = `${pool.name} #${tokenId}`;
  for (const side of [loanThing, nft]) {
    if ((isAddress(side.collection) && !same(side.collection, pool.collection)) || (side.tokenId != null && String(side.tokenId) !== tokenId.toString())) {
      throw fail('BAD_REQUEST', 400, `Loan #${loanId} is for ${name}, not the NFT that was asked for.`);
    }
  }
  if (owner && !same(holder, owner)) throw fail('NOT_OWNER', 400, `This wallet does not hold loan #${loanId}. Only the wallet holding it can repay it and take the NFT.`);

  const who = getAddress(owner || holder);
  const { address: quote, symbol: sym, decimals: dec } = pool.quote;
  const token = tokenThing(tokenOf(pool.quote));
  const rateNow = C(DESK, DESK_ABI, 'rate', [BigInt(pool.id)]);
  const priceNow = C(DESK, DESK_ABI, 'floorOf', [BigInt(pool.id), tokenId]);
  const held = C(quote, ERC20_ABI, 'balanceOf', [who]);
  const allowed = C(quote, ERC20_ABI, 'allowance', [who, DESK]);
  const gas = C(MULTICALL3, MULTICALL_ABI, 'getEthBalance', [who]);
  const nftOwner = C(pool.collection, ERC721_ABI, 'ownerOf', [tokenId]);
  const [[rate, price, balance, allowance, eth], opener] = await Promise.all([
    readLive([rateNow, priceNow, held, allowed, gas]),
    within(openerOf(loanId, t.openedAt), 1_500, null),
  ]);
  if (!rate || balance == null || allowance == null || eth == null) throw UPSTREAM();
  const rateBps = Number(rate[1]);

  // the debt moves every second and `redeem` takes what is owed when it lands: allow for half an hour of the
  // pool's top rate, and no more
  const room = (debt * BigInt(topRate(pool.terms)) * 1_800n) / (10_000n * YEAR) + 1n;
  const need = debt + room;
  const wrap = need > balance && same(quote, WETH) ? need - balance : 0n;
  if (owner && need > balance) {
    if (!wrap) throw fail('NOT_ENOUGH', 400, `Repaying takes ${human(need, dec, true)} ${sym} and this wallet holds ${human(balance, dec)}.`);
    if (eth < wrap + GAS_RESERVE) throw fail('NOT_ENOUGH', 400, `Repaying takes ${human(need, dec, true)} WETH. This wallet holds ${human(balance, dec)} WETH and ${human(eth, 18)} ETH, which is not enough to cover the rest.`);
  }
  const approved = !!owner && allowance >= need;
  const redeemCall = C(DESK, DESK_ABI, 'redeem', [loanId]);
  const build = (withTx, paid) => [
    ...(owner && wrap ? [leg('wrap', `Wrap ${human(wrap, 18, true)} ETH into WETH`, {
      input: { token: tokenThing(ETH), amount: wrap.toString() }, output: { token, amount: wrap.toString() },
      note: 'The desk is repaid in WETH. This turns just enough of your ETH into it.',
      call: withTx ? C(WETH, WETH_ABI, 'deposit', [], wrap) : null,
    })] : []),
    ...(approved ? [] : [leg('approve', `Let the pawn desk take up to ${human(need, dec, true)} ${sym}`, {
      note: `What you owe plus ${human(room, dec, true)} ${sym} for the interest that builds up before the repayment lands. The desk takes only what is owed.`,
      call: withTx ? C(quote, ERC20_ABI, 'approve', [DESK, need]) : null,
    })]),
    leg('repay', `Repay ${human(paid, dec, true)} ${sym} and take ${name} back`, {
      input: { token, amount: paid.toString() },
      note: `${owner && (wrap || !approved) ? 'Needs the steps before it to land first. ' : ''}The desk takes exactly what is owed at that second and sends the NFT to your wallet in the same transaction.`,
      call: withTx ? redeemCall : null,
    }),
  ];

  let legs = build(false, debt);
  let paid = debt;
  let block = null;
  if (owner) {
    legs = build(true, debt);
    const sim = await simulate({ from: who, steps: legs.map((l) => l.exec.tx), post: [nftOwner] });
    const bad = sim.steps.find((s) => !s.ok);
    if (bad) throw refusal(bad.error);
    const took = value(redeemCall, sim.steps[sim.steps.length - 1]);
    if (took == null || took > need) throw UNCHECKED();
    if (!same(value(nftOwner, sim.post[0]), who)) throw fail('WOULD_REVERT', 400, 'The chain refused this when it was tried: the NFT did not come back to the wallet.');
    paid = took;
    block = sim.block;
    legs = build(true, paid);
  }

  const perDay = (paid * BigInt(rateBps)) / 3_650_000n;
  const interest = paid > t.principal ? paid - t.principal : 0n;
  const at = price ? standing(pool, paid, price[0]) : null;
  const foreign = opener && !same(opener, who);
  const warnings = [];
  if (foreign) warnings.push(`${owner ? 'You did not open this loan' : 'The wallet holding this loan did not open it'}: ${short(opener)} did, and the loan was sent on afterwards. Repaying it means paying ${human(paid, dec, true)} ${sym} for ${name}. Only do that if you meant to buy this loan.`);
  else if (!opener) warnings.push('Only repay a loan you took out yourself, or one you meant to buy. A loan that simply appeared in a wallet can be bait.');
  if (!pool.quote.vouched) warnings.push(`This loan is repaid in ${sym} (${short(quote)}), a token this site does not vouch for.`);
  if (at?.sellable) warnings.push(`${name} can be sold by anyone right now: the debt has reached the line. Repaying only works if it lands first.`);
  else if (at?.reach != null && at.reach >= 90) warnings.push(`This loan is ${at.reach.toFixed(0)}% of the way to the line where anyone can sell ${name}.`);
  warnings.push(UNAUDITED);

  return {
    routing: 'PLAN', op: id,
    headline: `Repay ${human(paid, dec, true)} ${sym} and take ${name} back`,
    // the gas token this plan spends is the ETH it wraps; the page holds every step to what is shown here
    pay: { label: `Loan #${loanId} and ${human(paid, dec, true)} ${sym}`, amount: owner && wrap ? wrap.toString() : null, token: owner && wrap ? tokenThing(ETH) : null },
    receive: { label: name, amount: null, token: null },
    legs,
    facts: [
      {
        label: 'You pay', value: `${human(paid, dec, true)} ${sym}`,
        sub: `${human(t.principal, dec)} ${sym} was borrowed on ${dayOf(t.openedAt)}. ${human(interest, dec, true)} ${sym} of interest has built up since.${owner && wrap ? ` ${human(wrap, 18, true)} of it comes from your ETH, wrapped first.` : ''}`,
      },
      { label: 'You get back', value: name, sub: 'Sent to your wallet by the same transaction that repays the loan. The loan NFT is burned.', tone: 'ok' },
      { label: 'If you wait', value: `${pct(rateBps)} a year right now`, sub: `What you owe grows by about ${human(perDay, dec, true)} ${sym} a day. There is no due date.` },
      ...(at ? [{
        label: 'How close it is to being sold', value: at.reach == null ? 'No sale price right now' : `${at.reach.toFixed(0)}% of the way`,
        sub: `Anyone can sell the NFT once what is owed reaches ${human(at.line, dec)} ${sym}: ${pct(pool.terms.liq)} of the ${human(price[0], dec)} ${sym} it would sell for today.`,
        tone: at.sellable ? 'danger' : at.reach != null && at.reach >= 90 ? 'warn' : undefined,
      }] : []),
      ...(foreign ? [{ label: 'Opened by', value: short(opener), sub: 'Not the wallet that holds the loan now. It was sent on after it was opened.', tone: 'danger' }] : []),
      checkedFact(owner, legs, block),
    ],
    warnings,
    contracts: [
      { chainId: HOME, address: quote, name: same(quote, WETH) ? 'Wrapped Ether (WETH)' : `${sym} token` },
      { chainId: HOME, address: DESK, name: 'staccpad pawn desk' },
    ],
  };
}

/** A plan for the pair, or a refusal in one plain sentence. `owner` null prices it without building anything. */
export async function plan({ input, output, owner = null, slippage = 1 } = {}) {
  if (!match(input, output)) throw fail('NO_OP', 404, 'The pawn desk cannot make that trade.');
  if (owner != null && !isAddress(owner)) throw fail('BAD_REQUEST', 400, 'That wallet address is not valid.');
  const s = Number(slippage);
  const slip = Number.isFinite(s) && s >= 0 ? Math.min(50, s) : 1;
  try {
    return input.kind === 'nft' ? await planLoan(input, output, owner, slip) : await planRepay(input, output, owner);
  } catch (e) {
    if (e?.planError) throw e;
    console.warn(new Date().toISOString(), 'pawn plan failed:', redact(String(e?.message || e).split('\n')[0].slice(0, 200)));
    throw UPSTREAM();
  }
}

/** No routes of its own. Reading the desk's pools here means the first visitor does not wait for them. */
export function register() {
  deskPools.get().catch(() => {});
}
