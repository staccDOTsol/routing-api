// Throwaway check of otc.mjs. Reads only; sends nothing and posts nothing to the live board.
//   export PATH=/opt/homebrew/opt/node@22/bin:$PATH
//   node server/ops/otc.test.mjs [--json]                 through the staccpad proxy
//   node server/ops/otc.test.mjs --direct                 the DRPC_KEY path, with a made-up key and lb.drpc.live played by this script
//   OP_FILE=./_otc.next.mjs node server/ops/otc.test.mjs  a draft
//
// Part A runs against the live board and chain as they are.
// Part B puts a synthetic board in front of the module (the live one is empty), with orders really signed by a
// key made up on the spot, and tells the RPC to pretend, for these reads only, that this key holds the NFTs it
// offers. Seaport itself then checks the signatures and moves both NFTs inside the test run.
// Part C posts an offer end to end with staccpad's own inbox code standing in for the live board.
import { Readable } from 'node:stream';
import { createPublicClient, encodeAbiParameters, hashTypedData, http, keccak256, pad, parseAbi, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
const DIRECT = process.argv.includes('--direct');
const FAKE_KEY = 'TESTKEY_made_up_0123456789';
if (DIRECT) process.env.DRPC_KEY = FAKE_KEY; else delete process.env.DRPC_KEY;
const plainFetch = globalThis.fetch;
const hits = { direct: 0, proxy: 0 };
let directMode = 'ok';
// lb.drpc.live is played by the staccpad proxy; the made-up key must never reach anything real
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const m = u.match(/^https:\/\/lb\.drpc\.live\/robinhood\/(.+)$/);
  if (m) {
    hits.direct++;
    if (m[1] !== FAKE_KEY) throw new Error('the test saw a dRPC key it did not make up');
    if (directMode === 'auth') return new Response(JSON.stringify({ message: 'Invalid JWT', code: 401 }), { status: 401, headers: { 'content-type': 'application/json' } });
    return plainFetch('https://staccpad.fun/rpc', init);
  }
  if (u === 'https://staccpad.fun/rpc') hits.proxy++;
  return plainFetch(url, init);
};
const otc = await import(process.env.OP_FILE || './otc.mjs');

const OWNER = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158';
const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395';
const HOMECOMING = '0x7c165Ae6E7BFD939Fee1ACA99Ca5aeDf85c52dD4';
const CCFF00 = '0x505A22Ffed8d37ebE580FfD98d2Cdb0021189146';
const STRAY = '0xC6132BD1B7eE344ba6a53fa203116D168cDc5307';
const BAGGERS = '0xf0415872Cd9283F2D7b687Fa2D8Be96B10cDAb88';
const CONTINUUM = '0xbd6553bb479309C869506C8EACb372209A460e2e';
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = `0x${'00'.repeat(32)}`;
const json = process.argv.includes('--json');
const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const nft = (collection, tokenId) => ({ kind: 'nft', id: `nft:4663:${collection.toLowerCase()}:${tokenId ?? 'any'}`, label: '', sub: '', chainId: 4663, collection, tokenId: tokenId === null ? null : String(tokenId), name: '', image: null, collectionName: '' });
const chain = createPublicClient({ transport: http('https://staccpad.fun/rpc', { timeout: 20_000, fetchFn: plainFetch }) });
const times = [];

let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`); };

function print(p) {
  console.log(`  headline: ${p.headline}`);
  console.log(`  pay:      ${p.pay.label}`);
  console.log(`  receive:  ${p.receive.label}`);
  p.legs.forEach((l, i) => {
    const e = l.exec;
    const how = e.type === 'tx' ? (e.tx ? `tx to ${e.tx.to} value ${e.tx.value} data ${e.tx.data.slice(0, 74)}... (${(e.tx.data.length - 2) / 2} bytes)` : 'tx null (quote only)')
      : (e.typedData ? `sign ${e.typedData.primaryType}, then POST ${e.submit.path} (order ${e.submit.body.bet.hash})` : 'sign (quote only)');
    console.log(`  leg ${i}:    [${l.kind} @${l.chainId}] ${l.label}\n            ${how}${l.note ? `\n            note: ${l.note}` : ''}`);
  });
  p.facts.forEach((f) => console.log(`  fact:     ${f.label}: ${f.value}${f.tone ? ` [${f.tone}]` : ''}${f.sub ? `\n            ${f.sub}` : ''}`));
  p.warnings.forEach((w) => console.log(`  warning:  ${w}`));
  console.log(`  contracts: ${p.contracts.map((c) => `${c.name} ${c.address}@${c.chainId}`).join(', ')}`);
}
function wellFormed(p, owner) {
  const problems = [];
  if (p.routing !== 'PLAN' || p.op !== 'otc') problems.push('routing/op');
  if (p.pay.amount !== null || p.pay.token !== null || p.receive.amount !== null || p.receive.token !== null) problems.push('an NFT side carries an amount');
  for (const l of p.legs) {
    if (l.exec.type === 'tx') {
      if (!owner) { if (l.exec.tx !== null) problems.push('quote-only leg carries a tx'); continue; }
      const tx = l.exec.tx;
      if (!tx) { problems.push('missing tx'); continue; }
      if (tx.chainId !== l.chainId || tx.value !== '0') problems.push('leg chain or value');
      if (!p.contracts.some((c) => c.chainId === tx.chainId && c.address.toLowerCase() === tx.to.toLowerCase())) problems.push(`undeclared target ${tx.to}`);
    } else if (l.exec.type === 'sign') {
      if (!l.exec.submit.path.startsWith('/api/op/otc/')) problems.push('submit path');
      if (owner && !l.exec.typedData) problems.push('nothing to sign');
    } else problems.push('exec type');
  }
  const text = JSON.stringify([p.headline, p.pay.label, p.receive.label, p.legs.map((l) => [l.label, l.note]), p.facts, p.warnings]);
  if (/[\u2014\u2015]/.test(text)) problems.push('em dash in copy');
  if (/tick/i.test(text)) problems.push('the word tick in copy');
  if (JSON.stringify(p).includes(FAKE_KEY) || /lb\.drpc\.live/.test(JSON.stringify(p))) problems.push('THE KEY OR ITS URL IS IN THE PLAN');
  return problems;
}
async function run(name, input, output, owner, expect = {}) {
  console.log(`\n== ${name} ${owner ? `for ${owner}` : '(quote only, no owner)'}`);
  try {
    const t0 = Date.now();
    const p = await otc.plan({ input, output, owner, slippage: 0.5 });
    times.push({ name, ms: Date.now() - t0 });
    console.log(`  built in ${Date.now() - t0} ms`);
    print(p);
    const problems = wellFormed(p, owner);
    check('plan is well formed', problems.length === 0, problems.join('; '));
    if (expect.kinds) check(`legs are ${expect.kinds.join(' + ')}`, p.legs.map((l) => l.kind).join(',') === expect.kinds.join(','), `got ${p.legs.map((l) => l.kind).join(',')}`);
    if (owner && expect.kinds?.includes('swap')) check('test run passed', p.facts.some((f) => f.label === 'Checked'));
    return p;
  } catch (e) {
    check(`plan failed: ${e.code || ''} ${e.detail || e.message}`, false, e.cause ? String(e.cause.message || e.cause).slice(0, 200) : '');
    return null;
  }
}
const expectFail = async (name, args, code) => {
  try { const p = await otc.plan(args); check(name, false, `no error: ${p.headline}`); }
  catch (e) { check(`${name}: ${e.code} (${e.status}) "${e.detail}"`, e.planError === true && e.code === code && typeof e.detail === 'string', e.code === code ? '' : String(e.cause?.message || '')); }
};

// ════════════════════════ the DRPC_KEY path ════════════════════════
if (DIRECT) {
  console.log('== direct dRPC (made-up key; lb.drpc.live is played by this script, backed by the staccpad proxy)');
  hits.direct = 0; hits.proxy = 0;
  await run('direct: post Stray Cucks #102 for any Baggers', nft(STRAY, 102), nft(BAGGERS, null), OWNER, { kinds: ['approve', 'sign'] });
  check(`every Robinhood read went straight to dRPC (direct ${hits.direct}, proxy ${hits.proxy})`, hits.direct >= 2 && hits.proxy === 0);
  directMode = 'auth'; hits.direct = 0; hits.proxy = 0;
  await run('fallback after 401: post Stray Cucks #101 for any Baggers', nft(STRAY, 101), nft(BAGGERS, null), OWNER, { kinds: ['approve', 'sign'] });
  check(`the proxy answered (direct tried ${hits.direct}, proxy ${hits.proxy})`, hits.proxy >= 2 && hits.direct >= 1 && hits.direct <= 2);
  hits.direct = 0;
  await run('while direct rests: post Stray Cucks #96 for any Baggers', nft(STRAY, 96), nft(BAGGERS, null), OWNER, { kinds: ['approve', 'sign'] });
  check(`direct is not asked again while it rests (${hits.direct} tries)`, hits.direct === 0);
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

// ════════════════════════ Part A: live, as it is ════════════════════════
console.log('== match');
check('NFT -> NFT on Robinhood', otc.match(nft(STRAY, 102), nft(BAGGERS, null)) === true);
check('a token is not this', otc.match({ kind: 'token', chainId: 4663, address: 'NATIVE' }, nft(BAGGERS, 1)) === false);
check('an NFT on another chain is not this', otc.match({ ...nft(STRAY, 1), chainId: 8453 }, nft(BAGGERS, 1)) === false);
check('null is not this', otc.match(null, null) === false);

console.log('\n== live board (it is what it is)');
const liveBoard = await (await plainFetch('https://staccpad.fun/api/swap/bets?board=1')).json();
console.log(`  staccpad.fun/api/swap/bets?board=1 holds ${liveBoard.bets?.length} order(s)`);
const owned = await otc.catalog('nft-owned', { owner: OWNER });
const buyable = await otc.catalog('nft-buyable', { owner: OWNER, input: nft(HOMECOMING, 4582) });
const browse = await otc.catalog('nft-buyable', { owner: OWNER });
console.log(`  catalog nft-owned: ${owned.length}, nft-buyable for Homecoming #4582: ${buyable.length}, nft-buyable with no input: ${browse.length}`);
check('catalog answers arrays', Array.isArray(owned) && Array.isArray(buyable) && Array.isArray(browse));
check('catalog(token) is empty', (await otc.catalog('token', { owner: OWNER })).length === 0);
check('catalog without an owner is empty for nft-owned', (await otc.catalog('nft-owned', {})).length === 0);

// Nothing on the live board gives a Baggers for a Stray Cucks, so this is an offer to post.
const SEAPORT_VIEW = parseAbi([
  'struct OfferItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; }',
  'struct ConsiderationItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; address recipient; }',
  'struct OrderComponents { address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 counter; }',
  'function getOrderHash(OrderComponents order) view returns (bytes32)',
  'function information() view returns (string version, bytes32 domainSeparator, address conduitController)',
]);
const big = (c) => ({ ...c, offer: c.offer.map((i) => ({ ...i, identifierOrCriteria: BigInt(i.identifierOrCriteria), startAmount: 1n, endAmount: 1n })), consideration: c.consideration.map((i) => ({ ...i, identifierOrCriteria: BigInt(i.identifierOrCriteria), startAmount: 1n, endAmount: 1n })), startTime: BigInt(c.startTime), endTime: BigInt(c.endTime), salt: BigInt(c.salt), counter: BigInt(c.counter) });
async function checkAgainstSeaport(p) {
  const leg = p.legs.find((l) => l.exec.type === 'sign');
  const { typedData, submit } = leg.exec;
  const onChain = await chain.readContract({ address: SEAPORT, abi: SEAPORT_VIEW, functionName: 'getOrderHash', args: [big(typedData.message)] });
  check(`Seaport.getOrderHash on chain equals the order hash in the plan (${onChain})`, onChain.toLowerCase() === submit.body.bet.hash.toLowerCase());
  const [, separator] = await chain.readContract({ address: SEAPORT, abi: SEAPORT_VIEW, functionName: 'information' });
  const { EIP712Domain: _d, ...types } = typedData.types;
  const digest = hashTypedData({ domain: typedData.domain, types, primaryType: typedData.primaryType, message: typedData.message });
  check('the digest the wallet signs is keccak(0x1901, Seaport\'s own domain separator, that hash)', digest === keccak256(`0x1901${separator.slice(2)}${onChain.slice(2)}`));
  return { typedData, submit };
}
const post1 = await run('post: Stray Cucks #102 for any Baggers (approval needed)', nft(STRAY, 102), nft(BAGGERS, null), OWNER, { kinds: ['approve', 'sign'] });
if (post1) await checkAgainstSeaport(post1);
const holder1 = await chain.readContract({ address: CONTINUUM, abi: parseAbi(['function ownerOf(uint256) view returns (address)']), functionName: 'ownerOf', args: [1n] }).catch(() => null);
console.log(`\n  (Continuum Season 1 #1 is held by ${holder1})`);
const post2 = await run('post: Homecoming #4582 for Continuum Season 1 #1 (Seaport already allowed)', nft(HOMECOMING, 4582), nft(CONTINUUM, 1), OWNER, { kinds: ['sign'] });
if (post2) await checkAgainstSeaport(post2);
await run('post, quote only', nft(STRAY, 102), nft(BAGGERS, null), null, { kinds: ['approve', 'sign'] });

console.log('\n== expected failures (live)');
await expectFail('an NFT that is not in the wallet', { input: nft(CONTINUUM, 1), output: nft(BAGGERS, null), owner: OWNER }, 'NOT_YOURS');
await expectFail('the same NFT on both sides', { input: nft(STRAY, 102), output: nft(STRAY, 102), owner: OWNER }, 'SAME_NFT');
await expectFail('asking for an NFT already held', { input: nft(STRAY, 102), output: nft(STRAY, 101), owner: OWNER }, 'ALREADY_YOURS');
await expectFail('asking for something that is not an NFT collection', { input: nft(STRAY, 102), output: nft('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', null), owner: OWNER }, 'NOT_AN_NFT');
await expectFail('no exact NFT on the pay side', { input: nft(STRAY, null), output: nft(BAGGERS, null), owner: OWNER }, 'PICK_YOUR_NFT');
await expectFail('bad owner', { input: nft(STRAY, 102), output: nft(BAGGERS, null), owner: 'nope' }, 'BAD_OWNER');

// ════════════════════════ Part B: a synthetic board, real signatures, real Seaport ════════════════════════
console.log('\n\n== synthetic board: orders signed by a throwaway key, settled by the real Seaport inside a test run');
const maker = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
console.log(`  maker ${maker.address} (made up for this run; holds nothing on chain)`);

const fields = (list) => list.split(',').map((f) => { const [name, type] = f.split(':'); return { name, type }; });
const ORDER_TYPES = {
  OrderComponents: fields('offerer:address,zone:address,offer:OfferItem[],consideration:ConsiderationItem[],orderType:uint8,startTime:uint256,endTime:uint256,zoneHash:bytes32,salt:uint256,conduitKey:bytes32,counter:uint256'),
  OfferItem: fields('itemType:uint8,token:address,identifierOrCriteria:uint256,startAmount:uint256,endAmount:uint256'),
  ConsiderationItem: fields('itemType:uint8,token:address,identifierOrCriteria:uint256,startAmount:uint256,endAmount:uint256,recipient:address'),
};
const DOMAIN = { name: 'Seaport', version: '1.6', chainId: 4663, verifyingContract: SEAPORT };
const { hashStruct } = await import('viem');
const leafOf = (i) => keccak256(pad(toHex(BigInt(i)), { size: 32 }));
const pairOf = (a, b) => (BigInt(a) < BigInt(b) ? keccak256(`0x${a.slice(2)}${b.slice(2)}`) : keccak256(`0x${b.slice(2)}${a.slice(2)}`));
function rootOf(ids) { let layer = ids.map(leafOf).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)); while (layer.length > 1) { const next = []; for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? pairOf(layer[i], layer[i + 1]) : layer[i]); layer = next; } return layer[0]; }
const T = Math.floor(Date.now() / 1000);
let salt = 1n;
async function order({ giveId, want, signer = maker, endTime = T + 3600, counterparty = null, extra = [] }) {
  const components = {
    offerer: maker.address, zone: ZERO,
    offer: [{ itemType: 2, token: CONTINUUM, identifierOrCriteria: String(giveId), startAmount: '1', endAmount: '1' }],
    consideration: [{ ...want.item, recipient: maker.address }, ...extra],
    orderType: 0, startTime: String(T - 120), endTime: String(endTime), zoneHash: ZERO32, salt: String(salt++), conduitKey: ZERO32, counter: '0',
  };
  const signature = await signer.signTypedData({ domain: DOMAIN, types: ORDER_TYPES, primaryType: 'OrderComponents', message: components });
  return { v: 1, chainId: 4663, counterparty, lock: counterparty ? 'item' : 'open', components, hash: hashStruct({ data: components, primaryType: 'OrderComponents', types: ORDER_TYPES }), signature, ...(want.sets ? { sets: want.sets } : {}) };
}
const exact = (token, tokenId) => ({ item: { itemType: 2, token, identifierOrCriteria: String(tokenId), startAmount: '1', endAmount: '1' } });
const any = (token) => ({ item: { itemType: 4, token, identifierOrCriteria: '0', startAmount: '1', endAmount: '1' } });
const oneOf = (token, ids) => { const root = rootOf(ids); return { item: { itemType: 4, token, identifierOrCriteria: BigInt(root).toString(), startAmount: '1', endAmount: '1' }, sets: { [root.toLowerCase()]: { ids: ids.map(String) } } }; };

const O1 = await order({ giveId: 1, want: exact(HOMECOMING, 4582) });
const O2 = await order({ giveId: 2, want: any(STRAY) });
const O3 = await order({ giveId: 3, want: oneOf(BAGGERS, [183, 238, 999999]) });
const O4 = await order({ giveId: 900004, want: exact(HOMECOMING, 5125) }); // the maker does not hold what it offers
const O5 = await order({ giveId: 5, want: exact(HOMECOMING, 5125), endTime: T - 10 }); // expired
const O6 = await order({ giveId: 6, want: exact(HOMECOMING, 5125), extra: [{ itemType: 1, token: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', identifierOrCriteria: '0', startAmount: '1000', endAmount: '1000', recipient: maker.address }] }); // also wants WETH: not one for one
const O7 = await order({ giveId: 7, want: exact(HOMECOMING, 5125), signer: stranger }); // signed by someone else
const O8 = await order({ giveId: 8, want: exact(HOMECOMING, 4309), counterparty: OWNER }); // addressed to the owner: lives in the mailbox

// For these reads only, the chain is told that the maker holds Continuum #1,2,3,5,6,7,8 with Seaport allowed to
// move each, and one CCFF00 Square (the board's posting pass). Standard OpenZeppelin layout: _owners at slot 2,
// _balances at 3, _tokenApprovals at 4 (found by reading the live contracts' storage).
const slot = (types, values) => keccak256(encodeAbiParameters(types.map((type) => ({ type })), values));
const word = (v) => pad(typeof v === 'bigint' ? toHex(v) : v, { size: 32 });
const heldIds = [1n, 2n, 3n, 5n, 6n, 7n, 8n];
const pretend = (accounts) => {
  const out = { [CONTINUUM]: { stateDiff: {} }, [CCFF00]: { stateDiff: {} } };
  for (const [who, ids] of accounts) {
    for (const i of ids) {
      out[CONTINUUM].stateDiff[slot(['uint256', 'uint256'], [i, 2n])] = word(who);
      out[CONTINUUM].stateDiff[slot(['uint256', 'uint256'], [i, 4n])] = word(SEAPORT);
    }
    out[CONTINUUM].stateDiff[slot(['address', 'uint256'], [who, 3n])] = word(BigInt(ids.length));
    out[CCFF00].stateDiff[slot(['address', 'uint256'], [who, 3n])] = word(1n);
  }
  return out;
};
let overrides = pretend([[maker.address, heldIds]]);
let txOverrides = {}; // on top, but only inside test runs of transactions (calls that carry a sender)
let board = [O1, O2, O3, O4, O5, O6, O7];
let mailbox = [O8];
let boardPosts = [];
let upstreamPost = async () => new Response(JSON.stringify({ error: 'not expected' }), { status: 500 });
const realFetch = globalThis.fetch;
// warm staccpad's wallet index: its first answer for a wallet takes about ten seconds
await plainFetch(`https://staccpad.fun/api/wallet/${OWNER}/nfts`).then((r) => r.text()).catch(() => {});
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://staccpad.fun/api/swap/bets')) {
    if (init?.method === 'POST') { boardPosts.push(JSON.parse(init.body)); return upstreamPost(JSON.parse(init.body)); }
    return new Response(JSON.stringify({ bets: u.includes('board=1') ? board : mailbox }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u === 'https://staccpad.fun/rpc' && typeof init?.body === 'string') {
    const b = JSON.parse(init.body);
    const withSender = (calls) => calls.some((c) => c.from);
    if (!Array.isArray(b) && b.method === 'eth_call') b.params[2] = { ...(b.params[2] || {}), ...overrides, ...(b.params[0].from ? txOverrides : {}) };
    if (!Array.isArray(b) && b.method === 'eth_simulateV1') b.params[0].blockStateCalls[0].stateOverrides = { ...overrides, ...(withSender(b.params[0].blockStateCalls[0].calls) ? txOverrides : {}) };
    return realFetch(url, { ...init, body: JSON.stringify(b) });
  }
  return realFetch(url, init);
};
// the module keeps a board for 5 s and then serves the old copy once more while it reloads: wait, ask (which
// starts the reload), and wait for the reload to land, so that the next answer is the new board
const fresh = async () => {
  await new Promise((r) => setTimeout(r, 5_200));
  await otc.catalog('nft-buyable', { owner: OWNER });
  await otc.catalog('nft-buyable', {});
  await new Promise((r) => setTimeout(r, 1_500));
  await new Promise((r) => setTimeout(r, 5_200));
};
await fresh();

console.log('\n== catalog against the synthetic board');
const mineWanted = await otc.catalog('nft-owned', { owner: OWNER });
for (const t of mineWanted) console.log(`  owned+wanted: ${t.label} [${t.id}] :: ${t.sub}${t.image ? ' (image)' : ''}`);
const ids = new Set(mineWanted.map((t) => t.id));
const idOf = (c, i) => `nft:4663:${c.toLowerCase()}:${i}`;
check('Homecoming #4582 is wanted (O1, a named id)', ids.has(idOf(HOMECOMING, 4582)));
check('Homecoming #4309 is wanted (O8, addressed to this wallet through the mailbox)', ids.has(idOf(HOMECOMING, 4309)));
check('Homecoming #5125 is wanted only by the wrongly signed O7 (the chain cannot tell until it is run)', ids.has(idOf(HOMECOMING, 5125)));
check('every Stray Cucks the wallet holds is wanted (O2, any of the collection)', ids.has(idOf(STRAY, 102)) && ids.has(idOf(STRAY, 88)) && [...ids].filter((x) => x.startsWith(`nft:4663:${STRAY.toLowerCase()}`)).length >= 2);
check('Baggers #183 and #238 are wanted, #141 is not (O3, a set)', ids.has(idOf(BAGGERS, 183)) && ids.has(idOf(BAGGERS, 238)) && !ids.has(idOf(BAGGERS, 141)));
check('every thing has the NftThing fields', mineWanted.every((t) => t.kind === 'nft' && t.chainId === 4663 && typeof t.label === 'string' && t.label && typeof t.sub === 'string' && /^[0-9]+$/.test(t.tokenId) && typeof t.collectionName === 'string' && 'image' in t && 'name' in t));

const forHome = await otc.catalog('nft-buyable', { owner: OWNER, input: nft(HOMECOMING, 4582) });
for (const t of forHome) console.log(`  for Homecoming #4582: ${t.label} [${t.id}] :: ${t.sub}`);
check('the board gives Continuum #1 for Homecoming #4582, and nothing else', forHome.length === 1 && forHome[0].id === idOf(CONTINUUM, 1));
const forStray = await otc.catalog('nft-buyable', { owner: OWNER, input: nft(STRAY, 102) });
check('the board gives Continuum #2 for Stray Cucks #102', forStray.length === 1 && forStray[0].id === idOf(CONTINUUM, 2));
const forBag141 = await otc.catalog('nft-buyable', { owner: OWNER, input: nft(BAGGERS, 141) });
check('the board gives nothing for Baggers #141 (not in the set)', forBag141.length === 0);
const all = await otc.catalog('nft-buyable', { owner: OWNER });
for (const t of all) console.log(`  on the board: ${t.label} [${t.id}] :: ${t.sub}`);
const allIds = new Set(all.map((t) => t.id));
check('browse shows the live one-for-one orders', [1, 2, 3, 7, 8].every((i) => allIds.has(idOf(CONTINUUM, i))));
check('an order whose maker no longer holds the NFT is not shown (O4)', !allIds.has(idOf(CONTINUUM, 900004)));
check('an expired order is not shown (O5)', !allIds.has(idOf(CONTINUUM, 5)));
check('an order that also wants WETH is not shown (O6)', !allIds.has(idOf(CONTINUUM, 6)));
const anon = await otc.catalog('nft-buyable', {});
check('without a wallet the mailbox order (O8) is not shown', !anon.some((t) => t.id === idOf(CONTINUUM, 8)) && anon.some((t) => t.id === idOf(CONTINUUM, 1)));

const take1 = await run('take O1: Homecoming #4582 for Continuum #1 (named id, Seaport already allowed)', nft(HOMECOMING, 4582), nft(CONTINUUM, 1), OWNER, { kinds: ['swap'] });
const take2 = await run('take O2: Stray Cucks #102 for any Continuum (any-of-collection order, approval needed)', nft(STRAY, 102), nft(CONTINUUM, null), OWNER, { kinds: ['approve', 'swap'] });
const take3 = await run('take O3: Baggers #238 for Continuum #3 (set order, merkle proof, approval needed)', nft(BAGGERS, 238), nft(CONTINUUM, 3), OWNER, { kinds: ['approve', 'swap'] });
await run('take O8: Homecoming #4309 for Continuum #8 (addressed to this wallet)', nft(HOMECOMING, 4309), nft(CONTINUUM, 8), OWNER, { kinds: ['swap'] });
await run('take O1, quote only', nft(HOMECOMING, 4582), nft(CONTINUUM, 1), null, { kinds: ['approve', 'swap'] });
await expectFail('take O7: the order was signed by someone else, Seaport refuses it in the test run', { input: nft(HOMECOMING, 5125), output: nft(CONTINUUM, 7), owner: OWNER }, 'WOULD_REVERT');
await expectFail('take O1 with an NFT the wallet does not hold', { input: nft(HOMECOMING, 1), output: nft(CONTINUUM, 1), owner: OWNER }, 'NOT_YOURS');
await run('Baggers #141 is not in O3\'s set, so this becomes an offer to post', nft(BAGGERS, 141), nft(CONTINUUM, 3), OWNER, { kinds: ['approve', 'sign'] });

// The same calldata the existing betfi code (nft-range cli) builds for these orders.
try {
  const ref = await import('/Users/stacc/nft-range/cli/src/betfi.mjs');
  const a = ref.askFulfillment({ bet: O1, isNative: false, total: 0n });
  check('take O1 calldata equals nft-range betfi.mjs fulfillOrder calldata', take1?.legs.at(-1).exec.tx.data === a.data);
  const b = ref.bidFulfillment({ bet: O2, anyId: true, tokenId: null }, 102n);
  check('take O2 calldata equals nft-range betfi.mjs fulfillAdvancedOrder calldata', take2?.legs.at(-1).exec.tx.data === b.data);
} catch (e) { check(`reference calldata: ${e.message}`, false); }
check('take O3 approves the single token, not the collection', take3?.legs[0].exec.tx.data.startsWith('0x095ea7b3') && take3.legs[0].exec.tx.to.toLowerCase() === BAGGERS.toLowerCase());

// a collection that refuses Seaport: its code is swapped for one that reverts the way Limit Break's validator does
{
  // inside the test run only, the collection's code answers every call the way Limit Break's validator does:
  // PUSH4 1de5204e, shifted to the top of a word, stored, and four bytes of it reverted
  txOverrides = { [STRAY]: { code: '0x631de5204e60e01b60005260046000fd' } };
  await expectFail('a collection that only lets listed marketplaces move it', { input: nft(STRAY, 102), output: nft(CONTINUUM, null), owner: OWNER }, 'WOULD_REVERT');
  txOverrides = {};
}
// eth_simulateV1 not served: one transaction still runs through eth_call, an approval plus a swap is refused
{
  const wrapped = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://staccpad.fun/rpc' && typeof init?.body === 'string' && JSON.parse(init.body).method === 'eth_simulateV1') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such method' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return wrapped(url, init);
  };
  await run('take O1 without eth_simulateV1 (eth_call)', nft(HOMECOMING, 4582), nft(CONTINUUM, 1), OWNER, { kinds: ['swap'] });
  await expectFail('take O2 without eth_simulateV1 cannot be tested and is refused', { input: nft(STRAY, 102), output: nft(CONTINUUM, null), owner: OWNER }, 'SIMULATION_UNAVAILABLE');
  globalThis.fetch = wrapped;
}

// ════════════════════════ Part C: post an offer, end to end, without touching the live board ════════════════════════
console.log('\n\n== posting: plan, sign, POST /api/op/otc/post, staccpad\'s own inbox code, then take it');
const routes = {};
otc.register({ post: (path, handler) => { routes[path] = handler; } });
check('register adds POST /api/op/otc/post', typeof routes['/api/op/otc/post'] === 'function');
const call = async (body, { raw = false } = {}) => {
  const res = { code: 0, out: null, status(c) { this.code = c; return this; }, set() { return this; }, json(o) { this.out = o; return this; } };
  const req = raw ? Readable.from([Buffer.from(JSON.stringify(body))]) : { body };
  await routes['/api/op/otc/post'](req, res);
  return res;
};
const { createSwapInbox } = await import('/Users/stacc/staccpad-ai/swap-inbox.mjs');
const { verifyTypedData } = await import('viem');
let gateOpen = true;
const inbox = createSwapInbox({ statePath: null, verify: (a) => verifyTypedData(a).catch(() => false), gate: async () => gateOpen });
upstreamPost = async (bet) => {
  try { return new Response(JSON.stringify(await inbox.put(bet)), { status: 200, headers: { 'content-type': 'application/json' } }); }
  catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: e.status || 503, headers: { 'content-type': 'application/json' } }); }
};

// a second made-up wallet posts: it "holds" Continuum #20 and a pass, and wants any Stray Cucks
const poster = privateKeyToAccount(generatePrivateKey());
overrides = pretend([[maker.address, heldIds], [poster.address, [20n]]]);
// its Continuum #20 is not yet allowed to Seaport: clear the pretend approval so the plan has to ask for it
delete overrides[CONTINUUM].stateDiff[slot(['uint256', 'uint256'], [20n, 4n])];
// a wallet with no gas cannot be told a fee; give the pretend poster some
overrides[poster.address] = { balance: '0x2386f26fc10000' };
const offer = await run('post from a made-up wallet: Continuum #20 for any Stray Cucks', nft(CONTINUUM, 20), nft(STRAY, null), poster.address, { kinds: ['approve', 'sign'] });
if (offer) {
  const { typedData, submit } = await checkAgainstSeaport(offer);
  const { EIP712Domain: _d, ...types } = typedData.types;
  const signature = await poster.signTypedData({ domain: typedData.domain, types, primaryType: typedData.primaryType, message: typedData.message });

  let r = await call({ ...submit.body, signature: `${signature.slice(0, -4)}0000` });
  check(`a broken signature is refused: ${r.code} ${r.out?.errorCode}`, r.code === 400 && r.out.errorCode === 'BAD_SIGNATURE' && boardPosts.length === 0);
  r = await call({ ...submit.body, signature: await stranger.signTypedData({ domain: typedData.domain, types, primaryType: typedData.primaryType, message: typedData.message }) });
  check(`someone else's signature is refused: ${r.code} ${r.out?.errorCode}`, r.code === 400 && r.out.errorCode === 'BAD_SIGNATURE' && boardPosts.length === 0);
  const fat = structuredClone(submit.body.bet); fat.components.consideration.push({ itemType: 1, token: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', identifierOrCriteria: '0', startAmount: '5', endAmount: '5', recipient: poster.address });
  r = await call({ bet: fat, signature });
  check(`an order with anything extra in it is refused: ${r.code} ${r.out?.errorCode}`, r.code === 400 && r.out.errorCode === 'BAD_OFFER' && boardPosts.length === 0);
  const moved = structuredClone(submit.body.bet); moved.components.offer[0].identifierOrCriteria = '21';
  r = await call({ bet: moved, signature });
  check(`an order edited after signing is refused: ${r.code} ${r.out?.errorCode}`, r.code === 400 && boardPosts.length === 0);
  r = await call({ nonsense: true });
  check(`nonsense is refused: ${r.code} ${r.out?.errorCode}`, r.code === 400 && boardPosts.length === 0);

  gateOpen = false;
  r = await call({ ...submit.body, signature });
  check(`the board's posting gate comes back as a sentence: ${r.code} ${r.out?.errorCode} "${r.out?.detail}"`, r.code === 403 && r.out.errorCode === 'POST_NEEDS_PASS');
  gateOpen = true;
  r = await call({ ...submit.body, signature }, { raw: true });
  check(`the signed offer is accepted by staccpad's inbox code: ${r.code} ${JSON.stringify(r.out)}`, r.code === 200 && r.out.ok === true && r.out.hash === submit.body.bet.hash && r.out.existing === false);
  r = await call({ ...submit.body, signature });
  check(`posting it twice is harmless: ${r.code} ${JSON.stringify(r.out)}`, r.code === 200 && r.out.existing === true);

  // now it is on (the stand-in) board: the owner sees it and can take it with a Stray Cucks
  board = await inbox.board(null);
  mailbox = [];
  check('the inbox now lists the offer as an open order', board.length === 1 && board[0].hash === submit.body.bet.hash);
  // once posted the poster has approved: pretend that too
  overrides[CONTINUUM].stateDiff[slot(['uint256', 'uint256'], [20n, 4n])] = word(SEAPORT);
  await fresh();
  const seen = await otc.catalog('nft-buyable', { owner: OWNER, input: nft(STRAY, 96) });
  check('the owner is offered Continuum #20 for a Stray Cucks', seen.length === 1 && seen[0].id === idOf(CONTINUUM, 20));
  await run('take the freshly posted offer: Stray Cucks #96 for Continuum #20', nft(STRAY, 96), nft(CONTINUUM, 20), OWNER, { kinds: ['approve', 'swap'] });
}
// a wallet without a pass is told before it signs anything
{
  const nobody = privateKeyToAccount(generatePrivateKey());
  overrides = pretend([[nobody.address, [30n]]]);
  delete overrides[CCFF00];
  board = []; mailbox = [];
  await fresh();
  await expectFail('posting without a pass', { input: nft(CONTINUUM, 30), output: nft(STRAY, null), owner: nobody.address }, 'POST_NEEDS_PASS');
}
globalThis.fetch = realFetch;

console.log('\n== speed (through the staccpad proxy from this machine)');
for (const t of times) console.log(`  ${String(t.ms).padStart(5)} ms  ${t.name}`);
const slow = times.filter((t) => t.ms > 2_000);
check(`every plan under 2 s (slowest ${Math.max(...times.map((t) => t.ms))} ms)`, slow.length === 0, slow.map((t) => `${t.name}: ${t.ms} ms`).join('; '));

if (json && take3) console.log(`\n== one plan, whole\n${show(take3)}`);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
