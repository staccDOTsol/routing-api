// ETH in, a mystery NFT out. Through staccpad's gacha desks.
//
// A desk is a peg vault (nft-range src/peg/PegVaultV2.sol): it holds one collection's NFTs and issues a claim token
// against them. `pull` locks one NFT's worth of claims and pins the block; two Ethereum blocks later `reveal`
// picks an NFT with that block's hash and sends it. The GachaHelper (src/peg/GachaHelper.sol) does the first half
// in ETH: it buys exactly the claims a pull costs from the vault's own ETH pool, pulls for the sender, and returns
// the ETH it did not need, all in one transaction.
//
//   ETH -> mystery   helper.pull{value: price + slippage}(vault, poolKey)      then, not from here: vault.reveal(pullId)
//
// The second half is why this module can say no. A pull that nobody reveals delivers nothing. staccpad runs a
// keeper that reveals every pull; this page cannot (the pull's id and the block it waits for do not exist when the
// plan is made, and the page runs a plan's steps back to back). So a pull is only sold while that keeper says it
// is running, has a key and has gas. Otherwise the desks are listed as paused and the plan is a refusal.
//
// What this module will not do:
//   * return a transaction it has not run for that wallet on the chain's current state (eth_simulateV1);
//   * trust the request about a desk: the vault and its pool key are read from staccpad's factory, never from the
//     request, and the helper is checked to swap on the same PoolManager as the factory;
//   * send more ETH than the price plus the slippage the page asked for (the page refuses more than that itself).
//
// Chain reads go to dRPC with the server key when there is one, and through the owner's dRPC proxy otherwise.
// Nothing is ever sent from here.
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, toFunctionSelector, toHex } from 'viem';

export const id = 'gacha';

// ───────────────────────── fixed facts ─────────────────────────

const STACCPAD = 'https://staccpad.fun';
const PROXY = `${STACCPAD}/rpc`;
const HOME = 4663;
const KEY_SHAPE = /^[A-Za-z0-9_-]{8,200}$/;
/** dRPC's own load balancer, reached with the server key. It stays inside this file: never logged, never returned. */
const DIRECT = KEY_SHAPE.test(process.env.DRPC_KEY || '') ? `https://lb.drpc.live/robinhood/${process.env.DRPC_KEY}` : null;

/** Peg factory v3 (vault v2, the one with pulls), the helper, and Robinhood's canonical v4 Quoter (staccpad peg.ts). */
const FACTORY = '0x71FF4720E877fbbC013AE9ad6a0Eb32461b98470';
const HELPER = '0xAdb7d3DD08f6caE09c76DE9C36AA88eeF55703D0';
const QUOTER = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ZERO = '0x0000000000000000000000000000000000000000';
/** A stand-in sender for reads that must not come from a cache. */
const PROBE = '0x000000000000000000000000000000000000dEaD';

const KEEPER_URL = `${STACCPAD}/api/gacha/keeper`;
const MARKETS_URL = `${STACCPAD}/api/markets`;
/** The keeper counts as running when it looked at the desks this recently and can pay for a handful of reveals. */
const KEEPER_FRESH_MS = 5 * 60_000;
const KEEPER_MIN_GAS = 20_000_000_000_000n;
const MAX_DESKS = 400;

const ETH = {
  chainId: HOME, address: 'NATIVE', symbol: 'ETH', name: 'Ether', decimals: 18,
  logo: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png', tags: ['native'],
};

const KEY = 'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }';
const FACTORY_ABI = parseAbi([
  KEY,
  'function allVaultsLength() view returns (uint256)',
  'function allVaults(uint256) view returns (address)',
  'function poolsOf(address vault) view returns (bytes32[])',
  'function getPoolKey(bytes32 poolId) view returns (PoolKey)',
  'function poolManager() view returns (address)',
]);
const VAULT_ABI = parseAbi([
  'function collection() view returns (address)',
  'function name() view returns (string)',
  'function inventoryCount() view returns (uint256)',
  'function inventoryAt(uint256 index) view returns (uint256)',
  'function pullCost() view returns (uint256)',
  'function mintUnit() view returns (uint256)',
  'function taxBps() view returns (uint16)',
  'function pullCount() view returns (uint256)',
  'function openPulls() view returns (uint256[])',
  'function pulls(uint256 pullId) view returns (address owner, address receiver, uint96 commitBlock, uint256 escrow, uint256 fees, bool settled)',
]);
const HELPER_ABI = parseAbi([
  KEY,
  'function manager() view returns (address)',
  'function free(address vault) view returns (uint256)',
  'function pull(address vault, PoolKey key) payable returns (uint256 pullId)',
]);
const QUOTER_ABI = parseAbi([
  KEY,
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  // not a view on chain (it runs the swap and undoes it); a simulated call is exactly what it is for
  'function quoteExactOutputSingle(QuoteExactSingleParams params) returns (uint256 amountIn, uint256 gasEstimate)',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
const ERC721_ABI = parseAbi(['function name() view returns (string)']);
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
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** Log lines never carry the key, whatever ends up in them. */
const redact = (s) => (DIRECT ? String(s).split(process.env.DRPC_KEY).join('[key]') : String(s));

/** A refusal the page can show as it is: one plain sentence in `detail`. */
const fail = (code, status, detail) => Object.assign(new Error(detail), { planError: true, code, detail, status });
const UNCHECKED = () => fail('SIM_UNAVAILABLE', 503, 'This could not be tried on the chain just now, so it is not offered. Try again in a moment.');
const UPSTREAM = () => fail('UPSTREAM', 503, 'The mystery desks could not be read just now. Try again in a moment.');

/**
 * One cached value, one refresh at a time. A failed refresh keeps the last good copy. With `staleOk`, a copy that
 * is past `ttl` but younger than that is handed over at once while the refresh runs behind it.
 */
function cached({ ttl, load, staleOk = 0 }) {
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
      if (Date.now() - at < staleOk) { refresh().catch(() => {}); return value; }
      try { return await refresh(); } catch { return value; }
    },
  };
}

/** At most `max` of these at once. The upstream is shared with the live site. */
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
      const j = await post(PROXY, body, 9_000, false);
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
 * Run calls in order, as `from`, on top of the chain's current state, and send nothing (eth_simulateV1). `pre`
 * and `post` are reads around the `steps`. Each row is { ok, data, error }. When the node cannot do this, the
 * answer is a refusal, never a guess.
 */
async function simulate({ from, pre = [], steps = [], post = [] }) {
  const wire = (c) => ({ from, to: c.to, data: c.data, ...(c.value && BigInt(c.value) > 0n ? { value: toHex(BigInt(c.value)) } : {}) });
  const all = [...pre, ...steps, ...post];
  let res;
  try {
    res = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: all.map(wire) }], validation: false }, 'latest']);
  } catch (e) {
    if (e?.rpc && /insufficient (funds|balance)/i.test(e.rpc.message)) throw fail('NOT_ENOUGH', 400, 'This wallet does not have enough ETH for that.');
    throw UNCHECKED();
  }
  const rows = res?.[0]?.calls;
  if (!Array.isArray(rows) || rows.length !== all.length) throw UNCHECKED();
  const out = rows.map((c) => ({ ok: c?.status === '0x1', data: typeof c?.returnData === 'string' ? c.returnData : '0x', error: c?.status === '0x1' ? null : (c?.error || { message: 'execution reverted' }) }));
  const a = pre.length, b = a + steps.length;
  return { pre: out.slice(0, a), steps: out.slice(a, b), post: out.slice(b), block: Number(BigInt(res[0].number ?? 0)) };
}

/** Reads on the chain's state right now, decoded; a failed read is null. Throws when the chain cannot be asked. */
async function readLive(specs, chunk = 60) {
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

// what a contract said when it refused, in words. Revert strings are the helper's own; custom errors go by selector.
const errors = (...sigs) => new RegExp(`^(${sigs.map((s) => (s.startsWith('0x') ? s : toFunctionSelector(s))).join('|')})`, 'i');
const REASONS = [
  [/^price$/i, 'the price moved past your limit'],
  [errors('Empty()'), 'the desk has no NFTs left'],
  [errors('WrongPool()'), 'this desk has no ETH pool'],
  [/^refund$/i, 'the unspent ETH could not be sent back to this wallet'],
  [errors('NotEnoughLiquidity(bytes32)', 'ERC20InsufficientBalance(address,uint256,uint256)'), 'its pool does not have enough for one pull'],
  [/insufficient funds/i, 'the wallet cannot cover it'],
];
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

// ───────────────────────── the desks ─────────────────────────

/** The vault's own ETH pool: native is currency0, the claim is currency1, and a peg pool has no hook. */
const nativeKey = (keys, vault) => {
  const k = keys.find((x) => x && same(x.currency0, ZERO) && same(x.currency1, vault) && same(x.hooks, ZERO));
  return k ? { currency0: ZERO, currency1: getAddress(vault), fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: ZERO } : null;
};

/**
 * Every vault of the factory, with the things about it that do not change. Read from the chain, never from the
 * feed or the request. A vault with no ETH pool yet is asked again each time, since one can be opened later.
 */
const desks = cached({
  ttl: 5 * 60_000,
  staleOk: 60 * 60_000,
  load: async (prev) => {
    const [length, manager, helperManager] = await multicall([
      C(FACTORY, FACTORY_ABI, 'allVaultsLength'), C(FACTORY, FACTORY_ABI, 'poolManager'), C(HELPER, HELPER_ABI, 'manager'),
    ]);
    if (length == null || !isAddress(manager)) throw new Error('factory unreadable');
    // the helper swaps on one PoolManager for good; a factory on another one is not its factory
    if (!same(manager, helperManager)) throw new Error('the helper and the factory are not on the same PoolManager');
    const list = prev ? [...prev.list] : [];
    const n = Math.min(Number(length), MAX_DESKS);
    if (n > list.length) {
      const at = Array.from({ length: n - list.length }, (_, i) => list.length + i);
      const vaults = await multicall(at.map((i) => C(FACTORY, FACTORY_ABI, 'allVaults', [BigInt(i)])));
      const about = await multicall(vaults.flatMap((v) => (isAddress(v) ? [C(v, VAULT_ABI, 'collection'), C(v, VAULT_ABI, 'name')] : [])));
      let k = 0;
      const fresh = [];
      for (const v of vaults) {
        if (!isAddress(v)) throw new Error('vault list unreadable');
        const [collection, claim] = [about[k], about[k + 1]];
        k += 2;
        if (!isAddress(collection)) throw new Error('vault unreadable');
        fresh.push({ vault: getAddress(v), collection: getAddress(collection), claim: clean(claim ?? '', 64), name: '', key: null });
      }
      const names = await multicall(fresh.map((d) => C(d.collection, ERC721_ABI, 'name')));
      fresh.forEach((d, i) => { d.name = clean(names[i] ?? '', 48) || d.claim.replace(/^v(?=[A-Z])/, '').replace(/\s+Claim$/i, '') || 'NFT'; });
      list.push(...fresh);
    }
    const keyless = list.filter((d) => !d.key);
    const pools = await multicall(keyless.map((d) => C(FACTORY, FACTORY_ABI, 'poolsOf', [d.vault])));
    const asks = keyless.flatMap((d, i) => (pools[i] || []).map((poolId) => ({ d, spec: C(FACTORY, FACTORY_ABI, 'getPoolKey', [poolId]) })));
    const keys = await multicall(asks.map((a) => a.spec));
    for (const d of keyless) d.key = nativeKey(keys.filter((_, i) => asks[i].d === d), d.vault);
    return { list, byVault: new Map(list.map((d) => [d.vault.toLowerCase(), d])) };
  },
});
const allDesks = () => desks.get().catch((e) => {
  console.warn(new Date().toISOString(), 'gacha desks unreadable:', redact(String(e?.message || e).split('\n')[0].slice(0, 160)));
  throw UPSTREAM();
});

/** staccpad's market feed, for the names and pictures it shows. It sometimes answers without `markets`. */
const feed = cached({
  ttl: 60_000,
  staleOk: 30 * 60_000,
  load: async (prev) => {
    const j = await fetchJson(MARKETS_URL, 8_000);
    if (!Array.isArray(j?.markets) || !j.markets.length) {
      if (prev) return prev;
      throw new Error('the feed answered without markets');
    }
    const byVault = new Map();
    const art = new Map();
    for (const m of j.markets) {
      if (!m || typeof m !== 'object') continue;
      const image = imageUrl(m.image);
      if (isAddress(m.collectionAddress) && image?.startsWith('https://') && !art.has(m.collectionAddress.toLowerCase())) art.set(m.collectionAddress.toLowerCase(), image);
      if (m.pool?.kind !== 'peg' || !isAddress(m.vaultAddress)) continue;
      const k = m.vaultAddress.toLowerCase();
      const eth = same(m.pool.quoteToken, ZERO);
      if (!byVault.has(k) || eth) byVault.set(k, { name: clean(String(m.name ?? '').replace(/\s+\/\s+[^/]*$/, ''), 48), image });
    }
    return { byVault, art };
  },
});
/** The feed if it answers in time. It is only names and pictures: nothing waits long for it. */
const faces = (ms) => within(feed.get().catch(() => null), ms, null);
/** What a desk is called and shown as: staccpad's own name and art for it, else what the collection calls itself. */
function faceOf(d, f) {
  const m = f?.byVault.get(d.vault.toLowerCase());
  return { name: m?.name || d.name, image: f?.art.get(d.collection.toLowerCase()) ?? m?.image ?? null };
}

/** The claims the helper has to buy for one pull, exactly as it works it out (GachaHelper._pull). */
function claimsToBuy({ cost, free, tax }) {
  if (free >= cost) return 0n;
  const short = cost - free;
  return tax === 0 ? short : (short * 10_000n) / BigInt(10_000 - tax) + 1n; // it arrives net of the vault's burn
}
const stateSpecs = (d) => [C(d.vault, VAULT_ABI, 'inventoryCount'), C(d.vault, VAULT_ABI, 'pullCost'), C(d.vault, VAULT_ABI, 'taxBps'), C(HELPER, HELPER_ABI, 'free', [d.vault])];
function stateFrom([inventory, cost, tax, free]) {
  if (inventory == null || cost == null || tax == null || free == null || Number(tax) >= 10_000) return null;
  return { inventory: Number(inventory), cost, tax: Number(tax), free };
}
const quoteSpec = (d, claims) => C(QUOTER, QUOTER_ABI, 'quoteExactOutputSingle', [{ poolKey: d.key, zeroForOne: true, exactAmount: claims, hookData: '0x' }]);

/** Is staccpad's keeper revealing pulls right now? Asked of the keeper itself, then of the chain for its gas. */
const keeper = cached({
  ttl: 20_000,
  load: async () => {
    const j = await fetchJson(KEEPER_URL, 4_000);
    const at = Date.now();
    if (!isAddress(j?.keeper)) return { on: false, at };
    if (!(Number.isFinite(Number(j.lastTick)) && at - Number(j.lastTick) < KEEPER_FRESH_MS)) return { on: false, at };
    const gas = BigInt(await rpc('eth_getBalance', [j.keeper, 'latest']));
    return { on: gas >= KEEPER_MIN_GAS, at };
  },
});
/** True only on a fresh yes. A keeper that cannot be asked is a keeper that is not known to be running. */
async function revealing() {
  const k = await keeper.get().catch(() => null);
  return !!k && k.on && Date.now() - k.at < 2 * 60_000;
}

/** Every desk that can sell a pull right now, with its price. Fifteen seconds fresh; up to a minute old it is handed over while it refreshes. */
const board = cached({
  ttl: 15_000,
  staleOk: 60_000,
  load: async () => {
    const [all, f] = await Promise.all([allDesks(), faces(2_500)]);
    const list = all.list.filter((d) => d.key);
    const read = await readNow(list.flatMap(stateSpecs));
    const open = list.map((d, i) => ({ d, s: stateFrom(read.slice(i * 4, i * 4 + 4)) })).filter((x) => x.s && x.s.inventory > 0 && x.s.cost > 0n);
    const asks = open.map((x) => claimsToBuy(x.s));
    const quotes = await readNow(open.map((x, i) => (asks[i] > 0n ? quoteSpec(x.d, asks[i]) : C(x.d.vault, VAULT_ABI, 'pullCost'))));
    const things = [];
    open.forEach(({ d, s }, i) => {
      const price = asks[i] === 0n ? 0n : quotes[i]?.[0];
      if (price == null) return; // its pool cannot sell one pull's worth right now: not on offer
      const { name, image } = faceOf(d, f);
      things.push({
        kind: 'mystery', id: `gacha:${HOME}:${d.vault.toLowerCase()}`, label: `Mystery ${name}`,
        sub: `1 of ${s.inventory} at random for ${human(price, 18, true)} ETH`,
        chainId: HOME, desk: d.vault, name, image, price: { amount: price.toString(), token: tokenThing(ETH) }, inventory: s.inventory,
      });
    });
    return things.sort((a, b) => b.inventory - a.inventory || a.name.localeCompare(b.name)).map(({ inventory, ...t }) => t);
  },
});

const tokenThing = (t) => ({ kind: 'token', id: `token:${t.chainId}:${t.address.toLowerCase()}`, label: t.symbol, sub: t.name, ...t });

// ───────────────────────── catalog ─────────────────────────

/** `mystery`: every desk a pull can be bought from right now, with its price. Paused desks say so. */
export async function catalog(kind, { chainId = null } = {}) {
  if (kind !== 'mystery' || (chainId != null && Number(chainId) !== HOME)) return [];
  const [things, on] = await Promise.all([board.get(), revealing()]);
  return on ? things : things.map((t) => ({ ...t, sub: 'Paused: staccpad is not revealing pulls right now' }));
}

// ───────────────────────── plan ─────────────────────────

export function match(input, output) {
  return !!input && !!output && input.kind === 'token' && output.kind === 'mystery'
    && Number(input.chainId) === HOME && Number(output.chainId) === HOME && isAddress(output.desk);
}

const UNAUDITED = 'The mystery desks are new and unaudited. Only spend what you could stand to lose.';

async function planPull(output, owner, slippage) {
  const [all, f, on] = await Promise.all([allDesks(), faces(1_000), revealing()]);
  const d = all.byVault.get(output.desk.toLowerCase());
  if (!d) throw fail('NO_DESK', 404, 'That is not one of staccpad\'s mystery desks.');
  const { name } = faceOf(d, f);
  if (!d.key) throw fail('NO_DESK', 404, `The ${name} desk has no ETH pool yet, so a pull cannot be bought with ETH.`);
  if (!on) {
    throw fail('REVEAL_OFF', 503, 'Mystery pulls are paused: staccpad is not revealing them right now, so a pull would not deliver its NFT. Nothing was built.');
  }

  // what the desk holds and what a pull costs, on the chain as it is right now
  const pullsSoFar = C(d.vault, VAULT_ABI, 'pullCount');
  const waiting = C(d.vault, VAULT_ABI, 'openPulls');
  const read = await readLive([...stateSpecs(d), pullsSoFar, waiting, C(d.vault, VAULT_ABI, 'mintUnit')]);
  const s = stateFrom(read.slice(0, 4));
  const [soFar, open, perNft] = read.slice(4);
  if (!s || soFar == null || !Array.isArray(open)) throw UPSTREAM();
  if (s.inventory === 0) throw fail('EMPTY', 404, `The ${name} desk is empty right now.`);
  if (s.cost === 0n) throw fail('NO_PRICE', 404, `The ${name} desk cannot price a pull right now.`);
  const claims = claimsToBuy(s);
  const shown = Math.min(s.inventory, 12);
  // putting one NFT back in mints `mintUnit` claims; what the pool pays for those is what an NFT sells back for
  const resale = C(QUOTER, QUOTER_ABI, 'quoteExactInputSingle', [{ poolKey: d.key, zeroForOne: false, exactAmount: perNft ?? 0n, hookData: '0x' }]);
  const [quote, back, ...inside] = await readLive([
    claims > 0n ? quoteSpec(d, claims) : pullsSoFar,
    perNft ? resale : pullsSoFar,
    ...Array.from({ length: shown }, (_, i) => C(d.vault, VAULT_ABI, 'inventoryAt', [BigInt(i)])),
  ]);
  const sellsFor = perNft && Array.isArray(back) ? back[0] : null;
  const quoted = claims === 0n ? 0n : quote?.[0];
  if (quoted == null) throw fail('NO_PRICE', 404, `The ${name} desk cannot sell a pull right now: its pool does not have enough.`);

  // the page allows a step this much of the gas token and no more: the price plus the slippage it was given
  const capOf = (p) => (p * BigInt(Math.round((100 + slippage) * 100))) / 10_000n;
  const price = quoted;
  const cap = capOf(price);
  const call = C(HELPER, HELPER_ABI, 'pull', [d.vault, d.key], cap);
  let block = null;
  if (owner) {
    const who = getAddress(owner);
    const gas = C(MULTICALL3, MULTICALL_ABI, 'getEthBalance', [who]);
    const next = soFar + 1n;
    const mine = C(d.vault, VAULT_ABI, 'pulls', [next]);
    const sim = await simulate({ from: who, pre: [gas], steps: [call], post: [gas, mine] });
    if (!sim.steps[0].ok) throw refusal(sim.steps[0].error);
    const [before, after, pulled, lodged] = [value(gas, sim.pre[0]), value(gas, sim.post[0]), value(call, sim.steps[0]), value(mine, sim.post[1])];
    if (before == null || after == null || pulled == null) throw UNCHECKED();
    // the pull this run opened, read back in the same run: it must be waiting, and it must be this wallet's
    if (pulled !== next || !lodged || !same(lodged[1], who) || lodged[5] !== false) throw fail('WOULD_REVERT', 400, 'The chain refused this when it was tried: the pull was not recorded for this wallet.');
    // simulated gas is free, so what left the wallet is what the pull took
    const spent = before - after;
    if (spent < 0n || spent > cap) throw fail('WOULD_REVERT', 400, 'The chain refused this when it was tried: it would cost more than the limit.');
    block = sim.block;
  }
  const eth = tokenThing(ETH);
  const ids = inside.filter((x) => x != null && x.toString().length <= 12).map((x) => `#${x}`);
  const rest = s.inventory - ids.length;
  const last = s.inventory <= open.length + 1;
  const legs = [{
    kind: 'pull', chainId: HOME, label: `Pay ${human(price, 18, true)} ETH and pull`,
    in: { token: eth, amount: price.toString() }, out: null, feeNative: null,
    note: `Sends ${human(cap, 18, true)} ETH at most. What the price does not need comes straight back in the same transaction. The NFT arrives on its own, usually within half a minute.`,
    exec: { type: 'tx', tx: owner ? { chainId: HOME, to: call.to, value: call.value.toString(), data: call.data } : null },
  }];

  return {
    routing: 'PLAN', op: id,
    headline: `Buy 1 mystery ${name} for ${human(price, 18, true)} ETH`,
    pay: { label: 'ETH', amount: price.toString(), token: eth },
    receive: { label: `1 mystery ${name}`, amount: null, token: null },
    legs,
    facts: [
      { label: 'Price', value: `${human(price, 18, true)} ETH`, sub: `One pull, with the creator royalty, the staccpad fee and the pool fee all inside. Up to ${human(cap, 18, true)} ETH is sent in case the price moves, and whatever is not needed comes straight back.`, tone: 'ok' },
      {
        label: 'What you can get', value: `1 of ${count(s.inventory, `${name} NFT`, `${name} NFTs`)}`,
        sub: `One NFT out of whatever is in the desk when your pull is revealed. A block hash picks it and you have no say. In it now: ${ids.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}.`,
      },
      { label: 'Random and final', value: 'No choosing, no redo, no refund', sub: 'The NFT is picked by the hash of an Ethereum block that does not exist yet when you pay. You cannot choose it, and once you have paid there is no undoing it and no second try without paying again.', tone: 'warn' },
      {
        label: 'What it sells back for', value: sellsFor ? `About ${human(sellsFor, 18)} ETH` : 'Nothing right now',
        sub: sellsFor
          ? `What this desk's pool pays for one ${name} NFT right now, whichever one you get. The gap to the price is fees and the pool's own spread.`
          : `This desk's pool is not buying ${name} NFTs back right now.`,
        tone: sellsFor && sellsFor * 2n >= price ? undefined : 'warn',
      },
      { label: 'When it arrives', value: 'Usually within half a minute', sub: 'Paying locks your pull. Two Ethereum blocks later (12 to 24 seconds) staccpad reveals it and the NFT lands in this wallet, with nothing more to sign. If it has not come after a couple of minutes, staccpad.fun/gacha has a button to reveal it yourself.' },
      {
        label: 'If the desk empties first', value: 'You get the desk\'s token, not ETH',
        sub: `If others take the last ${s.inventory === 1 ? 'NFT' : 'NFTs'} before your pull is revealed, what you paid comes back as the desk's own token, worth about one NFT in its pool. Any small change from a pull comes back the same way.`,
        tone: last ? 'warn' : undefined,
      },
      owner
        ? { label: 'Checked', value: 'Tried on the live chain for this wallet', sub: `The step went through${block ? ` at block ${block}` : ''}, and the pull was recorded for this wallet.`, tone: 'ok' }
        : { label: 'Checked', value: 'Priced on the live chain', sub: 'Connect a wallet and the step is built and tried for it.' },
    ],
    warnings: [
      'What you get is random and the purchase is final: no choosing, no redo, no refund.',
      ...(sellsFor ? [] : [`This desk's pool is not buying ${name} NFTs back right now, so the one you get may be hard to sell.`]),
      ...(last ? [`Only ${count(s.inventory, 'NFT is', 'NFTs are')} left in this desk${open.length ? ` and ${count(open.length, 'pull is', 'pulls are')} already waiting` : ''}. If the desk is empty when your pull is revealed, you get the desk's token back, not an NFT and not ETH.`] : []),
      UNAUDITED,
    ],
    contracts: [{ chainId: HOME, address: HELPER, name: 'staccpad mystery desk' }],
  };
}

/** A plan for the pair, or a refusal in one plain sentence. `owner` null prices it without building anything. */
export async function plan({ input, output, owner = null, slippage = 1 } = {}) {
  if (!match(input, output)) throw fail('NO_OP', 404, 'The mystery desks cannot make that trade.');
  if (owner != null && !isAddress(owner)) throw fail('BAD_REQUEST', 400, 'That wallet address is not valid.');
  if (input.address !== 'NATIVE') throw fail('PAY_IN_ETH', 400, 'A mystery pull is paid in ETH. Put ETH in the pay box.');
  const n = Number(slippage);
  const slip = Number.isFinite(n) && n >= 0 ? Math.min(50, n) : 1;
  try {
    return await planPull(output, owner, slip);
  } catch (e) {
    if (e?.planError) throw e;
    console.warn(new Date().toISOString(), 'gacha plan failed:', redact(String(e?.message || e).split('\n')[0].slice(0, 200)));
    throw UPSTREAM();
  }
}

/** No routes of its own. Loading the board here means the first visitor does not wait for it. */
export function register() {
  feed.get().catch(() => {}).then(() => board.get()).catch(() => {});
}
