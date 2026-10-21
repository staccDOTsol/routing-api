// Every NFT a wallet holds, on every chain, for the picker. This module trades nothing: it only lists, so the "My NFTs"
// tab fills at once from one indexed lookup, and the venues (pools, loan desks, swap offers) say what each is worth
// when they answer. Source: dRPC's Data & Wallet API with the server key (`DRPC_KEY`, or a full `DRPC_DATA_URL`).
import { getAddress, isAddress } from 'viem';

export const id = 'wallet';

const KEY = process.env.DRPC_KEY || '';
const BASE = String(process.env.DRPC_DATA_URL || (KEY ? `https://lb.drpc.live/lambda/${KEY}` : '')).replace(/\/$/, '');
const TTL_MS = 30_000;
const MAX_PAGES = 6;
const MAX_OWNERS = 300;

export const match = () => false;
export async function plan() {
  throw { planError: true, code: 'NO_OP', detail: 'Listing only.', status: 404 };
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g, '').trim().slice(0, max) : '');
const picture = (v) => (typeof v === 'string' && /^(https:\/\/|ipfs:\/\/|ar:\/\/)[^\s"'<>]{4,400}$/.test(v) ? v : null);
const shortId = (s) => (s.length > 9 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

export function toThing(n) {
  const a = n?.attributes;
  const chainId = Number(n?.chain_id_numeric);
  if (!a || !Number.isSafeInteger(chainId) || chainId <= 0 || n.spam === true) return null;
  if (!isAddress(a.contract_address || '')) return null;
  let tokenId;
  try { tokenId = BigInt(a.token_id).toString(); } catch { return null; }
  const standard = String(a.interface || '').toUpperCase() === 'ERC1155' ? 'erc1155' : 'erc721';
  const collection = getAddress(a.contract_address);
  const named = clean(a.collection?.name, 64);
  // an unnamed collection comes back as its own address: that is not a name
  const collectionName = named && !isAddress(named) ? named : `Collection ${collection.slice(0, 6)}…${collection.slice(-4)}`;
  const name = clean(a.name, 64) || `${collectionName} #${shortId(tokenId)}`;
  return {
    kind: 'nft',
    id: `nft:${chainId}:${collection.toLowerCase()}:${tokenId}`,
    label: name,
    sub: collectionName,
    chainId, collection, tokenId, name,
    image: picture(a.preview_url) || picture(a.image_url),
    collectionName,
    standard,
  };
}

const cache = new Map(); // owner (lowercase) -> { at, promise }

async function load(owner) {
  const out = [];
  const seen = new Set();
  let token = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const u = new URL(`${BASE}/v1/wallets/${owner}/nfts`);
    u.searchParams.set('limit', '100');
    if (token) u.searchParams.set('page_token', token);
    const r = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`nft lookup answered ${r.status}`);
    const j = await r.json();
    for (const n of Array.isArray(j?.data) ? j.data : []) {
      const t = toThing(n);
      if (t && !seen.has(t.id)) { seen.add(t.id); out.push(t); }
    }
    token = typeof j?.next_page_token === 'string' && j.next_page_token ? j.next_page_token : null;
    if (!token) break;
  }
  return out;
}

function nftsOf(owner) {
  const key = owner.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = load(owner).catch((e) => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw e;
  });
  cache.set(key, { at: Date.now(), promise });
  if (cache.size > MAX_OWNERS) cache.delete(cache.keys().next().value);
  return promise;
}

/** `nft-wallet`: everything the wallet holds, as it is indexed. With `chainId`, only that chain. */
export async function catalog(kind, { owner = null, chainId = null } = {}) {
  if (kind !== 'nft-wallet' || !BASE || !isAddress(owner || '')) return [];
  const all = await nftsOf(owner);
  return chainId != null ? all.filter((t) => t.chainId === Number(chainId)) : all;
}
