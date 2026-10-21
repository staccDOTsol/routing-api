// node --test arb.test.mjs            what needs no network
// ARB_LIVE=1 node --test arb.test.mjs  the same, and the module against Robinhood Chain itself (reads and
//                                      simulations only: nothing is ever sent)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as arb from './arb.mjs';

const { human, pctOf, upBy, downBy, keyed, seal, tokenIdOf, reason } = arb._internals;
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = `0x${'0'.repeat(64)}`;
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const WIZ = '0xe5744D0e6Ea60CDE94F720f4A17Cd9Eb65e92c32';
const tok = (chainId, address, extra = {}) => ({ kind: 'token', chainId, address, ...extra });
const nft = (chainId, collection, tokenId) => ({ kind: 'nft', chainId, collection, tokenId });
const refused = async (p) => { try { await p; } catch (e) { return e; } throw new Error('was not refused'); };

test('match: two tokens or an NFT and a token, on one chain this module reads', () => {
  assert.equal(arb.match(tok(4663, 'NATIVE'), tok(4663, 'NATIVE')), true, 'the same token both sides is a real request');
  assert.equal(arb.match(tok(4663, 'NATIVE'), tok(4663, USDG)), true);
  assert.equal(arb.match(tok(8453, WIZ), tok(8453, 'NATIVE')), true);
  assert.equal(arb.match(tok(4663, 'NATIVE'), tok(8453, 'NATIVE')), false, 'two chains is somebody else\'s trade');
  assert.equal(arb.match(tok(999999, 'NATIVE'), tok(999999, 'NATIVE')), false, 'a chain it does not read');
  assert.equal(arb.match(tok(4663, 'not-an-address'), tok(4663, 'NATIVE')), false);
  assert.equal(arb.match(nft(4663, WIZ, '7'), tok(4663, 'NATIVE')), true);
  assert.equal(arb.match(nft(4663, WIZ, null), tok(4663, 'NATIVE')), false, 'selling needs an id');
  assert.equal(arb.match(tok(4663, 'NATIVE'), nft(4663, WIZ, null)), true, 'buying with no id means the floor');
  assert.equal(arb.match(nft(4663, WIZ, '1'), nft(4663, WIZ, '2')), false);
  assert.equal(arb.match(null, tok(4663, 'NATIVE')), false);
  assert.equal(arb.match({ kind: 'loan', chainId: 4663 }, tok(4663, 'NATIVE')), false);
});

test('amounts in words are exact, short, and never floats', () => {
  assert.equal(human(1351213391879269n), '0.001351');
  assert.equal(human(13290364409045161n), '0.01329');
  assert.equal(human(10n ** 18n), '1');
  assert.equal(human(123456789n, 6), '123.4567');
  assert.equal(human(17856624780800n, 18, 3), '0.0000178');
  assert.equal(human(-5n * 10n ** 17n), '-0.5');
  assert.equal(human(0n), '0');
  assert.equal(pctOf(11921294392385092n, 1351213391879269n), '882');
  assert.equal(pctOf(5n, 100n), '5');
  assert.equal(pctOf(15n, 1000n), '1.5');
  assert.equal(pctOf(1n, 0n), '0');
});

test('tolerance is computed the way the page\'s executor computes it', () => {
  // exec.ts opPlan: budget = pay * BigInt(Math.round((100 + slippage) * 100)) / 10_000n
  for (const [x, s] of [[1351213391879269n, 1], [10n ** 18n, 0.5], [7n, 2.5], [123456789n, 0.01], [999n, 20]]) {
    assert.equal(upBy(x, s), (x * BigInt(Math.round((100 + s) * 100))) / 10_000n);
    assert.ok(downBy(x, s) <= x);
  }
  assert.equal(upBy(10_000n, 1), 10_100n);
  assert.equal(downBy(10_000n, 1), 9_900n);
  assert.equal(downBy(10_000n, 100), 0n);
  assert.equal(downBy(10_000n, 250), 0n, 'never negative');
});

test('token ids', () => {
  assert.equal(tokenIdOf('4904'), 4904n);
  assert.equal(tokenIdOf(7), 7n);
  assert.equal(tokenIdOf('0'), 0n);
  for (const bad of [null, undefined, '', '-1', '1.5', '0x10', 'abc', {}, 1.5, '9'.repeat(80)]) assert.equal(tokenIdOf(bad), null);
});

test('a plan that would trip the executor is caught before it leaves', () => {
  const router = '0x914658DE2A13bCb38BDADA4364d60A1e9d360408';
  const eth = { chainId: 4663, address: 'NATIVE', symbol: 'ETH', decimals: 18 };
  const leg = (to, value) => ({ kind: 'buy', chainId: 4663, exec: { type: 'tx', tx: { chainId: 4663, to, value: String(value), data: '0x' } } });
  const plan = (legs, contracts, pay = { amount: '1000', token: eth }) => ({ legs, contracts: contracts.map((address) => ({ chainId: 4663, address, name: 'x' })), pay });
  assert.ok(seal(plan([leg(router, 1010)], [router]), 1), 'the amount shown plus the tolerance is allowed');
  assert.throws(() => seal(plan([leg(router, 1011)], [router]), 1), /more of the gas token/);
  assert.throws(() => seal(plan([leg(router, 600), leg(router, 600)], [router]), 1), /more of the gas token/, 'the budget is for every step together');
  assert.throws(() => seal(plan([leg(WETH, 0)], [router]), 1), /does not list/);
  assert.throws(() => seal(plan([leg(router, 1)], [router], { amount: '5', token: { ...eth, address: WIZ } }), 1), /more of the gas token/, 'paying with a token leaves no gas token to send');
  assert.ok(seal(plan([{ kind: 'buy', chainId: 4663, exec: { type: 'tx', tx: null } }, { kind: 'swap', chainId: 4663, exec: { type: 'router', query: {} } }], []), 1), 'a preview and a router leg carry nothing to check');
});

test('refusals from contracts are said in words', () => {
  assert.equal(reason({ data: '0xe450d38c0000', message: 'execution reverted' }), 'the pool could not hand over a whole NFT');
  assert.equal(reason({ message: 'execution reverted: slippage' }), 'the price moved past your limit');
  assert.equal(reason({ data: '0x08c379a0' + '0'.repeat(62) + '20' + '0'.repeat(62) + '09' + Buffer.from('fifo race').toString('hex').padEnd(64, '0') }), 'someone else took that NFT first');
  assert.equal(reason({ data: '0xdeadbeef' }), 'a contract refused it');
  assert.equal(reason(null), 'a contract refused it');
});

// ───────────────────────── the bet board (fixtures from stacc-arb test/betfi.test.mjs) ─────────────────────────

const later = String(Math.floor(Date.now() / 1000) + 3600);
const COLLECTION = '0xc21cEf8315f1DF2b570bAf9808a1B86378013C36';
const MAKER = '0xc7F55a2D2e8B386aBaFeF9245AD640193294fAb6';
const bet = (offer, consideration) => ({
  v: 1, chainId: 4663, counterparty: null, lock: 'open', hash: `0x${'ab'.repeat(32)}`, signature: `0x${'cd'.repeat(65)}`,
  components: { offerer: MAKER, zone: ZERO, offer, consideration, orderType: 0, startTime: '1', endTime: later, zoneHash: ZERO32, salt: '1', conduitKey: ZERO32, counter: '0' },
});
const nftItem = (id) => ({ itemType: 2, token: COLLECTION, identifierOrCriteria: String(id), startAmount: '1', endAmount: '1' });
const ethItem = (wei) => ({ itemType: 0, token: ZERO, identifierOrCriteria: '0', startAmount: wei, endAmount: wei, recipient: MAKER });
const wethItem = (wei) => ({ itemType: 1, token: WETH, identifierOrCriteria: '0', startAmount: wei, endAmount: wei });

test('board asks and bids normalise; zones, expired, promised and id-set orders are left out', () => {
  const ask = arb.normaliseBet(bet([nftItem(39)], [ethItem('30000000000000000')]));
  assert.equal(ask.kind, 'ask');
  assert.equal(ask.tokenId, 39n);
  assert.equal(ask.total, 30000000000000000n);
  assert.equal(ask.money, 'NATIVE');
  const fill = arb.fillBet(ask);
  assert.equal(fill.functionName, 'fulfillOrder');
  assert.equal(fill.value, 30000000000000000n, 'an ask in the gas token is paid with the call');
  assert.ok(fill.data.startsWith('0xb3a34c4c'));
  assert.equal(fill.to, '0x0000000000000068F116a894984e2DB1123eB395');

  const wethAsk = arb.normaliseBet(bet([nftItem(40)], [{ ...wethItem('500'), recipient: MAKER }]));
  assert.equal(wethAsk.money, WETH.toLowerCase());
  assert.equal(arb.fillBet(wethAsk).value, 0n, 'an ask in a token sends no gas token');

  const anyBid = arb.normaliseBet(bet([wethItem('1000')], [{ itemType: 4, token: COLLECTION, identifierOrCriteria: '0', startAmount: '1', endAmount: '1', recipient: MAKER }]));
  assert.equal(anyBid.kind, 'bid');
  assert.equal(anyBid.tokenId, null);
  assert.equal(anyBid.net, 1000n);
  assert.equal(anyBid.money, WETH.toLowerCase());
  assert.equal(arb.fillBet(anyBid, 7n).functionName, 'fulfillAdvancedOrder');

  const exact = arb.normaliseBet(bet([wethItem('1000')], [{ ...nftItem(5), recipient: ZERO }]));
  assert.equal(exact.tokenId, 5n);
  assert.equal(arb.fillBet(exact, 5n).functionName, 'fulfillOrder');
  assert.throws(() => arb.fillBet(exact, 6n), /different NFT/);

  const zoned = bet([nftItem(1)], [ethItem('1')]);
  zoned.components.zone = '0x0000000000000000000000000000000000000001';
  assert.equal(arb.normaliseBet(zoned), null);
  const expired = bet([nftItem(1)], [ethItem('1')]);
  expired.components.endTime = '1';
  assert.equal(arb.normaliseBet(expired), null);
  const promised = bet([nftItem(1)], [ethItem('1')]);
  promised.counterparty = '0x0000000000000000000000000000000000000002';
  assert.equal(arb.normaliseBet(promised), null);
  const idSet = bet([wethItem('1')], [{ itemType: 4, token: COLLECTION, identifierOrCriteria: '123', startAmount: '1', endAmount: '1', recipient: ZERO }]);
  assert.equal(arb.normaliseBet(idSet), null);
  const otherChain = bet([nftItem(1)], [ethItem('1')]);
  otherChain.chainId = 8453;
  assert.equal(arb.normaliseBet(otherChain), null);
  const rising = bet([nftItem(1)], [{ ...ethItem('1'), endAmount: '2' }]);
  assert.equal(arb.normaliseBet(rising), null, 'a price that moves with time is not a price');
  const mixed = bet([nftItem(1)], [ethItem('1'), { ...wethItem('1'), recipient: MAKER }]);
  assert.equal(arb.normaliseBet(mixed), null, 'two currencies in one ask');
  assert.equal(arb.normaliseBet(null), null);
  assert.equal(arb.normaliseBet({}), null);
});

// ───────────────────────── OpenSea orders ─────────────────────────

const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395';
const FEE = '0x0000a26b00c1F0DF003000390027140000fAa719';
const listing = (over = {}) => ({
  order_hash: `0x${'11'.repeat(32)}`, protocol_address: SEAPORT,
  protocol_data: { parameters: {
    offerer: MAKER, zone: ZERO, orderType: 0, startTime: '1', endTime: later, zoneHash: ZERO32, salt: '5', conduitKey: ZERO32,
    offer: [{ itemType: 2, token: COLLECTION, identifierOrCriteria: '12', startAmount: '1', endAmount: '1' }],
    consideration: [
      { itemType: 0, token: ZERO, identifierOrCriteria: '0', startAmount: '990', endAmount: '990', recipient: MAKER },
      { itemType: 0, token: ZERO, identifierOrCriteria: '0', startAmount: '10', endAmount: '10', recipient: FEE },
    ],
    ...over,
  } },
});
const offer = (over = {}) => ({
  order_hash: `0x${'22'.repeat(32)}`, protocol_address: SEAPORT,
  protocol_data: { parameters: {
    offerer: MAKER, zone: ZERO, orderType: 0, startTime: '1', endTime: later, zoneHash: ZERO32, salt: '6', conduitKey: ZERO32,
    offer: [{ itemType: 1, token: WETH, identifierOrCriteria: '0', startAmount: '2000', endAmount: '2000' }],
    consideration: [
      { itemType: 4, token: COLLECTION, identifierOrCriteria: '0', startAmount: '1', endAmount: '1', recipient: MAKER },
      { itemType: 1, token: WETH, identifierOrCriteria: '0', startAmount: '20', endAmount: '20', recipient: FEE },
    ],
    ...over,
  } },
});

test('an OpenSea listing costs the buyer everything in it; an offer pays the seller what is left after its fees', () => {
  const l = arb.normaliseListing(listing(), 'slug');
  assert.equal(l.kind, 'ask');
  assert.equal(l.total, 1000n, 'the seller\'s part and the fees');
  assert.equal(l.money, 'NATIVE');
  assert.equal(l.tokenId, 12n);
  assert.equal(l.collection, COLLECTION.toLowerCase());
  const o = arb.normaliseOffer(offer(), 'slug');
  assert.equal(o.kind, 'bid');
  assert.equal(o.net, 1980n);
  assert.equal(o.tokenId, null);
  assert.equal(o.money, WETH.toLowerCase());

  assert.equal(arb.normaliseListing({ ...listing(), protocol_address: WETH }, 's'), null, 'not Seaport');
  assert.equal(arb.normaliseListing(listing({ endTime: '1' }), 's'), null, 'expired');
  assert.equal(arb.normaliseListing(listing({ offer: [{ itemType: 3, token: COLLECTION, identifierOrCriteria: '1', startAmount: '1', endAmount: '1' }] }), 's'), null, 'not one ERC-721');
  assert.equal(arb.normaliseOffer({ ...offer(), criteria: { trait: { type: 'x', value: 'y' } } }, 's'), null, 'a trait offer');
  assert.equal(arb.normaliseOffer(offer({ offer: [{ itemType: 1, token: WETH, identifierOrCriteria: '0', startAmount: '2000', endAmount: '1000' }] }), 's'), null, 'a falling price');
  assert.equal(arb.normaliseOffer(offer({ consideration: [{ itemType: 4, token: COLLECTION, identifierOrCriteria: '99', startAmount: '1', endAmount: '1', recipient: MAKER }] }), 's'), null, 'an id set');
  assert.equal(arb.normaliseListing(null, 's'), null);
  assert.equal(arb.normaliseOffer({}, 's'), null);
});

// ───────────────────────── the cache every venue read goes through ─────────────────────────

test('keyed: one load at a time, fresh then stale then reloaded, and a failed load never sticks', async () => {
  let loads = 0, failNext = false;
  const c = keyed({ fresh: 40, stale: 120, load: async (k) => { loads++; await new Promise((r) => setTimeout(r, 5)); if (failNext) { failNext = false; throw new Error('down'); } return `${k}:${loads}`; } });
  const [a, b] = await Promise.all([c.get('x'), c.get('x')]);
  assert.equal(a, 'x:1');
  assert.equal(b, 'x:1', 'two callers share one load');
  assert.equal(await c.get('x'), 'x:1', 'fresh: no load');
  assert.equal(await c.get(4663), '4663:2');
  assert.equal(c.peek('4663'), '4663:2', 'a number and its string are one key');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await c.get('x'), 'x:1', 'stale: the old value at once');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await c.get('x'), 'x:3', 'and the refresh behind it has landed');
  await new Promise((r) => setTimeout(r, 140));
  failNext = true;
  await assert.rejects(c.get('x'), /down/, 'past stale, a failed load is the answer');
  assert.equal(await c.get('x'), 'x:5', 'and the next call simply tries again');
  c.drop('x');
  assert.equal(c.peek('x'), undefined);
});

// ───────────────────────── what plan() refuses without asking the chain ─────────────────────────

test('plan refuses what it cannot be, in words, before any read', async () => {
  let e = await refused(arb.plan({ input: tok(4663, 'NATIVE'), output: tok(8453, 'NATIVE') }));
  assert.equal(e.planError, true);
  assert.equal(e.code, 'BAD_REQUEST');
  e = await refused(arb.plan({ input: tok(4663, 'NATIVE'), output: tok(4663, 'NATIVE'), owner: '0x123' }));
  assert.equal(e.code, 'BAD_REQUEST');
  e = await refused(arb.plan({ input: tok(4663, 'NATIVE'), output: tok(4663, 'NATIVE'), owner: ZERO }));
  assert.equal(e.code, 'BAD_REQUEST');
  e = await refused(arb.plan({ input: tok(4663, WETH, { amount: '1000' }), output: tok(4663, WETH) }));
  assert.equal(e.code, 'NO_EDGE');
  assert.equal(e.status, 404);
  assert.match(e.detail, /^No loop pays/);
  e = await refused(arb.plan({ input: tok(4663, 'NATIVE', { amount: '1.5' }), output: tok(4663, WETH) }));
  assert.equal(e.code, 'BAD_REQUEST', 'an amount that is not base units');
  e = await refused(arb.plan({ input: tok(4663, 'NATIVE'), output: tok(4663, WETH) }));
  assert.equal(e.code, 'AMOUNT_REQUIRED');
});

test('wrapping is one transaction, one for one, with nothing to read when no wallet is named', async () => {
  const p = await arb.plan({ input: tok(4663, 'NATIVE', { amount: '1000000000000000' }), output: tok(4663, WETH) });
  assert.equal(p.routing, 'PLAN');
  assert.equal(p.op, 'arb');
  assert.equal(p.pay.amount, '1000000000000000');
  assert.equal(p.receive.amount, '1000000000000000');
  assert.equal(p.receive.token.address, WETH);
  assert.equal(p.legs.length, 1);
  assert.equal(p.legs[0].exec.tx, null, 'no wallet, no transaction');
  const back = await arb.plan({ input: tok(4663, WETH, { amount: '5' }), output: tok(4663, 'NATIVE') });
  assert.equal(back.legs[0].kind, 'unwrap');
  assert.equal(back.receive.token.address, 'NATIVE');
});

// ───────────────────────── the words ─────────────────────────

test('what a person reads: no long dashes, and never the word the owner banned', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('./arb.mjs', import.meta.url)), 'utf8');
  assert.equal(/[\u2012-\u2015]/.test(src.replace(/\[\\u2012-\\u2015\]/g, '')), false, 'a long dash in the source');
  // every sentence-like string: it has a space, and it is not a Solidity signature
  const strings = [...src.matchAll(/(['`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]).filter((t) => t.includes(' ') && !/^(struct|function|event|error) /.test(t));
  assert.ok(strings.length > 100);
  for (const t of strings) assert.equal(/\bticks?\b/i.test(t), false, `"${t}"`);
});

// ───────────────────────── live: Robinhood Chain itself ─────────────────────────

const live = process.env.ARB_LIVE ? test : test.skip;
const ETH = tok(4663, 'NATIVE', { symbol: 'ETH', decimals: 18 });
/** Everything the page's executor (aggregator src/lib/exec.ts opPlan) holds a plan to. */
function executable(p, slippage = 1) {
  assert.equal(p.routing, 'PLAN');
  assert.equal(p.op, 'arb');
  for (const k of ['headline', 'pay', 'receive', 'legs', 'facts', 'warnings', 'contracts']) assert.ok(p[k] != null, k);
  assert.ok(p.legs.length > 0);
  const listed = new Set(p.contracts.map((c) => `${c.chainId}:${c.address.toLowerCase()}`));
  let value = 0n;
  for (const l of p.legs) {
    assert.ok(l.label && typeof l.label === 'string');
    assert.equal(l.feeNative, null);
    if (l.exec.type === 'router') { assert.equal(l.exec.query.type, 'exactIn'); continue; }
    assert.equal(l.exec.type, 'tx');
    if (!l.exec.tx) continue;
    assert.equal(l.exec.tx.chainId, l.chainId);
    assert.ok(listed.has(`${l.chainId}:${l.exec.tx.to.toLowerCase()}`), `${l.exec.tx.to} is not listed`);
    assert.match(l.exec.tx.data, /^0x[0-9a-f]*$/);
    value += BigInt(l.exec.tx.value);
  }
  const budget = p.pay.token?.address === 'NATIVE' ? (BigInt(p.pay.amount) * BigInt(Math.round((100 + slippage) * 100))) / 10_000n : 0n;
  assert.ok(value <= budget, 'the legs send more gas token than the pay box allows');
  const text = JSON.stringify([p.headline, p.pay.label, p.receive.label, p.legs.map((l) => [l.label, l.note]), p.facts, p.warnings]);
  assert.equal(/[\u2012-\u2015]/.test(text), false, 'a long dash');
  assert.equal(/\bticks?\b/i.test(text), false);
}

live('live: the same coin both sides is the best loop, run on the chain, or an honest no', async () => {
  let p;
  try { p = await arb.plan({ input: { ...ETH, amount: '50000000000000000' }, output: ETH }); } catch (e) {
    assert.equal(e.planError, true);
    assert.equal(e.code, 'NO_EDGE', e.detail);
    assert.match(e.detail, /^No loop pays right now\./);
    return;
  }
  executable(p);
  assert.equal(p.pay.token.address, 'NATIVE');
  assert.equal(p.receive.token.address, 'NATIVE');
  const net = BigInt(p.loop.out) - BigInt(p.loop.cost) - BigInt(p.loop.fee);
  assert.equal(net.toString(), p.loop.net);
  assert.ok(net > 0n, 'a loop that does not pay is never offered');
  assert.ok(p.legs.every((l) => l.exec.tx === null), 'no wallet named, no transactions');
});

live('live: a loop too large for the amount typed says what it takes', async () => {
  const e = await refused(arb.plan({ input: { ...ETH, amount: '1' }, output: ETH }));
  assert.ok(['AMOUNT_TOO_SMALL', 'NO_EDGE'].includes(e.code), e.code);
});

live('live: the gas token into a claim is the vault route only when it mints more than the pool', async () => {
  let p;
  try { p = await arb.plan({ input: { ...ETH, amount: '2000000000000000' }, output: tok(4663, WIZ) }); } catch (e) {
    assert.equal(e.planError, true);
    assert.ok(['NO_OP', 'NO_EDGE'].includes(e.code), `${e.code}: ${e.detail}`);
    return;
  }
  executable(p);
  assert.equal(p.pay.amount, '2000000000000000', 'the same amount in as a pool quote would be for');
  assert.equal(p.receive.token.address, WIZ);
  if (p.venue) assert.ok(BigInt(p.receive.amount) > BigInt(p.venue.plainOut), 'it has to beat the pool alone');
});

live('live: a claim out to the gas token passes when the pool already pays best', async () => {
  try {
    const p = await arb.plan({ input: tok(4663, WIZ, { amount: '1000000000000000000' }), output: ETH });
    executable(p);
    assert.ok(BigInt(p.receive.amount) > BigInt(p.venue.plainOut));
  } catch (e) {
    assert.equal(e.planError, true);
    assert.equal(e.code, 'NO_OP', `${e.code}: ${e.detail}`);
  }
});
