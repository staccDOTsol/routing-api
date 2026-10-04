#!/usr/bin/env python3
"""Teach @uniswap/smart-order-router about Robinhood Chain (4663).

The public router stopped at X Layer; sdk-core already ships Robinhood's v2/v3/v4 addresses. This mirrors every
X Layer site in the compiled build with a Robinhood one. Run after install, then `npx patch-package
@uniswap/smart-order-router` to save the result under patches/.
"""
import re, sys, pathlib

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'node_modules/@uniswap/smart-order-router/build')
X, R = 'sdk_core_1.ChainId.XLAYER', 'sdk_core_1.ChainId.ROBINHOOD'
USDG = "new sdk_core_1.Token(sdk_core_1.ChainId.ROBINHOOD, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 'USDG', 'Global Dollar')"
WETH = "new sdk_core_1.Token(sdk_core_1.ChainId.ROBINHOOD, '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', 18, 'WETH', 'Wrapped Ether')"
# Arrays Robinhood stays out of: it is an Arbitrum Orbit chain (no OP-stack L1 fee) and has no mixed-route quoter.
SKIP_ARRAYS = ('HAS_L1_FEE', 'MIXED_SUPPORTED', 'opStackChains')

def swap(s):
    return s.replace('ChainId.XLAYER', 'ChainId.ROBINHOOD').replace('USDC_XLAYER', 'USDG_ROBINHOOD') \
            .replace('NativeCurrencyName.XLAYER', 'NativeCurrencyName.ETHER')

def patch(path, text):
    if 'ChainId.ROBINHOOD' in text:
        return text
    rel = str(path)
    lines, out, array, i = text.split('\n'), [], None, 0
    while i < len(lines):
        l = lines[i]
        m = re.match(r'^(?:exports\.|const )(\w+) = \[', l)
        if m: array = m.group(1)
        if re.match(r'^\];?\s*$', l): array = None
        nxt = lines[i + 1] if i + 1 < len(lines) else ''
        if X not in l and 'case 196:' not in l and 'USDC_XLAYER = new' not in l:
            out.append(l); i += 1; continue
        if 'USDC_XLAYER = new' in l:                                   # token-provider: define USDG next to it
            out += [l, 'exports.USDG_ROBINHOOD = ' + USDG + ';']
        elif 'case 196:' in l:                                         # numeric id -> enum / name
            ret = "sdk_core_1.ChainId.ROBINHOOD" if 'ChainId.XLAYER' in nxt else "'robinhood-mainnet'"
            out += [l.replace('196', '4663'), re.sub(r'return .*;', f'return {ret};', nxt), l]
        elif re.match(r'^\s*case ' + re.escape(X) + r':\s*(//.*)?$', l):
            if 'JSON_RPC_PROVIDER_XLAYER' in nxt:
                out += [l.replace(X, R), nxt.replace('XLAYER', 'ROBINHOOD'), l]
            elif 'USDC_XLAYER' in nxt:
                out += [l.replace(X, R), swap(nxt), l]
            elif 'gateway.tenderly.co' in nxt:
                out.append(l)                                           # no Tenderly gateway for Robinhood
            else:
                out += [l.replace(X, R), l]                             # fall through with X Layer's settings
        elif re.match(r'^\s*' + re.escape(X) + r',\s*$', l):
            out.append(l)
            if array not in SKIP_ARRAYS: out.append(l.replace(X, R))
        elif re.match(r'^\s*\[' + re.escape(X) + r'\]: .*[\[{]\s*$', l):  # multi-line map entry
            j = i
            while not re.match(r'^\s*[\]}],?\s*$', lines[j]): j += 1
            block = lines[i:j + 1]
            out += block
            if 'OKB' in '\n'.join(block):
                block = [b.replace("'OKB'", "'ETH'", 1).replace("'OKB'", "'ETHER'") for b in block]
            out += [swap(b) for b in block]
            i = j + 1; continue
        elif re.match(r'^\s*\[' + re.escape(X) + r'\]: ', l):          # single-line map entry
            out.append(l)
            if 'MIXED' not in (array or '') and not re.search(r"\]: '0x2d0141", l):
                if 'WOKB' in l: out.append(f"    [{R}]: {WETH},")
                else: out.append(swap(l))
        elif re.search(r'\[' + re.escape(X) + r'\]: (sdk_core_1\.CHAIN_TO_ADDRESSES_MAP\[' + re.escape(X) + r'\]\.\w+) \}\);$', l):
            out.append(re.sub(r'(\[' + re.escape(X) + r'\]: (sdk_core_1\.CHAIN_TO_ADDRESSES_MAP\[' + re.escape(X) + r'\]\.\w+)) \}\);$',
                              lambda m: m.group(1) + ', ' + swap(m.group(1)) + ' });', l))
        else:
            out.append(l)                                               # X Layer's own native-currency class etc.
        i += 1
    return '\n'.join(out)

changed = 0
for build in ('main',):
    for p in sorted((ROOT / build).rglob('*.js')):
        t = p.read_text()
        if 'XLAYER' not in t: continue
        n = patch(p, t)
        if n != t:
            p.write_text(n); changed += 1
            print('patched', p.relative_to(ROOT), n.count('ROBINHOOD'))
print(changed, 'files')
