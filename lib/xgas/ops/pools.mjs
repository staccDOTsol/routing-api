// An NFT in, tokens out. Tokens in, an NFT out. Through staccpad's peg pools.
//
// A peg pool is three contracts: a vault that holds one collection's NFTs and issues a claim token against them, a
// plain Uniswap v4 pool where that claim trades against the gas token or an ERC-20, and a router that does
// "NFT in" or "NFT out" in one transaction (nft-range src/peg/PegRouter.sol, PegVaultV2.sol, PegFactory.sol).
//
//   NFT -> token    collection.approve(router, id)   then   router.sell(key, vault, id, [], minQuote, owner)
//   token -> NFT    [token.approve(router, max)]     then   router.buyFloor(key, vault, max, owner)
//                                                    or     router.snipe(key, vault, id, max, owner) for one exact id
//
// Nothing here is priced by formula. A price is what the router's own call returns when it is run on the chain's
// current state (eth_simulateV1), and a transaction is only returned after the exact legs, in order, ran clean
// for that wallet. What this module will not do:
//   * return a transaction it has not run for that wallet;
//   * ask for more than this one NFT, or more than the exact token amount;
//   * sell into a pool that cannot take the whole NFT: the router keeps the claims the pool did not buy, so a
//     partly filled sale loses the rest. Such a pool is refused, not quoted;
//   * believe the market feed about anything a contract can answer: every pool is checked against the factories
//     named below, and the router that gets the approval is read from the factory, never from the feed.
//
// Chain reads go only through the owner's dRPC proxy. Nothing is ever sent from here.
import {
  decodeAbiParameters, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi,
  toFunctionSelector, toHex,
} from 'viem';

export const id = 'pools';

// ───────────────────────── fixed facts ─────────────────────────

const STACCPAD = 'https://staccpad.fun';
const DRPC = `${STACCPAD}/rpc`;
const HOME = 4663;
const rpcUrl = (chainId) => (chainId === HOME ? DRPC : `${DRPC}/${chainId}`);
// With the server's own dRPC key the chain is read directly: the shared proxy queues and stalls under load, and a
// sale that takes ten seconds to price is a sale nobody makes. The proxy stays as the second try.
const DRPC_KEY = /^[A-Za-z0-9_-]{8,200}$/.test(process.env.DRPC_KEY || '') ? process.env.DRPC_KEY : null;
const DRPC_SLUGS = {
  4663: 'robinhood', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 130: 'unichain', 81457: 'blast', 1868: 'soneium',
  1: 'ethereum', 56: 'bsc', 137: 'polygon', 43114: 'avalanche', 57073: 'ink', 4326: 'megaeth', 7777777: 'zora',
};
const directUrl = (chainId) => (DRPC_KEY && DRPC_SLUGS[chainId] ? `https://lb.drpc.live/${DRPC_SLUGS[chainId]}/${DRPC_KEY}` : null);

const ZERO = '0x0000000000000000000000000000000000000000';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
/** Robinhood's canonical Uniswap v4 PoolManager and Quoter (staccpad src/contracts/peg.ts). */
const HOME_POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const HOME_QUOTER = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94';
/** The peg factories on Robinhood: current, then legacy. A feed market from any other factory is not served. */
const HOME_FACTORIES = ['0x71FF4720E877fbbC013AE9ad6a0Eb32461b98470', '0xfe82Da62B2D2D884f55bcada3703dF54D1F073c2'];
/** The omni peg hub: one address on every chain, and it names that chain's factory (staccpad omniPeg.ts). */
const OMNI_HUB = '0x884F74128f451F98Ec34Dc92F3f1Fc1B2fBDE322';
/** Tokens staccpad vouches for as a quote; anything else is whatever its deployer named it. */
const VOUCHED = ['0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'];

/** Where the omni hub lives. Robinhood also has the feed's pools. */
const CHAINS = new Map([
  [4663, { name: 'Robinhood Chain', gas: 'ETH' }],
  [8453, { name: 'Base', gas: 'ETH' }],
  [42161, { name: 'Arbitrum', gas: 'ETH' }],
  [10, { name: 'Optimism', gas: 'ETH' }],
  [130, { name: 'Unichain', gas: 'ETH' }],
  [81457, { name: 'Blast', gas: 'ETH' }],
  [1868, { name: 'Soneium', gas: 'ETH' }],
  [57073, { name: 'Ink', gas: 'ETH' }],
  [4326, { name: 'MegaETH', gas: 'ETH' }],
  [7777777, { name: 'Zora', gas: 'ETH' }],
  [56, { name: 'BNB Chain', gas: 'BNB' }],
  [137, { name: 'Polygon', gas: 'POL' }],
  [43114, { name: 'Avalanche', gas: 'AVAX' }],
]);
const chainName = (chainId) => CHAINS.get(chainId)?.name ?? `chain ${chainId}`;

/** A stand-in buyer for pricing: it is given a balance for the length of one simulated call and nothing else. */
const PROBE = '0x000000000000000000000000000000000000dEaD';
const PROBE_BUDGET = 10n ** 24n;

const KEY = 'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }';
const ROUTER_ABI = parseAbi([
  KEY,
  'function buyFloor(PoolKey key, address vault, uint256 maxQuote, address receiver) payable returns (uint256 tokenId, uint256 quotePaid)',
  'function snipe(PoolKey key, address vault, uint256 tokenId, uint256 maxQuote, address receiver) payable returns (uint256 quotePaid)',
  'function sell(PoolKey key, address vault, uint256 tokenId, bytes32[] idProof, uint256 minQuote, address receiver) returns (uint256 quoteReceived)',
]);
const FACTORY_ABI = parseAbi([
  KEY,
  'function allMarketsLength() view returns (uint256)',
  'function allPoolIds(uint256) view returns (bytes32)',
  'function markets(bytes32) view returns (address vault, address collection, address quoteToken, uint24 fee, int24 tickSpacing, address creator, bool exists)',
  'function getPoolKey(bytes32 poolId) view returns (PoolKey)',
  'function router() view returns (address)',
  'function poolManager() view returns (address)',
]);
const HUB_ABI = parseAbi(['function factory() view returns (address)']);
const VAULT_ABI = parseAbi([
  'function inventoryCount() view returns (uint256)',
  'function peekFloor() view returns (uint256)',
  'function inVault(uint256) view returns (bool)',
  'function floorCost() view returns (uint256)',
  'function redeemCost(uint256 tokenId, bool snipe) view returns (uint256 total, uint256 royalty, address royaltyReceiver, uint256 platform, address treasury, uint256 premium)',
  'function unit() view returns (uint256)', // vault v2 only: claims one NFT costs
  'function mintUnit() view returns (uint256)', // vault v2 only: claims one deposit mints (v1 is a flat 1e18)
]);
const ERC721_ABI = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function getApproved(uint256) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function approve(address to, uint256 tokenId)',
  'function name() view returns (string)',
  'function totalSupply() view returns (uint256)',
]);
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const QUOTER_ABI = parseAbi([
  KEY,
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactOutputSingle(QuoteExactSingleParams params) returns (uint256 amountIn, uint256 gasEstimate)',
]);
const MULTICALL_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);
const POOL_MANAGER_ABI = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);

// ───────────────────────── small pieces ─────────────────────────

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const isAddress = (s) => typeof s === 'string' && ADDRESS.test(s);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A token id as a BigInt, or null when it is not one. */
function tokenIdOf(v) {
  const s = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : v;
  if (typeof s !== 'string' || !/^[0-9]{1,78}$/.test(s)) return null;
  const n = BigInt(s);
  return n < 1n << 256n ? n : null;
}

/** Printable, one line, bounded, no long dashes: names and symbols come from contracts anyone can deploy. */
function clean(v, max = 64) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/[–—―]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max);
}
/** https and data: images only; a site path becomes absolute on staccpad. */
function imageUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  if (u.startsWith('data:image/')) return u.length <= 16_000 ? u : null;
  if (u.startsWith('https://')) return u.slice(0, 600);
  if (u.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${u.slice(7).replace(/^ipfs\//, '')}`.slice(0, 600);
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
const orList = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} or ${a[a.length - 1]}`);
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** A refusal the page can show as it is: one plain sentence in `detail`. */
const fail = (code, status, detail) => Object.assign(new Error(detail), { planError: true, code, detail, status });
const UNCHECKED = () => fail('SIM_UNAVAILABLE', 503, 'This trade could not be tried on the chain just now, so it is not offered. Try again in a moment.');

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
    peek: () => value,
  };
}
function keyed({ ttl, load, max = 200 }) {
  const map = new Map();
  return {
    get(key) {
      let c = map.get(key);
      if (!c) {
        if (map.size >= max) map.delete(map.keys().next().value);
        c = cached({ ttl: typeof ttl === 'function' ? ttl(key) : ttl, load: (prev) => load(key, prev) });
        map.set(key, c);
      }
      return c.get();
    },
    drop: (key) => map.delete(key),
  };
}

/** At most `max` of these at once. The Robinhood proxy is shared with the live site. */
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

const gates = new Map();
let rpcSeq = 0;

/** One JSON-RPC call through the proxy. A JSON-RPC error is thrown with `.rpc`; a dead line is retried once. */
function rpc(chainId, method, params) {
  if (!gates.has(chainId)) gates.set(chainId, gateOf(8));
  return gates.get(chainId)(async () => {
    for (let attempt = 0; ; attempt++) {
      let j = null;
      try {
        const direct = attempt === 0 ? directUrl(chainId) : null;
        const r = await fetch(direct ?? rpcUrl(chainId), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSeq, method, params }),
          signal: AbortSignal.timeout(direct ? 6_000 : 12_000),
        });
        j = JSON.parse(await r.text());
      } catch { /* no answer, or not JSON */ }
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        if (!j.error) return j.result;
        throw Object.assign(new Error(String(j.error.message ?? 'rpc error').slice(0, 300)), {
          rpc: { code: j.error.code, message: String(j.error.message ?? ''), data: j.error.data },
        });
      }
      if (attempt >= 1) throw new Error(`${chainName(chainId)} did not answer`);
      await sleep(250);
    }
  });
}

/** A call to make: where, what, and how to read the answer. */
const C = (to, abi, functionName, args = []) => ({ to, abi, functionName, data: encodeFunctionData({ abi, functionName, args }) });
function decode(spec, hex) {
  try { return decodeFunctionResult({ abi: spec.abi, functionName: spec.functionName, data: hex }); } catch { return null; }
}

/**
 * Many reads in one call (Multicall3.aggregate3). A read that fails is null.
 *
 * On Robinhood a plain eth_call is answered by the proxy from a cache that can be two minutes behind, which is
 * fine for facts that never change and wrong for who owns what. `now` sends the same batch as a simulation of
 * one read instead: the proxy passes that straight through (and does not unpack and store every inner call,
 * which matters when the batch is a whole collection's owners). Other chains have no cache in the way.
 */
async function multicall(chainId, specs, { chunk = 300, now = false } = {}) {
  const out = new Array(specs.length).fill(null);
  const parts = [];
  for (let i = 0; i < specs.length; i += chunk) parts.push([i, specs.slice(i, i + chunk)]);
  await Promise.all(parts.map(async ([start, part]) => {
    const batch = C(MULTICALL3, MULTICALL_ABI, 'aggregate3', [part.map((s) => ({ target: s.to, allowFailure: true, callData: s.data }))]);
    let hex = null;
    if (now && chainId === HOME) {
      const run = await simulate(HOME, { from: PROBE, pre: [batch] }).catch(() => null);
      if (run?.pre[0].ok) hex = run.pre[0].data; // otherwise a cached answer beats none
    }
    hex ??= await rpc(chainId, 'eth_call', [{ to: MULTICALL3, data: batch.data }, 'latest']);
    const rows = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: hex });
    rows.forEach((r, k) => { out[start + k] = r.success ? decode(part[k], r.returnData) : null; });
  }));
  return out;
}

const noSimulate = new Map(); // chainId → until when eth_simulateV1 is not worth asking for
const reverted = (e) => !!e?.rpc && (e.rpc.code === 3 || /revert/i.test(e.rpc.message));
const broke = (e) => !!e?.rpc && /insufficient (funds|balance)/i.test(e.rpc.message);

/**
 * Run calls in order, as `from`, on top of the chain's current state, and send nothing (eth_simulateV1: one
 * simulated block, so an approval is in place for the call after it). `pre` and `post` are reads around the
 * `steps`. `balance` lends `from` that much gas token for the run. Each row is { ok, data, error }.
 *
 * `short` means the node refused before running because `from` cannot afford a step's value.
 * `exact` is false when the chain's node has no eth_simulateV1 and a single step was run with eth_call instead:
 * there is then no `post`, and two steps that depend on each other cannot be run at all (that is a refusal).
 * Robinhood never takes that second road: its proxy caches eth_call, and a cached run is not a check.
 */
async function simulate(chainId, { from, pre = [], steps = [], post = [], balance = null }) {
  const wire = (c) => ({ from, to: c.to, data: c.data, ...(c.value && BigInt(c.value) > 0n ? { value: toHex(BigInt(c.value)) } : {}) });
  const row = (ok, data, error) => ({ ok, data: typeof data === 'string' ? data : '0x', error: error || null });
  const lend = balance == null ? null : { [from]: { balance: toHex(balance) } };
  const all = [...pre, ...steps, ...post];
  const shortOf = () => ({ pre: [], steps: steps.map(() => row(false, '0x', { message: 'insufficient funds' })), post: null, block: null, exact: true, short: true });

  if (!((noSimulate.get(chainId) || 0) > Date.now())) {
    try {
      const res = await rpc(chainId, 'eth_simulateV1', [{ blockStateCalls: [{ calls: all.map(wire), ...(lend ? { stateOverrides: lend } : {}) }], validation: false }, 'latest']);
      const rows = res?.[0]?.calls;
      if (!Array.isArray(rows) || rows.length !== all.length) throw new Error('short answer');
      const out = rows.map((c) => row(c?.status === '0x1', c?.returnData, c?.error));
      const a = pre.length, b = a + steps.length;
      return { pre: out.slice(0, a), steps: out.slice(a, b), post: out.slice(b), block: Number(BigInt(res[0].number ?? 0)), exact: true, short: false };
    } catch (e) {
      if (broke(e)) return shortOf();
      if (chainId === HOME) throw UNCHECKED();
      if (e?.rpc) noSimulate.set(chainId, Date.now() + (e.rpc.code === -32601 ? 600_000 : 60_000));
    }
  } else if (chainId === HOME) throw UNCHECKED();

  if (steps.length > 1) throw UNCHECKED();
  const one = async (c, override) => {
    try {
      return row(true, await rpc(chainId, 'eth_call', [wire(c), 'latest', ...(override ? [override] : [])]));
    } catch (e) {
      if (reverted(e)) return row(false, '0x', { message: e.rpc.message, data: e.rpc.data });
      throw e;
    }
  };
  try {
    const [p, s] = await Promise.all([Promise.all(pre.map((c) => one(c, null))), Promise.all(steps.map((c) => one(c, lend)))]);
    return { pre: p, steps: s, post: null, block: null, exact: false, short: false };
  } catch (e) {
    if (broke(e)) return shortOf();
    throw UNCHECKED();
  }
}

// what a contract said when it refused, in words. Revert strings are PegRouter's and PegVault's own; custom
// errors are matched by selector (OpenZeppelin 5 and ERC721A name the same failures differently).
const errors = (...sigs) => new RegExp(`^(${sigs.map((s) => (s.startsWith('0x') ? s : toFunctionSelector(s))).join('|')})`, 'i');
const SHORT_OF_CLAIMS = errors('ERC20InsufficientBalance(address,uint256,uint256)', 'NotEnoughLiquidity(bytes32)');
const REASONS = [
  [/^empty$/i, 'the pool has no NFTs left'],
  [errors('Empty()'), 'the pool has no NFTs left'],
  [/slippage/i, 'the price moved past your limit'],
  [/fifo race/i, 'someone else got the floor first'],
  [/id allowlist/i, 'this pool only takes certain NFTs from the collection, and this one is not on its list'],
  [/min balance/i, 'this pool has a holder rule that this sale does not meet'],
  [/not a factory market|vault not in pool/i, 'this pool is not registered with its router'],
  [/^already$/i, 'that NFT is already in the pool'],
  [/insufficient funds/i, 'the wallet cannot cover it'],
  // the collection's transfer validator turning away an operator it has not whitelisted (staccpad peg.ts scooperCanMove)
  [errors('0x1de5204e'), 'this collection only lets approved marketplaces move its NFTs, and the pool is not one of them'],
  [errors('ERC721InsufficientApproval(address,uint256)', 'TransferCallerNotOwnerNorApproved()', 'ApprovalCallerNotOwnerNorApproved()'), 'the pool is not allowed to take that NFT'],
  [errors('ERC721IncorrectOwner(address,uint256,address)', 'TransferFromIncorrectOwner()'), 'the wallet does not hold that NFT'],
  [errors('ERC721NonexistentToken(uint256)', 'OwnerQueryForNonexistentToken()'), 'that NFT does not exist'],
  [errors('ERC20InsufficientBalance(address,uint256,uint256)', 'ERC20InsufficientAllowance(address,uint256,uint256)'), 'there is not enough of the token to cover it'],
  [errors('NotInVault()'), 'that NFT is not in the pool'],
];
/** The raw reason a failed row carries: a revert string, a custom error's selector, or the node's message. */
function rawReason(error) {
  const data = typeof error?.data === 'string' ? error.data : '';
  if (data.startsWith('0x08c379a0')) {
    try { return clean(decodeAbiParameters([{ type: 'string' }], `0x${data.slice(10)}`)[0], 80); } catch { /* fall through */ }
  }
  if (/^0x[0-9a-fA-F]{8}/.test(data)) return data.slice(0, 10).toLowerCase();
  const m = /reverted:?\s*(.*)$/i.exec(String(error?.message || ''));
  return clean(m?.[1] || String(error?.message || ''), 80);
}
function plainReason(error) {
  const raw = rawReason(error);
  for (const [re, words] of REASONS) if (re.test(raw)) return words;
  return raw && !/^execution reverted$/i.test(raw) ? `the contract answered "${raw}"` : 'the contract gave no reason';
}
const refusal = (error) => fail('WOULD_REVERT', 400, `The chain refused this when it was tried: ${plainReason(error)}.`);

// ───────────────────────── the pools ─────────────────────────

/** Native sorts first; otherwise the lower address is currency0. No hook. */
function keyOf(quote, vault, fee, tickSpacing) {
  const q = getAddress(quote), v = getAddress(vault);
  const qFirst = q.toLowerCase() < v.toLowerCase();
  return { currency0: qFirst ? q : v, currency1: qFirst ? v : q, fee, tickSpacing, hooks: ZERO };
}
const poolIdOf = (k) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
)).toLowerCase();
/** Where the PoolManager keeps a pool's price word (StateLibrary: pools mapping at slot 6). */
const priceSlot = (poolId) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n]));

/** staccpad's market feed. It sometimes answers without `markets`: the last good copy is kept. */
const feed = cached({
  ttl: 60_000,
  load: async (prev) => {
    try {
      const j = await fetchJson(`${STACCPAD}/api/markets`, 9_000);
      if (Array.isArray(j?.markets) && j.markets.length) return j.markets;
    } catch (e) {
      if (!prev) throw e;
    }
    if (prev) return prev;
    throw new Error('the staccpad feed answered without markets');
  },
});

const checked = new Map(); // poolId → what its factory says about it (never changes once created)
const routerOf = new Map(); // factory → its router
const nameOf = new Map(); // `${chainId}:${collection}` → the collection's own name()
const tokenOf = new Map(); // `${chainId}:${token}` → { symbol, decimals }

/** Fill in collection names and quote-token symbols and decimals from the chain, once each. */
async function describe(chainId, facts) {
  const k = (a) => `${chainId}:${a.toLowerCase()}`;
  const names = [...new Set(facts.map((f) => f.collection))].filter((a) => !nameOf.has(k(a)));
  const tokens = [...new Set(facts.filter((f) => !same(f.quoteAddress, ZERO)).map((f) => f.quoteAddress))].filter((a) => !tokenOf.has(k(a)));
  if (!names.length && !tokens.length) return;
  const res = await multicall(chainId, [
    ...names.map((a) => C(a, ERC721_ABI, 'name')),
    ...tokens.flatMap((a) => [C(a, ERC20_ABI, 'decimals'), C(a, ERC20_ABI, 'symbol')]),
  ]);
  names.forEach((a, i) => { const name = clean(res[i] ?? '', 40); if (name) nameOf.set(k(a), name); });
  tokens.forEach((a, i) => {
    const decimals = res[names.length + i * 2], symbol = clean(res[names.length + i * 2 + 1] ?? '', 16);
    if (decimals != null && Number(decimals) <= 36 && symbol) tokenOf.set(k(a), { symbol, decimals: Number(decimals) });
  });
}

/** The verified facts of one pool as the object the rest of this file trades with, or null if it cannot be described. */
function finish(f, { source, fallbackName = '', image = null }) {
  const native = same(f.quoteAddress, ZERO);
  const token = native ? { symbol: CHAINS.get(f.chainId).gas, decimals: 18 } : tokenOf.get(`${f.chainId}:${f.quoteAddress.toLowerCase()}`);
  if (!token) return null;
  const name = nameOf.get(`${f.chainId}:${f.collection.toLowerCase()}`) || clean(fallbackName, 40) || `Collection ${f.collection.slice(0, 8)}`;
  return { ...f, native, quote: { address: f.quoteAddress, ...token }, name, image, source, homeCollection: null };
}

/** Robinhood's feed markets: peg pools on the canonical PoolManager, each one confirmed by its own factory. */
async function feedPools() {
  const markets = await feed.get();
  const wanted = [];
  const pictures = new Map();
  for (const m of markets) {
    const p = m?.pool;
    if (!p || p.kind !== 'peg' || !same(p.poolManager, HOME_POOL_MANAGER)) continue;
    const factory = HOME_FACTORIES.find((f) => same(f, p.factory));
    if (!factory || ![m.collectionAddress, m.vaultAddress, p.quoteToken].every(isAddress) || !BYTES32.test(p.poolId || '')) continue;
    if (!Number.isInteger(p.fee) || !Number.isInteger(p.tickSpacing)) continue;
    const key = keyOf(p.quoteToken, m.vaultAddress, p.fee, p.tickSpacing);
    const poolId = p.poolId.toLowerCase();
    if (poolIdOf(key) !== poolId) continue;
    wanted.push({ m, p, key, poolId, factory });
    const c = m.collectionAddress.toLowerCase();
    if (!pictures.has(c) && imageUrl(m.image)) pictures.set(c, imageUrl(m.image));
  }

  const fresh = wanted.filter((w) => !checked.has(w.poolId));
  if (fresh.length) {
    const factories = [...new Set(fresh.map((w) => w.factory))].filter((f) => !routerOf.has(f));
    const res = await multicall(HOME, [
      ...fresh.map((w) => C(w.factory, FACTORY_ABI, 'markets', [w.poolId])),
      ...factories.map((f) => C(f, FACTORY_ABI, 'router')),
    ]);
    factories.forEach((f, i) => { const r = res[fresh.length + i]; if (isAddress(r) && !same(r, ZERO)) routerOf.set(f, getAddress(r)); });
    // markets() is a plain getter and never reverts: a missing answer is a failed read, and a thin list must not be cached
    if (res.slice(0, fresh.length).some((r) => r == null) || fresh.some((w) => !routerOf.has(w.factory))) throw new Error('factories unreadable');
    fresh.forEach((w, i) => {
      const r = res[i], router = routerOf.get(w.factory);
      const [vault, collection, quote, fee, spacing, , exists] = r;
      const agrees = exists && same(vault, w.m.vaultAddress) && same(collection, w.m.collectionAddress) && same(quote, w.p.quoteToken)
        && Number(fee) === w.p.fee && Number(spacing) === w.p.tickSpacing;
      if (!agrees) return;
      checked.set(w.poolId, {
        chainId: HOME, poolId: w.poolId, factory: w.factory, router, poolManager: HOME_POOL_MANAGER,
        vault: getAddress(vault), collection: getAddress(collection), quoteAddress: getAddress(quote), key: w.key, fee: w.p.fee,
      });
    });
  }
  const facts = wanted.filter((w) => checked.has(w.poolId));
  await describe(HOME, facts.map((w) => checked.get(w.poolId)));
  return facts.map((w) => finish(checked.get(w.poolId), {
    source: 'feed',
    fallbackName: String(w.m.name || '').replace(/\s+\/\s+[^/]*$/, ''), // "Name / USDG" is the pair; keep the collection's half
    image: pictures.get(w.m.collectionAddress.toLowerCase()) ?? null,
  })).filter(Boolean);
}

/** The omni hub's factory on `chainId`, read pool by pool from the chain. No feed involved. */
async function omniPools(chainId) {
  const [factory] = await multicall(chainId, [C(OMNI_HUB, HUB_ABI, 'factory')]);
  if (!isAddress(factory) || same(factory, ZERO)) return [];
  const [length, router, poolManager] = await multicall(chainId, [C(factory, FACTORY_ABI, 'allMarketsLength'), C(factory, FACTORY_ABI, 'router'), C(factory, FACTORY_ABI, 'poolManager')]);
  if (length == null || !isAddress(router) || !isAddress(poolManager)) throw new Error(`omni factory unreadable on ${chainId}`);
  if (chainId === HOME && !same(poolManager, HOME_POOL_MANAGER)) return [];
  const n = Math.min(Number(length), 200);
  const ids = (await multicall(chainId, Array.from({ length: n }, (_, i) => C(factory, FACTORY_ABI, 'allPoolIds', [BigInt(i)])))).filter((x) => BYTES32.test(x || ''));
  const rows = await multicall(chainId, ids.flatMap((x) => [C(factory, FACTORY_ABI, 'markets', [x]), C(factory, FACTORY_ABI, 'getPoolKey', [x])]));
  const facts = [];
  if (ids.length !== n || rows.some((r) => r == null)) throw new Error(`omni factory unreadable on ${chainId}`);
  ids.forEach((poolId, i) => {
    const m = rows[i * 2], k = rows[i * 2 + 1];
    if (!m[6]) return;
    const [vault, collection, quote] = m;
    const key = { currency0: getAddress(k.currency0), currency1: getAddress(k.currency1), fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: getAddress(k.hooks) };
    const pair = (same(key.currency0, quote) && same(key.currency1, vault)) || (same(key.currency0, vault) && same(key.currency1, quote));
    if (!pair || !same(key.hooks, ZERO) || poolIdOf(key) !== poolId.toLowerCase()) return;
    facts.push({
      chainId, poolId: poolId.toLowerCase(), factory: getAddress(factory), router: getAddress(router), poolManager: getAddress(poolManager),
      vault: getAddress(vault), collection: getAddress(collection), quoteAddress: getAddress(quote), key, fee: key.fee,
    });
  });
  await describe(chainId, facts);
  return facts.map((f) => finish(f, { source: 'omni' })).filter(Boolean);
}

async function loadPools(chainId, prev) {
  if (chainId !== HOME) {
    const [pools, home] = await Promise.all([omniPools(chainId), poolsOn(HOME).catch(() => [])]);
    // an omni vault has the same address everywhere: its Robinhood twin knows the picture and the original collection
    for (const p of pools) {
      const twin = home.find((h) => same(h.vault, p.vault));
      if (twin) { p.image = twin.image; p.homeCollection = twin.collection; if (!nameOf.get(`${chainId}:${p.collection.toLowerCase()}`)) p.name = twin.name; }
    }
    return pools;
  }
  const [a, b] = await Promise.allSettled([feedPools(), omniPools(HOME)]);
  // the feed's pools are the bulk of it: with none, and none remembered, say so rather than cache a thin list
  if (a.status === 'rejected' && !prev) throw a.reason;
  const fromFeed = a.status === 'fulfilled' ? a.value : (prev || []).filter((p) => p.source === 'feed');
  const fromHub = b.status === 'fulfilled' ? b.value : (prev || []).filter((p) => p.source === 'omni');
  for (const p of fromHub) p.image ??= fromFeed.find((f) => same(f.collection, p.collection))?.image ?? null;
  return [...fromFeed, ...fromHub];
}
const poolCache = keyed({ ttl: (chainId) => (Number(chainId) === HOME ? 60_000 : 300_000), max: 64, load: (chainId, prev) => loadPools(Number(chainId), prev) });
/** Every pool this module serves on a chain. Robinhood: a minute fresh. Elsewhere: five. */
const poolsOn = (chainId) => poolCache.get(chainId);

const claimIs0 = (pool) => same(pool.key.currency0, pool.vault);
/** What `claims` are worth in the quote at the pool's current price, before any trade moves it. */
function atLastPrice(pool, priceWord, claims) {
  if (typeof priceWord !== 'string' || claims == null) return null;
  const root = BigInt(priceWord) & ((1n << 160n) - 1n); // the price is stored as a square root, scaled by 2^96
  if (root === 0n) return null;
  return claimIs0(pool) ? (claims * root * root) >> 192n : (claims << 192n) / (root * root);
}

// ───────────────────────── the transactions ─────────────────────────

const tx = (chainId, call, value = 0n) => ({ chainId, to: call.to, value: value.toString(), data: call.data });
const approveNft = (pool, tokenId) => C(pool.collection, ERC721_ABI, 'approve', [pool.router, tokenId]);
const approveToken = (pool, amount) => C(pool.quote.address, ERC20_ABI, 'approve', [pool.router, amount]);
const sellCall = (pool, tokenId, min, to) => C(pool.router, ROUTER_ABI, 'sell', [pool.key, pool.vault, tokenId, [], min, to]);
const buyCall = (pool, tokenId, max, to) => (tokenId == null
  ? C(pool.router, ROUTER_ABI, 'buyFloor', [pool.key, pool.vault, max, to])
  : C(pool.router, ROUTER_ABI, 'snipe', [pool.key, pool.vault, tokenId, max, to]));
/** How much of the pool's quote `who` holds: the gas token through Multicall3, a token through itself. */
const balanceCall = (pool, who) => (pool.native ? C(MULTICALL3, MULTICALL_ABI, 'getEthBalance', [who]) : C(pool.quote.address, ERC20_ABI, 'balanceOf', [who]));
const value = (spec, row) => (row?.ok ? decode(spec, row.data) : null);

// ───────────────────────── pricing by trying ─────────────────────────

/**
 * Sell `tokenId` into `pool` as `seller`, on live state, with no minimum: what does the router pay, and does the
 * pool take the whole NFT? `stranded` is claims left behind in the router, which is a sale to refuse.
 */
async function trySell(pool, tokenId, seller) {
  const held = balanceCall(pool, seller);
  const routerClaims = C(pool.vault, ERC20_ABI, 'balanceOf', [pool.router]);
  const pre = [
    held, routerClaims,
    C(pool.collection, ERC721_ABI, 'getApproved', [tokenId]),
    C(pool.collection, ERC721_ABI, 'isApprovedForAll', [seller, pool.router]),
    C(pool.poolManager, POOL_MANAGER_ABI, 'extsload', [priceSlot(pool.poolId)]),
    C(pool.vault, VAULT_ABI, 'mintUnit'),
    C(pool.vault, VAULT_ABI, 'inventoryCount'),
  ];
  const steps = [approveNft(pool, tokenId), sellCall(pool, tokenId, 0n, seller)];
  const sim = await simulate(pool.chainId, { from: seller, pre, steps, post: [held, routerClaims] });
  const bad = sim.steps.find((s) => !s.ok);
  const out = { pool, ok: !bad, error: bad?.error ?? null, approved: false, paid: 0n, received: 0n, stranded: 0n, lastPrice: null, inventory: 0, block: sim.block };
  if (bad) return out;
  const [before, claimsBefore, approvedTo, forAll, word, mintUnit, inventory] = pre.map((s, i) => value(s, sim.pre[i]));
  const [after, claimsAfter] = [value(held, sim.post[0]), value(routerClaims, sim.post[1])];
  if (before == null || after == null || claimsBefore == null || claimsAfter == null) throw UNCHECKED();
  out.approved = same(approvedTo, pool.router) || forAll === true;
  out.paid = value(steps[1], sim.steps[1]) ?? 0n; // what the router says it paid, and what it holds minQuote against
  out.received = after - before; // what actually reached the seller
  out.stranded = claimsAfter - claimsBefore;
  out.lastPrice = atLastPrice(pool, word, mintUnit ?? 10n ** 18n);
  out.inventory = Number(inventory ?? 0n);
  return out;
}
const sells = (t) => t.ok && t.stranded === 0n && t.received > 0n && t.paid > 0n;

/**
 * Price one NFT out of `pool`: the floor, or `tokenId` exactly. The gas-token price is the router's own answer
 * when a stand-in with a lent balance buys it; a token price is the canonical Quoter's (Robinhood only).
 * `who` is whose balance and allowance to read alongside, if anyone's.
 */
async function tryBuy(pool, tokenId, who) {
  const exact = tokenId != null;
  const reads = [
    C(pool.vault, VAULT_ABI, 'inventoryCount'),
    C(pool.poolManager, POOL_MANAGER_ABI, 'extsload', [priceSlot(pool.poolId)]),
    C(pool.vault, VAULT_ABI, 'unit'),
    exact ? C(pool.vault, VAULT_ABI, 'redeemCost', [tokenId, true]) : C(pool.vault, VAULT_ABI, 'floorCost'),
    exact ? C(pool.vault, VAULT_ABI, 'inVault', [tokenId]) : C(pool.vault, VAULT_ABI, 'peekFloor'),
    balanceCall(pool, who || PROBE),
    ...(pool.native ? [] : [C(pool.quote.address, ERC20_ABI, 'allowance', [who || PROBE, pool.router])]),
  ];
  const out = { pool, ok: false, error: null, empty: false, missing: false, unsupported: false, pay: 0n, tokenId: tokenId ?? null, inventory: 0, feeBps: 0, premiumBps: 0, lastPrice: null, balance: null, allowance: null, block: null };
  const fill = (rows) => {
    const [inventory, word, unit, cost, spot, balance, allowance] = reads.map((s, i) => value(s, rows[i]));
    out.inventory = Number(inventory ?? 0n);
    out.empty = out.inventory === 0;
    out.missing = exact && spot !== true;
    const one = unit ?? 10n ** 18n; // a v1 vault has no unit(): one NFT is a flat 1e18 claims
    const claims = exact ? cost?.[0] : cost;
    if (claims != null && one > 0n) {
      const premium = exact ? cost[5] : 0n;
      out.premiumBps = Number((premium * 10_000n) / one);
      out.feeBps = Number(((claims - one - premium) * 10_000n) / one);
      out.lastPrice = atLastPrice(pool, word, claims);
    }
    if (!exact && spot != null) out.tokenId = spot;
    out.balance = who ? balance : null;
    out.allowance = who && !pool.native ? allowance : null;
    return claims;
  };

  if (pool.native) {
    const step = { ...buyCall(pool, tokenId, PROBE_BUDGET, PROBE), value: PROBE_BUDGET };
    const sim = await simulate(pool.chainId, { from: PROBE, balance: PROBE_BUDGET * 2n, pre: reads, steps: [step] });
    fill(sim.pre);
    out.block = sim.block;
    if (out.empty || out.missing) return out;
    if (!sim.steps[0].ok) { out.error = sim.steps[0].error; return out; }
    const got = value(step, sim.steps[0]);
    out.pay = exact ? got : got?.[1];
    if (!exact && got) out.tokenId = got[0];
    out.ok = typeof out.pay === 'bigint' && out.pay > 0n && out.tokenId != null;
    return out;
  }

  if (pool.chainId !== HOME) { out.unsupported = true; return out; }
  const first = await simulate(HOME, { from: PROBE, pre: reads });
  const claims = fill(first.pre);
  out.block = first.block;
  if (out.empty || out.missing || claims == null || out.tokenId == null) return out;
  const ask = C(HOME_QUOTER, QUOTER_ABI, 'quoteExactOutputSingle', [{ poolKey: pool.key, zeroForOne: !claimIs0(pool), exactAmount: claims, hookData: '0x' }]);
  const second = await simulate(HOME, { from: PROBE, pre: [ask] });
  if (!second.pre[0].ok) { out.error = second.pre[0].error; return out; }
  out.pay = value(ask, second.pre[0])?.[0] ?? 0n;
  out.ok = out.pay > 0n;
  return out;
}

// ───────────────────────── plans ─────────────────────────

/** The pools of `collection` on `chainId`, and the ones among them quoted in `tok`. Refuses when there are none. */
async function poolsFor(chainId, collection, tok, { strict = true } = {}) {
  let pools;
  try { pools = await poolsOn(chainId); } catch { throw fail('UPSTREAM', 503, 'The pools could not be read just now. Try again in a moment.'); }
  const all = pools.filter((p) => same(p.collection, collection));
  if (!all.length) throw fail('NO_POOL', 404, `There is no staccpad pool for this collection on ${chainName(chainId)}.`);
  const mine = all.filter((p) => (tok.address === 'NATIVE' ? p.native : !p.native && same(p.quote.address, tok.address)));
  if (!mine.length && strict) {
    const asked = clean(String(tok.symbol ?? ''), 16) || 'that token';
    throw fail('NO_POOL', 404, `${all[0].name} trades for ${orList([...new Set(all.map((p) => p.quote.symbol))])} here, not ${asked}.`);
  }
  return { all, mine };
}

/** The pool's quote as the page's Token, keeping the logo and tags the page already had for it. */
function tokenFor(pool, thing) {
  const logo = typeof thing?.logo === 'string' ? imageUrl(thing.logo) : null;
  const tags = Array.isArray(thing?.tags) ? thing.tags.filter((t) => typeof t === 'string').slice(0, 8).map((t) => clean(t, 24)) : [];
  return {
    chainId: pool.chainId, address: pool.native ? 'NATIVE' : pool.quote.address, symbol: pool.quote.symbol,
    name: clean(String(thing?.name ?? ''), 64) || pool.quote.symbol, decimals: pool.quote.decimals, logo,
    tags: tags.length ? tags : pool.native ? ['native'] : [],
  };
}

const leg = (kind, chainId, label, { input = null, output = null, note = null, call = null, wei = 0n }) => ({
  kind, chainId, label, in: input, out: output, feeNative: null, note, exec: { type: 'tx', tx: call ? tx(chainId, call, wei) : null },
});
/** The legs exactly as they will be sent, for one more run before they are handed over. */
const asSteps = (legs) => legs.map((l) => ({ to: l.exec.tx.to, data: l.exec.tx.data, value: l.exec.tx.value }));

const checkedFact = (owner, legs, sim) => (owner
  ? { label: 'Checked', value: 'Tried on the live chain for this wallet', sub: `${legs.length === 1 ? 'The step' : `All ${legs.length} steps, in order,`} went through${sim.block ? ` at block ${sim.block}` : ''}.`, tone: 'ok' }
  : { label: 'Checked', value: 'Priced by trying it on the live chain', sub: 'Connect a wallet and the steps are built and tried for it.' });

/** How far a trade lands from the pool's last price, as a warning when it is far. */
function drift(lastPrice, amount, selling) {
  if (lastPrice == null || lastPrice <= 0n) return { bps: 0, tone: undefined };
  const bps = Number(selling ? ((lastPrice - amount) * 10_000n) / lastPrice : ((amount - lastPrice) * 10_000n) / lastPrice);
  return { bps, tone: bps > 2_500 ? 'danger' : bps > 500 ? 'warn' : undefined };
}

async function planSell(nft, tok, owner, slippage) {
  const chainId = Number(nft.chainId);
  const tokenId = tokenIdOf(nft.tokenId);
  // the token in the other box is a preference, not a condition: a sale goes to whichever pool can take the whole NFT
  const { all, mine } = await poolsFor(chainId, nft.collection, tok, { strict: false });
  const collection = all[0].collection;
  const name = `${all[0].name} #${tokenId}`;

  const ownerOf = C(collection, ERC721_ABI, 'ownerOf', [tokenId]);
  const holder = value(ownerOf, (await simulate(chainId, { from: PROBE, pre: [ownerOf] })).pre[0]);
  if (!isAddress(holder)) throw fail('NOT_FOUND', 404, `${name} does not exist on ${chainName(chainId)}.`);
  if (owner && !same(holder, owner)) throw fail('NOT_OWNER', 400, `This wallet does not hold ${name}.`);
  if (all.some((p) => same(p.vault, holder))) throw fail('NOT_OWNER', 400, `${name} is already in the pool.`);
  const seller = owner ? getAddress(owner) : getAddress(holder); // with no wallet yet, price it as whoever holds it

  const sellInto = (pools) => Promise.all(pools.map((p) => trySell(p, tokenId, seller).catch((e) => ({ pool: p, ok: false, thrown: e }))));
  let tries = await sellInto(mine);
  let best = tries.filter(sells).sort((a, b) => (a.received > b.received ? -1 : a.received < b.received ? 1 : 0))[0];
  if (!best) {
    // no pool in the asked token can pay: every other pool of the collection is tried. Amounts in different tokens
    // cannot be ranked against each other here, so the gas token's pool leads, then whichever pays.
    const rest = all.filter((p) => !mine.includes(p));
    if (rest.length) {
      const more = await sellInto(rest);
      // only the gas token's pools are a safe second choice: they can be ranked against each other, and the best
      // of them wins. A pool quoted in some third token is never picked on the seller's behalf.
      best = more.filter((t) => sells(t) && t.pool.native).sort((a, b) => (a.received > b.received ? -1 : a.received < b.received ? 1 : 0))[0];
      tries = [...tries, ...more];
    }
  }
  if (!best) {
    if (tries.some((t) => t.ok)) throw fail('POOL_CANNOT_PAY', 404, `The ${all[0].name} pool cannot pay for a whole NFT right now.`);
    const unchecked = tries.find((t) => t.thrown);
    if (unchecked) throw unchecked.thrown?.planError ? unchecked.thrown : UNCHECKED();
    throw refusal(tries[0].error);
  }

  const pool = best.pool;
  const sym = pool.quote.symbol, dec = pool.quote.decimals;
  const token = tokenFor(pool, mine.includes(pool) ? tok : null);
  const min = (best.paid * BigInt(Math.round((100 - slippage) * 100))) / 10_000n;
  const build = (withTx, approved) => [
    ...(approved ? [] : [leg('approve', chainId, `Let the pool take ${name}`, {
      note: 'Only this one NFT. Nothing else in the wallet is touched.', call: withTx ? approveNft(pool, tokenId) : null,
    })]),
    leg('sell', chainId, `Sell ${name} for ${human(best.received, dec)} ${sym}`, {
      output: { token, amount: best.received.toString() },
      note: `${approved ? '' : 'Needs the step before it to land first. '}You get at least ${human((min * best.received) / best.paid, dec)} ${sym}, or the sale does not happen.`,
      call: withTx ? sellCall(pool, tokenId, min, seller) : null,
    }),
  ];

  let legs = build(false, false);
  let run = best;
  let received = best.received;
  if (owner) {
    legs = build(true, best.approved);
    const held = balanceCall(pool, seller);
    const routerClaims = C(pool.vault, ERC20_ABI, 'balanceOf', [pool.router]);
    const sim = await simulate(chainId, { from: seller, pre: [held, routerClaims], steps: asSteps(legs), post: [held, routerClaims, ownerOf] });
    const bad = sim.steps.find((s) => !s.ok);
    if (bad) throw refusal(bad.error);
    const [before, claimsBefore] = [value(held, sim.pre[0]), value(routerClaims, sim.pre[1])];
    const [after, claimsAfter, nowHeldBy] = [value(held, sim.post?.[0]), value(routerClaims, sim.post?.[1]), value(ownerOf, sim.post?.[2])];
    if (before == null || after == null || claimsBefore == null || claimsAfter == null) throw UNCHECKED();
    if (claimsAfter !== claimsBefore || after <= before) throw fail('POOL_CANNOT_PAY', 404, `The ${pool.name} pool cannot pay for a whole NFT right now.`);
    if (!same(nowHeldBy, pool.vault)) throw fail('WOULD_REVERT', 400, 'The chain refused this when it was tried: the NFT did not reach the pool.');
    received = after - before;
    run = sim;
    // the label and the amount are what this exact run delivered
    legs[legs.length - 1].label = `Sell ${name} for ${human(received, dec)} ${sym}`;
    legs[legs.length - 1].out = { token, amount: received.toString() };
  }

  const floor = (min * best.received) / best.paid; // the least that can arrive: the router's minimum, less any cut the token takes
  const d = drift(best.lastPrice, received, true);
  const warnings = [];
  if (d.tone) warnings.push(`The pool's last price was ${human(best.lastPrice, dec)} ${sym}, but it can only pay ${human(received, dec)} ${sym} for a whole NFT right now. That is ${pct(d.bps)} less.`);
  if (best.received < best.paid) warnings.push(`${sym} takes a cut of every transfer, so less arrives than the pool sends.`);

  return {
    routing: 'PLAN', op: id,
    headline: `Sell ${name} for ${human(received, dec)} ${sym}`,
    pay: { label: name, amount: null, token: null },
    receive: { label: sym, amount: received.toString(), token },
    legs,
    facts: [
      { label: 'You get', value: `${human(received, dec)} ${sym}`, sub: `At least ${human(floor, dec)} ${sym}, or the sale does not happen.`, tone: d.tone ?? 'ok' },
      { label: 'Pool', value: `${pool.name} for ${sym}`, sub: `${count(best.inventory, 'NFT', 'NFTs')} inside right now.` },
      { label: 'Fees', value: `${pct(pool.fee / 100)} pool fee`, sub: 'Already taken out of what you get.' },
      checkedFact(owner, legs, run),
    ],
    warnings,
    contracts: [
      { chainId, address: pool.collection, name: `${pool.name} collection` },
      { chainId, address: pool.router, name: 'staccpad pool router' },
    ],
  };
}

async function planBuy(tok, nft, owner, slippage) {
  const chainId = Number(nft.chainId);
  const wanted = nft.tokenId == null ? null : tokenIdOf(nft.tokenId);
  const { all, mine } = await poolsFor(chainId, nft.collection, tok);
  const title = all[0].name;
  const buyer = owner ? getAddress(owner) : null;

  const tries = await Promise.all(mine.map((p) => tryBuy(p, wanted, buyer).catch((e) => ({ pool: p, ok: false, thrown: e }))));
  const best = tries.filter((t) => t.ok).sort((a, b) => (a.pay < b.pay ? -1 : a.pay > b.pay ? 1 : 0))[0];
  if (!best) {
    const unchecked = tries.find((t) => t.thrown);
    if (tries.every((t) => t.thrown)) throw unchecked.thrown?.planError ? unchecked.thrown : UNCHECKED();
    if (wanted != null && tries.every((t) => t.thrown || t.missing || t.empty)) throw fail('NOT_IN_POOL', 404, `${title} #${wanted} is not in the pool right now.`);
    if (tries.every((t) => t.thrown || t.empty)) throw fail('EMPTY_VAULT', 404, `The ${title} pool has no NFTs left to buy right now.`);
    if (tries.every((t) => t.thrown || t.unsupported)) throw fail('NO_POOL', 404, `Buying ${title} with ${mine[0].quote.symbol} is not offered on ${chainName(chainId)} yet.`);
    const refused = tries.find((t) => t.error);
    // a pool that cannot hand over a whole NFT's claims leaves the router short of them (or the Quoter says so)
    if (!refused || SHORT_OF_CLAIMS.test(rawReason(refused.error))) throw fail('POOL_CANNOT_FILL', 404, `The ${title} pool does not have a whole NFT for sale right now.`);
    throw refusal(refused.error);
  }

  const pool = best.pool;
  const sym = pool.quote.symbol, dec = pool.quote.decimals;
  const token = tokenFor(pool, tok);
  const thing = wanted == null ? `the floor ${title}` : `${title} #${wanted}`;
  // the same arithmetic the page uses for its spending cap, so the two can never disagree by a unit
  const max = (best.pay * BigInt(Math.round((100 + slippage) * 100))) / 10_000n;
  const needsApproval = !pool.native && !(buyer && best.allowance != null && best.allowance >= max);
  const build = (withTx) => [
    ...(needsApproval ? [leg('approve', chainId, `Let the pool take up to ${human(max, dec, true)} ${sym}`, {
      note: 'Exactly this much and no more.', call: withTx ? approveToken(pool, max) : null,
    })] : []),
    leg('buy', chainId, `Buy ${thing} for ${human(best.pay, dec, true)} ${sym}`, {
      input: { token, amount: best.pay.toString() },
      note: `${needsApproval ? 'Needs the step before it to land first. ' : ''}You pay at most ${human(max, dec, true)} ${sym}. Whatever is not used comes straight back.`,
      call: withTx ? buyCall(pool, wanted, max, buyer) : null, wei: pool.native ? max : 0n,
    }),
  ];

  let legs = build(false);
  let run = best;
  if (buyer) {
    if (best.balance != null && best.balance < max) {
      throw fail('INSUFFICIENT_BALANCE', 400, `This needs up to ${human(max, dec, true)} ${sym} in the wallet and it holds ${human(best.balance, dec)} ${sym}.`);
    }
    legs = build(true);
    const held = balanceCall(pool, buyer);
    const nowOwner = C(pool.collection, ERC721_ABI, 'ownerOf', [best.tokenId]);
    const sim = await simulate(chainId, { from: buyer, pre: [held], steps: asSteps(legs), post: [held, nowOwner] });
    if (sim.short) throw fail('INSUFFICIENT_BALANCE', 400, `This needs up to ${human(max, dec, true)} ${sym} in the wallet, and it does not hold that much.`);
    const bad = sim.steps.find((s) => !s.ok);
    if (bad) throw refusal(bad.error);
    if (sim.post) {
      // the wallet holds the NFT afterwards, and it cost no more than the cap
      const [before, after, heldBy] = [value(held, sim.pre[0]), value(held, sim.post[0]), value(nowOwner, sim.post[1])];
      if (before == null || after == null) throw UNCHECKED();
      if (!same(heldBy, buyer)) throw fail('WOULD_REVERT', 400, 'The chain refused this when it was tried: the NFT did not reach the wallet.');
      if (before - after > max) throw fail('WOULD_REVERT', 400, 'The chain refused this when it was tried: it would cost more than the limit.');
    }
    run = sim;
  }

  const d = drift(best.lastPrice, best.pay, false);
  const warnings = [];
  if (d.tone) warnings.push(`The pool's last price was ${human(best.lastPrice, dec)} ${sym}, but a whole NFT costs ${human(best.pay, dec, true)} ${sym} right now. That is ${pct(d.bps)} more.`);
  const fees = [`${pct(pool.fee / 100)} pool fee`];
  if (best.feeBps > 0) fees.push(`${pct(best.feeBps)} creator and platform fees`);
  if (best.premiumBps > 0) fees.push(`${pct(best.premiumBps)} for choosing this exact one`);

  return {
    routing: 'PLAN', op: id,
    headline: `Buy ${thing} for ${human(best.pay, dec, true)} ${sym}`,
    pay: { label: sym, amount: best.pay.toString(), token },
    receive: { label: wanted == null ? `1 ${title} (the floor one)` : `${title} #${wanted}`, amount: null, token: null },
    legs,
    facts: [
      { label: 'You pay', value: `${human(best.pay, dec, true)} ${sym}`, sub: `At most ${human(max, dec, true)} ${sym}. Whatever is not used comes straight back.`, tone: d.tone ?? 'ok' },
      wanted == null
        ? { label: 'You get', value: `1 ${title}`, sub: `Next in line is #${best.tokenId}. If someone buys first, you get the one after it.` }
        : { label: 'You get', value: `${title} #${wanted}`, sub: 'This exact one, or nothing happens.' },
      { label: 'In the pool', value: count(best.inventory, 'NFT', 'NFTs') },
      { label: 'Fees', value: orList(fees).replace(' or ', ' and '), sub: 'Already inside the price.' },
      checkedFact(owner, legs, run),
    ],
    warnings,
    contracts: [
      ...(pool.native ? [] : [{ chainId, address: pool.quote.address, name: `${sym} token` }]),
      { chainId, address: pool.router, name: 'staccpad pool router' },
    ],
  };
}

// ───────────────────────── the module contract ─────────────────────────

/** An NFT and a token on one chain this module reads. Which pool, if any, is plan's to find. */
export function match(input, output) {
  if (!input || !output || typeof input !== 'object' || typeof output !== 'object') return false;
  const selling = input.kind === 'nft' && output.kind === 'token';
  if (!selling && !(input.kind === 'token' && output.kind === 'nft')) return false;
  const nft = selling ? input : output, tok = selling ? output : input;
  const chainId = Number(nft.chainId);
  if (!CHAINS.has(chainId) || Number(tok.chainId) !== chainId) return false;
  if (!isAddress(nft.collection) || !(tok.address === 'NATIVE' || isAddress(tok.address))) return false;
  // selling needs an id; on the receive side no id means the floor one
  return selling ? tokenIdOf(nft.tokenId) != null : nft.tokenId == null || tokenIdOf(nft.tokenId) != null;
}

export async function plan({ input, output, owner = null, slippage = 1 } = {}) {
  if (!match(input, output)) throw fail('BAD_REQUEST', 400, 'This needs an NFT on one side and a token on the same chain on the other.');
  if (owner != null && (!isAddress(owner) || same(owner, ZERO))) throw fail('BAD_REQUEST', 400, 'That wallet address is not valid.');
  const s = Number(slippage);
  const tolerance = Number.isFinite(s) && s >= 0 ? Math.min(50, s) : 1;
  return input.kind === 'nft' ? planSell(input, output, owner, tolerance) : planBuy(input, output, owner, tolerance);
}

// ───────────────────────── things for the picker ─────────────────────────

/** Gas token first, then tokens staccpad vouches for, then the rest by name. */
const rankOf = (pool) => (pool.native ? 0 : VOUCHED.some((a) => same(a, pool.quote.address)) ? 1 : 2);
const byQuote = (a, b) => rankOf(a.pool) - rankOf(b.pool) || a.pool.quote.symbol.localeCompare(b.pool.quote.symbol);
/** What the other box could hold for this thing: the page can drop the first one straight in. */
const quoteHint = (pool, amount) => ({ chainId: pool.chainId, address: pool.native ? 'NATIVE' : pool.quote.address, symbol: pool.quote.symbol, decimals: pool.quote.decimals, amount: amount.toString() });
/** One row per quote token: the best of several pools that trade the same pair. */
function bestPerQuote(rows, better) {
  const by = new Map();
  for (const r of rows) {
    const k = r.pool.native ? 'NATIVE' : r.pool.quote.address.toLowerCase();
    if (!by.has(k) || better(r, by.get(k))) by.set(k, r);
  }
  return [...by.values()].sort(byQuote);
}

/** Every pool on a chain whose floor can be bought right now, with what it costs. Twenty seconds fresh. */
const buyBoards = keyed({
  ttl: 20_000,
  max: 32,
  load: async (key) => {
    const chainId = Number(key);
    const pools = await poolsOn(chainId);
    if (chainId !== HOME) {
      const tries = await Promise.all(pools.filter((p) => p.native).map((p) => tryBuy(p, null, null).catch(() => null)));
      return tries.filter((t) => t?.ok).map((t) => ({ pool: t.pool, inventory: t.inventory, pay: t.pay }));
    }
    // Robinhood has a hundred pools: one batch for the vaults, one for the canonical Quoter (it refuses a pool
    // that cannot fill the whole amount, which is exactly the pools to leave out)
    const vaults = [...new Set(pools.map((p) => p.vault))];
    const v = await multicall(HOME, vaults.flatMap((a) => [C(a, VAULT_ABI, 'inventoryCount'), C(a, VAULT_ABI, 'floorCost')]));
    if (vaults.length && v.every((x) => x == null)) throw new Error('vaults unreadable'); // not "every pool is empty"
    const state = new Map(vaults.map((a, i) => [a, { inventory: Number(v[i * 2] ?? 0n), cost: v[i * 2 + 1] }]));
    const open = pools.filter((p) => state.get(p.vault).inventory > 0 && state.get(p.vault).cost != null);
    const asks = await multicall(HOME, open.map((p) => C(HOME_QUOTER, QUOTER_ABI, 'quoteExactOutputSingle', [
      { poolKey: p.key, zeroForOne: !claimIs0(p), exactAmount: state.get(p.vault).cost, hookData: '0x' },
    ])), { chunk: 20 });
    return open.map((p, i) => ({ pool: p, inventory: state.get(p.vault).inventory, pay: asks[i]?.[0] ?? 0n })).filter((r) => r.pay > 0n);
  },
});

async function buyable(chainId, input) {
  const rows = await buyBoards.get(chainId);
  const paying = input?.kind === 'token' && Number(input.chainId) === chainId && (input.address === 'NATIVE' || isAddress(input.address)) ? input : null;
  const by = new Map();
  for (const r of rows) {
    if (paying && !(paying.address === 'NATIVE' ? r.pool.native : !r.pool.native && same(r.pool.quote.address, paying.address))) continue;
    const k = r.pool.collection.toLowerCase();
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  return [...by.values()].map((list) => {
    const quotes = bestPerQuote(list, (a, b) => a.pay < b.pay);
    const { pool, pay, inventory } = quotes[0];
    return {
      kind: 'nft', id: `nft:${chainId}:${pool.collection.toLowerCase()}:floor`,
      label: pool.name, sub: `Floor for about ${human(pay, pool.quote.decimals, true)} ${pool.quote.symbol} · ${inventory} in the pool`,
      chainId, collection: pool.collection, tokenId: null, name: `${pool.name} floor`, image: pool.image, collectionName: pool.name,
      quotes: quotes.map((q) => quoteHint(q.pool, q.pay)),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

const PER_COLLECTION = 250;

/** staccpad's index of a Robinhood wallet's NFTs, by collection. It stops at 250 a collection and can lag the chain. */
const walletLists = keyed({
  ttl: 30_000,
  max: 200,
  load: async (owner) => {
    const j = await fetchJson(`${STACCPAD}/api/wallet/${owner}/nfts`, 6_000);
    if (!Array.isArray(j?.nfts)) throw new Error('wallet list unreadable');
    const by = new Map();
    for (const n of j.nfts) {
      if (!isAddress(n?.token) || tokenIdOf(n.id) == null) continue;
      const k = n.token.toLowerCase();
      if (!by.has(k)) by.set(k, []);
      by.get(k).push({ id: String(n.id), name: clean(n.name ?? '', 64), image: imageUrl(n.image) });
    }
    return by;
  },
});

const scanGate = gateOf(3); // a scan is thousands of reads: it never takes every lane from a plan being priced
const scans = new Map(); // `${chainId}:${owner}:${collection}` → { at, balance, ids, pending }
const SCAN_FRESH_MS = 10 * 60_000;
const SCAN_WAIT_MS = 2_500;
const LATE = Symbol('late');

/**
 * `ownerOf` over the whole supply: the only complete answer for a collection that cannot be enumerated (none of
 * staccpad's are). It takes seconds, so what it finds is remembered for ten minutes and re-checked, not re-scanned.
 */
function scanHeld(chainId, pool, owner, balance) {
  const key = `${chainId}:${owner}:${pool.collection}`.toLowerCase();
  let s = scans.get(key);
  if (!s) {
    if (scans.size >= 2_000) scans.delete(scans.keys().next().value);
    scans.set(key, s = { at: 0, balance: null, ids: [], pending: null });
  }
  s.pending ||= (async () => {
    try {
      let [supply] = await multicall(chainId, [C(pool.collection, ERC721_ABI, 'totalSupply')]);
      // a mirror on another chain has no totalSupply; its ids are the original collection's
      if (supply == null && pool.homeCollection) [supply] = await multicall(HOME, [C(pool.homeCollection, ERC721_ABI, 'totalSupply')]);
      if (supply != null && supply <= 20_000n) {
        // ids start at 0 or 1, and burns leave gaps: a miss is just skipped
        const ids = Array.from({ length: Number(supply) + 2 }, (_, i) => BigInt(i));
        const parts = [];
        for (let i = 0; i < ids.length; i += 1_000) parts.push(ids.slice(i, i + 1_000));
        const owners = (await Promise.all(parts.map((part) => scanGate(() => multicall(chainId, part.map((i) => C(pool.collection, ERC721_ABI, 'ownerOf', [i])), { chunk: 1_000, now: true }))))).flat();
        s.ids = ids.filter((_, i) => same(owners[i], owner)).map(String);
      }
      s.at = Date.now();
      s.balance = balance;
      return s.ids;
    } finally {
      s.pending = null;
    }
  })();
  return s.pending;
}
const scanned = (chainId, pool, owner) => scans.get(`${chainId}:${owner}:${pool.collection}`.toLowerCase());

/**
 * A wallet's NFTs that a pool will buy whole right now, with what each pays. Twenty seconds fresh.
 * Which ids the wallet holds: staccpad's index plus what an earlier scan found, each one confirmed by the chain
 * (the index lags and stops at 250). When the chain counts more than that, the collection is scanned; a scan
 * that is not back in a few seconds finishes behind the answer and shows up in the next one.
 */
const sellBoards = keyed({
  ttl: 20_000,
  max: 600,
  load: async (key) => {
    const [chain, owner] = key.split(':');
    const chainId = Number(chain);
    const by = new Map();
    for (const p of await poolsOn(chainId)) {
      const k = p.collection.toLowerCase();
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(p);
    }
    const collections = [...by.values()].map((list) => list[0]);
    const [listed, balances] = await Promise.all([
      chainId === HOME ? walletLists.get(owner).catch(() => new Map()) : new Map(),
      multicall(chainId, collections.map((p) => C(p.collection, ERC721_ABI, 'balanceOf', [owner])), { now: true }),
    ]);
    if (collections.length && balances.every((b) => b == null)) throw new Error('balances unreadable'); // not "holds nothing"
    const holding = collections.map((p, i) => ({ p, balance: balances[i] ?? 0n })).filter((c) => c.balance > 0n);
    const claimed = holding.flatMap(({ p }) => {
      const fromIndex = (listed.get(p.collection.toLowerCase()) || []).slice(0, PER_COLLECTION);
      const seen = new Set(fromIndex.map((t) => t.id));
      const fromScan = (scanned(chainId, p, owner)?.ids || []).filter((x) => !seen.has(x)).map((x) => ({ id: x, name: '', image: null }));
      return [...fromIndex, ...fromScan].slice(0, PER_COLLECTION).map((t) => ({ p, t }));
    });
    const owners = await multicall(chainId, claimed.map(({ p, t }) => C(p.collection, ERC721_ABI, 'ownerOf', [BigInt(t.id)])), { now: true });

    const things = [];
    await Promise.all(holding.map(async ({ p, balance }) => {
      const tokens = claimed.filter((c, i) => c.p === p && same(owners[i], owner)).map((c) => c.t);
      // every NFT of a collection mints the same claims, so one of them prices them all: start on that first
      const price = (sample) => Promise.all(by.get(p.collection.toLowerCase()).map((pool) => trySell(pool, BigInt(sample), owner).catch(() => null)));
      const tries = tokens.length ? price(tokens[0].id) : null;
      // scan when the chain counts more than is known here, unless a recent scan already saw this same count
      const last = scanned(chainId, p, owner);
      const settled = last?.at && last.balance === balance && Date.now() - last.at < SCAN_FRESH_MS;
      if (BigInt(tokens.length) < balance && tokens.length < PER_COLLECTION && !settled) {
        const scan = scanHeld(chainId, p, owner, balance).catch(() => []);
        const more = await within(scan, SCAN_WAIT_MS, LATE);
        if (more === LATE) scan.then((ids) => { if (ids.length) sellBoards.drop(key); }); // the next answer has them
        const known = new Set(tokens.map((t) => t.id));
        for (const tokenId of more === LATE ? [] : more) if (!known.has(tokenId) && tokens.length < PER_COLLECTION) tokens.push({ id: tokenId, name: '', image: null });
      }
      if (!tokens.length) return;
      const quotes = bestPerQuote((await (tries ?? price(tokens[0].id))).filter((t) => t && sells(t)), (a, b) => a.received > b.received);
      if (!quotes.length) return;
      const { pool, received } = quotes[0];
      for (const t of tokens) {
        const label = `${pool.name} #${t.id}`;
        things.push({
          kind: 'nft', id: `nft:${chainId}:${pool.collection.toLowerCase()}:${t.id}`,
          label, sub: `Sells for about ${human(received, pool.quote.decimals)} ${pool.quote.symbol}`,
          chainId, collection: pool.collection, tokenId: t.id, name: t.name || label, image: t.image ?? pool.image, collectionName: pool.name,
          quotes: quotes.map((q) => quoteHint(q.pool, q.received)),
        });
      }
    }));
    return things.sort((a, b) => a.collectionName.localeCompare(b.collectionName) || (BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : 1));
  },
});

/**
 * `nft-owned`: NFTs in `owner`'s wallet that a pool will buy, with the token and amount in `sub`.
 * `nft-buyable`: collections whose floor can be bought, with the price in `sub`; when `input` is a token, only
 * the ones it can pay for, priced in it. With no `chainId`, every chain is asked and the slow ones are left out.
 */
export async function catalog(kind, { owner = null, chainId = null, input = null } = {}) {
  if (kind !== 'nft-owned' && kind !== 'nft-buyable') return [];
  if (kind === 'nft-owned' && !isAddress(owner)) return [];
  const paying = kind === 'nft-buyable' && input?.kind === 'token' && CHAINS.has(Number(input.chainId)) ? Number(input.chainId) : null;
  const chains = chainId != null ? [Number(chainId)].filter((c) => CHAINS.has(c)) : paying != null ? [paying] : [...CHAINS.keys()];
  const lists = await Promise.all(chains.map((c) => within(
    (kind === 'nft-owned' ? sellBoards.get(`${c}:${getAddress(owner)}`) : buyable(c, input)).catch(() => []),
    chains.length > 1 && c !== HOME ? 6_000 : 10_500,
    [],
  )));
  return lists.flat();
}

/** GET /api/op/pools/board?chainId=4663: the pools served on a chain and what each floor costs, for a look inside. */
export function register(app) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/op/pools/board', async (req, res) => {
    const chainId = Number(req.query?.chainId ?? HOME);
    if (!CHAINS.has(chainId)) return res.status(404).json({ errorCode: 'NO_POOL', detail: 'No pools are read on that chain.' });
    try {
      const [pools, floors] = await Promise.all([poolsOn(chainId), buyBoards.get(chainId).catch(() => [])]);
      const floor = new Map(floors.map((f) => [f.pool.poolId, f]));
      res.set('Cache-Control', 'no-store').json({
        chainId,
        pools: pools.map((p) => ({
          poolId: p.poolId, collection: p.collection, name: p.name, vault: p.vault, router: p.router, source: p.source,
          quote: { address: p.native ? 'NATIVE' : p.quote.address, symbol: p.quote.symbol, decimals: p.quote.decimals },
          floor: floor.has(p.poolId) ? { amount: floor.get(p.poolId).pay.toString(), inventory: floor.get(p.poolId).inventory } : null,
        })),
      });
    } catch {
      res.status(503).json({ errorCode: 'UPSTREAM', detail: 'The pools could not be read just now. Try again in a moment.' });
    }
  });
}
