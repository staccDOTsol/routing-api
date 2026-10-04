#!/usr/bin/env python3
"""Load the router's L2 fee libraries on first use instead of at start.

@uniswap/smart-order-router requires @eth-optimism/sdk (3.4 MB of contract artifacts once bundled) and brotli
(an asm.js encoder that reserves a 600 MB buffer) at module load, for two calls: the L1 data fee on OP-stack
chains and the calldata size on Arbitrum. Every Lambda cold start paid for both, on every chain. This turns the
two requires into getters, so the libraries are evaluated the first time a quote on one of those chains needs
them. Run after install, then `npx patch-package @uniswap/smart-order-router` to save the result under patches/.
"""
import pathlib, sys

P = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'node_modules/@uniswap/smart-order-router/build/main/util/gas-factory-helpers.js')
t = P.read_text()
EDITS = [
    (
        'const sdk_1 = require("@eth-optimism/sdk");',
        'const sdk_1 = { get estimateL1Gas() { return require("@eth-optimism/sdk").estimateL1Gas; }, '
        'get estimateL1GasCost() { return require("@eth-optimism/sdk").estimateL1GasCost; } };',
    ),
    (
        'const brotli_1 = __importDefault(require("brotli"));',
        'const brotli_1 = { get default() { return __importDefault(require("brotli")).default; } };',
    ),
]
changed = 0
for old, new in EDITS:
    if new in t:
        continue
    if old not in t:
        raise SystemExit('not found, the router layout changed: ' + old)
    t = t.replace(old, new)
    changed += 1
P.write_text(t)
print(changed, 'edits')
