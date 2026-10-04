#!/usr/bin/env python3
"""Teach @uniswap/universal-router-sdk about Robinhood Chain (4663).

The SDK keeps its router table private (CHAIN_CONFIGS) and throws "Universal Router not deployed on chain 4663"
for anything missing from it, which is what turned every quote with a recipient into a 500. Robinhood has one
Universal Router; it answers eip712Domain() and takes the 2.1 layout of the v4 swap actions, so both 2.x keys
point at it. Run after install, then `npx patch-package @uniswap/universal-router-sdk` to save the result.
"""
import pathlib, re, sys

DIST = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'node_modules/@uniswap/universal-router-sdk/dist')
WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'
ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904'
CREATED = 18127
ZERO = '0x0000000000000000000000000000000000000000'
ENTRY = (
    '{weth:"%s",routerConfigs:{"1.2":{address:"%s",creationBlock:1},'
    '"2.0":{address:"%s",creationBlock:%d},"2.1":{address:"%s",creationBlock:%d}}}'
) % (WETH, ZERO, ROUTER, CREATED, ROUTER, CREATED)


def patch(text):
    if '[4663]' in text:
        return text
    # the X Layer entry is the last one in the table: find it, walk to its closing brace, add ours after it
    m = re.search(r'(\w+)\[196\]\s*=\s*\{', text)
    if not m:
        raise SystemExit('X Layer entry not found: the SDK layout changed')
    depth, i = 0, m.end() - 1
    while True:
        depth += {'{': 1, '}': -1}.get(text[i], 0)
        if depth == 0:
            break
        i += 1
    return text[: i + 1] + ', %s[4663] = %s' % (m.group(1), ENTRY) + text[i + 1 :]


changed = 0
for name in ('universal-router-sdk.cjs.development.js', 'universal-router-sdk.cjs.production.min.js', 'universal-router-sdk.esm.js'):
    p = DIST / name
    t = p.read_text()
    n = patch(t)
    if n != t:
        p.write_text(n)
        changed += 1
        print('patched', name)
print(changed, 'files')
