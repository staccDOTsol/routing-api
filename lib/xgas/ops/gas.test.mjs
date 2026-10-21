// Throwaway check of gas.mjs against live state and the live Relay API. Reads and quotes only; sends nothing.
//   export PATH=/opt/homebrew/opt/node@22/bin:$PATH
//   node server/ops/gas.test.mjs [--json]              the module as deployed, through the staccpad proxy
//   node server/ops/gas.test.mjs --direct              the DRPC_KEY path, with a made-up key and lb.drpc.live played by this script
//   OP_FILE=./_gas.next.mjs node server/ops/gas.test.mjs   a draft
const DIRECT = process.argv.includes('--direct');
const FAKE_KEY = 'TESTKEY_made_up_0123456789';
if (DIRECT) process.env.DRPC_KEY = FAKE_KEY; else delete process.env.DRPC_KEY;

const realFetch = globalThis.fetch;
const SLUG_TO_CHAIN = { robinhood: 4663, base: 8453, arbitrum: 42161, optimism: 10, unichain: 130, blast: 81457, soneium: 1868, ethereum: 1, bsc: 56, polygon: 137, avalanche: 43114, ink: 57073, megaeth: 4326, zora: 7777777 };
const proxyOf = (chainId) => (chainId === 4663 ? 'https://staccpad.fun/rpc' : `https://staccpad.fun/rpc/${chainId}`);
const hits = { direct: 0, proxy: 0, relay: 0 };
// Relay allows 50 quotes a minute and the module stops itself short of that: the test keeps well under both
const quoteTimes = [];
async function pace() {
  for (;;) {
    while (quoteTimes.length && Date.now() - quoteTimes[0] > 60_000) quoteTimes.shift();
    if (quoteTimes.length < 28) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
let directMode = 'ok'; // ok | auth | hang | down
let proxyDown = false;
let rewriteRpc = null; // (url, body) => { answer } | { body } | undefined
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.relay.link/quote')) { hits.relay++; quoteTimes.push(Date.now()); }
  const m = u.match(/^https:\/\/lb\.drpc\.live\/([a-z0-9-]+)\/(.+)$/);
  let target = u;
  if (m) {
    hits.direct++;
    if (m[2] !== FAKE_KEY) throw new Error('the test saw a dRPC key it did not make up');
    if (directMode === 'auth') return new Response(JSON.stringify({ message: 'Invalid JWT', code: 401 }), { status: 401, headers: { 'content-type': 'application/json' } });
    if (directMode === 'down') return new Response('bad gateway', { status: 502 });
    if (directMode === 'hang') { await new Promise((r, j) => { const t = setTimeout(r, 15_000); init?.signal?.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'TimeoutError' })); }); }); }
    target = proxyOf(SLUG_TO_CHAIN[m[1]]); // a healthy direct endpoint, played by the proxy
  } else if (u.startsWith('https://staccpad.fun/rpc')) {
    hits.proxy++;
    if (proxyDown) return new Response('bad gateway', { status: 502 });
  }
  if (rewriteRpc && typeof init?.body === 'string' && (m || u.startsWith('https://staccpad.fun/rpc'))) {
    const body = JSON.parse(init.body);
    const out = Array.isArray(body) ? undefined : await rewriteRpc(target, body);
    if (out?.answer) return new Response(JSON.stringify(out.answer), { status: 200, headers: { 'content-type': 'application/json' } });
    if (out?.body) return realFetch(target, { ...init, body: JSON.stringify(out.body) });
  }
  return realFetch(target, init);
};

const gas = await import(process.env.OP_FILE || './gas.mjs');

const OWNER = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158';
const tok = (chainId, address, symbol, name, decimals, amount) => ({ kind: 'token', id: `token:${chainId}:${address.toLowerCase()}`, label: symbol, sub: name, chainId, address, symbol, name, decimals, logo: null, tags: [], ...(amount ? { amount } : {}) });
const USDG = (amount) => tok(4663, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 'USDG', 'Global Dollar', 6, amount);
const WETH_RH = (amount) => tok(4663, '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', 'WETH', 'Wrapped Ether', 18, amount);
const gasOf = (chainId, symbol = 'ETH', amount) => tok(chainId, 'NATIVE', symbol, symbol, 18, amount);
const json = process.argv.includes('--json');
const quiet = !process.argv.includes('--verbose');
const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`); };
const times = [];

function print(p) {
  console.log(`  headline: ${p.headline}`);
  if (quiet) { console.log(`  legs:     ${p.legs.map((l) => `${l.kind}${l.exec.tx ? ` -> ${l.exec.tx.to}` : ' (no tx)'}`).join(' ; ')}`); console.log(`  checked:  ${p.facts.find((f) => f.label === 'Checked')?.sub || '(quote only)'}`); return; }
  console.log(`  pay:      ${p.pay.amount} ${p.pay.token.symbol} @${p.pay.token.chainId} (${p.pay.label})`);
  console.log(`  receive:  ${p.receive.amount} ${p.receive.token.symbol} @${p.receive.token.chainId} (${p.receive.label})`);
  p.legs.forEach((l, i) => console.log(`  leg ${i}:    [${l.kind} @${l.chainId}] ${l.label}\n            ${l.exec.tx ? `to ${l.exec.tx.to} value ${l.exec.tx.value} data ${l.exec.tx.data.slice(0, 138)}${l.exec.tx.data.length > 138 ? `... (${(l.exec.tx.data.length - 2) / 2} bytes)` : ''}` : 'tx null (quote only)'}${l.note ? `\n            note: ${l.note}` : ''}`));
  p.facts.forEach((f) => console.log(`  fact:     ${f.label}: ${f.value}${f.tone ? ` [${f.tone}]` : ''}${f.sub ? `\n            ${f.sub}` : ''}`));
  p.warnings.forEach((w) => console.log(`  warning:  ${w}`));
  console.log(`  contracts: ${p.contracts.map((c) => `${c.name} ${c.address}@${c.chainId}`).join(', ')}`);
}
function wellFormed(p, owner) {
  const problems = [];
  if (p.routing !== 'PLAN' || p.op !== 'gas') problems.push('routing/op');
  let budget = p.pay.token.address === 'NATIVE' ? BigInt(p.pay.amount) : 0n;
  for (const l of p.legs) {
    if (l.exec.type !== 'tx') { problems.push('exec type'); continue; }
    if (!owner) { if (l.exec.tx !== null) problems.push('quote-only leg carries a tx'); continue; }
    const tx = l.exec.tx;
    if (!tx) { problems.push('missing tx'); continue; }
    if (tx.chainId !== l.chainId) problems.push('leg chain');
    if (!p.contracts.some((c) => c.chainId === tx.chainId && c.address.toLowerCase() === tx.to.toLowerCase())) problems.push(`undeclared target ${tx.to}`);
    if (BigInt(tx.value) > budget) problems.push('spends more gas token than the pay box shows');
    budget -= BigInt(tx.value);
  }
  const text = JSON.stringify(p);
  if (/[—―]/.test(text)) problems.push('em dash in copy');
  if (/tick/i.test(JSON.stringify([p.headline, p.pay.label, p.receive.label, p.legs.map((l) => [l.label, l.note]), p.facts, p.warnings]))) problems.push('the word tick in copy');
  if (text.includes(FAKE_KEY) || /lb\.drpc\.live/.test(text)) problems.push('THE KEY OR ITS URL IS IN THE PLAN');
  return problems;
}

const plans = {};
async function run(name, input, output, owner, expect = {}) {
  console.log(`\n== ${name} ${owner ? `for ${owner}` : '(quote only, no owner)'}`);
  await pace();
  try {
    const t0 = Date.now();
    const p = await gas.plan({ input, output, owner, slippage: expect.slippage });
    const ms = Date.now() - t0;
    if (!expect.untimed) times.push({ name, ms });
    console.log(`  built in ${ms} ms`);
    print(p);
    const problems = wellFormed(p, owner);
    check('plan is well formed', problems.length === 0, problems.join('; '));
    if (owner) check('test run passed', p.facts.some((f) => f.label === 'Checked'));
    if (expect.legs !== undefined) check(`${expect.legs} leg(s)`, p.legs.length === expect.legs, `got ${p.legs.length}`);
    if (expect.target) check(`deposit goes to ${expect.target}`, p.legs.at(-1).exec.tx?.to.toLowerCase() === expect.target.toLowerCase());
    if (expect.logs !== undefined) check(expect.logs ? 'the deposit was seen in Relay\'s contract' : 'ran without logs (fallback)', /showed up in Relay/.test(p.facts.find((f) => f.label === 'Checked')?.sub || '') === expect.logs);
    plans[name] = p;
    return p;
  } catch (e) {
    check(`plan failed: ${e.code || ''} ${e.detail || e.message}`, false, e.cause ? String(e.cause.message || e.cause) : '');
    return null;
  }
}
const expectFail = async (name, args, code) => {
  await pace();
  try { const p = await gas.plan(args); check(name, false, `no error; legs ${p.legs.length}`); return null; }
  catch (e) {
    const leaked = [e.detail, e.message, String(e.cause?.message || ''), String(e.stack || '')].some((s) => String(s).includes(FAKE_KEY) || /lb\.drpc\.live/.test(String(s)));
    check(`${name}: ${e.code} (${e.status}) "${e.detail}"${e.cause ? ` [${String(e.cause.message || e.cause).slice(0, 90)}]` : ''}`, e.planError === true && e.code === code && typeof e.detail === 'string' && !leaked, leaked ? 'KEY LEAKED IN THE ERROR' : '');
    return e;
  }
};
const DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const DEPOSITORY_2 = '0x59916da825d2d2ec1bf878d71c88826f6633ecca';
const PROXY = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
const SOLVER = '0xf70da97812CB96acDF810712Aa562db8dfA3dbEF'; // Relay's solver: holds gas and USDC on most chains, used read-only as a sender
const HOLDER = '0x8366a39CC670B4001A1121B8F6A443A643e40951'; // holds WETH on Robinhood, used read-only as a sender

// ════════════════════════ the DRPC_KEY path ════════════════════════
if (DIRECT) {
  console.log('== direct dRPC (made-up key; lb.drpc.live is played by this script, backed by the staccpad proxy)');
  await run('warm-up', USDG('100000'), gasOf(8453), OWNER, { legs: 2, untimed: true });
  hits.direct = 0; hits.proxy = 0;
  await run('direct: 0.1 USDG on Robinhood -> gas on Base', USDG('110000'), gasOf(8453), OWNER, { legs: 2, target: DEPOSITORY, logs: true });
  check(`every chain read went straight to dRPC (direct ${hits.direct}, proxy ${hits.proxy})`, hits.direct >= 3 && hits.proxy === 0);
  hits.direct = 0; hits.proxy = 0;
  await run('direct: a chain with no dRPC slug (Linea) still reads through the proxy', gasOf(59144, 'ETH', '500000000000000'), gasOf(8453), SOLVER, { legs: 1, target: DEPOSITORY_2 });
  check(`Linea went through the proxy (proxy ${hits.proxy})`, hits.proxy >= 2);

  console.log('\n== direct refuses the key (401): fall back to the proxy, then leave direct alone for a while');
  directMode = 'auth'; hits.direct = 0; hits.proxy = 0;
  await run('fallback after 401: 0.1 USDG on Robinhood -> gas on Base', USDG('120000'), gasOf(8453), OWNER, { legs: 2, target: DEPOSITORY, logs: true });
  const firstDirect = hits.direct;
  check(`the proxy answered (direct tried ${hits.direct}, proxy ${hits.proxy})`, hits.proxy >= 3 && hits.direct >= 1);
  await run('while direct rests: 0.13 USDG on Robinhood -> gas on Base', USDG('130000'), gasOf(8453), OWNER, { legs: 2, target: DEPOSITORY });
  check(`direct was not asked again for Robinhood (${hits.direct - firstDirect} more tries, all for other reads)`, hits.direct - firstDirect <= 1);

  console.log('\n== both upstreams down: a clean refusal, and no key in it');
  directMode = 'down'; proxyDown = true;
  await expectFail('nothing answers', { input: USDG('140000'), output: gasOf(8453), owner: OWNER }, 'UPSTREAM_UNAVAILABLE');
  proxyDown = false; directMode = 'ok';
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

// ════════════════════════ the module as deployed ════════════════════════
console.log('== match (synchronous, on the list in hand)');
check('USDG on Robinhood -> gas on Base', gas.match(USDG(), gasOf(8453)) === true);
check('ETH on Robinhood -> BNB on BNB Chain', gas.match(gasOf(4663), gasOf(56, 'BNB')) === true);
check('same chain is not this', gas.match(USDG(), gasOf(4663)) === false);
check('a token on the far side is not this', gas.match(USDG(), tok(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC', 'USD Coin', 6)) === false);
check('the xGas chain is left to the vault', gas.match(USDG(), gasOf(466302, 'xMoney')) === false && gas.match(gasOf(466302, 'xMoney'), gasOf(8453)) === false);
check('a chain nobody has heard of is not this', gas.match(USDG(), gasOf(987654321)) === false);
check('an NFT is not this', gas.match({ kind: 'nft', chainId: 4663 }, gasOf(8453)) === false);
check('garbage is not this', gas.match(null, undefined) === false && gas.match({ kind: 'token', chainId: 'x' }, {}) === false);
check('catalog serves nothing', (await gas.catalog('token', { owner: OWNER })).length === 0);

await run('cold: 0.1 USDG on Robinhood -> gas on Base (first plan of the process)', USDG('100000'), gasOf(8453), OWNER, { legs: 2, target: DEPOSITORY, logs: true, untimed: true });
const cold = Date.now();
check('Relay\'s own chain list has arrived: a chain outside the built-in copy now matches (Linea)', gas.match(USDG(), gasOf(59144)) === true);
await run('0.1 USDG on Robinhood -> gas on BNB Chain', USDG('100000'), gasOf(56, 'BNB'), OWNER, { legs: 2, target: DEPOSITORY, logs: true });
await run('0.1 USDG on Robinhood -> gas on Base', USDG('100000'), gasOf(8453), null, { legs: 2 });
await run('0.0005 ETH on Robinhood -> gas on Base (gas token in, one leg)', gasOf(4663, 'ETH', '500000000000000'), gasOf(8453), OWNER, { legs: 1, target: DEPOSITORY, logs: true });
await run('exact out: 0.0002 ETH on Base, paid in ETH on Robinhood', gasOf(4663), gasOf(8453, 'ETH', '200000000000000'), OWNER, { legs: 1, target: DEPOSITORY });
await run('0.1 USDG on Robinhood -> gas on Base at 1% slippage', USDG('100000'), gasOf(8453), OWNER, { legs: 2, slippage: 1 });
await run('swap first: 0.0001 WETH on Robinhood -> gas on Base, simulated from a WETH holder', WETH_RH('100000000000000'), gasOf(8453), HOLDER, { target: PROXY, logs: true });

console.log('\n== any chain Relay serves, out or in');
await run('destination outside the built-in copy: 1 USDG on Robinhood -> gas on Linea', USDG('1000000'), gasOf(59144), OWNER, { legs: 2, target: DEPOSITORY });
await run('destination with its own gas token: 0.1 USDG on Robinhood -> MNT on Mantle', USDG('100000'), gasOf(5000, 'MNT'), OWNER, { legs: 2 });
await run('another origin: 1 USDC on Base -> gas on Robinhood, simulated from a USDC holder', tok(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC', 'USD Coin', 6, '1000000'), gasOf(4663), SOLVER, { target: DEPOSITORY, logs: true });
await run('an origin without eth_simulateV1: 1 USDC on Avalanche -> gas on Base, simulated from a USDC holder', tok(43114, '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 'USDC', 'USD Coin', 6, '1000000'), gasOf(8453), SOLVER, { target: DEPOSITORY, logs: false, untimed: true });
await run('an origin on Relay\'s second depository: 0.0005 ETH on Linea -> gas on Base, simulated from a holder', gasOf(59144, 'ETH', '500000000000000'), gasOf(8453), SOLVER, { legs: 1, target: DEPOSITORY_2, logs: true });
await run('quote only: 0.01 BNB on BNB Chain -> POL on Polygon', gasOf(56, 'BNB', '10000000000000000'), gasOf(137, 'POL'), null, { legs: 1 });

console.log('\n== expected failures');
await expectFail('more USDG than the wallet holds', { input: USDG('5000000000'), output: gasOf(8453), owner: OWNER }, 'INSUFFICIENT_BALANCE');
await expectFail('more than Relay carries in one go', { input: USDG('5000000000000'), output: gasOf(8453), owner: OWNER }, 'AMOUNT_TOO_HIGH');
await expectFail('no amount', { input: USDG(), output: gasOf(8453), owner: OWNER }, 'AMOUNT_REQUIRED');
await expectFail('dust', { input: USDG('10'), output: gasOf(8453), owner: OWNER }, 'AMOUNT_TOO_LOW');
await expectFail('X Money has no route', { input: tok(4663, '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E', 'xMoney', 'X Money', 18, '1000000000000000000'), output: gasOf(8453), owner: OWNER }, 'NO_ROUTE');
await expectFail('not a token', { input: tok(4663, '0x00000000000000000000000000000000000000Aa', 'NOPE', 'Nope', 18, '1000'), output: gasOf(8453), owner: OWNER }, 'NOT_A_TOKEN');
await expectFail('a wallet that holds nothing', { input: USDG('100000'), output: gasOf(8453), owner: '0x00000000000000000000000000000000000000b1' }, 'INSUFFICIENT_BALANCE');
// the vault contract holds USDG and no ETH: the plainest "token but no gas on the origin chain"
await expectFail('a holder with no gas on the origin chain', { input: USDG('100000'), output: gasOf(8453), owner: '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E' }, 'NO_GAS_ON_ORIGIN');

console.log('\n== not ours: always a clean NO_OP, never anything else');
await expectFail('same chain', { input: USDG('100000'), output: gasOf(4663), owner: OWNER }, 'NO_OP');
await expectFail('a destination Relay does not serve', { input: USDG('100000'), output: gasOf(987654321), owner: OWNER }, 'NO_OP');
await expectFail('an origin Relay does not serve', { input: gasOf(987654321, 'X', '1000000000000000'), output: gasOf(8453), owner: OWNER }, 'NO_OP');
await expectFail('the xGas chain as destination', { input: USDG('100000'), output: gasOf(466302, 'xMoney'), owner: OWNER }, 'NO_OP');
await expectFail('an origin Relay serves but this server cannot read (Monad), with a wallet', { input: gasOf(143, 'MON', '1000000000000000000'), output: gasOf(8453), owner: OWNER }, 'NO_OP');
await expectFail('the same origin, quote only', { input: gasOf(143, 'MON', '1000000000000000000'), output: gasOf(8453), owner: null }, 'NO_OP');
await expectFail('a token thing that is not a token', { input: { kind: 'token', chainId: 4663, address: 'nope', amount: '1' }, output: gasOf(8453), owner: OWNER }, 'NO_OP');

// ── the same module with Relay or the chain misbehaving ──
console.log('\n== a Relay answer that is not the known shape is refused');
await pace();
quoteTimes.push(Date.now());
const base = await (await realFetch('https://api.relay.link/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: OWNER, recipient: OWNER, originChainId: 4663, destinationChainId: 8453, originCurrency: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', destinationCurrency: '0x0000000000000000000000000000000000000000', amount: '90000', tradeType: 'EXACT_INPUT' }) })).json();
const wrapped = globalThis.fetch;
const tamper = (edit) => {
  const q = structuredClone(base);
  edit(q);
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://api.relay.link/quote') ? new Response(JSON.stringify(q), { status: 200, headers: { 'content-type': 'application/json' } }) : wrapped(url, init));
};
const dep = (q) => q.steps.at(-1).items[0].data;
// a different slippage on every case: the module shares identical requests for 4 s, and each case must be asked afresh
let nth = 0;
const args = () => ({ input: USDG('90000'), output: gasOf(8453), owner: OWNER, slippage: 2 + (nth += 0.01) });
tamper(() => {});
await pace();
try { const p = await gas.plan(args()); check('the untouched answer is accepted', p.legs.length === 2); } catch (e) { check(`the untouched answer is accepted: ${e.code} ${e.cause?.message}`, false); }
tamper((q) => { dep(q).to = '0x00000000000000000000000000000000000000b1'; q.steps[0].items[0].data.data = q.steps[0].items[0].data.data.replace(DEPOSITORY.slice(2), '00000000000000000000000000000000000000b1'); });
await expectFail('deposit addressed to an unknown contract', args(), 'RELAY_SHAPE');
tamper((q) => { dep(q).to = DEPOSITORY_2; q.steps[0].items[0].data.data = q.steps[0].items[0].data.data.replace(DEPOSITORY.slice(2), DEPOSITORY_2.slice(2)); });
await expectFail('deposit addressed to the depository of another chain', args(), 'RELAY_SHAPE');
tamper((q) => { dep(q).data = dep(q).data.replace(OWNER.slice(2).toLowerCase(), '00000000000000000000000000000000000000b1'); });
await expectFail('deposit credited to someone else', args(), 'RELAY_SHAPE');
tamper((q) => { dep(q).data = dep(q).data.replace('15f90'.padStart(64, '0'), '989680'.padStart(64, '0')); });
await expectFail('deposit of a different amount', args(), 'RELAY_SHAPE');
tamper((q) => { dep(q).value = '1000'; });
await expectFail('deposit that also takes gas token', args(), 'RELAY_SHAPE');
tamper((q) => { q.steps.push(structuredClone(q.steps[1])); });
await expectFail('a third step', args(), 'RELAY_SHAPE');
tamper((q) => { q.steps[1].kind = 'signature'; });
await expectFail('a signature step', args(), 'RELAY_SHAPE');
tamper((q) => { q.details.recipient = '0x00000000000000000000000000000000000000b1'; });
await expectFail('delivery to someone else', args(), 'RELAY_SHAPE');
tamper((q) => { q.protocol.v2.orderData.output.payments[0].recipient = '0x00000000000000000000000000000000000000b1'; });
await expectFail('order pays someone else', args(), 'RELAY_SHAPE');
tamper((q) => { q.details.currencyOut.currency.chainId = 56; });
await expectFail('delivery on another chain', args(), 'RELAY_SHAPE');
tamper((q) => { q.protocol.v2.orderId = `0x${'ab'.repeat(32)}`; });
await expectFail('order id that the deposit does not carry', args(), 'RELAY_SHAPE');
tamper((q) => { dep(q).chainId = 8453; });
await expectFail('transaction for another chain', args(), 'RELAY_SHAPE');
globalThis.fetch = wrapped;

console.log('\n== when the test run fails, or eth_simulateV1 is not served');
// only the runs that carry a sender are tampered with: the module's own reads are simulated blocks too
const txRun = (b) => b.method === 'eth_simulateV1' && b.params[0].blockStateCalls[0].calls.some((c) => c.from);
// Relay's depository replaced by code that always reverts, inside the simulated block only
rewriteRpc = (_u, b) => { if (!txRun(b)) return undefined; b.params[0].blockStateCalls[0].stateOverrides = { [DEPOSITORY]: { code: '0x60006000fd' } }; return { body: b }; };
await expectFail('a reverting test run is refused', { input: USDG('80000'), output: gasOf(8453), owner: OWNER }, 'WOULD_REVERT');
// the depository replaced by code that accepts anything and does nothing: no revert, but no deposit either
rewriteRpc = (_u, b) => { if (!txRun(b)) return undefined; b.params[0].blockStateCalls[0].stateOverrides = { [DEPOSITORY]: { code: '0x00' } }; return { body: b }; };
await expectFail('a run that does not land in the depository is refused', { input: USDG('70000'), output: gasOf(8453), owner: OWNER }, 'WOULD_REVERT');
// eth_simulateV1 not served at all: reads fall back to plain calls, approval and deposit run through Multicall3's code at the owner's address
const noSim = (_u, b) => (b.method === 'eth_simulateV1' ? { answer: { jsonrpc: '2.0', id: b.id, error: { code: -32601, message: 'the method eth_simulateV1 does not exist' } } } : undefined);
rewriteRpc = noSim;
await run('fallback: 0.06 USDG on Robinhood -> gas on Base without eth_simulateV1', USDG('60000'), gasOf(8453), OWNER, { legs: 2, target: DEPOSITORY, logs: false, untimed: true });
await run('fallback: 0.0003 ETH on Robinhood -> gas on Base without eth_simulateV1 (eth_call)', gasOf(4663, 'ETH', '300000000000000'), gasOf(8453), OWNER, { legs: 1, logs: false, untimed: true });
await expectFail('fallback refuses a swap-first route it cannot inspect', { input: WETH_RH('100000000000000'), output: gasOf(8453), owner: HOLDER }, 'CANNOT_VERIFY_ROUTE');
// the fallback must also notice a revert
rewriteRpc = (u, b) => { const a = noSim(u, b); if (a) return a; if (b.method === 'eth_call' && b.params[2] && b.params[0].from) { b.params[2][DEPOSITORY] = { code: '0x60006000fd' }; return { body: b }; } return undefined; };
await expectFail('fallback: a reverting run is refused', { input: USDG('50000'), output: gasOf(8453), owner: OWNER }, 'WOULD_REVERT');
rewriteRpc = null;
// the chain cannot be read at all
proxyDown = true;
await expectFail('the origin chain does not answer', { input: USDG('40000'), output: gasOf(8453), owner: OWNER }, 'UPSTREAM_UNAVAILABLE');
proxyDown = false;

console.log('\n== speed (through the staccpad proxy from this machine; the first plan of the process is the cold one)');
for (const t of times) console.log(`  ${String(t.ms).padStart(5)} ms  ${t.name}`);
const slow = times.filter((t) => t.ms > 2_000);
check(`every warm plan under 2 s (slowest ${Math.max(...times.map((t) => t.ms))} ms)`, slow.length === 0, slow.map((t) => `${t.name}: ${t.ms} ms`).join('; '));

if (json) console.log(`\n== one plan, whole\n${show(plans['0.1 USDG on Robinhood -> gas on Base'])}`);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
