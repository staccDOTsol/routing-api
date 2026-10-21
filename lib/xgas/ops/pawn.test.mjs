// Throwaway check for pawn.mjs against the live chain. Reads only: every transaction it prints is simulated,
// none is sent.   node server/ops/pawn.test.mjs
import * as pawn from './pawn.mjs';

const RPC = 'https://staccpad.fun/rpc';
const HOLDER = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158'; // has open loans, WETH and an approval in place
const FRESH = '0x45Dd976FeA4d137e24db584D6C968a958Ae26C8f'; // holds Cutesie Faces and CCFF00, has approved nothing
const CCFF00 = '0x505A22Ffed8d37ebE580FfD98d2Cdb0021189146';
const CUTESIE = '0xFfA3d745E19eD60abFF7C7CBB4DAA101600E0F8f';
const HOMECOMING = '0x7c165Ae6E7BFD939Fee1ACA99Ca5aeDf85c52dD4';

let failures = 0;
const ok = (cond, what) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failures++; };
const head = (s) => console.log(`\n━━ ${s}`);

const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
/** Runs a plan's transactions again, in order, as `from`, with nothing from the module in the way. */
async function rerun(from, legs) {
  const calls = legs.map((l) => ({ from, to: l.exec.tx.to, data: l.exec.tx.data, ...(BigInt(l.exec.tx.value) > 0n ? { value: `0x${BigInt(l.exec.tx.value).toString(16)}` } : {}) }));
  const r = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls }], validation: false }, 'latest']);
  return r.result[0].calls.map((c, i) => `${legs[i].kind}: ${c.status === '0x1' ? `ok, gas ${parseInt(c.gasUsed, 16)}, ${c.logs.length} logs` : `REVERT ${JSON.stringify(c.error).slice(0, 140)}`}`);
}

// the house rules for copy: no long dash, and three words that never reach a reader
const BANNED = /tick|sqrt|utili[sz]ation|[\u2014\u2015]/i;
const FIELD_NAMES = new Set(['kind', 'id', 'ticketId', 'data', 'to', 'address', 'collection', 'logo', 'image', 'type', 'op', 'routing']);
function lint(v, path = '') {
  if (typeof v === 'string') return BANNED.test(v) ? [`${path}: ${v.slice(0, 90)}`] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => lint(x, `${path}[${i}]`));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => (FIELD_NAMES.has(k) ? [] : lint(x, `${path}.${k}`)));
  return [];
}

function show(p) {
  console.log(`  headline: ${p.headline}`);
  console.log(`  pay:      ${JSON.stringify({ label: p.pay.label, amount: p.pay.amount, token: p.pay.token?.symbol ?? null })}`);
  console.log(`  receive:  ${JSON.stringify({ label: p.receive.label, amount: p.receive.amount, token: p.receive.token?.symbol ?? null })}`);
  p.legs.forEach((l, i) => {
    console.log(`  leg ${i + 1} [${l.kind}] ${l.label}`);
    if (l.in) console.log(`         in  ${l.in.amount} ${l.in.token.symbol}`);
    if (l.out) console.log(`         out ${l.out.amount} ${l.out.token.symbol}`);
    console.log(`         note: ${l.note}`);
    console.log(`         tx: ${l.exec.tx ? `to ${l.exec.tx.to} value ${l.exec.tx.value} data ${l.exec.tx.data.slice(0, 74)}${l.exec.tx.data.length > 74 ? '...' : ''}` : 'none (no wallet)'}`);
  });
  for (const f of p.facts) console.log(`  fact${f.tone ? ` (${f.tone})` : ''}: ${f.label} = ${f.value}${f.sub ? `\n         ${f.sub}` : ''}`);
  for (const w of p.warnings) console.log(`  warning: ${w}`);
  console.log(`  contracts: ${p.contracts.map((c) => `${c.name} ${c.address}`).join(' | ')}`);
}
async function refuses(what, args, code) {
  try {
    await pawn.plan(args);
    ok(false, `${what}: expected ${code}, got a plan`);
  } catch (e) {
    ok(e?.planError === true && e.code === code && typeof e.detail === 'string' && Number.isInteger(e.status), `${what} -> ${e.code} ${e.status}: ${e.detail}`);
    if (e?.detail && BANNED.test(e.detail)) ok(false, `banned copy in refusal: ${e.detail}`);
  }
}
/** What the page sends: plain JSON, nothing a BigInt could hide in. */
const wire = (v) => JSON.parse(JSON.stringify(v));

const nft = (collection, tokenId) => ({ kind: 'nft', id: `nft:4663:${collection.toLowerCase()}:${tokenId}`, label: 'x', sub: '', chainId: 4663, collection, tokenId: String(tokenId), name: 'x', image: null, collectionName: '' });

head('module contract');
ok(pawn.id === 'pawn', 'id is pawn');
ok(['match', 'plan', 'catalog', 'register'].every((k) => typeof pawn[k] === 'function'), 'exports match, plan, catalog, register');
ok(pawn.match(nft(CCFF00, 1), { kind: 'loan', chainId: 4663, collection: CCFF00 }) === true, 'match nft -> loan');
ok(pawn.match({ kind: 'ticket', chainId: 4663, ticketId: '2', collection: CUTESIE, tokenId: '1440' }, nft(CUTESIE, 1440)) === true, 'match loan -> its nft');
ok(pawn.match({ kind: 'ticket', chainId: 4663, ticketId: '2', collection: CUTESIE, tokenId: '1440' }, nft(CUTESIE, 9)) === false, 'no match: loan -> a different nft');
ok(pawn.match(nft(CCFF00, 1), { kind: 'loan', chainId: 4663, collection: CUTESIE }) === false, 'no match: loan of another collection');
ok(pawn.match(nft(CCFF00, 1), { kind: 'token', chainId: 4663, address: 'NATIVE' }) === false, 'no match: nft -> token');
ok(pawn.match({ ...nft(CCFF00, 1), chainId: 8453 }, { kind: 'loan', chainId: 8453, collection: CCFF00 }) === false, 'no match: another chain');
ok((await pawn.catalog('mystery', { owner: HOLDER })).length === 0, 'catalog of a kind it does not serve is empty');
ok((await pawn.catalog('ticket', { owner: null })).length === 0, 'no wallet, no loans');

head(`catalog nft-owned, ${HOLDER}`);
let t0 = Date.now();
const owned = await pawn.catalog('nft-owned', { owner: HOLDER, chainId: null, input: null });
console.log(`  ${owned.length} things in ${Date.now() - t0} ms`);
for (const t of owned.slice(0, 6)) console.log(`  ${t.id} | ${t.label} | ${t.sub} | image ${t.image ? 'yes' : 'no'}`);
ok(lint(owned).length === 0, 'copy is clean');

head(`catalog nft-owned, ${FRESH}`);
t0 = Date.now();
const ownedFresh = await pawn.catalog('nft-owned', { owner: FRESH });
console.log(`  ${ownedFresh.length} things in ${Date.now() - t0} ms`);
for (const t of ownedFresh) console.log(`  ${t.id} | ${t.label} | ${t.sub}`);

head('catalog loan, for the first NFT of each wallet');
const first = owned[0] ?? nft(CCFF00, 8098);
const firstFresh = ownedFresh.find((t) => t.collection.toLowerCase() === CUTESIE.toLowerCase()) ?? nft(CUTESIE, 1);
const offers = await pawn.catalog('loan', { owner: HOLDER, input: wire(first) });
const offersFresh = await pawn.catalog('loan', { owner: FRESH, input: wire(firstFresh) });
for (const o of [...offers, ...offersFresh]) console.log(`  ${o.id} | ${o.label} | ${o.sub} | pays in ${o.currency.symbol} ${o.currency.address}`);
ok(offers.length > 0 && offersFresh.length > 0, 'a loan is on offer for both');
ok((await pawn.catalog('loan', { input: wire(nft(HOMECOMING, 4582)) })).length === 0, 'no offer where the desk has nothing to lend (homecoming pool is empty)');
ok(lint([...offers, ...offersFresh]).length === 0, 'copy is clean');

head(`catalog ticket (open loans), ${HOLDER}`);
t0 = Date.now();
const loans = await pawn.catalog('ticket', { owner: HOLDER });
console.log(`  ${loans.length} loans in ${Date.now() - t0} ms`);
for (const t of loans) console.log(`  ${t.id} | ${t.label} | ${t.sub} | loan ${t.ticketId} | image ${t.image ? 'yes' : 'no'}`);
ok(loans.length > 0, 'the wallet has open loans');
ok(lint(loans).length === 0, 'copy is clean');

head(`plan: NFT -> loan, ${first.label}, wallet ${HOLDER} (approval already in place)`);
const p1 = await pawn.plan(wire({ input: first, output: offers[0], owner: HOLDER, slippage: 1 }));
show(p1);
console.log('  independent rerun:', (await rerun(HOLDER, p1.legs)).join(' ; '));
ok(p1.routing === 'PLAN' && p1.op === 'pawn', 'routing PLAN, op pawn');
ok(p1.legs.every((l) => l.exec.type === 'tx' && l.exec.tx && l.exec.tx.chainId === 4663 && p1.contracts.some((c) => c.address.toLowerCase() === l.exec.tx.to.toLowerCase())), 'every leg has a transaction to a declared contract');
ok(p1.legs.every((l) => l.exec.tx.value === '0'), 'no gas token is spent');
ok(p1.warnings.some((w) => /can sell/.test(w)) && p1.facts.some((f) => f.label === 'When anyone can sell it'), 'the sale condition is in facts and in warnings');
ok(lint(p1).length === 0, `copy is clean ${lint(p1).join(' / ')}`);
ok(JSON.stringify(p1).length > 0, 'the plan is plain JSON');

head(`plan: NFT -> loan, ${firstFresh.label}, wallet ${FRESH} (nothing approved)`);
const p2 = await pawn.plan(wire({ input: firstFresh, output: offersFresh[0], owner: FRESH, slippage: 0.5 }));
show(p2);
console.log('  independent rerun:', (await rerun(FRESH, p2.legs)).join(' ; '));
ok(p2.legs.length === 2 && p2.legs[0].kind === 'approve' && p2.legs[1].kind === 'pawn', 'two legs: approve one NFT, then pawn');
ok(p2.legs[0].exec.tx.data.startsWith('0x095ea7b3'), 'the approval is approve(desk, id), not setApprovalForAll');
ok(lint(p2).length === 0, `copy is clean ${lint(p2).join(' / ')}`);

head('plan: NFT -> loan with no wallet (quote only)');
const p3 = await pawn.plan(wire({ input: firstFresh, output: offersFresh[0], owner: null, slippage: 1 }));
console.log(`  ${p3.headline} | legs ${p3.legs.map((l) => `${l.kind}:${l.exec.tx === null ? 'no tx' : 'TX'}`).join(', ')}`);
ok(p3.legs.every((l) => l.exec.tx === null), 'no transaction without a wallet');

head(`plan: loan -> NFT (repay), ${loans[0]?.label}, wallet ${HOLDER}`);
const back = (t) => nft(t.collection, t.tokenId);
const p4 = await pawn.plan(wire({ input: loans[0], output: back(loans[0]), owner: HOLDER, slippage: 1 }));
show(p4);
console.log('  independent rerun:', (await rerun(HOLDER, p4.legs)).join(' ; '));
ok(p4.legs[p4.legs.length - 1].kind === 'repay', 'the last leg repays');
ok(p4.legs.every((l) => l.exec.tx && p4.contracts.some((c) => c.address.toLowerCase() === l.exec.tx.to.toLowerCase())), 'every leg has a transaction to a declared contract');
{
  const spent = p4.legs.reduce((n, l) => n + BigInt(l.exec.tx.value), 0n);
  const shown = p4.pay.token?.address === 'NATIVE' ? BigInt(p4.pay.amount) : 0n;
  ok(spent <= shown, `gas token spent (${spent}) is no more than the pay side shows (${shown})`);
}
ok(lint(p4).length === 0, `copy is clean ${lint(p4).join(' / ')}`);

head('plan: loan -> NFT with no wallet (quote only)');
const p5 = await pawn.plan(wire({ input: loans[0], output: back(loans[0]), owner: null, slippage: 1 }));
console.log(`  ${p5.headline} | legs ${p5.legs.map((l) => `${l.kind}:${l.exec.tx === null ? 'no tx' : 'TX'}`).join(', ')}`);
ok(p5.legs.every((l) => l.exec.tx === null), 'no transaction without a wallet');

// Two roads no wallet on the chain walks today, so the chain's answer is bent for one read each and everything
// after it is real: a wallet with no WETH (the debt is wrapped from ETH), and a loan sent on by whoever opened it.
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const OTHER = '0x2Be5B4851dF3E812b9A3BbE2b158b561cBd783C7'; // holds loans 6 to 24
const realFetch = globalThis.fetch;
let bend = null;
globalThis.fetch = async (url, init) => {
  const res = await realFetch(url, init);
  if (!bend || url !== RPC || !init?.body) return res;
  const req = JSON.parse(init.body);
  const json = await res.json();
  bend(req, json);
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
};

head(`plan: loan -> NFT when the wallet holds no WETH (its WETH balance is read as 0), wallet ${HOLDER}`);
bend = (req, json) => {
  if (req.method !== 'eth_simulateV1') return;
  req.params[0].blockStateCalls[0].calls.forEach((c, i) => {
    if (c.to.toLowerCase() === WETH.toLowerCase() && c.data.startsWith('0x70a08231')) json.result[0].calls[i].returnData = `0x${'0'.repeat(64)}`;
  });
};
const p6 = await pawn.plan(wire({ input: loans[1], output: back(loans[1]), owner: HOLDER, slippage: 1 }));
bend = null;
show(p6);
console.log('  independent rerun:', (await rerun(HOLDER, p6.legs)).join(' ; '));
ok(p6.legs[0].kind === 'wrap' && BigInt(p6.legs[0].exec.tx.value) > 0n && p6.legs[0].exec.tx.to.toLowerCase() === WETH.toLowerCase(), 'the first leg wraps ETH into WETH');
{
  const spent = p6.legs.reduce((n, l) => n + BigInt(l.exec.tx.value), 0n);
  ok(p6.pay.token?.address === 'NATIVE' && spent === BigInt(p6.pay.amount), `the pay side shows exactly the ETH that is spent (${spent} wei)`);
  // the page's own rule (exec.ts opPlan): no step may spend more gas token than pay.amount plus slippage
  ok(spent <= (BigInt(p6.pay.amount) * 10_100n) / 10_000n, 'inside the budget the page allows');
}
ok(lint(p6).length === 0, `copy is clean ${lint(p6).join(' / ')}`);

head(`plan: loan -> NFT for a loan someone else opened (the opening event is read as another wallet's), wallet ${OTHER}`);
const otherLoan = { kind: 'ticket', id: 'pawn-loan:4663:6', label: 'x', sub: '', chainId: 4663, ticketId: '6', collection: CUTESIE, tokenId: '507', image: null };
bend = (req, json) => {
  if (req.method === 'eth_getLogs' && Array.isArray(json.result)) for (const l of json.result) l.topics[3] = `0x${'0'.repeat(24)}${'ab'.repeat(20)}`;
};
const p7 = await pawn.plan(wire({ input: otherLoan, output: back(otherLoan), owner: OTHER, slippage: 1 }));
bend = null;
console.log(`  ${p7.headline}`);
for (const f of p7.facts.filter((x) => x.tone === 'danger')) console.log(`  fact (danger): ${f.label} = ${f.value} | ${f.sub}`);
console.log(`  warning: ${p7.warnings[0]}`);
ok(p7.facts.some((f) => f.label === 'Opened by' && f.tone === 'danger') && /did not open this loan/.test(p7.warnings[0]), 'a loan opened by another wallet is called out, first');
ok(p7.legs.map((l) => l.kind).join(',') === 'approve,repay', 'legs: approve the debt, then repay');
ok(lint(p7).length === 0, `copy is clean ${lint(p7).join(' / ')}`);

head('refusals');
await refuses('someone else\'s NFT', wire({ input: firstFresh, output: offersFresh[0], owner: HOLDER, slippage: 1 }), 'NOT_OWNER');
await refuses('a desk pool with nothing to lend', wire({ input: nft(HOMECOMING, 4582), output: { kind: 'loan', chainId: 4663, collection: HOMECOMING }, owner: HOLDER, slippage: 1 }), 'DESK_SHORT');
await refuses('a collection with no desk pool', wire({ input: nft('0xDCd9c4087963d4bffE7179a143D5bdEab6622bC6', 12433), output: { kind: 'loan', chainId: 4663 }, owner: HOLDER, slippage: 1 }), 'NO_DESK');
await refuses('a loan that is closed', wire({ input: { kind: 'ticket', chainId: 4663, ticketId: '1' }, output: { kind: 'nft', chainId: 4663 }, owner: HOLDER, slippage: 1 }), 'LOAN_CLOSED');
await refuses('a loan held by another wallet', wire({ input: loans[0], output: back(loans[0]), owner: FRESH, slippage: 1 }), 'NOT_OWNER');
await refuses('a pair it does not serve', wire({ input: first, output: { kind: 'token', chainId: 4663, address: 'NATIVE' }, owner: HOLDER, slippage: 1 }), 'NO_OP');

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
