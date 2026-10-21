// Throwaway check of vault.mjs against live state. Reads only; sends nothing.
//   export PATH=/opt/homebrew/opt/node@22/bin:$PATH
//   node server/ops/vault.test.mjs [--verbose] [--json]    through the staccpad proxy
//   node server/ops/vault.test.mjs --direct                 the DRPC_KEY path, with a made-up key and lb.drpc.live played by this script
//   OP_FILE=./_vault.next.mjs node server/ops/vault.test.mjs   a draft
const DIRECT = process.argv.includes('--direct');
const FAKE_KEY = 'TESTKEY_made_up_0123456789';
if (DIRECT) process.env.DRPC_KEY = FAKE_KEY; else delete process.env.DRPC_KEY;

const realFetch = globalThis.fetch;
const hits = { direct: 0, proxy: 0, xgas: 0 };
let directMode = 'ok'; // ok | auth | down
let proxyDown = false;
let rewriteRpc = null; // (body) => { answer } | { body } | undefined
globalThis.fetch = async (url, init) => {
  const u = String(url);
  let target = u;
  const m = u.match(/^https:\/\/lb\.drpc\.live\/robinhood\/(.+)$/);
  if (m) {
    hits.direct++;
    if (m[1] !== FAKE_KEY) throw new Error('the test saw a dRPC key it did not make up');
    if (directMode === 'auth') return new Response(JSON.stringify({ message: 'Invalid JWT', code: 401 }), { status: 401, headers: { 'content-type': 'application/json' } });
    if (directMode === 'down') return new Response('bad gateway', { status: 502 });
    target = 'https://staccpad.fun/rpc'; // a healthy direct endpoint, played by the proxy
  } else if (u === 'https://staccpad.fun/rpc') {
    hits.proxy++;
    if (proxyDown) return new Response('bad gateway', { status: 502 });
  } else if (u === 'https://xgas.dev/rpc') hits.xgas++;
  if (rewriteRpc && typeof init?.body === 'string' && (m || u === 'https://staccpad.fun/rpc')) {
    const out = await rewriteRpc(JSON.parse(init.body));
    if (out?.answer) return new Response(JSON.stringify(out.answer), { status: 200, headers: { 'content-type': 'application/json' } });
    if (out?.body) return realFetch(target, { ...init, body: JSON.stringify(out.body) });
  }
  return realFetch(target, init);
};

const vault = await import(process.env.OP_FILE || './vault.mjs');

const OWNER = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158';
const USDG = { kind: 'token', id: 'token:4663:0x5fc5360d0400a0fd4f2af552add042d716f1d168', label: 'USDG', sub: 'Global Dollar', chainId: 4663, address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', name: 'Global Dollar', decimals: 6, logo: null, tags: ['stable'] };
const XM = { kind: 'token', id: 'token:4663:0xa924c725b64cc346f275269efa4bd0538cfba97e', label: 'xMoney', sub: 'X Money', chainId: 4663, address: '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E', symbol: 'xMoney', name: 'X Money', decimals: 18, logo: null, tags: ['xmoney'] };
const ETH = { kind: 'token', id: 'token:4663:native', label: 'ETH', sub: 'Ether', chainId: 4663, address: 'NATIVE', symbol: 'ETH', name: 'Ether', decimals: 18, logo: null, tags: ['native'] };
const json = process.argv.includes('--json');
const quiet = !process.argv.includes('--verbose');
const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`); };
const times = [];

function print(p) {
  console.log(`  headline: ${p.headline}`);
  console.log(`  pay:      ${p.pay.amount} ${p.pay.token.symbol} @${p.pay.token.chainId} (${p.pay.label})`);
  console.log(`  receive:  ${p.receive.amount} ${p.receive.token.symbol} @${p.receive.token.chainId} (${p.receive.label})`);
  p.legs.forEach((l, i) => console.log(`  leg ${i}:    [${l.kind} @${l.chainId}] ${l.label} -> ${l.exec.tx ? `to ${l.exec.tx.to} value ${l.exec.tx.value} data ${l.exec.tx.data.slice(0, 74)}${l.exec.tx.data.length > 74 ? '...' : ''}` : 'tx null (quote only)'}`));
  if (quiet) return;
  p.facts.forEach((f) => console.log(`  fact:     ${f.label}: ${f.value}${f.tone ? ` [${f.tone}]` : ''}${f.sub ? `\n            ${f.sub}` : ''}`));
  p.warnings.forEach((w) => console.log(`  warning:  ${w}`));
  console.log(`  contracts: ${p.contracts.map((c) => `${c.name} ${c.address}@${c.chainId}`).join(', ')}`);
}

/** Every leg must be callable by the page: its target is declared, on the leg's own chain, within the pay box. */
function wellFormed(p, owner) {
  const problems = [];
  if (p.routing !== 'PLAN' || p.op !== 'vault') problems.push('routing/op');
  let budget = p.pay.token.address === 'NATIVE' ? BigInt(p.pay.amount) : 0n;
  for (const l of p.legs) {
    if (l.exec.type !== 'tx') { problems.push('exec type'); continue; }
    if (!owner) { if (l.exec.tx !== null) problems.push('quote-only leg carries a tx'); continue; }
    const tx = l.exec.tx;
    if (!tx) { problems.push('missing tx'); continue; }
    if (tx.chainId !== l.chainId) problems.push('leg chain');
    if (!p.contracts.some((c) => c.chainId === tx.chainId && c.address.toLowerCase() === tx.to.toLowerCase())) problems.push(`undeclared target ${tx.to}`);
    if (!/^0x[0-9a-f]*$/i.test(tx.data) || !/^[0-9]+$/.test(tx.value)) problems.push('tx encoding');
    if (BigInt(tx.value) > budget) problems.push('spends more gas token than the pay box shows');
    budget -= BigInt(tx.value);
  }
  const all = JSON.stringify(p);
  const copy = JSON.stringify([p.headline, p.pay.label, p.receive.label, p.legs.map((l) => [l.label, l.note]), p.facts, p.warnings]);
  if (/[—―]/.test(all)) problems.push('em dash in copy');
  if (/tick/i.test(copy)) problems.push('the word tick in copy');
  if (all.includes(FAKE_KEY) || /lb\.drpc\.live/.test(all)) problems.push('THE KEY OR ITS URL IS IN THE PLAN');
  return problems;
}

const with_ = (t, amount) => ({ ...t, amount });
const L4 = (await vault.catalog('token', { owner: OWNER }))[0];
const cases = [
  ['enter: 0.05 USDG -> X Money (Robinhood)', with_(USDG, '50000'), XM],
  ['exit: 0.1 X Money (Robinhood) -> USDG', with_(XM, '100000000000000000'), USDG],
  ['enter-l4: 0.05 USDG -> X Money gas on xGas', with_(USDG, '50000'), L4],
  ['exit-l4: 1 X Money gas on xGas -> USDG', with_(L4, '1000000000000000000'), USDG],
];
const plans = {};
async function runAll(label) {
  for (const [name, input, output] of cases) {
    for (const owner of [OWNER, null]) {
      console.log(`\n== ${label}${name} ${owner ? `for ${owner}` : '(quote only, no owner)'}`);
      try {
        const t0 = Date.now();
        const p = await vault.plan({ input, output, owner, slippage: 0.5 });
        const ms = Date.now() - t0;
        times.push({ name: `${label}${name}${owner ? '' : ' (quote)'}`, ms });
        console.log(`  built in ${ms} ms`);
        print(p);
        const problems = wellFormed(p, owner);
        check('plan is well formed', problems.length === 0, problems.join('; '));
        if (owner) { check('test run passed', p.facts.some((f) => f.label === 'Checked')); plans[name] = p; }
        else check('same number of legs or one more (approval unknown) than the owner plan', p.legs.length >= (plans[name]?.legs.length ?? 0));
      } catch (e) {
        check(`plan failed: ${e.code || ''} ${e.detail || e.message}`, false, e.cause ? String(e.cause.message || e.cause) : '');
      }
    }
  }
}
const expectFail = async (name, args, code) => {
  try { await vault.plan(args); check(name, false, 'no error'); }
  catch (e) {
    const leaked = [e.detail, e.message, String(e.cause?.message || ''), String(e.stack || '')].some((s) => String(s).includes(FAKE_KEY) || /lb\.drpc\.live/.test(String(s)));
    check(`${name}: ${e.code} (${e.status}) "${e.detail}"`, e.planError === true && e.code === code && typeof e.detail === 'string' && !leaked, leaked ? 'KEY LEAKED IN THE ERROR' : '');
  }
};

// ════════════════════════ the DRPC_KEY path ════════════════════════
if (DIRECT) {
  console.log('== direct dRPC (made-up key; lb.drpc.live is played by this script, backed by the staccpad proxy)');
  await new Promise((r) => setTimeout(r, 1_500)); // the module warms its exit window at import
  hits.direct = 0; hits.proxy = 0;
  await runAll('direct: ');
  check(`every Robinhood read went straight to dRPC (direct ${hits.direct}, proxy ${hits.proxy}, xGas ${hits.xgas})`, hits.direct >= 8 && hits.proxy === 0);

  console.log('\n== direct refuses the key (401): fall back to the proxy, then leave direct alone for a while');
  directMode = 'auth'; hits.direct = 0; hits.proxy = 0;
  try { const p = await vault.plan({ input: with_(USDG, '60000'), output: XM, owner: OWNER }); check(`the proxy answered (direct tried ${hits.direct}, proxy ${hits.proxy}): ${p.headline}`, hits.proxy >= 2 && hits.direct >= 1 && hits.direct <= 2 && wellFormed(p, OWNER).length === 0); }
  catch (e) { check(`fallback failed: ${e.code} ${e.detail}`, false); }
  hits.direct = 0;
  try { await vault.plan({ input: with_(XM, '110000000000000000'), output: USDG, owner: OWNER }); check(`while direct rests it is not asked again (${hits.direct} tries)`, hits.direct === 0); }
  catch (e) { check(`second plan failed: ${e.code} ${e.detail}`, false); }

  console.log('\n== both upstreams down: a clean refusal, and no key in it');
  directMode = 'down'; proxyDown = true;
  await expectFail('nothing answers', { input: with_(USDG, '70000'), output: XM, owner: OWNER }, 'UPSTREAM_UNAVAILABLE');
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

// ════════════════════════ the module as deployed ════════════════════════
console.log('== match');
check('USDG -> X Money (Robinhood)', vault.match(USDG, XM) === true);
check('X Money (Robinhood) -> USDG', vault.match(XM, USDG) === true);
check('USDG -> X Money (xGas gas)', vault.match(USDG, L4) === true);
check('X Money (xGas gas) -> USDG', vault.match(L4, USDG) === true);
check('ETH -> X Money is not the vault', vault.match(ETH, XM) === false);
check('X Money -> X Money on xGas is not the vault', vault.match(XM, L4) === false);
check('an NFT is not the vault', vault.match({ kind: 'nft', chainId: 4663 }, USDG) === false);
check('null is not the vault', vault.match(null, undefined) === false);

console.log('\n== catalog');
console.log(show(await vault.catalog('token', {})));
check('catalog(token) serves X Money on xGas', L4?.chainId === 466302 && L4.address === 'NATIVE' && L4.id === 'token:466302:native');
check('catalog(token) for a non-USDG input is empty', (await vault.catalog('token', { input: ETH })).length === 0);
check('catalog(token) for USDG input offers it', (await vault.catalog('token', { input: USDG })).length === 1);
check('catalog(nft-owned) is empty', (await vault.catalog('nft-owned', { owner: OWNER })).length === 0);

await runAll('');

console.log('\n== expected failures');
await expectFail('more USDG than the wallet holds', { input: with_(USDG, '5000000000000'), output: XM, owner: OWNER }, 'INSUFFICIENT_BALANCE');
await expectFail('more X Money than the wallet holds', { input: with_(XM, '5000000000000000000000'), output: USDG, owner: OWNER }, 'INSUFFICIENT_BALANCE');
await expectFail('more xGas X Money than the wallet holds', { input: with_(L4, '5000000000000000000000'), output: USDG, owner: OWNER }, 'INSUFFICIENT_BALANCE');
await expectFail('no amount', { input: USDG, output: XM, owner: OWNER }, 'AMOUNT_REQUIRED');
await expectFail('zero', { input: with_(USDG, '0'), output: XM, owner: OWNER }, 'AMOUNT_REQUIRED');
await expectFail('dust into xGas', { input: with_(USDG, '50'), output: L4, owner: OWNER }, 'AMOUNT_TOO_SMALL');
await expectFail('bad owner', { input: with_(USDG, '50000'), output: XM, owner: '0x123' }, 'BAD_OWNER');
await expectFail('not a vault pair', { input: with_(ETH, '1'), output: XM, owner: OWNER }, 'NOT_A_VAULT_PAIR');
// the vault contract itself: it holds USDG, and it is a contract
await expectFail('a contract wallet cannot receive on xGas', { input: with_(USDG, '50000'), output: L4, owner: '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E' }, 'CONTRACT_WALLET');

// The same plans with the chain misbehaving, by rewriting requests for this process only.
console.log('\n== when the test run fails, or cannot be made');
// only the runs that carry a sender are tampered with: the module's own reads are simulated blocks too
const txRun = (b) => b.method === 'eth_simulateV1' && b.params[0].blockStateCalls[0].calls.some((c) => c.from);
// 1. the vault's code is replaced by one that always reverts, inside the simulated block only
rewriteRpc = (b) => { if (!txRun(b)) return undefined; b.params[0].blockStateCalls[0].stateOverrides = { '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E': { code: '0x60006000fd' } }; return { body: b }; };
await expectFail('a reverting test run refuses the enter', { input: with_(USDG, '50000'), output: XM, owner: OWNER }, 'WOULD_REVERT');
await expectFail('a reverting test run refuses the exit', { input: with_(XM, '100000000000000000'), output: USDG, owner: OWNER }, 'WOULD_REVERT');
// 2. eth_simulateV1 is not served: reads fall back to plain calls, one transaction to eth_call, two cannot be tested and are refused
rewriteRpc = (b) => (b.method === 'eth_simulateV1' ? { answer: { jsonrpc: '2.0', id: b.id, error: { code: -32601, message: 'the method eth_simulateV1 does not exist' } } } : undefined);
try { const p = await vault.plan({ input: with_(XM, '100000000000000000'), output: USDG, owner: OWNER }); check(`exit still planned through eth_call: receive ${p.receive.amount}`, p.legs[0].exec.tx !== null && p.receive.amount === plans[cases[1][0]].receive.amount); } catch (e) { check(`exit through eth_call: ${e.code} ${e.detail}`, false, String(e.cause?.message || '')); }
await expectFail('approval plus deposit cannot be tested without eth_simulateV1', { input: with_(USDG, '50000'), output: XM, owner: OWNER }, 'SIMULATION_UNAVAILABLE');
// 3. the sender cannot pay for the block: the node refuses it as a whole
rewriteRpc = (b) => (txRun(b) ? { answer: { jsonrpc: '2.0', id: b.id, error: { code: -38014, message: 'err: insufficient funds for gas * price + value: address 0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158 have 1 want 2' } } } : undefined);
await expectFail('a block the node refuses outright is a failed run, not a missing one', { input: with_(XM, '100000000000000000'), output: USDG, owner: OWNER }, 'WOULD_REVERT');
rewriteRpc = null;
// 4. the RPC is down
proxyDown = true;
await expectFail('the chain cannot be read', { input: with_(USDG, '50000'), output: XM, owner: OWNER }, 'UPSTREAM_UNAVAILABLE');
proxyDown = false;

console.log('\n== speed (through the staccpad proxy from this machine)');
for (const t of times) console.log(`  ${String(t.ms).padStart(5)} ms  ${t.name}`);
const slow = times.filter((t) => t.ms > 2_000);
check(`every plan under 2 s (slowest ${Math.max(...times.map((t) => t.ms))} ms)`, slow.length === 0, slow.map((t) => `${t.name}: ${t.ms} ms`).join('; '));

if (json) console.log(`\n== one plan, whole\n${show(plans[cases[0][0]])}`);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
