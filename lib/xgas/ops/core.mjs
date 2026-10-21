// The operation dispatcher, with no web framework in it: the same file runs under the site's server and inside the
// router's Lambda. An operation module turns one thing into another (sell an NFT, take a loan, deliver gas, run a
// loop that ends where it started) and exports:
//
//   id                                   short name, also the plan's `op`
//   match(input, output)                 cheap and synchronous: could this module take the pair at all?
//   plan({ input, output, owner, slippage })   -> { routing: 'PLAN', op, headline, pay, receive, legs, facts, warnings, contracts }
//   catalog(kind, { owner, chainId, input })   -> Thing[] for the picker (optional)
//   register(app)                        extra routes of its own (optional)
//
// A module refuses with `throw { planError: true, code, detail, status }`.

const KINDS = new Set(['token', 'nft', 'loan', 'ticket', 'mystery']);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PLAN_TIMEOUT_MS = 14_000;
const CATALOG_TIMEOUT_MS = 12_000;
const MAX_THINGS = 600;

export const planError = (code, detail, status = 400) => ({ planError: true, code, detail, status });
const isPlanError = (e) => Boolean(e && typeof e === 'object' && e.planError === true);
/** "Not mine" and "not yet" mean the next module should be asked; anything else is a real answer. */
const passes = (e) => isPlanError(e) && (e.code === 'NO_OP' || e.code === 'NOT_YET');

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(planError('SLOW', 'That took too long to price. Try again.', 504)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function thing(v, name) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !KINDS.has(v.kind)) throw planError('BAD_REQUEST', `${name} is not something this site trades.`, 400);
  if (JSON.stringify(v).length > 8_000) throw planError('BAD_REQUEST', `${name} is too large.`, 400);
  return v;
}

const tokenKey = (t) => (t && typeof t.address === 'string' ? `${t.chainId}:${t.address.toLowerCase()}` : null);
const big = (v) => { try { return v == null ? null : BigInt(v); } catch { return null; } };

/**
 * Picks the plan that leaves the trader best off. Plans are only compared when they are the same trade:
 * the same token out for the same amount in (most out wins), or the same thing out for the same token in
 * (least in wins). Anything else keeps the order the modules were asked in.
 */
export function rank(plans) {
  if (plans.length < 2) return plans;
  const outKeys = new Set(plans.map((p) => tokenKey(p.receive?.token)));
  const inKeys = new Set(plans.map((p) => tokenKey(p.pay?.token)));
  const outs = plans.map((p) => big(p.receive?.amount));
  const ins = plans.map((p) => big(p.pay?.amount));
  const sameIn = inKeys.size === 1 && !inKeys.has(null);
  const sameOut = outKeys.size === 1 && !outKeys.has(null);
  const order = plans.map((p, i) => ({ p, i }));
  if (sameIn && sameOut && outs.every((x) => x != null) && ins.every((x) => x != null)) {
    // most out per unit in: cross-multiplied so nothing is rounded
    order.sort((a, b) => {
      const l = outs[a.i] * ins[b.i], r = outs[b.i] * ins[a.i];
      return l > r ? -1 : l < r ? 1 : a.i - b.i;
    });
  } else if (sameIn && ins.every((x) => x != null) && !plans.some((p) => p.receive?.token)) {
    order.sort((a, b) => (ins[a.i] < ins[b.i] ? -1 : ins[a.i] > ins[b.i] ? 1 : a.i - b.i));
  }
  return order.map((x) => x.p);
}

export function createOps(modules, { log = () => {} } = {}) {
  const list = modules.filter((m) => m && typeof m.id === 'string' && typeof m.match === 'function' && typeof m.plan === 'function');

  async function plan(body) {
    const input = thing(body?.input, 'What you give');
    const output = thing(body?.output, 'What you receive');
    const owner = body?.owner == null || body.owner === '' ? null : body.owner;
    if (owner !== null && !(typeof owner === 'string' && ADDRESS.test(owner))) throw planError('BAD_REQUEST', 'That wallet address is not valid.', 400);
    const s = Number(body?.slippage);
    const slippage = Number.isFinite(s) && s > 0 ? Math.min(20, Math.max(0.01, s)) : 1;

    const takers = list.filter((m) => { try { return m.match(input, output) === true; } catch { return false; } });
    if (!takers.length) throw planError('NO_OP', 'Nothing here can make that trade yet.', 404);

    const settled = await Promise.all(takers.map((m) =>
      withTimeout(Promise.resolve().then(() => m.plan({ input, output, owner, slippage })), PLAN_TIMEOUT_MS)
        .then((p) => ({ m, p }), (e) => ({ m, e }))));
    const good = settled.filter((x) => x.p && x.p.routing === 'PLAN').map((x) => ({ ...x.p, op: x.p.op || x.m.id }));
    if (!good.length) {
      const said = settled.find((x) => x.e && isPlanError(x.e) && !passes(x.e));
      if (said) throw said.e;
      const broke = settled.find((x) => x.e && !isPlanError(x.e));
      if (broke) {
        log(`op ${broke.m.id} failed:`, String(broke.e?.shortMessage || broke.e?.message || broke.e).split('\n')[0].slice(0, 200));
        throw planError('OP_FAILED', 'That could not be priced right now. Try again in a moment.', 502);
      }
      throw planError('NO_OP', 'Nothing here can make that trade yet.', 404);
    }
    const [best, ...rest] = rank(good);
    return rest.length ? { ...best, alternatives: rest } : best;
  }

  async function things(body) {
    const kind = typeof body?.kind === 'string' ? body.kind.slice(0, 32) : '';
    if (!kind) throw planError('BAD_REQUEST', 'kind is required.', 400);
    const owner = typeof body?.owner === 'string' && ADDRESS.test(body.owner) ? body.owner : null;
    const chainId = Number.isSafeInteger(Number(body?.chainId)) && Number(body.chainId) > 0 ? Number(body.chainId) : null;
    const input = body?.input && typeof body.input === 'object' && KINDS.has(body.input.kind) && JSON.stringify(body.input).length <= 8_000 ? body.input : null;

    let failed = 0;
    const lists = await Promise.all(list.filter((m) => typeof m.catalog === 'function').map((m) =>
      withTimeout(Promise.resolve().then(() => m.catalog(kind, { owner, chainId, input })), CATALOG_TIMEOUT_MS)
        .then((r) => (Array.isArray(r) ? r : []), (e) => {
          if (!passes(e)) {
            failed += 1;
            log(`catalog ${m.id}/${kind} failed:`, String(e?.detail || e?.shortMessage || e?.message || e).split('\n')[0].slice(0, 200));
          }
          return [];
        })));
    const seen = new Set();
    const out = [];
    for (const t of lists.flat()) {
      if (!t || typeof t !== 'object' || !KINDS.has(t.kind) || typeof t.id !== 'string' || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      if (out.length >= MAX_THINGS) break;
    }
    // `live` is false when no module that is switched on lists anything at all: the page then says so instead of "you hold nothing"
    // `failed` counts venues that did not answer: an empty list with failures is "could not read", not "nothing there"
    return { things: out, live: list.some((m) => typeof m.catalog === 'function'), failed };
  }

  return { modules: list, ids: list.map((m) => m.id), plan, things };
}

/** How a refusal goes over the wire, whichever host is answering. */
export function toResponse(e) {
  if (isPlanError(e)) {
    const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : 400;
    return { status, body: { errorCode: String(e.code || 'BAD_REQUEST'), detail: String(e.detail || 'That request was refused.') } };
  }
  return { status: 500, body: { errorCode: 'INTERNAL_ERROR', detail: 'Unexpected error' } };
}
