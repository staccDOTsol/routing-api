// Written by scripts/sync-ops.sh. Do not edit: run the script again.
//
// The operation modules the router hosts, in the order ties are broken in. Each is loaded on first use inside a
// try, so one that throws while loading takes only itself out (see lib/xgas/ops-host.ts).
/* eslint-disable @typescript-eslint/no-var-requires */
export const OP_LOADERS: Array<[string, () => any]> = [
  ['vault', () => require('./ops/vault.mjs')],
  ['pools', () => require('./ops/pools.mjs')],
  ['otc', () => require('./ops/otc.mjs')],
  ['pawn', () => require('./ops/pawn.mjs')],
  ['gacha', () => require('./ops/gacha.mjs')],
  ['gas', () => require('./ops/gas.mjs')],
  ['arb', () => require('./ops/arb.mjs')],
  ['wallet', () => require('./ops/wallet.mjs')],
]

export const loadCore = (): any => require('./ops/core.mjs')
