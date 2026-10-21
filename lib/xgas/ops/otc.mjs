// NFT for NFT, zero fee: the betfi board. Take an order that gives one NFT for one NFT, or post one.
//
// The board (staccpad's /api/swap/bets) is a mailbox of signed Seaport 1.6 orders: plain FULL_OPEN orders, zone 0,
// conduit key 0, no fee item, settled by calling Seaport itself. This module only looks at the one shape that
// fits one box in, one box out: the maker gives exactly one ERC-721 and wants exactly one ERC-721 back (a named
// id, any id of a collection, or any id of a listed set). Everything else on the board is left to betfi.fun.
//
//   take: [allow Seaport to move this one NFT] + Seaport.fulfillOrder / fulfillAdvancedOrder
//   post: [allow Seaport to move this one NFT] + sign the order (EIP-712), then POST it to /api/op/otc/post,
//         which checks it again and forwards it to the board
//
// An order is only shown or taken after the chain says it can still settle: not cancelled, not filled, the
// maker's counter unchanged, the maker still holding the NFT with Seaport allowed to move it, and (the board's
// own rule) the maker still holding a pass. A take is then run from the owner against the latest state, and the
// run must show both NFTs changing hands and nothing else leaving the wallet. Approvals are for the single
// token id, never the collection. Chain reads go only through the owner's dRPC proxy.
import { randomBytes } from 'node:crypto';
import {
  createPublicClient, decodeErrorResult, decodeFunctionResult, encodeFunctionData, getAddress, hashStruct, http, isAddress,
  keccak256, pad, parseAbi, recoverTypedDataAddress, toHex,
} from 'viem';

export const id = 'otc';

// ───────────────────────── fixed facts ─────────────────────────

const RH = 4663;
const RPC_URL = 'https://staccpad.fun/rpc';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395';
const STACCPAD = 'https://staccpad.fun';
const BOARD = `${STACCPAD}/api/swap/bets`;
const POST_PATH = '/api/op/otc/post';
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = `0x${'00'.repeat(32)}`;
const DEAD = '0x000000000000000000000000000000000000dEaD';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** Posting is gated by the board: the maker must hold one of these. Taking is open to anyone. */
const PASSES = [
  { token: '0x7c165Ae6E7BFD939Fee1ACA99Ca5aeDf85c52dD4', label: 'Homecoming' },
  { token: '0x505A22Ffed8d37ebE580FfD98d2Cdb0021189146', label: 'CCFF00 Square' },
];
const OFFER_DAYS = 7;
const MAX_ORDERS = 200; // one-for-one orders examined per board read
const MAX_SET = 20_000; // ids in a criteria set, the board's own cap

const ITEM_ERC721 = 2;
const ITEM_ERC721_CRITERIA = 4;
const fields = (list) => list.split(',').map((f) => { const [name, type] = f.split(':'); return { name, type }; });
const ORDER_TYPES = {
  OrderComponents: fields('offerer:address,zone:address,offer:OfferItem[],consideration:ConsiderationItem[],orderType:uint8,startTime:uint256,endTime:uint256,zoneHash:bytes32,salt:uint256,conduitKey:bytes32,counter:uint256'),
  OfferItem: fields('itemType:uint8,token:address,identifierOrCriteria:uint256,startAmount:uint256,endAmount:uint256'),
  ConsiderationItem: fields('itemType:uint8,token:address,identifierOrCriteria:uint256,startAmount:uint256,endAmount:uint256,recipient:address'),
};
const DOMAIN = { name: 'Seaport', version: '1.6', chainId: RH, verifyingContract: SEAPORT };
const DOMAIN_TYPE = fields('name:string,version:string,chainId:uint256,verifyingContract:address');

const SEAPORT_ABI = parseAbi([
  'struct OfferItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; }',
  'struct ConsiderationItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; address recipient; }',
  'struct OrderParameters { address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 totalOriginalConsiderationItems; }',
  'struct Order { OrderParameters parameters; bytes signature; }',
  'struct AdvancedOrder { OrderParameters parameters; uint120 numerator; uint120 denominator; bytes signature; bytes extraData; }',
  'struct CriteriaResolver { uint256 orderIndex; uint8 side; uint256 index; uint256 identifier; bytes32[] criteriaProof; }',
  'function fulfillOrder(Order order, bytes32 fulfillerConduitKey) payable returns (bool fulfilled)',
  'function fulfillAdvancedOrder(AdvancedOrder advancedOrder, CriteriaResolver[] criteriaResolvers, bytes32 fulfillerConduitKey, address recipient) payable returns (bool fulfilled)',
  'function getCounter(address offerer) view returns (uint256 counter)',
  'function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)',
]);
const ERC721 = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function approve(address to, uint256 tokenId)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'function name() view returns (string)',
  'function tokenURI(uint256 tokenId) view returns (string)',
]);
const ERRORS = parseAbi([
  'error Error(string)',
  'error Panic(uint256)',
  'error InvalidSigner()',
  'error InvalidSignature()',
  'error BadSignatureV(uint8 v)',
  'error BadContractSignature()',
  'error OrderIsCancelled(bytes32 orderHash)',
  'error OrderAlreadyFilled(bytes32 orderHash)',
  'error InvalidTime(uint256 startTime, uint256 endTime)',
  'error InvalidProof()',
  'error UnresolvedConsiderationCriteria(uint256 orderIndex, uint256 considerationIndex)',
  'error TokenTransferGenericFailure(address token, address from, address to, uint256 identifier, uint256 amount)',
  'error NoContract(address account)',
  'error MissingOriginalConsiderationItems()',
  'error ERC721InsufficientApproval(address operator, uint256 tokenId)',
  'error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner)',
  'error ERC721NonexistentToken(uint256 tokenId)',
  'error TransferCallerNotOwnerNorApproved()',
  'error TransferFromIncorrectOwner()',
]);
const ERROR_TEXT = {
  InvalidSigner: 'the order was not signed by its maker',
  InvalidSignature: 'the order was not signed by its maker',
  BadSignatureV: 'the order was not signed by its maker',
  BadContractSignature: 'the order was not signed by its maker',
  OrderIsCancelled: 'the maker cancelled this order',
  OrderAlreadyFilled: 'someone already took this order',
  InvalidTime: 'the order has expired',
  InvalidProof: 'that NFT is not one the order accepts',
  TokenTransferGenericFailure: 'one of the two NFTs could not be moved',
  ERC721InsufficientApproval: 'Seaport is not allowed to move one of the two NFTs',
  ERC721IncorrectOwner: 'one of the two NFTs is no longer where the order says',
  ERC721NonexistentToken: 'one of the two NFTs does not exist',
  TransferCallerNotOwnerNorApproved: 'Seaport is not allowed to move one of the two NFTs',
  TransferFromIncorrectOwner: 'one of the two NFTs is no longer where the order says',
};
/** Limit Break's transfer validator answering OperatorNotAllowed: the collection refuses Seaport outright. */
const OPERATOR_NOT_ALLOWED = '1de5204e';
const BLOCKED = 'this collection only lets marketplaces on its own list move it, and Seaport is not on the list';

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
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const isAddr = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
const uint = (s) => typeof s === 'string' && /^[0-9]{1,78}$/.test(s);
const clean = (v, max = 64) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const now = () => Math.floor(Date.now() / 1000);
const day = (unix) => new Date(Number(unix) * 1000).toISOString().slice(0, 16).replace('T', ' ');
const warn = (m) => console.warn(new Date().toISOString(), `otc: ${m}`);
/** Base units to a short decimal for a sentence. Exact, no floats. */
function human(value, decimals = 18, sig = 3) {
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (!frac) return (v / base).toString();
  const lead = v / base === 0n ? frac.match(/^0*/)[0].length : 0;
  const cut = frac.slice(0, lead + sig).replace(/0+$/, '');
  return cut ? `${v / base}.${cut}` : (v / base).toString();
}

// Seaport's criteria tree: leaf = keccak256(uint256 id), sorted pairs, an odd node is carried up. Root 0 = any id.
const leaf = (tokenId) => keccak256(pad(toHex(BigInt(tokenId)), { size: 32 }));
const pair = (a, b) => (BigInt(a) < BigInt(b) ? keccak256(`0x${a.slice(2)}${b.slice(2)}`) : keccak256(`0x${b.slice(2)}${a.slice(2)}`));
function layersOf(ids) {
  const leaves = [...new Set(ids.map(String))].map(leaf).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? pair(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }
  return layers;
}
const merkleRoot = (ids) => (ids.length ? layersOf(ids).at(-1)[0] : ZERO32);
function merkleProof(ids, tokenId) {
  const layers = layersOf(ids);
  let idx = layers[0].indexOf(leaf(tokenId));
  if (idx < 0) throw new Error('not in the set');
  const proof = [];
  for (let l = 0; l < layers.length - 1; l++) {
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sib < layers[l].length) proof.push(layers[l][sib]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}
const orderHash = (components) => hashStruct({ data: components, primaryType: 'OrderComponents', types: ORDER_TYPES });

// ───────────────────────── chain access ─────────────────────────

let rpcClient = null;
const client = () => (rpcClient ??= createPublicClient({ transport: http(RPC_URL, { timeout: 20_000, retryCount: 1, retryDelay: 300 }) }));
const multicall = (contracts) => (contracts.length ? client().multicall({ contracts, allowFailure: true, multicallAddress: MULTICALL3, batchSize: 8_192 }) : Promise.resolve([]));
const good = (r) => r && r.status === 'success';

async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => null);
  if (!j || typeof j !== 'object') throw new Error(`the RPC answered ${r.status}`);
  return j;
}

function reason(data, message) {
  if (typeof data === 'string' && data.includes(OPERATOR_NOT_ALLOWED)) return BLOCKED;
  if (typeof data === 'string' && data.length >= 10) {
    try {
      const d = decodeErrorResult({ abi: ERRORS, data });
      if (d.errorName === 'Error') return clean(String(d.args?.[0] ?? ''), 160) || 'no reason given';
      return ERROR_TEXT[d.errorName] || d.errorName;
    } catch { /* not one we know */ }
    return `the contract answered with error code ${data.slice(0, 10)}`;
  }
  return message && !/^execution reverted$/i.test(message) ? clean(String(message), 160) : 'the contract refused it without a reason';
}

/**
 * Run `calls` ({ from, to, data }) in order against the latest state: one simulated block through
 * eth_simulateV1, or eth_call for a single call. Null when the chain could not run it.
 */
async function simulate(calls) {
  const body = calls.map((c) => ({ from: c.from, to: c.to, data: c.data, value: '0x0' }));
  try {
    const j = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: body }], validation: false }, 'latest']);
    const out = j.result?.[0]?.calls;
    if (Array.isArray(out) && out.length === body.length) {
      return out.map((c) => ({
        ok: c.status === '0x1',
        data: c.returnData || '0x',
        logs: Array.isArray(c.logs) ? c.logs : [],
        gas: c.gasUsed ? BigInt(c.gasUsed) : 0n,
        raw: c.status === '0x1' ? null : String(c.error?.data ?? c.returnData ?? ''),
        why: c.status === '0x1' ? null : reason(c.error?.data ?? c.returnData, c.error?.message),
      }));
    }
  } catch { /* fall through */ }
  if (body.length !== 1) return null;
  try {
    const j = await rpc('eth_call', [body[0], 'latest']);
    if (typeof j.result === 'string') return [{ ok: true, data: j.result, logs: null, gas: 0n, raw: null, why: null }];
    if (j.error && (j.error.code === 3 || typeof j.error.data === 'string' || /revert/i.test(String(j.error.message)))) {
      return [{ ok: false, data: '0x', logs: null, gas: 0n, raw: String(j.error.data ?? ''), why: reason(j.error.data, j.error.message) }];
    }
  } catch { /* unreachable */ }
  return null;
}

// ───────────────────────── the board ─────────────────────────

/**
 * A board entry as a one-for-one NFT order, or null. The same structural rules the board applies to every bet
 * (swap-inbox.mjs checkBetShape), narrowed to: one ERC-721 given, one ERC-721 or criteria item wanted, paid to
 * the maker, nothing else on either side.
 */
function oneForOne(b) {
  if (!b || typeof b !== 'object' || b.v !== 1 || b.chainId !== RH) return null;
  if (!(b.lock === 'open' && b.counterparty === null) && !(b.lock === 'item' && isAddr(b.counterparty))) return null;
  const c = b.components;
  if (!c || typeof c !== 'object' || !isAddr(c.offerer) || c.zone !== ZERO || c.orderType !== 0 || c.zoneHash !== ZERO32 || c.conduitKey !== ZERO32) return null;
  if (![c.startTime, c.endTime, c.salt, c.counter].every(uint)) return null;
  if (!Array.isArray(c.offer) || c.offer.length !== 1 || !Array.isArray(c.consideration) || c.consideration.length !== 1) return null;
  const give = c.offer[0];
  const want = c.consideration[0];
  const one = (i) => i && isAddr(i.token) && uint(i.identifierOrCriteria) && i.startAmount === '1' && i.endAmount === '1';
  if (!one(give) || give.itemType !== ITEM_ERC721) return null;
  if (!one(want) || (want.itemType !== ITEM_ERC721 && want.itemType !== ITEM_ERC721_CRITERIA) || !same(want.recipient, c.offerer)) return null;
  if (typeof b.signature !== 'string' || !/^0x[0-9a-fA-F]{2,4096}$/.test(b.signature)) return null;
  let hash;
  try { hash = orderHash(c); } catch { return null; }
  if (!same(hash, b.hash)) return null;

  const wanted = { collection: getAddress(want.token), tokenId: null, ids: null };
  if (want.itemType === ITEM_ERC721) wanted.tokenId = BigInt(want.identifierOrCriteria);
  else if (BigInt(want.identifierOrCriteria) !== 0n) {
    // a set: its ids travel with the bet and must hash to the root the maker signed
    const root = pad(toHex(BigInt(want.identifierOrCriteria)), { size: 32 }).toLowerCase();
    const set = b.sets?.[root]?.ids;
    if (!Array.isArray(set) || !set.length || set.length > MAX_SET || !set.every(uint) || merkleRoot(set) !== root) return null;
    wanted.ids = set.map(BigInt);
  }
  return {
    hash, bet: b, maker: getAddress(c.offerer), counterparty: b.counterparty,
    give: { collection: getAddress(give.token), tokenId: BigInt(give.identifierOrCriteria) },
    want: wanted, startTime: Number(c.startTime), endTime: Number(c.endTime),
  };
}
const accepts = (o, collection, tokenId) => same(o.want.collection, collection)
  && (o.want.tokenId !== null ? o.want.tokenId === tokenId : o.want.ids === null || o.want.ids.some((x) => x === tokenId));

async function fetchBets(query) {
  const r = await fetch(`${BOARD}?${query}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`the board answered ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.bets) ? j.bets : [];
}

/** Of `list`, the orders the chain says can still settle. One multicall. */
async function stillGood(list) {
  if (!list.length) return [];
  const per = 5 + PASSES.length;
  const res = await multicall(list.flatMap((o) => [
    { address: SEAPORT, abi: SEAPORT_ABI, functionName: 'getOrderStatus', args: [o.hash] },
    { address: SEAPORT, abi: SEAPORT_ABI, functionName: 'getCounter', args: [o.maker] },
    { address: o.give.collection, abi: ERC721, functionName: 'ownerOf', args: [o.give.tokenId] },
    { address: o.give.collection, abi: ERC721, functionName: 'isApprovedForAll', args: [o.maker, SEAPORT] },
    { address: o.give.collection, abi: ERC721, functionName: 'getApproved', args: [o.give.tokenId] },
    ...PASSES.map((p) => ({ address: p.token, abi: ERC721, functionName: 'balanceOf', args: [o.maker] })),
  ]));
  return list.filter((o, i) => {
    const [status, counter, holder, all, one, ...passes] = res.slice(i * per, i * per + per);
    if (!good(status) || !good(counter) || !good(holder)) return false;
    const [, cancelled, filled, size] = status.result;
    if (cancelled || (size > 0n && filled >= size)) return false;
    if (counter.result !== BigInt(o.bet.components.counter)) return false;
    if (!same(holder.result, o.maker)) return false;
    if (!((good(all) && all.result === true) || (good(one) && same(one.result, SEAPORT)))) return false;
    return passes.some((p) => good(p) && p.result > 0n);
  });
}

const boards = new Map(); // key -> { at, p }
function cachedOrders(key, query) {
  const hit = boards.get(key);
  if (hit && Date.now() - hit.at < 5_000) return hit.p;
  const p = (async () => {
    const t = now();
    const shaped = (await fetchBets(query)).map(oneForOne).filter((o) => o && o.startTime <= t && o.endTime > t + 60).slice(0, MAX_ORDERS);
    return stillGood(shaped);
  })();
  if (boards.size > 200) boards.delete(boards.keys().next().value);
  boards.set(key, { at: Date.now(), p });
  p.catch(() => boards.delete(key));
  return p;
}

/**
 * Every one-for-one order `owner` could take right now: the open board, plus orders addressed to that wallet
 * (they wait in its mailbox, not on the board). Never the wallet's own orders.
 */
async function liveOrders(owner) {
  const [open, mine] = await Promise.all([
    cachedOrders('board', 'board=1'),
    owner ? cachedOrders(`wallet:${owner.toLowerCase()}`, `wallet=${owner}`).catch(() => []) : [],
  ]);
  const seen = new Set();
  const out = [];
  for (const o of [...mine.filter((x) => same(x.counterparty, owner)), ...open]) {
    if (seen.has(o.hash) || (owner && same(o.maker, owner))) continue;
    seen.add(o.hash);
    out.push(o);
  }
  return out;
}

// ───────────────────────── what an NFT is called and looks like ─────────────────────────

const names = new Map(); // collection -> name
const metas = new Map(); // collection:id -> { at, name, image }
const key = (collection, tokenId) => `${collection.toLowerCase()}:${tokenId}`;

/** https and small data: images only (the page's CSP). Anything else goes through staccpad's image proxy. */
function imageUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  if (u.startsWith('data:image/')) return u.length <= 16_000 ? u : null;
  if (/^(https?:\/\/|ipfs:\/\/|ar:\/\/)/.test(u) && u.length <= 1_500) return `${STACCPAD}/api/img?uri=${encodeURIComponent(u)}`;
  return null;
}

/**
 * Collection names (read from the contracts) and token names and images (tokenURI, resolved by staccpad's
 * metadata proxy, never fetched from here: a token URI is whatever its contract says). Best effort and bounded:
 * what is not known in time is simply left blank.
 */
async function describe(items, budgetMs = 6_000) {
  const cols = [...new Set(items.map((i) => i.collection.toLowerCase()))].filter((c) => !names.has(c));
  const need = items.filter((i) => i.tokenId !== null && !(metas.get(key(i.collection, i.tokenId))?.at > Date.now() - 600_000)).slice(0, 60);
  const work = (async () => {
    const res = await multicall([
      ...cols.map((address) => ({ address, abi: ERC721, functionName: 'name' })),
      ...need.map((i) => ({ address: i.collection, abi: ERC721, functionName: 'tokenURI', args: [BigInt(i.tokenId)] })),
    ]);
    cols.forEach((c, n) => names.set(c, good(res[n]) ? clean(res[n].result, 48) : ''));
    await Promise.all(need.map(async (i, n) => {
      const r = res[cols.length + n];
      let meta = null;
      try {
        const uri = good(r) ? String(r.result) : '';
        if (uri.startsWith('data:application/json') && uri.length <= 200_000) {
          const body = uri.slice(uri.indexOf(',') + 1);
          meta = JSON.parse(uri.includes(';base64') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body));
        } else if (/^(ipfs:\/\/|ar:\/\/|https?:\/\/)/.test(uri) && uri.length <= 2_000) {
          const m = await fetch(`${STACCPAD}/api/meta?uri=${encodeURIComponent(uri)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
          if (m.ok) meta = await m.json();
        }
      } catch { /* blank */ }
      if (metas.size > 2_000) metas.delete(metas.keys().next().value);
      metas.set(key(i.collection, i.tokenId), { at: Date.now(), name: clean(meta?.name, 64), image: imageUrl(meta?.image || meta?.image_url) });
    }));
  })().catch((e) => warn(`describe: ${String(e?.message || e).slice(0, 120)}`));
  let timer;
  await Promise.race([work, new Promise((r) => { timer = setTimeout(r, budgetMs); })]);
  clearTimeout(timer);
}
const collectionName = (collection) => names.get(collection.toLowerCase()) || `Collection ${short(collection)}`;
/** The unambiguous name used wherever something is signed: the collection's own name and the id. */
const title = (collection, tokenId) => (tokenId === null ? `any ${collectionName(collection)}` : `${collectionName(collection)} #${tokenId}`);

function thing(collection, tokenId, sub) {
  const m = tokenId === null ? null : metas.get(key(collection, tokenId));
  const name = m?.name || title(collection, tokenId);
  return {
    kind: 'nft', id: `nft:${RH}:${collection.toLowerCase()}:${tokenId === null ? 'any' : tokenId}`, label: name, sub,
    chainId: RH, collection, tokenId: tokenId === null ? null : String(tokenId), name, image: m?.image || null, collectionName: collectionName(collection),
  };
}

const wallets = new Map(); // owner -> { at, p }
/** Everything a wallet holds, from staccpad's wallet index: [{ token, id }]. Only a hint; ownerOf decides. */
function walletNfts(owner) {
  const k = owner.toLowerCase();
  const hit = wallets.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = (async () => {
    const r = await fetch(`${STACCPAD}/api/wallet/${owner}/nfts`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`the wallet index answered ${r.status}`);
    const j = await r.json();
    return (Array.isArray(j?.nfts) ? j.nfts : []).filter((n) => isAddr(n?.token) && uint(String(n?.id))).map((n) => ({ token: getAddress(n.token), id: BigInt(n.id) }));
  })();
  if (wallets.size > 500) wallets.delete(wallets.keys().next().value);
  wallets.set(k, { at: Date.now(), p });
  p.catch(() => wallets.delete(k));
  return p;
}

// ───────────────────────── picker ─────────────────────────

const nftRef = (t) => (t && typeof t === 'object' && t.kind === 'nft' && t.chainId === RH && isAddr(t.collection) ? t : null);

/** The owner's NFTs that a live order wants, each with the order(s) that want it. */
async function ownedAndWanted(owner) {
  const orders = await liveOrders(owner);
  if (!orders.length) return [];
  // named ids are candidates as they stand; "any of a collection" and sets need to know what the wallet holds there
  const held = orders.some((o) => o.want.tokenId === null) ? await walletNfts(owner).catch((e) => { warn(`wallet index: ${String(e?.message || e).slice(0, 100)}`); return []; }) : [];
  const cands = new Map(); // collection:id -> { collection, tokenId, orders }
  const add = (collection, tokenId, o) => {
    const k = key(collection, tokenId);
    if (!cands.has(k)) cands.set(k, { collection, tokenId, orders: [] });
    cands.get(k).orders.push(o);
  };
  for (const o of orders) {
    if (o.want.tokenId !== null) add(o.want.collection, o.want.tokenId, o);
    else for (const n of held) if (accepts(o, n.token, n.id)) add(o.want.collection, n.id, o);
  }
  const list = [...cands.values()].slice(0, 300);
  const owners = await multicall(list.map((c) => ({ address: c.collection, abi: ERC721, functionName: 'ownerOf', args: [c.tokenId] })));
  return list.filter((_, i) => good(owners[i]) && same(owners[i].result, owner));
}

export async function catalog(kind, { owner, chainId, input } = {}) {
  if (kind !== 'nft-owned' && kind !== 'nft-buyable') return [];
  if (typeof chainId === 'number' && chainId !== RH) return [];
  const who = isAddress(owner || '') ? getAddress(owner) : null;
  try {
    if (kind === 'nft-owned') {
      if (!who) return [];
      const mine = await ownedAndWanted(who);
      await describe([...mine.map((m) => ({ collection: m.collection, tokenId: m.tokenId })), ...mine.flatMap((m) => m.orders.map((o) => o.give))]);
      return mine.map((m) => thing(m.collection, m.tokenId, m.orders.length === 1
        ? `An open order gives ${title(m.orders[0].give.collection, m.orders[0].give.tokenId)} for it`
        : `${m.orders.length} open orders want it`));
    }
    const orders = await liveOrders(who);
    const mineRef = nftRef(input);
    const pay = mineRef && uint(String(mineRef.tokenId)) ? { collection: getAddress(mineRef.collection), tokenId: BigInt(mineRef.tokenId) } : null;
    if (input && !pay) return [];
    const hits = pay ? orders.filter((o) => accepts(o, pay.collection, pay.tokenId)) : orders;
    await describe([...hits.map((o) => o.give), ...hits.map((o) => ({ collection: o.want.collection, tokenId: o.want.tokenId })), ...(pay ? [pay] : [])]);
    const seen = new Set();
    const out = [];
    for (const o of hits) {
      const t = thing(o.give.collection, o.give.tokenId, pay
        ? `For your ${title(pay.collection, pay.tokenId)}, from ${short(o.maker)}`
        : `Wants ${o.want.ids ? `one of ${o.want.ids.length} ${collectionName(o.want.collection)}` : title(o.want.collection, o.want.tokenId)}`);
      if (!seen.has(t.id)) { seen.add(t.id); out.push(t); }
    }
    return out;
  } catch (e) {
    // the picker gets an empty list rather than an error; the log says why
    warn(`catalog ${kind}: ${String(e?.message || e).slice(0, 160)}`);
    return [];
  }
}

// ───────────────────────── plan ─────────────────────────

export function match(input, output) {
  return !!nftRef(input) && !!nftRef(output);
}

const approveData = (tokenId) => encodeFunctionData({ abi: ERC721, functionName: 'approve', args: [SEAPORT, tokenId] });
const approveLeg = (collection, tokenId, tx) => ({
  kind: 'approve', chainId: RH, label: `Allow Seaport to move ${title(collection, tokenId)}`, in: null, out: null, feeNative: null,
  note: 'This one NFT only, not the whole collection.',
  exec: { type: 'tx', tx },
});

function parametersOf(c) {
  const item = (i) => ({ itemType: i.itemType, token: i.token, identifierOrCriteria: BigInt(i.identifierOrCriteria), startAmount: BigInt(i.startAmount), endAmount: BigInt(i.endAmount) });
  return {
    offerer: c.offerer, zone: c.zone, offer: c.offer.map(item), consideration: c.consideration.map((i) => ({ ...item(i), recipient: i.recipient })),
    orderType: c.orderType, startTime: BigInt(c.startTime), endTime: BigInt(c.endTime), zoneHash: c.zoneHash, salt: BigInt(c.salt), conduitKey: c.conduitKey,
    totalOriginalConsiderationItems: BigInt(c.consideration.length),
  };
}
/** Seaport calldata that takes `o`, supplying `tokenId` for what it wants. A named id needs no resolver. */
function takeData(o, tokenId) {
  const parameters = parametersOf(o.bet.components);
  if (o.want.tokenId !== null) {
    return { fn: 'fulfillOrder', data: encodeFunctionData({ abi: SEAPORT_ABI, functionName: 'fulfillOrder', args: [{ parameters, signature: o.bet.signature }, ZERO32] }) };
  }
  const criteriaProof = o.want.ids === null ? [] : merkleProof(o.want.ids, tokenId);
  const advanced = { parameters, numerator: 1n, denominator: 1n, signature: o.bet.signature, extraData: '0x' };
  // side 1 = consideration, item 0; recipient 0 = the caller receives what the maker gives
  return { fn: 'fulfillAdvancedOrder', data: encodeFunctionData({ abi: SEAPORT_ABI, functionName: 'fulfillAdvancedOrder', args: [advanced, [{ orderIndex: 0n, side: 1, index: 0n, identifier: tokenId, criteriaProof }], ZERO32, ZERO] }) };
}

const topicOf = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
/** Did the run move `tokenId` of `collection` from `from` to `to`? */
const moved = (logs, collection, from, to, tokenId) => logs.some((l) => same(l.address, collection) && Array.isArray(l.topics) && l.topics.length === 4
  && l.topics[0] === TRANSFER && l.topics[1].toLowerCase() === topicOf(from) && l.topics[2].toLowerCase() === topicOf(to) && BigInt(l.topics[3]) === tokenId);
/** How many things the run moved out of `owner`, of any kind. */
const leftWallet = (logs, owner) => logs.filter((l) => Array.isArray(l.topics) && l.topics[0] === TRANSFER && String(l.topics[1]).toLowerCase() === topicOf(owner)).length;

async function feeFact(owner, runs) {
  try {
    const gas = runs.reduce((n, r) => n + (r.gas || 0n), 0n);
    if (gas === 0n) return null;
    const [price, eth] = await Promise.all([client().getGasPrice(), client().getBalance({ address: owner })]);
    const fee = gas * price;
    if (eth < fee) throw fail('NO_GAS', 'You need a little ETH on Robinhood Chain for the network fee, and your wallet does not hold enough.');
    return { label: 'Network fee', value: `about ${human(fee)} ETH`, sub: 'From a test run of these exact transactions.' };
  } catch (e) {
    if (e?.planError) throw e;
    return null;
  }
}

const UNAUDITED = 'This page is new and unaudited. Read both NFTs in your wallet before you sign: a swap cannot be undone.';

export async function plan({ input, output, owner }) {
  const pay = nftRef(input);
  const get = nftRef(output);
  if (!pay || !get) throw fail('NOT_AN_NFT_SWAP', 'This swaps one NFT for another on Robinhood Chain.', 404);
  if (!uint(String(pay.tokenId))) throw fail('PICK_YOUR_NFT', 'Pick the exact NFT you are giving.', 400);
  if (get.tokenId !== null && !uint(String(get.tokenId))) throw fail('BAD_TOKEN_ID', 'That NFT id is not valid.', 400);
  if (owner !== null && owner !== undefined && !isAddress(owner)) throw fail('BAD_OWNER', 'That wallet address is not valid.', 400);
  const who = owner ? getAddress(owner) : null;
  const give = { collection: getAddress(pay.collection), tokenId: BigInt(pay.tokenId) };
  const want = { collection: getAddress(get.collection), tokenId: get.tokenId === null ? null : BigInt(get.tokenId) };
  if (want.tokenId !== null && same(give.collection, want.collection) && give.tokenId === want.tokenId) throw fail('SAME_NFT', 'That is the same NFT on both sides.', 400);

  let orders;
  try {
    orders = await liveOrders(who);
  } catch (e) {
    throw fail('BOARD_UNAVAILABLE', 'The betfi board did not answer. Try again in a moment.', 503, e);
  }
  try {
    // an order that gives what is asked for and accepts what is offered; one naming the exact id comes first
    const hits = orders.filter((o) => same(o.give.collection, want.collection) && (want.tokenId === null || o.give.tokenId === want.tokenId) && accepts(o, give.collection, give.tokenId));
    const order = hits.find((o) => o.want.tokenId !== null) || hits[0];
    return order ? await planTake(order, give, who) : await planPost(give, want, who);
  } catch (e) {
    if (e?.planError) throw e;
    throw fail('UPSTREAM_UNAVAILABLE', 'Robinhood Chain could not be read just now. Try again in a moment.', 503, e);
  }
}

/** Take a live order: the owner's NFT goes to the maker and the maker's comes back, in one Seaport call. */
async function planTake(o, give, owner) {
  await describe([give, o.give]);
  const mine = title(give.collection, give.tokenId);
  const theirs = title(o.give.collection, o.give.tokenId);
  const take = takeData(o, give.tokenId);
  const legs = [];
  let fee = null;
  let takeTx = null;

  if (!owner) {
    legs.push(approveLeg(give.collection, give.tokenId, null));
  } else {
    const [holder, all, one] = await multicall([
      { address: give.collection, abi: ERC721, functionName: 'ownerOf', args: [give.tokenId] },
      { address: give.collection, abi: ERC721, functionName: 'isApprovedForAll', args: [owner, SEAPORT] },
      { address: give.collection, abi: ERC721, functionName: 'getApproved', args: [give.tokenId] },
    ]);
    if (!good(holder) || !same(holder.result, owner)) throw fail('NOT_YOURS', `${mine} is not in your wallet.`);
    const allowed = (good(all) && all.result === true) || (good(one) && same(one.result, SEAPORT));
    const approveTx = allowed ? null : { chainId: RH, to: give.collection, value: '0', data: approveData(give.tokenId) };
    if (approveTx) legs.push(approveLeg(give.collection, give.tokenId, approveTx));
    takeTx = { chainId: RH, to: SEAPORT, value: '0', data: take.data };

    const runs = await simulate([...(approveTx ? [approveTx] : []), takeTx].map((t) => ({ from: owner, to: t.to, data: t.data })));
    if (!runs) throw fail('SIMULATION_UNAVAILABLE', 'The chain could not test this swap just now, so nothing was prepared. Try again in a moment.', 503);
    const bad = runs.find((r) => !r.ok);
    if (bad) throw fail('WOULD_REVERT', `A test run of this exact swap failed: ${bad.why}. Nothing was sent.`);
    const last = runs.at(-1);
    if (decodeFunctionResult({ abi: SEAPORT_ABI, functionName: take.fn, data: last.data }) !== true) throw fail('WOULD_REVERT', 'A test run of this swap did not settle the order. Nothing was sent.');
    if (last.logs) {
      // the run must show exactly the trade on the screen: theirs in, mine out, and nothing else leaving
      if (!moved(last.logs, o.give.collection, o.maker, owner, o.give.tokenId) || !moved(last.logs, give.collection, owner, o.maker, give.tokenId) || leftWallet(last.logs, owner) !== 1) {
        throw fail('WOULD_REVERT', 'A test run of this swap did not move exactly these two NFTs. Nothing was sent.');
      }
    }
    fee = await feeFact(owner, runs);
  }
  legs.push({
    kind: 'swap', chainId: RH, label: `Swap ${mine} for ${theirs}`, in: null, out: null, feeNative: null,
    note: 'Both NFTs move in the same transaction, or neither does.',
    exec: { type: 'tx', tx: takeTx },
  });

  return {
    routing: 'PLAN',
    op: id,
    headline: `Your ${mine} for ${theirs}, in one transaction`,
    pay: { label: mine, amount: null, token: null },
    receive: { label: theirs, amount: null, token: null },
    legs,
    facts: [
      { label: 'Fee', value: 'None', sub: 'The order has no fee and no royalty item: one NFT each way. You pay only the network fee.', tone: 'ok' },
      { label: 'You receive', value: theirs, sub: `Collection contract ${o.give.collection}. Check it is the collection you mean: anyone can deploy one with the same name.` },
      { label: 'Other side', value: short(o.maker), sub: `Their order is already signed${o.counterparty ? ' and addressed to you' : ''}. Their NFT only moves if yours does.` },
      { label: 'Settles on', value: 'Seaport 1.6', sub: 'The exchange contract OpenSea uses, called directly. No marketplace in between.' },
      { label: 'Order ends', value: `${day(o.endTime)} UTC`, sub: 'The maker can also cancel it, or move the NFT, at any moment before you send.' },
      ...(fee ? [fee] : []),
      ...(owner ? [{ label: 'Checked', value: 'Test run passed', sub: 'This exact swap was run from your wallet against the live chain: their NFT came in, yours went out, nothing else moved.', tone: 'ok' }] : []),
    ],
    warnings: [UNAUDITED],
    contracts: [
      { chainId: RH, address: give.collection, name: `${collectionName(give.collection)} (the NFT you allow)` },
      { chainId: RH, address: SEAPORT, name: 'Seaport 1.6' },
    ],
  };
}

/** Nothing on the board matches: write the order, have the wallet sign it, and put it on the board to wait. */
async function planPost(give, want, owner) {
  await describe([give, want]);
  const mine = title(give.collection, give.tokenId);
  const theirs = title(want.collection, want.tokenId);
  const legs = [];
  let exec = { type: 'sign', typedData: null, submit: { path: POST_PATH, body: {} } };
  let endTime = now() + OFFER_DAYS * 86_400;
  let fee = null;

  if (!owner) {
    legs.push(approveLeg(give.collection, give.tokenId, null));
  } else {
    const res = await multicall([
      { address: give.collection, abi: ERC721, functionName: 'ownerOf', args: [give.tokenId] },
      { address: give.collection, abi: ERC721, functionName: 'isApprovedForAll', args: [owner, SEAPORT] },
      { address: give.collection, abi: ERC721, functionName: 'getApproved', args: [give.tokenId] },
      { address: SEAPORT, abi: SEAPORT_ABI, functionName: 'getCounter', args: [owner] },
      { address: want.collection, abi: ERC721, functionName: 'supportsInterface', args: ['0x80ac58cd'] },
      ...(want.tokenId !== null ? [{ address: want.collection, abi: ERC721, functionName: 'ownerOf', args: [want.tokenId] }] : []),
      ...PASSES.map((p) => ({ address: p.token, abi: ERC721, functionName: 'balanceOf', args: [owner] })),
    ]);
    const [holder, all, one, counter, is721] = res;
    const theirHolder = want.tokenId !== null ? res[5] : null;
    const passes = res.slice(want.tokenId !== null ? 6 : 5);
    if (!good(holder) || !same(holder.result, owner)) throw fail('NOT_YOURS', `${mine} is not in your wallet.`);
    if (!good(is721) || is721.result !== true) throw fail('NOT_AN_NFT', `${short(want.collection)} is not an NFT collection on Robinhood Chain.`);
    if (theirHolder && !good(theirHolder)) throw fail('NO_SUCH_NFT', `${theirs} does not exist.`);
    if (theirHolder && same(theirHolder.result, owner)) throw fail('ALREADY_YOURS', `${theirs} is already in your wallet.`);
    if (!good(counter)) throw new Error('Seaport could not be read');
    if (!passes.some((p) => good(p) && p.result > 0n)) {
      throw fail('POST_NEEDS_PASS', `Nobody is offering that swap right now. Posting your own offer needs a ${PASSES.map((p) => p.label).join(' or a ')} in your wallet; taking an existing one does not.`, 403);
    }

    const allowed = (good(all) && all.result === true) || (good(one) && same(one.result, SEAPORT));
    const approveTx = allowed ? null : { chainId: RH, to: give.collection, value: '0', data: approveData(give.tokenId) };
    // Run the approval, then the move a taker would trigger: Seaport itself transferring the NFT out. A collection
    // that only lets listed marketplaces move it fails here, before anything is signed.
    const runs = await simulate([
      ...(approveTx ? [{ from: owner, to: approveTx.to, data: approveTx.data }] : []),
      { from: SEAPORT, to: give.collection, data: encodeFunctionData({ abi: ERC721, functionName: 'transferFrom', args: [owner, theirHolder ? theirHolder.result : DEAD, give.tokenId] }) },
    ]);
    if (!runs) throw fail('SIMULATION_UNAVAILABLE', 'The chain could not test this offer just now, so nothing was prepared. Try again in a moment.', 503);
    const bad = runs.find((r) => !r.ok);
    if (bad) throw fail(bad.why === BLOCKED ? 'COLLECTION_BLOCKS_SEAPORT' : 'WOULD_REVERT', bad.why === BLOCKED ? `${collectionName(give.collection)} cannot be swapped here: ${BLOCKED}.` : `A test run showed Seaport could not move ${mine}: ${bad.why}. Nothing was signed.`);
    if (theirHolder) {
      // and the NFT asked for: without its holder's approval the run fails, which is fine, unless the collection itself says no
      const probe = await simulate([{ from: SEAPORT, to: want.collection, data: encodeFunctionData({ abi: ERC721, functionName: 'transferFrom', args: [theirHolder.result, owner, want.tokenId] }) }]);
      if (probe && !probe[0].ok && probe[0].why === BLOCKED) throw fail('COLLECTION_BLOCKS_SEAPORT', `${collectionName(want.collection)} cannot be swapped here: ${BLOCKED}.`);
    }
    if (approveTx) {
      legs.push(approveLeg(give.collection, give.tokenId, approveTx));
      fee = await feeFact(owner, runs.slice(0, 1));
    }

    const t = now();
    endTime = t + OFFER_DAYS * 86_400;
    const item = (collection, tokenId) => ({ itemType: tokenId === null ? ITEM_ERC721_CRITERIA : ITEM_ERC721, token: collection, identifierOrCriteria: tokenId === null ? '0' : tokenId.toString(), startAmount: '1', endAmount: '1' });
    const components = {
      offerer: owner, zone: ZERO, offer: [item(give.collection, give.tokenId)], consideration: [{ ...item(want.collection, want.tokenId), recipient: owner }],
      orderType: 0, startTime: String(t - 60), endTime: String(endTime), zoneHash: ZERO32, salt: BigInt(`0x${randomBytes(32).toString('hex')}`).toString(),
      conduitKey: ZERO32, counter: counter.result.toString(),
    };
    const bet = { v: 1, chainId: RH, counterparty: null, lock: 'open', components, hash: orderHash(components) };
    exec = {
      type: 'sign',
      typedData: { domain: DOMAIN, types: { EIP712Domain: DOMAIN_TYPE, ...ORDER_TYPES }, primaryType: 'OrderComponents', message: components },
      submit: { path: POST_PATH, body: { bet } },
    };
  }
  legs.push({
    kind: 'sign', chainId: RH, label: `Sign your offer: ${mine} for ${theirs}`, in: null, out: null, feeNative: null,
    note: 'A signature, not a transaction. It costs nothing and moves nothing until someone takes the offer.',
    exec,
  });

  return {
    routing: 'PLAN',
    op: id,
    headline: `Nobody is offering that yet. Post your own: ${mine} for ${theirs}`,
    pay: { label: mine, amount: null, token: null },
    receive: { label: `${theirs}, if someone takes your offer`, amount: null, token: null },
    legs,
    facts: [
      { label: 'This is an offer, not a swap', value: 'It waits for a taker', sub: `It goes on the betfi board. Nothing moves until someone holding ${theirs} takes it. If nobody does, it just sits there until it runs out.`, tone: 'warn' },
      { label: 'Runs out', value: `${day(endTime)} UTC`, sub: `${OFFER_DAYS} days from now. Your NFT stays in your wallet the whole time.` },
      { label: 'Fee', value: 'None', sub: 'No fee and no royalty item in the order: one NFT each way.', tone: 'ok' },
      { label: 'Who can take it', value: want.tokenId === null ? `Anyone holding any ${collectionName(want.collection)}` : `Whoever holds ${theirs}`, sub: `Collection contract ${want.collection}. They do not have to ask you again: your signature is the yes.`, tone: want.tokenId === null ? 'warn' : undefined },
      { label: 'To call it off', value: 'Cancel on betfi.fun, or move the NFT', sub: 'A signed offer stays good until it runs out. Cancelling it is a Seaport transaction (betfi.fun has the button). It also cannot be taken while the NFT is out of your wallet.' },
      { label: 'Settles on', value: 'Seaport 1.6', sub: 'The exchange contract OpenSea uses, called directly. No marketplace in between.' },
      ...(fee ? [fee] : []),
      ...(owner ? [{ label: 'Checked', value: 'Test run passed', sub: `A test run showed Seaport can move ${mine} once you allow it.`, tone: 'ok' }] : []),
    ].map((f) => { if (f.tone === undefined) delete f.tone; return f; }),
    warnings: [
      `Once signed, anyone holding ${theirs} can take your ${mine} without asking you again, until the offer runs out or you cancel it.`,
      ...(want.tokenId === null ? [`You asked for any ${collectionName(want.collection)}. That includes the least wanted one in the collection.`] : []),
      UNAUDITED,
    ],
    contracts: [
      { chainId: RH, address: give.collection, name: `${collectionName(give.collection)} (the NFT you allow)` },
      { chainId: RH, address: SEAPORT, name: 'Seaport 1.6' },
    ],
  };
}

// ───────────────────────── the route a signed offer is posted to ─────────────────────────

const say = (res, status, errorCode, detail) => res.status(status).set('Cache-Control', 'no-store').json(status === 200 ? detail : { error: detail, errorCode, detail });

/** The request body as JSON, whether or not a parser ran before this handler. 64 kb at most. */
async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw fail('TOO_LARGE', 'Request body over 64 kb.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('BAD_REQUEST', 'The request could not be read.', 400); }
}

/**
 * POST /api/op/otc/post { bet, signature }. The page signs the typed data a plan handed it and posts the result
 * here. Only the one-for-one shape this module writes is accepted, the signature must be the maker's, and the
 * signed order is then handed to the board, which checks it all again and applies its own posting gate.
 */
async function postOffer(req, res) {
  try {
    const body = await readJson(req);
    const signature = body?.signature;
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{2,4096}$/.test(signature)) throw fail('BAD_SIGNATURE', 'The signature is missing or malformed.', 400);
    const b = body?.bet;
    const bet = b && typeof b === 'object' ? { v: b.v, chainId: b.chainId, counterparty: b.counterparty, lock: b.lock, components: b.components, hash: b.hash, signature } : null;
    const o = oneForOne(bet);
    if (!o || o.counterparty !== null || o.want.ids !== null) throw fail('BAD_OFFER', 'That is not an offer this page wrote.', 400);
    if (o.endTime <= now() || o.endTime > now() + (OFFER_DAYS + 1) * 86_400) throw fail('BAD_OFFER', 'That offer has run out. Ask for a fresh one.', 400);

    const typed = { domain: DOMAIN, types: ORDER_TYPES, primaryType: 'OrderComponents', message: bet.components };
    let signed = false;
    try { signed = same(await recoverTypedDataAddress({ ...typed, signature }), o.maker); } catch { /* not a plain signature */ }
    // a contract wallet (a token-bound account, a Safe) signs through ERC-1271, which only the chain can check
    if (!signed) signed = await client().verifyTypedData({ ...typed, address: o.maker, signature }).catch(() => false);
    if (!signed) throw fail('BAD_SIGNATURE', 'That signature does not belong to the wallet making the offer.', 400);

    let r;
    try {
      r = await fetch(BOARD, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(bet), signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw fail('BOARD_UNAVAILABLE', 'The betfi board did not answer, so the offer was not posted. Nothing has moved; try again.', 503, e);
    }
    const j = await r.json().catch(() => null);
    if (r.ok) {
      boards.delete('board');
      return say(res, 200, null, { ok: true, hash: o.hash, existing: j?.existing === true });
    }
    if (r.status === 403) throw fail('POST_NEEDS_PASS', `Posting needs a ${PASSES.map((p) => p.label).join(' or a ')} in the wallet making the offer.`, 403);
    throw fail('BOARD_REFUSED', r.status >= 500 ? 'The betfi board is not taking offers right now. Nothing has moved; try again.' : 'The betfi board did not accept that offer.', r.status >= 500 ? 503 : 400, new Error(`${r.status} ${clean(String(j?.error || ''), 160)}`));
  } catch (e) {
    if (e?.planError) return say(res, e.status, e.code, e.detail);
    warn(`post: ${String(e?.message || e).slice(0, 160)}`);
    return say(res, 500, 'INTERNAL', 'Something went wrong on our side. Nothing has moved; try again.');
  }
}

export function register(app) {
  app.post(POST_PATH, postOffer);
}
