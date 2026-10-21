// Throwaway check for gacha.mjs against the live chain. Reads only: every transaction it prints is simulated,
// none is sent.   node server/ops/gacha.test.mjs
import { decodeEventLog, parseAbi } from 'viem';
import * as gacha from './gacha.mjs';

const RPC = 'https://staccpad.fun/rpc';
const KEEPER_URL = 'https://staccpad.fun/api/gacha/keeper';
const HOLDER = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158'; // has ETH
const EMPTY_WALLET = '0x00000000000000000000000000000000000a11ce'; // has none
const HOMECOMING_DESK = '0x1A4284558d79b88Ecc0f53b15430Ed3594cDb860'; // 89 NFTs inside, but its ETH pool is too thin to sell a pull
const ETH = { kind: 'token', id: 'token:4663:native', label: 'ETH', sub: 'Ether', chainId: 4663, address: 'NATIVE', symbol: 'ETH', name: 'Ether', decimals: 18, logo: null, tags: ['native'] };
const WETH = { ...ETH, id: 'token:4663:0x0bd7d308f8e1639fab988df18a8011f41eacad73', address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', symbol: 'WETH', tags: ['wrapped'] };

let failures = 0;
const ok = (cond, what) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failures++; };
const head = (s) => console.log(`\n━━ ${s}`);
const wire = (v) => JSON.parse(JSON.stringify(v));

// the keeper's own answer can be bent here, to see the plan the module makes once staccpad's keeper is running
const realFetch = globalThis.fetch;
let keeperSays = null;
globalThis.fetch = async (url, init) => (keeperSays && url === KEEPER_URL
  ? new Response(JSON.stringify(keeperSays()), { status: 200, headers: { 'content-type': 'application/json' } })
  : realFetch(url, init));

const rpc = async (method, params) => (await (await realFetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
const HELPER_EVENTS = parseAbi(['event Pulled(address indexed vault, address indexed player, uint256 indexed pullId, uint256 ethSpent, uint256 tokenIdIn)']);
/** Runs the plan's transaction again as `from`, with nothing from the module in the way, and reads the helper's own event. */
async function rerun(from, legs) {
  const calls = legs.map((l) => ({ from, to: l.exec.tx.to, data: l.exec.tx.data, value: `0x${BigInt(l.exec.tx.value).toString(16)}` }));
  const r = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls }], validation: false }, 'latest']);
  return r.result[0].calls.map((c, i) => {
    if (c.status !== '0x1') return `${legs[i].kind}: REVERT ${JSON.stringify(c.error).slice(0, 160)}`;
    let said = '';
    for (const l of c.logs) {
      try { const e = decodeEventLog({ abi: HELPER_EVENTS, data: l.data, topics: l.topics }); said = `, helper says pull #${e.args.pullId} for ${e.args.player} took ${e.args.ethSpent} wei`; } catch { /* another contract's event */ }
    }
    return `${legs[i].kind}: ok, gas ${parseInt(c.gasUsed, 16)}, ${c.logs.length} logs${said}`;
  });
}

const BANNED = /tick|sqrt|utili[sz]ation|[\u2014\u2015]/i;
const FIELD_NAMES = new Set(['kind', 'id', 'data', 'to', 'address', 'desk', 'logo', 'image', 'type', 'op', 'routing']);
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
    console.log(`         note: ${l.note}`);
    console.log(`         tx: ${l.exec.tx ? `to ${l.exec.tx.to} value ${l.exec.tx.value} data ${l.exec.tx.data.slice(0, 74)}...` : 'none (no wallet)'}`);
  });
  for (const f of p.facts) console.log(`  fact${f.tone ? ` (${f.tone})` : ''}: ${f.label} = ${f.value}${f.sub ? `\n         ${f.sub}` : ''}`);
  for (const w of p.warnings) console.log(`  warning: ${w}`);
  console.log(`  contracts: ${p.contracts.map((c) => `${c.name} ${c.address}`).join(' | ')}`);
}
async function refuses(what, args, code) {
  try {
    await gacha.plan(args);
    ok(false, `${what}: expected ${code}, got a plan`);
  } catch (e) {
    ok(e?.planError === true && e.code === code && typeof e.detail === 'string' && Number.isInteger(e.status), `${what} -> ${e.code} ${e.status}: ${e.detail}`);
    if (e?.detail && BANNED.test(e.detail)) ok(false, `banned copy in refusal: ${e.detail}`);
  }
}

head('module contract');
ok(gacha.id === 'gacha', 'id is gacha');
ok(['match', 'plan', 'catalog', 'register'].every((k) => typeof gacha[k] === 'function'), 'exports match, plan, catalog, register');
const someDesk = { kind: 'mystery', chainId: 4663, desk: HOMECOMING_DESK };
ok(gacha.match(ETH, someDesk) === true, 'match token -> mystery');
ok(gacha.match({ ...ETH, chainId: 8453 }, someDesk) === false, 'no match: a token on another chain');
ok(gacha.match(someDesk, ETH) === false, 'no match: mystery -> token');
ok(gacha.match(ETH, { kind: 'mystery', chainId: 4663, desk: 'not an address' }) === false, 'no match: a desk that is not an address');
ok((await gacha.catalog('nft-owned', { owner: HOLDER })).length === 0, 'catalog of a kind it does not serve is empty');
ok((await gacha.catalog('mystery', { chainId: 8453 })).length === 0, 'no desks on another chain');

head('what staccpad\'s keeper says right now');
const live = await (await realFetch(KEEPER_URL)).json();
console.log(`  ${JSON.stringify(live)}`);
const keeperOn = typeof live.keeper === 'string' && live.keeper.startsWith('0x');
console.log(`  -> ${keeperOn ? 'it has a key: pulls are revealed for the player' : 'it has NO key: nothing reveals a pull, so the module must not sell one'}`);

head('catalog mystery (live)');
let t0 = Date.now();
const desks = await gacha.catalog('mystery', { owner: null, chainId: null, input: null });
console.log(`  ${desks.length} desks in ${Date.now() - t0} ms (cold)`);
t0 = Date.now();
await gacha.catalog('mystery', {});
console.log(`  again in ${Date.now() - t0} ms (warm)`);
for (const t of desks) console.log(`  ${t.id} | ${t.label} | ${t.sub} | price ${t.price ? `${t.price.amount} ${t.price.token.symbol}` : 'none'} | image ${t.image ? t.image.slice(0, 28) : 'no'}`);
ok(desks.length > 0, 'there are desks');
ok(desks.every((t) => t.kind === 'mystery' && t.chainId === 4663 && /^0x[0-9a-fA-F]{40}$/.test(t.desk) && t.price && /^[0-9]+$/.test(t.price.amount) && t.price.token.address === 'NATIVE'), 'every desk has an address and an ETH price');
ok(desks.every((t) => JSON.stringify(t).length < 8_000), 'every desk fits in a request body');
ok(keeperOn || desks.every((t) => /^Paused/.test(t.sub)), 'with the keeper off, every desk says it is paused');
ok(lint(desks).length === 0, `copy is clean ${lint(desks).join(' / ')}`);

// the wallet used here is a live one and its balance moves: the cheapest desk keeps this check affordable
const pick = [...desks].sort((a, b) => (BigInt(a.price.amount) < BigInt(b.price.amount) ? -1 : 1))[0];

head(`plan (live): ETH -> ${pick.label}, wallet ${HOLDER}`);
if (keeperOn) {
  console.log('  the keeper is on: see the plan below');
} else {
  await refuses('a pull while nothing reveals pulls', wire({ input: ETH, output: pick, owner: HOLDER, slippage: 1 }), 'REVEAL_OFF');
  await refuses('the same with no wallet', wire({ input: ETH, output: pick, owner: null, slippage: 1 }), 'REVEAL_OFF');
}

// from here on the keeper is made to answer "running, with gas", so the plan the module will make then can be seen
// and its transaction run against the real chain
keeperSays = () => ({ revealed: 12, failed: 0, lastTick: Date.now() - 4_000, vaults: 35, open: 0, keeper: HOLDER, helper: '0xAdb7d3DD08f6caE09c76DE9C36AA88eeF55703D0' });
await new Promise((r) => setTimeout(r, 21_000)); // the module remembers the keeper's answer for twenty seconds

head('catalog mystery (keeper answering as if it were running)');
const open = await gacha.catalog('mystery', {});
for (const t of open.slice(0, 4)) console.log(`  ${t.label} | ${t.sub}`);
ok(open.length > 0 && open.every((t) => !/^Paused/.test(t.sub)), 'no desk is paused');
ok(lint(open).length === 0, `copy is clean ${lint(open).join(' / ')}`);
const want = open.find((t) => t.desk === pick.desk) ?? open[0];

head(`plan: ETH -> ${want.label}, wallet ${HOLDER}, slippage 0.5%`);
t0 = Date.now();
const p1 = await gacha.plan(wire({ input: ETH, output: want, owner: HOLDER, slippage: 0.5 }));
console.log(`  built in ${Date.now() - t0} ms`);
show(p1);
console.log('  independent rerun:', (await rerun(HOLDER, p1.legs)).join(' ; '));
ok(p1.routing === 'PLAN' && p1.op === 'gacha', 'routing PLAN, op gacha');
ok(p1.legs.length === 1 && p1.legs[0].exec.tx && p1.legs[0].exec.tx.chainId === 4663, 'one leg with a transaction');
ok(p1.contracts.some((c) => c.address.toLowerCase() === p1.legs[0].exec.tx.to.toLowerCase()), 'the leg calls a declared contract');
{
  const value = BigInt(p1.legs[0].exec.tx.value);
  // the page's own rule (exec.ts opPlan): no step may spend more gas token than pay.amount plus slippage
  const budget = (BigInt(p1.pay.amount) * BigInt(Math.round((100 + 0.5) * 100))) / 10_000n;
  ok(p1.pay.token.address === 'NATIVE' && value <= budget && value >= BigInt(p1.pay.amount), `sends ${value} wei: at least the price ${p1.pay.amount}, inside the page's budget ${budget}`);
}
ok(p1.facts.some((f) => f.label === 'Price') && p1.facts.some((f) => f.label === 'What you can get') && p1.facts.some((f) => f.label === 'Random and final'), 'facts state the price, the pool it draws from, and that it is random and final');
ok(p1.facts.some((f) => f.label === 'What it sells back for'), 'facts state what an NFT from this desk sells back for');
ok(p1.warnings.some((w) => /random/.test(w) && /final/.test(w)), 'the warning says random and final');
ok(lint(p1).length === 0, `copy is clean ${lint(p1).join(' / ')}`);

head('plan: the same with no wallet (quote only)');
t0 = Date.now();
const p2 = await gacha.plan(wire({ input: ETH, output: want, owner: null, slippage: 1 }));
console.log(`  ${p2.headline} | tx ${p2.legs[0].exec.tx === null ? 'none' : 'PRESENT'} | ${Date.now() - t0} ms`);
ok(p2.legs.length === 1 && p2.legs[0].exec.tx === null, 'no transaction without a wallet, same number of legs');

head('refusals');
await refuses('paying with a token that is not ETH', wire({ input: WETH, output: want, owner: HOLDER, slippage: 1 }), 'PAY_IN_ETH');
await refuses('a desk that is not staccpad\'s', wire({ input: ETH, output: { kind: 'mystery', chainId: 4663, desk: HOLDER }, owner: HOLDER, slippage: 1 }), 'NO_DESK');
await refuses('a desk whose pool cannot sell a pull', wire({ input: ETH, output: { kind: 'mystery', chainId: 4663, desk: HOMECOMING_DESK }, owner: HOLDER, slippage: 1 }), 'NO_PRICE');
await refuses('a wallet with no ETH', wire({ input: ETH, output: want, owner: EMPTY_WALLET, slippage: 1 }), 'NOT_ENOUGH');
await refuses('a pair it does not serve', wire({ input: ETH, output: ETH, owner: HOLDER, slippage: 1 }), 'NO_OP');

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
