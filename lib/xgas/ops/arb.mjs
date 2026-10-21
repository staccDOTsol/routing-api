// Every venue an NFT can be bought or sold at, read as one graph, so a swap can go the way that pays most.
//
// This is the stacc-arb scanner (~/nft-range/cli, npm stacc-arb 0.4.4) digested into an operation module. The
// scanner prints candidates for a keeper with a private key. This answers one request with one plan of unsigned
// transactions a browser wallet can send in order, or says honestly that nothing pays.
//
// Venues (Robinhood Chain 4663 unless said otherwise):
//   peg pools        PegFactory v3 / v2 and the omni peg factory: a vault that holds one collection and issues a
//                    claim token, plain Uniswap v4 pools against it, a router that does NFT in / NFT out
//   hook pools       StaccpadFactory stacks: the same idea on staccpad's own hook
//   curves           Number Go Up collections: mint at the curve price, redeem at the floor
//   the bet board    zero-fee Seaport orders at staccpad.fun/api/swap/bets (asks and bids)
//   OpenSea          Seaport listings and collection offers, when OPENSEA_API_KEY is set
//   the vault itself an NFT in mints claims, claims in redeem the floor NFT
//
// What it answers:
//   same token both sides     the best loop that ends where it started (buy an NFT where it is cheap, sell it where
//                             it is dear), or NO_EDGE with the size of the loss
//   gas token <-> its wrapper wrap or unwrap, one transaction
//   token -> claim            buy the NFT elsewhere and vault it, when that mints more claims than the pool sells
//   claim -> token            redeem the NFT and sell it elsewhere, when that pays more than the pool
//   gas token -> any token    run the loop first, then swap what it left: the swap comes out larger
//   NFT -> token, token -> NFT   the best venue of all of them
//
// Nothing is priced by a formula. A candidate is found from a cached book of the venues (rebuilt every 15 seconds,
// never per request), and what is returned has been run, leg by leg in order, on the chain's current state
// (eth_simulateV1) for the wallet that will sign it. Amounts are what that run moved. Nothing is ever sent from here.
// Chain reads go only through the owner's dRPC (the staccpad proxy, or lb.drpc.live when DRPC_KEY is set).
import {
  decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, toHex,
} from 'viem';

export const id = 'arb';

// ───────────────────────── fixed facts ─────────────────────────

const HOME = 4663;
const STACCPAD = 'https://staccpad.fun';
const BOARD_URL = `${STACCPAD}/api/swap/bets?board=1`;
const OPENSEA_API = 'https://api.opensea.io/api/v2';

const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = `0x${'0'.repeat(64)}`;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395';
const CONDUIT_CONTROLLER = '0x00000000F9490004C11Cef243f5400493c00Ad63';
/** One address on every chain; it names that chain's omni peg factory. */
const OMNI_HUB = '0x884F74128f451F98Ec34Dc92F3f1Fc1B2fBDE322';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

/**
 * Where this module reads. `quoter` is Uniswap's canonical v4 Quoter there (@uniswap/sdk-core CHAIN_TO_ADDRESSES_MAP),
 * `slug` is dRPC's name for the chain, `opensea` is OpenSea's.
 */
const CHAINS = new Map([
  [4663, { name: 'Robinhood Chain', gas: 'ETH', gasName: 'Ether', slug: 'robinhood', opensea: 'robinhood', quoter: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94', wrapped: { address: WETH, symbol: 'WETH' } }],
  [8453, { name: 'Base', gas: 'ETH', gasName: 'Ether', slug: 'base', opensea: 'base', quoter: '0x0d5e0F971ED27FBfF6c2837bf31316121532048D', wrapped: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' } }],
  [42161, { name: 'Arbitrum', gas: 'ETH', gasName: 'Ether', slug: 'arbitrum', opensea: 'arbitrum', quoter: '0x3972c00f7ed4885e145823eb7c655375d275a1c5', wrapped: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH' } }],
  [10, { name: 'Optimism', gas: 'ETH', gasName: 'Ether', slug: 'optimism', opensea: 'optimism', quoter: '0x1f3131a13296fb91c90870043742c3cdbff1a8d7', wrapped: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' } }],
  [130, { name: 'Unichain', gas: 'ETH', gasName: 'Ether', slug: 'unichain', opensea: 'unichain', quoter: '0x333e3c607b141b18ff6de9f258db6e77fe7491e0', wrapped: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' } }],
  [81457, { name: 'Blast', gas: 'ETH', gasName: 'Ether', slug: 'blast', opensea: 'blast', quoter: '0x6f71cdcb0d119ff72c6eb501abceb576fbf62bcf', wrapped: { address: '0x4300000000000000000000000000000000000004', symbol: 'WETH' } }],
  [1868, { name: 'Soneium', gas: 'ETH', gasName: 'Ether', slug: 'soneium', opensea: 'soneium', quoter: '0x3972c00f7ed4885e145823eb7c655375d275a1c5', wrapped: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' } }],
  [57073, { name: 'Ink', gas: 'ETH', gasName: 'Ether', slug: 'ink', opensea: 'ink', quoter: '0x3972c00f7ed4885e145823eb7c655375d275a1c5', wrapped: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' } }],
  [7777777, { name: 'Zora', gas: 'ETH', gasName: 'Ether', slug: 'zora', opensea: 'zora', quoter: '0x5edaccc0660e0a2c44b06e07ce8b915e625dc2c6', wrapped: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' } }],
  [56, { name: 'BNB Chain', gas: 'BNB', gasName: 'BNB', slug: 'bsc', opensea: null, quoter: '0x9f75dd27d6664c475b90e105573e550ff69437b0', wrapped: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB' } }],
  [137, { name: 'Polygon', gas: 'POL', gasName: 'POL', slug: 'polygon', opensea: 'matic', quoter: '0xb3d5c3dfc3a7aebff71895a7191796bffc2c81b9', wrapped: { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WPOL' } }],
  [43114, { name: 'Avalanche', gas: 'AVAX', gasName: 'Avalanche', slug: 'avalanche', opensea: 'avalanche', quoter: '0xbe40675bb704506a3c2ccfb762dcfd1e979845c2', wrapped: { address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', symbol: 'WAVAX' } }],
]);
const chainName = (chainId) => CHAINS.get(chainId)?.name ?? `chain ${chainId}`;

/**
 * Every NFT pool stack on Robinhood (stacc-arb chain.mjs STACKS). The omni peg factory is not listed: the hub names
 * it, on every chain. The router of a peg stack is read back from its factory; a hook stack's is pinned here.
 */
const STACKS = [
  { label: 'peg', kind: 'peg', factory: '0x71FF4720E877fbbC013AE9ad6a0Eb32461b98470' },
  { label: 'peg v2', kind: 'peg', factory: '0xfe82Da62B2D2D884f55bcada3703dF54D1F073c2' },
  { label: 'staccpad', kind: 'hook', factory: '0x9f6AE7690d77a8FAb18Ba42fA064FBf0c4791E14', router: '0x914658DE2A13bCb38BDADA4364d60A1e9d360408' },
  { label: 'staccpad v2', kind: 'hook', factory: '0x09679A39650AdDb57126FD4A2e4C2CC8bE729B73', router: '0x914658DE2A13bCb38BDADA4364d60A1e9d360408' },
  { label: 'omnigods', kind: 'hook', factory: '0xF0BE828B3126C4eED2E4EDaCF9FE3923da7c9Fe9', router: '0x09be76f8392AECF440ea8400212751730c18e723' },
];
/** Number Go Up factories, newest first (stacc-arb chain.mjs NGU_FACTORIES). */
const NGU_FACTORIES = [
  '0xAC211C90A697B20dF0145bd22F895da8e2C3Fec4', '0x28c88315FEA956ffFCA1cEa47BDC29fea7b1B895', '0xA86581A116e8EfdDdB449Ce1Ca8E9822a5434d1f',
  '0xca94813887b485e4e16bdc1bd4488dd0a1bec33a', '0x0aae2bad7011884638f85b19d887099c96759e0f', '0xC1C1A27c91EEAaAceE4Bf200429362383299bdf7',
  '0xE2c3C2Ead6dC5a0CbeEF93D811a056Ba0A958680', '0xA04FF119FEc693d094F72e08f078204b370DA1Cb', '0x2B7d8FB395EA63A7F303f4Ea07f5f1c2DCCCe975',
];

/** A stand-in wallet for pricing: it is lent a balance for the length of one simulated run and nothing else. */
const PROBE = '0x000000000000000000000000000000000000dEaD';
const PROBE_LEND = 10n ** 21n;
/** An id no real collection has minted, for pricing a sale into a hook pool without holding anything. */
const FAKE_ID = (1n << 200n) + 7n;
/**
 * An ERC-721 where every token belongs to one address (slot 0) and approvals are never checked. It is never
 * deployed: its runtime code stands in for a collection during one simulated sale, so a hook pool can be asked what
 * it pays without holding an NFT. Source: nft-range src/arb/sim/SimMocks.sol (PermissiveERC721), solc 0.8.26.
 */
const PERMISSIVE_ERC721 = 
  '0x6080806040526004361015610012575f80fd5b5f3560e01c90816301ffc9a71461041e5750806306fdde03146103d6578063081812fc146103a4578063095ea7b31461031e57806317de2f1f146102f757806323b872dd146102e057806342842e0e146102b75780636352211e1461028757806370a082311461026257806395d89b4114610219578063a22cb46514610190578063b88d4fde146101065763e985e9c5146100ab575f80fd5b34610102576040366003190112610102576100c4610495565b6100cc6104ab565b9060018060a01b03165f52600360205260405f209060018060a01b03165f52602052602060ff60405f2054166040519015158152f35b5f80fd5b346101025760803660031901126101025761011f610495565b6101276104ab565b6064359167ffffffffffffffff831161010257366023840112156101025782600401359161015483610531565b9261016260405194856104fb565b8084523660248287010111610102576020815f92602461018e9801838801378501015260443591610636565b005b34610102576040366003190112610102576101a9610495565b6024359081151580920361010257335f52600360205260405f2060018060a01b0382165f5260205260405f2060ff1981541660ff841617905560405191825260018060a01b0316907f17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c3160203392a3005b34610102575f3660031901126101025761025e60405161023a6040826104fb565b600381526253494d60e81b6020820152604051918291602083526020830190610471565b0390f35b346101025760203660031901126101025761027b610495565b50602060405160018152f35b346101025760203660031901126101025760206102a5600435610608565b6040516001600160a01b039091168152f35b346101025761018e6102c8366104c1565b90604051926102d86020856104fb565b5f8452610636565b346101025761018e6102f1366104c1565b9161054d565b34610102575f366003190112610102575f546040516001600160a01b039091168152602090f35b3461010257604036600319011261010257610337610495565b6024355f81815260026020526040902080546001600160a01b0319166001600160a01b038085169190911790915590919061037183610608565b6001600160a01b0390921691167f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b9255f80a4005b34610102576020366003190112610102576004355f526002602052602060018060a01b0360405f205416604051908152f35b34610102575f3660031901126101025761025e6040516103f76040826104fb565b600681526553696d37323160d01b6020820152604051918291602083526020830190610471565b34610102576020366003190112610102576004359063ffffffff60e01b8216809203610102576020916380ac58cd60e01b8114908115610460575b5015158152f35b6301ffc9a760e01b14905083610459565b805180835260209291819084018484015e5f828201840152601f01601f1916010190565b600435906001600160a01b038216820361010257565b602435906001600160a01b038216820361010257565b6060906003190112610102576004356001600160a01b038116810361010257906024356001600160a01b0381168103610102579060443590565b90601f8019910116810190811067ffffffffffffffff82111761051d57604052565b634e487b7160e01b5f52604160045260245ffd5b67ffffffffffffffff811161051d57601f01601f191660200190565b9061055783610608565b6001600160a01b0392831692168290036105d2575f83815260016020908152604080832080546001600160a01b03199081166001600160a01b039690961695861790915560029092528220805490911690559091907fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9080a4565b60405162461bcd60e51b815260206004820152600e60248201526d29a4a69d103737ba1037bbb732b960911b6044820152606490fd5b5f908152600160205260409020546001600160a01b03168061063357505f546001600160a01b031690565b90565b92919261064484838361054d565b813b610651575b50505050565b5f8094936106a9829561069b6040519384926020840197630a85bd0160e11b895233602486015260018060a01b0316604485015260648401526080608484015260a4830190610471565b03601f1981018352826104fb565b51925af13d15610768573d6106bd81610531565b906106cb60405192836104fb565b81523d5f602083013e5b8161075a575b81610725575b50156106f0575f80808061064b565b60405162461bcd60e51b815260206004820152600d60248201526c29a4a69d103932b1b2b4bb32b960991b6044820152606490fd5b905060208180518101031261010257602001516001600160e01b031981169081900361010257630a85bd0160e11b145f6106e1565b9050602081511015906106db565b60606106d556fea164736f6c634300081a000a';

const BOOK_FRESH_MS = 15_000;
const BOOK_STALE_MS = 120_000;
const INDEX_FRESH_MS = 10 * 60_000;
const INDEX_STALE_MS = 60 * 60_000;
const BOARD_FRESH_MS = 30_000;
const OPENSEA_FRESH_MS = 60_000;
const LOOP_FRESH_MS = 8_000;
/** How many candidates are run on the chain per request, best estimate first. */
const TRIALS = 4;
/** NFTs per plan: each one is a transaction of its own to sign. */
const MAX_NFTS = 3;
/** Simulated gas is what the calls burn; the chain also bills for posting them. This covers that and a moving price. */
const GAS_PAD_NUM = 13n, GAS_PAD_DEN = 10n;
const UNWRAP_GAS = 40_000n;

const ALPHA = 'These contracts are new and unaudited. Only use amounts you can afford to lose.';
const SEPARATE = 'These are separate transactions, sent one after another. If a price moves after the first one, a later step can be refused, and you would hold the NFT instead of the tokens.';

// ───────────────────────── ABIs ─────────────────────────

const KEY = 'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }';
const PEG_ROUTER = parseAbi([
  KEY,
  'function buyFloor(PoolKey key, address vault, uint256 maxQuote, address receiver) payable returns (uint256 tokenId, uint256 quotePaid)',
  'function snipe(PoolKey key, address vault, uint256 tokenId, uint256 maxQuote, address receiver) payable returns (uint256 quotePaid)',
  'function sell(PoolKey key, address vault, uint256 tokenId, bytes32[] idProof, uint256 minQuote, address receiver) returns (uint256 quoteReceived)',
]);
const HOOK_ROUTER = parseAbi([
  KEY,
  'function buyFloor(PoolKey key, address vault, address quoteToken, uint256 maxQuote, address receiver) payable returns (uint256 tokenId)',
  'function snipe(PoolKey key, address vault, address quoteToken, uint256 tokenId, uint256 maxQuote, address receiver) payable',
  'function sell(PoolKey key, address vault, address quoteToken, uint256 tokenId, uint256 minQuote, address receiver) returns (uint256 quoteReceived)',
]);
const PEG_FACTORY = parseAbi([
  KEY,
  'function allMarketsLength() view returns (uint256)',
  'function allPoolIds(uint256) view returns (bytes32)',
  'function markets(bytes32) view returns (address vault, address collection, address quoteToken, uint24 fee, int24 tickSpacing, address creator, bool exists)',
  'function getPoolKey(bytes32 poolId) view returns (PoolKey)',
  'function router() view returns (address)',
]);
const HOOK_FACTORY = parseAbi([
  KEY,
  'function allMarketsLength() view returns (uint256)',
  'function allPoolIds(uint256) view returns (bytes32)',
  'function markets(bytes32) view returns (address vault, address collection, address quoteToken, uint24 fee, int24 tickSpacing, bool exists)',
  'function getPoolKey(address collection, address quoteToken, uint24 fee) view returns (PoolKey)',
]);
const HUB = parseAbi(['function factory() view returns (address)']);
const VAULT = parseAbi([
  'function inventoryCount() view returns (uint256)',
  'function peekFloor() view returns (uint256)',
  'function inventoryAt(uint256) view returns (uint256)',
  'function floorCost() view returns (uint256)',
  'function unit() view returns (uint256)',
  'function mintUnit() view returns (uint256)',
  'function taxBps() view returns (uint16)',
  'function allowedIdsRoot() view returns (bytes32)',
  'function minBalance() view returns (uint256)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function deposit(uint256 tokenId, address receiver) returns (uint256)',
  'function depositBatch(uint256[] tokenIds, address receiver) returns (uint256)',
  'function redeemFloor(address receiver) returns (uint256)',
]);
const ERC721 = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function getApproved(uint256) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function approve(address to, uint256 tokenId)',
  'function setApprovalForAll(address operator, bool approved)',
  'function name() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);
const WRAPPED = parseAbi(['function deposit() payable', 'function withdraw(uint256 wad)']);
const QUOTER = parseAbi([
  KEY,
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
  'function quoteExactOutputSingle(QuoteExactSingleParams params) returns (uint256 amountIn, uint256 gasEstimate)',
]);
const NGU_FACTORY = parseAbi(['function allCollectionsLength() view returns (uint256)', 'function allCollections(uint256) view returns (address)']);
const NGU = parseAbi([
  'function name() view returns (string)',
  'function minted() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function seedQty() view returns (uint256)',
  'function companionsPerMint() view returns (uint8)',
  'function isCompanion(uint256) view returns (bool)',
  'function quoteBuy(uint256 qty) view returns (uint256)',
  'function quoteSell(uint256 qty) view returns (uint256)',
  'function buy(uint256 qty, address to) payable returns (uint256 cost)',
  'function sell(uint256[] ids, address to, uint256 minOut) returns (uint256 payout)',
]);
const MULTICALL = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);
/** Seaport 1.6: the entry points the bet board and OpenSea's fulfillment endpoint use. */
const SEAPORT_ABI = parseAbi([
  'struct OfferItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; }',
  'struct ConsiderationItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; address recipient; }',
  'struct OrderParameters { address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 totalOriginalConsiderationItems; }',
  'struct Order { OrderParameters parameters; bytes signature; }',
  'struct AdvancedOrder { OrderParameters parameters; uint120 numerator; uint120 denominator; bytes signature; bytes extraData; }',
  'struct CriteriaResolver { uint256 orderIndex; uint8 side; uint256 index; uint256 identifier; bytes32[] criteriaProof; }',
  'struct AdditionalRecipient { uint256 amount; address recipient; }',
  'struct BasicOrderParameters { address considerationToken; uint256 considerationIdentifier; uint256 considerationAmount; address offerer; address zone; address offerToken; uint256 offerIdentifier; uint256 offerAmount; uint8 basicOrderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 offererConduitKey; bytes32 fulfillerConduitKey; uint256 totalOriginalAdditionalRecipients; AdditionalRecipient[] additionalRecipients; bytes signature; }',
  'function fulfillBasicOrder(BasicOrderParameters parameters) payable returns (bool)',
  'function fulfillBasicOrder_efficient_6GL6yc(BasicOrderParameters parameters) payable returns (bool)',
  'function fulfillOrder(Order order, bytes32 fulfillerConduitKey) payable returns (bool)',
  'function fulfillAdvancedOrder(AdvancedOrder advancedOrder, CriteriaResolver[] criteriaResolvers, bytes32 fulfillerConduitKey, address recipient) payable returns (bool)',
]);
const CONDUITS = parseAbi(['function getConduit(bytes32 key) view returns (address conduit, bool exists)']);

// ───────────────────────── small pieces ─────────────────────────

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isAddress = (s) => typeof s === 'string' && ADDRESS.test(s);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const lc = (a) => String(a).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const min = (a, b) => (a < b ? a : b);

/** A refusal the dispatcher shows as is. NO_OP and NOT_YET mean "ask the next module". */
const fail = (code, detail, status = 422) => Object.assign(new Error(detail), { planError: true, code, detail, status });
const PASS = (detail = 'No venue here beats the plain route for that pair.') => fail('NO_OP', detail, 404);
const UNCHECKED = () => fail('SIM_UNAVAILABLE', 'This could not be tried on the chain just now, so it is not offered. Try again in a moment.', 503);

/** Printable, one line, bounded, no long dashes: names and symbols come from contracts anyone can deploy. */
function clean(v, max = 48) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '').replace(/[\u2012-\u2015]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max);
}
/** Base units to a short decimal: at most `sig` digits after the leading zeros. Exact, no floats. */
function human(value, decimals = 18, sig = 4) {
  let v = BigInt(value);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (!frac) return `${neg ? '-' : ''}${whole}`;
  const lead = whole === 0n ? frac.match(/^0*/)[0].length : 0;
  const cut = frac.slice(0, lead + sig).replace(/0+$/, '');
  return `${neg ? '-' : ''}${cut ? `${whole}.${cut}` : whole}`;
}
/** A collection's name short enough to sit in a sentence: no trailing "collection", cut at a word. */
function brief(name, max = 30) {
  const n = name.replace(/\s+collection$/i, '').trim();
  if (n.length <= max) return n;
  const cut = n.slice(0, max);
  return (cut.lastIndexOf(' ') > 12 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trim();
}
const pctOf = (part, whole) => (whole === 0n ? '0' : (Number((part * 100_000n) / whole) / 1000).toFixed(Math.abs(Number((part * 1000n) / whole)) >= 100 ? 0 : 1).replace(/\.0$/, ''));
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Slippage as the page's executor computes it, so a leg's value can never pass its budget by a rounding. */
const upBy = (x, slippage) => (x * BigInt(Math.round((100 + slippage) * 100))) / 10_000n;
const downBy = (x, slippage) => (x * BigInt(Math.max(0, Math.round((100 - slippage) * 100)))) / 10_000n;

/** A token id as a BigInt, or null when it is not one. */
function tokenIdOf(v) {
  const s = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === 'bigint' ? v.toString() : v;
  if (typeof s !== 'string' || !/^[0-9]{1,78}$/.test(s)) return null;
  const n = BigInt(s);
  return n < 1n << 256n ? n : null;
}
function amountOf(thing) {
  const a = thing?.amount;
  if (a == null || a === '') return null;
  if (typeof a !== 'string' || !/^[0-9]{1,77}$/.test(a)) throw fail('BAD_REQUEST', 'The amount is not a whole number of base units.', 400);
  const n = BigInt(a);
  return n > 0n ? n : null;
}

/** At most `max` of `fn` at once; the rest wait their turn. */
function gateOf(max) {
  let active = 0;
  const waiting = [];
  const next = () => { active--; const w = waiting.shift(); if (w) w(); };
  return async (fn) => {
    if (active >= max) await new Promise((r) => waiting.push(r));
    active++;
    try { return await fn(); } finally { next(); }
  };
}

/**
 * One value per key, loaded at most once at a time. Fresh for `fresh` ms; after that the last value is served at
 * once while one load refreshes it, until `stale` ms, when a caller waits for the load. A load that fails keeps the
 * last value and is tried again on the next call: a frozen or dead load (a Lambda paused mid-flight) never sticks.
 */
function keyed({ fresh, stale = fresh, max = 64, load }) {
  const map = new Map();
  const refresh = (k, e) => {
    if (!e.pending) {
      const started = Date.now();
      e.pending = Promise.resolve().then(() => load(k, e.value)).then(
        (v) => { e.value = v; e.at = Date.now(); e.error = null; e.pending = null; return v; },
        (err) => { e.error = err; e.pending = null; throw err; },
      );
      e.pending.catch(() => {});
      e.started = started;
    } else if (Date.now() - e.started > 30_000) {
      // a load that has been "running" this long was frozen with the process: let a new one start
      e.pending = null;
      return refresh(k, e);
    }
    return e.pending;
  };
  return {
    async get(key) {
      const k = String(key);
      let e = map.get(k);
      if (!e) {
        if (map.size >= max) map.delete(map.keys().next().value);
        map.set(k, e = { value: undefined, at: 0, pending: null, error: null, started: 0 });
      }
      const age = Date.now() - e.at;
      if (e.value !== undefined && age < fresh) return e.value;
      if (e.value !== undefined && age < stale) { refresh(k, e); return e.value; }
      return refresh(k, e);
    },
    peek: (k) => map.get(String(k))?.value,
    drop: (k) => map.delete(String(k)),
    clear: () => map.clear(),
  };
}

// ───────────────────────── host hooks ─────────────────────────

/**
 * What the host may hand in. `classic` answers "what do the pools pay for this swap": inside the router it is the
 * route being computed for the same request, so nothing is priced twice. Without it the public quote endpoint is
 * asked, with plans switched off so a quote can never ask for itself.
 */
const DEBUG = !!process.env.ARB_DEBUG;
const host = { classic: null, classicUrl: null, log: DEBUG ? (...a) => console.error('[arb]', ...a) : () => {} };
export function configure(o = {}) {
  if (typeof o.classic === 'function' || o.classic === null) host.classic = o.classic ?? null;
  if (typeof o.classicUrl === 'string' || o.classicUrl === null) host.classicUrl = o.classicUrl ?? null;
  if (typeof o.log === 'function') host.log = o.log;
}
const DEFAULT_CLASSIC_URL = 'https://xn644o3px9.execute-api.us-east-2.amazonaws.com/prod/quote';

/** One call to the public quote endpoint at a time, and the same question within a few seconds is asked once. */
const classicAnswers = new Map(); // key -> { at, promise }
let classicBusy = Promise.resolve();
function askRouter(q) {
  const key = `${q.chainId}:${q.tokenIn}:${q.tokenOut}:${q.amount}`.toLowerCase();
  const hit = classicAnswers.get(key);
  if (hit && Date.now() - hit.at < 5_000) return hit.promise;
  if (classicAnswers.size > 200) classicAnswers.clear();
  const run = async () => {
    const url = host.classicUrl || process.env.ROUTER_QUOTE_URL || DEFAULT_CLASSIC_URL;
    const gas = CHAINS.get(q.chainId)?.gas ?? 'ETH';
    const alias = (t) => (t === 'NATIVE' ? (gas === 'POL' ? 'MATIC' : gas) : t);
    // plans=off: the router must answer with its pools alone, or a quote could end up asking for itself
    const p = new URLSearchParams({ tokenInAddress: alias(q.tokenIn), tokenInChainId: String(q.chainId), tokenOutAddress: alias(q.tokenOut), tokenOutChainId: String(q.chainId), amount: q.amount, type: 'exactIn', plans: 'off' });
    const r = await fetch(`${url}?${p}`, { headers: { accept: 'application/json', 'x-universal-router-version': '2.0' }, signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (typeof j?.quote !== 'string' || !/^[0-9]+$/.test(j.quote)) return null;
    return { amountOut: BigInt(j.quote), priceImpactBps: Math.round(Number(j.priceImpact ?? 0) * 100) || 0 };
  };
  const promise = (classicBusy = classicBusy.then(run, run)).catch(() => null);
  classicAnswers.set(key, { at: Date.now(), promise });
  return promise;
}

/** { amountOut, priceImpactBps } for an exact-in swap through the pools, or null when there is no answer in time. */
async function classicQuote({ chainId, tokenIn, tokenOut, amount }) {
  const q = { chainId, tokenIn, tokenOut, amount: amount.toString() };
  try {
    if (host.classic) {
      const r = await host.classic(q);
      return r && r.amountOut != null ? { amountOut: BigInt(r.amountOut), priceImpactBps: Number(r.priceImpactBps ?? 0) } : null;
    }
    // behind a queue of one and a slow router this could wait a long time: past a few seconds there is no answer
    return await Promise.race([askRouter(q), sleep(6_500).then(() => null)]);
  } catch {
    return null;
  }
}

// ───────────────────────── chain access ─────────────────────────

const KEY_SHAPE = /^[A-Za-z0-9_-]{8,200}$/;
/** dRPC only: straight to its load balancer when the server key is set, else (and as the fallback) the staccpad proxy. */
function rpcUrls(chainId) {
  const key = process.env.DRPC_KEY;
  const slug = CHAINS.get(chainId)?.slug;
  const proxy = chainId === HOME ? `${STACCPAD}/rpc` : `${STACCPAD}/rpc/${chainId}`;
  return key && KEY_SHAPE.test(key) && slug ? [`https://lb.drpc.live/${slug}/${key}`, proxy] : [proxy];
}

const gates = new Map();
let rpcSeq = 0;
const stats = { calls: 0, hedged: 0, retries: 0, failures: 0 };
const HEDGE_AFTER_MS = 1_200;
const READS = new Set(['eth_simulateV1', 'eth_call', 'eth_getStorageAt', 'eth_gasPrice']);

/** One POST. The parsed answer, or null when the line gave none in time. */
async function post(url, method, params, timeoutMs) {
  stats.calls++;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSeq, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = JSON.parse(await r.text());
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}
/**
 * The same question worded a second way. The proxy answers identical requests in flight from one upstream call,
 * so a second try has to differ or it would only wait behind the stalled first one.
 */
function reworded(method, params) {
  if (method === 'eth_simulateV1' && params[0] && typeof params[0] === 'object') return [{ ...params[0], returnFullTransactions: false }, ...params.slice(1)];
  return params;
}

/**
 * One JSON-RPC call. A JSON-RPC error is thrown with `.rpc`. The line stalls now and then, so a read that has not
 * answered in a little over a second is asked a second time alongside the first and the quicker answer is taken;
 * if neither comes back it is tried once more before giving up.
 */
function rpc(chainId, method, params, timeoutMs = 5_000) {
  if (!gates.has(chainId)) gates.set(chainId, gateOf(10));
  return gates.get(chainId)(async () => {
    const urls = rpcUrls(chainId);
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      const url = urls[Math.min(attempt, urls.length - 1)];
      const first = post(url, method, attempt ? reworded(method, params) : params, timeoutMs);
      let j;
      if (READS.has(method) && attempt === 0) {
        // whichever answers first with something; when one comes back empty, the other still may
        j = await new Promise((resolve) => {
          let open = 2;
          let timer = null;
          const done = (v) => { if (v) { clearTimeout(timer); resolve(v); } else if (--open === 0) resolve(null); };
          first.then(done);
          timer = setTimeout(() => { stats.hedged++; post(urls[urls.length - 1], method, reworded(method, params), timeoutMs).then(done); }, HEDGE_AFTER_MS);
        });
      } else {
        j = await first;
      }
      if (j) {
        if (DEBUG) host.log(`rpc ${chainId} ${method} ${Date.now() - started} ms${attempt ? ` (try ${attempt + 1})` : ''}`);
        if (!j.error) return j.result;
        throw Object.assign(new Error(String(j.error.message ?? 'rpc error').slice(0, 300)), { rpc: { code: j.error.code, message: String(j.error.message ?? ''), data: j.error.data } });
      }
      if (attempt >= 1) { stats.failures++; throw new Error(`${chainName(chainId)} did not answer ${method}`); }
      stats.retries++;
      await sleep(150);
    }
  });
}

/** A call to make: where, what, with how much of the gas token, and how to read the answer. */
const C = (to, abi, functionName, args = [], value = 0n) => ({ to, abi, functionName, value, data: encodeFunctionData({ abi, functionName, args }) });
const raw = (to, data, value = 0n) => ({ to, data, value, abi: null, functionName: null });
function decode(spec, hex) {
  if (!spec?.abi) return null;
  try { return decodeFunctionResult({ abi: spec.abi, functionName: spec.functionName, data: hex }); } catch { return null; }
}
const ethOf = (who) => C(MULTICALL3, MULTICALL, 'getEthBalance', [who]);
const balOf = (token, who) => (token === 'NATIVE' ? ethOf(who) : C(token, ERC20, 'balanceOf', [who]));

/**
 * Run calls in order, as `from`, on top of the chain's current state, and send nothing (eth_simulateV1: one
 * simulated block, so an approval is in place for the call after it). Never answered from a cache: the staccpad
 * proxy caches eth_call for seconds, and a cached run is not a check. Each row is { ok, data, gas, logs, error }.
 */
async function simulate(chainId, from, calls, { lend = null, overrides = null } = {}) {
  if (!calls.length) return { rows: [], block: 0 };
  const stateOverrides = { ...(overrides || {}) };
  if (lend != null) stateOverrides[from] = { ...(stateOverrides[from] || {}), balance: toHex(lend) };
  const wire = (c) => ({ from, to: c.to, data: c.data, ...(c.value && BigInt(c.value) > 0n ? { value: toHex(BigInt(c.value)) } : {}) });
  let res;
  try {
    res = await rpc(chainId, 'eth_simulateV1', [{ blockStateCalls: [{ calls: calls.map(wire), ...(Object.keys(stateOverrides).length ? { stateOverrides } : {}) }], validation: false }, 'latest']);
  } catch (e) {
    if (e?.rpc && /insufficient (funds|balance)/i.test(e.rpc.message)) throw fail('INSUFFICIENT_BALANCE', `This wallet does not hold enough ${CHAINS.get(chainId)?.gas ?? 'gas token'} on ${chainName(chainId)} for this.`, 400);
    throw UNCHECKED();
  }
  const rows = res?.[0]?.calls;
  if (!Array.isArray(rows) || rows.length !== calls.length) throw UNCHECKED();
  return {
    block: Number(BigInt(res[0].number ?? 0)),
    rows: rows.map((c, i) => ({
      ok: c?.status === '0x1',
      data: typeof c?.returnData === 'string' ? c.returnData : '0x',
      out: c?.status === '0x1' ? decode(calls[i], c.returnData) : null,
      gas: c?.gasUsed ? BigInt(c.gasUsed) : 0n,
      logs: Array.isArray(c?.logs) ? c.logs : [],
      error: c?.status === '0x1' ? null : (c?.error || { message: 'reverted' }),
    })),
  };
}

const noSimulate = new Map(); // chainId -> until when eth_simulateV1 is not worth asking for there
/**
 * Many reads in one round trip (Multicall3 inside one simulated call, so the proxy's cache is never the answer).
 * A read that fails is null. A chain whose node has no eth_simulateV1 is read with a plain eth_call instead:
 * its venues can be listed, and anything that would have to be run there is refused.
 */
async function mread(chainId, specs, chunk = 250) {
  const out = new Array(specs.length).fill(null);
  const parts = [];
  for (let i = 0; i < specs.length; i += chunk) parts.push([i, specs.slice(i, i + chunk)]);
  await Promise.all(parts.map(async ([start, part]) => {
    const data = encodeFunctionData({ abi: MULTICALL, functionName: 'aggregate3', args: [part.map((s) => ({ target: s.to, allowFailure: true, callData: s.data }))] });
    let hex = null;
    if (!((noSimulate.get(chainId) || 0) > Date.now())) {
      try {
        const { rows } = await simulate(chainId, PROBE, [raw(MULTICALL3, data)]);
        if (rows[0].ok) hex = rows[0].data;
      } catch { if (chainId !== HOME) noSimulate.set(chainId, Date.now() + 5 * 60_000); }
    }
    if (hex == null) {
      if (chainId === HOME) throw new Error('reads refused');
      hex = await rpc(chainId, 'eth_call', [{ to: MULTICALL3, data }, 'latest']);
    }
    const got = decodeFunctionResult({ abi: MULTICALL, functionName: 'aggregate3', data: hex });
    got.forEach((r, k) => { out[start + k] = r.success ? decode(part[k], r.returnData) : null; });
  }));
  return out;
}

/** Many independent calls, each with a gas allowance of its own (the Quoter is heavy). A call that fails is null. */
async function sread(chainId, specs, chunk = 100) {
  const out = new Array(specs.length).fill(null);
  const parts = [];
  for (let i = 0; i < specs.length; i += chunk) parts.push([i, specs.slice(i, i + chunk)]);
  await Promise.all(parts.map(async ([start, part]) => {
    const { rows } = await simulate(chainId, PROBE, part);
    rows.forEach((r, k) => { out[start + k] = r.ok ? r.out : null; });
  }));
  return out;
}

const gasPrices = keyed({ fresh: 15_000, stale: 120_000, load: async (chainId) => BigInt(await rpc(Number(chainId), 'eth_gasPrice', [])) });
const feeFor = (gasUnits, gasPrice) => (gasUnits * gasPrice * GAS_PAD_NUM) / GAS_PAD_DEN;

// what a contract said when it refused, in words
const REASONS = [
  [/^0xe450d38c/i, 'the pool could not hand over a whole NFT'],
  [/^0x7a5ed734/i, 'the pool does not have enough in it'],
  [/^0x177e802f|^0x64283d7b|not approved|insufficient approval/i, 'an approval was missing'],
  [/^0x1de5204e/i, 'this collection only lets listed marketplaces move it'],
  [/fifo race/i, 'someone else took that NFT first'],
  [/slippage/i, 'the price moved past your limit'],
  [/not a factory market/i, 'that pool is not one of this venue\'s'],
  [/insufficient (funds|balance)/i, 'the wallet does not hold enough'],
];
function reason(error) {
  let text = `${error?.data ?? ''} ${error?.message ?? ''}`;
  if (typeof error?.data === 'string' && error.data.startsWith('0x08c379a0') && error.data.length >= 138) {
    try { text += ` ${Buffer.from(error.data.slice(138), 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '')}`; } catch { /* keep the code */ }
  }
  for (const [re, words] of REASONS) if (re.test(text.trim())) return words;
  return 'a contract refused it';
}

// ───────────────────────── tokens ─────────────────────────

const gasToken = (chainId) => {
  const c = CHAINS.get(chainId);
  return { chainId, address: 'NATIVE', symbol: c.gas, name: c.gasName, decimals: 18, logo: null, tags: ['native'] };
};
const wrappedToken = (chainId) => {
  const c = CHAINS.get(chainId);
  return { chainId, address: getAddress(c.wrapped.address), symbol: c.wrapped.symbol, name: `Wrapped ${c.gasName}`, decimals: 18, logo: null, tags: ['wrapped'] };
};
const quoteToken = (m) => (m.quote.native ? gasToken(m.chainId) : { chainId: m.chainId, address: getAddress(m.quote.address), symbol: m.quote.symbol, name: m.quote.symbol, decimals: m.quote.decimals, logo: null, tags: [] });
const claimToken = (m) => ({ chainId: m.chainId, address: getAddress(m.vault), symbol: m.claimSymbol || 'CLAIM', name: m.claimName || `Vaulted ${m.name}`, decimals: 18, logo: null, tags: ['claim'] });
/** The page's own logo and tags for a token it already knows, on top of what the chain says about it. */
function dress(token, thing) {
  if (!thing || thing.kind !== 'token' || Number(thing.chainId) !== token.chainId || !same(String(thing.address), token.address)) return token;
  const logo = typeof thing.logo === 'string' && /^(https:\/\/|data:image\/)/.test(thing.logo) && thing.logo.length <= 16_000 ? thing.logo : token.logo;
  const tags = Array.isArray(thing.tags) && thing.tags.every((t) => typeof t === 'string' && t.length <= 24) ? thing.tags.slice(0, 8) : token.tags;
  return { ...token, logo, tags };
}
/** 'NATIVE' or a lowercase address: how a token is named everywhere below. */
const keyOfToken = (t) => (t.address === 'NATIVE' ? 'NATIVE' : lc(t.address));
const isTokenThing = (t) => !!t && typeof t === 'object' && t.kind === 'token' && CHAINS.has(Number(t.chainId)) && (t.address === 'NATIVE' || isAddress(t.address));
const isNftThing = (t) => !!t && typeof t === 'object' && t.kind === 'nft' && CHAINS.has(Number(t.chainId)) && isAddress(t.collection);

// ───────────────────────── the index: which venues exist ─────────────────────────

const claimIs0 = (m) => same(m.key.currency0, m.vault);

/**
 * Every pool, vault and curve on a chain, from the factories themselves. Ten minutes fresh: venues are created
 * rarely, and what moves (prices, inventory) is the book's job.
 */
const indexes = keyed({
  fresh: INDEX_FRESH_MS,
  stale: INDEX_STALE_MS,
  max: 16,
  load: async (k) => {
    const t0 = Date.now();
    const chainId = Number(k);
    const home = chainId === HOME;
    const stacks = home ? STACKS.map((s) => ({ ...s })) : [];
    const [omniFactory, ...pegRouters] = await mread(chainId, [C(OMNI_HUB, HUB, 'factory'), ...stacks.filter((s) => s.kind === 'peg').map((s) => C(s.factory, PEG_FACTORY, 'router'))]);
    stacks.filter((s) => s.kind === 'peg').forEach((s, i) => { s.router = pegRouters[i]; });
    if (isAddress(omniFactory) && !same(omniFactory, ZERO)) stacks.push({ label: 'omni', kind: 'peg', omni: true, factory: omniFactory, router: null });

    const facAbi = (s) => (s.kind === 'peg' ? PEG_FACTORY : HOOK_FACTORY);
    const head = await mread(chainId, [
      ...stacks.map((s) => C(s.factory, facAbi(s), 'allMarketsLength')),
      ...stacks.filter((s) => s.omni).map((s) => C(s.factory, PEG_FACTORY, 'router')),
      ...(home ? NGU_FACTORIES.map((f) => C(f, NGU_FACTORY, 'allCollectionsLength')) : []),
    ]);
    stacks.filter((s) => s.omni).forEach((s, i) => { s.router = head[stacks.length + i]; });
    const live = stacks.filter((s) => isAddress(s.router));
    const slots = live.flatMap((s) => Array.from({ length: Math.min(400, Number(head[stacks.indexOf(s)] ?? 0n)) }, (_, i) => ({ s, i })));
    const curveLens = home ? head.slice(stacks.length + stacks.filter((s) => s.omni).length) : [];
    const curveSlots = home ? NGU_FACTORIES.flatMap((f, n) => Array.from({ length: Math.min(200, Number(curveLens[n] ?? 0n)) }, (_, i) => ({ f, i }))) : [];

    const ids = await mread(chainId, [
      ...slots.map(({ s, i }) => C(s.factory, facAbi(s), 'allPoolIds', [BigInt(i)])),
      ...curveSlots.map(({ f, i }) => C(f, NGU_FACTORY, 'allCollections', [BigInt(i)])),
    ]);
    const curveAddrs = [...new Map(ids.slice(slots.length).filter(isAddress).map((a) => [lc(a), a])).values()];
    const metas = await mread(chainId, slots.map(({ s }, n) => C(s.factory, facAbi(s), 'markets', [ids[n] ?? ZERO32])));
    const drafts = slots.map(({ s }, n) => {
      const m = metas[n];
      if (!m || !ids[n]) return null;
      const peg = s.kind === 'peg';
      if (!(peg ? m[6] : m[5])) return null;
      return { chainId, stack: s.label, kind: s.kind, omni: !!s.omni, factory: s.factory, router: s.router, poolId: ids[n], vault: m[0], collection: m[1], quoteAddress: m[2], fee: Number(m[3]), tickSpacing: Number(m[4]) };
    }).filter(Boolean);

    const quotes = [...new Set(drafts.map((d) => lc(d.quoteAddress)).filter((a) => a !== ZERO))];
    const collections = [...new Set(drafts.map((d) => lc(d.collection)))];
    const pegVaults = [...new Set(drafts.filter((d) => d.kind === 'peg').map((d) => lc(d.vault)))];
    const CURVE_FIELDS = ['name', 'maxSupply', 'seedQty', 'companionsPerMint'];
    const more = await mread(chainId, [
      ...drafts.map((d) => (d.kind === 'peg' ? C(d.factory, PEG_FACTORY, 'getPoolKey', [d.poolId]) : C(d.factory, HOOK_FACTORY, 'getPoolKey', [d.collection, d.quoteAddress, d.fee]))),
      ...quotes.flatMap((a) => [C(a, ERC20, 'symbol'), C(a, ERC20, 'decimals')]),
      ...collections.map((a) => C(a, ERC721, 'name')),
      ...pegVaults.flatMap((a) => [C(a, VAULT, 'symbol'), C(a, VAULT, 'name'), C(a, VAULT, 'allowedIdsRoot'), C(a, VAULT, 'minBalance')]),
      ...curveAddrs.flatMap((a) => CURVE_FIELDS.map((fn) => C(a, NGU, fn))),
    ]);
    let at = drafts.length;
    const quoteMeta = new Map(quotes.map((a) => { const r = [clean(more[at] ?? '', 16), Number(more[at + 1] ?? 18)]; at += 2; return [a, r]; }));
    const names = new Map(collections.map((a) => [a, brief(clean(more[at++] ?? '', 64))]));
    const vaultMeta = new Map(pegVaults.map((a) => { const r = { symbol: clean(more[at] ?? '', 20), name: clean(more[at + 1] ?? '', 48), gated: more[at + 2] != null && BigInt(more[at + 2]) !== 0n, minBalance: more[at + 3] ?? 0n }; at += 4; return [a, r]; }));
    const curves = curveAddrs.map((a) => {
      const r = more.slice(at, at + CURVE_FIELDS.length); at += CURVE_FIELDS.length;
      if (r[1] == null) return null;
      return { chainId, collection: getAddress(a), name: brief(clean(r[0] ?? '', 64)) || `Collection ${a.slice(0, 6)}`, maxSupply: r[1], seedQty: r[2] ?? 0n, companions: Number(r[3] ?? 0) };
    }).filter(Boolean);

    const wrapped = lc(CHAINS.get(chainId).wrapped.address);
    const markets = drafts.map((d, n) => {
      const key = more[n];
      if (!key) return null;
      const native = same(d.quoteAddress, ZERO);
      const [symbol, decimals] = native ? [CHAINS.get(chainId).gas, 18] : quoteMeta.get(lc(d.quoteAddress)) || ['', 18];
      const v = vaultMeta.get(lc(d.vault));
      return {
        ...d,
        vault: getAddress(d.vault), collection: getAddress(d.collection), router: getAddress(d.router),
        key: { currency0: key.currency0, currency1: key.currency1, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing), hooks: key.hooks },
        quote: { address: native ? ZERO : getAddress(d.quoteAddress), native, wrapped: lc(d.quoteAddress) === wrapped, symbol: symbol || `${d.quoteAddress.slice(0, 6)}`, decimals },
        name: names.get(lc(d.collection)) || `Collection ${d.collection.slice(0, 6)}`,
        claimSymbol: v?.symbol || '', claimName: v?.name || '', gated: !!v?.gated, minBalance: v?.minBalance ?? 0n,
      };
    }).filter(Boolean);
    if (DEBUG) host.log(`index ${chainId}: ${markets.length} pools, ${curves.length} curves, ${Date.now() - t0} ms`);
    return { chainId, at: Date.now(), markets, curves };
  },
});

// ───────────────────────── the book: what each venue pays and charges right now ─────────────────────────

const fakeSlot0 = (owner) => ({ [`0x${'0'.repeat(64)}`]: `0x${'0'.repeat(24)}${owner.slice(2).toLowerCase()}` });
/** What kind of money a pool takes: the gas token itself, its wrapper, or a token by address. */
const moneyOf = (m) => (m.quote.native ? 'NATIVE' : lc(m.quote.address));
/** A pool that can be paid with the gas token sent along: peg pools quoted in it, hook pools quoted in its wrapper. */
const payableInGas = (m) => m.quote.native || (m.kind === 'hook' && m.quote.wrapped);

const buyCall = (m, max, to, withValue) => (m.kind === 'peg'
  ? C(m.router, PEG_ROUTER, 'buyFloor', [m.key, m.vault, max, to], withValue ? max : 0n)
  : C(m.router, HOOK_ROUTER, 'buyFloor', [m.key, m.vault, m.quote.address, max, to], withValue ? max : 0n));
const snipeCall = (m, tokenId, max, to, withValue) => (m.kind === 'peg'
  ? C(m.router, PEG_ROUTER, 'snipe', [m.key, m.vault, tokenId, max, to], withValue ? max : 0n)
  : C(m.router, HOOK_ROUTER, 'snipe', [m.key, m.vault, m.quote.address, tokenId, max, to], withValue ? max : 0n));
const sellCall = (m, tokenId, minOut, to) => (m.kind === 'peg'
  ? C(m.router, PEG_ROUTER, 'sell', [m.key, m.vault, tokenId, [], minOut, to])
  : C(m.router, HOOK_ROUTER, 'sell', [m.key, m.vault, m.quote.address, tokenId, minOut, to]));
const quoteIn = (m, amountIn, sellingClaim) => C(CHAINS.get(m.chainId).quoter, QUOTER, 'quoteExactInputSingle', [{ poolKey: m.key, zeroForOne: sellingClaim ? claimIs0(m) : !claimIs0(m), exactAmount: amountIn, hookData: '0x' }]);
const quoteOut = (m, amountOut) => C(CHAINS.get(m.chainId).quoter, QUOTER, 'quoteExactOutputSingle', [{ poolKey: m.key, zeroForOne: !claimIs0(m), exactAmount: amountOut, hookData: '0x' }]);

/** A curve mints ids in order; a mint with companions takes a block of ids and the buyer gets the first. */
const nextCurveId = (c) => (c.minted < c.seedQty ? c.minted : c.seedQty + (c.minted - c.seedQty) * BigInt(1 + c.companions));

/**
 * One pass over every venue on a chain: what each vault holds, what its floor costs through each pool, what a sale
 * into each pool pays, what each curve mints and redeems at. Seven round trips, about a second, shared by every
 * request for 15 seconds. These numbers pick the candidates; nothing is returned on their word alone.
 */
const books = keyed({
  fresh: BOOK_FRESH_MS,
  stale: BOOK_STALE_MS,
  max: 16,
  load: async (k) => {
    const chainId = Number(k);
    const ix = await indexes.get(chainId);
    const t0 = Date.now();
    const vaults = [...new Map(ix.markets.map((m) => [lc(m.vault), m])).values()];
    const perVault = 6;
    const [state, gasPrice] = await Promise.all([
      mread(chainId, [
        ...vaults.flatMap((m) => [C(m.vault, VAULT, 'inventoryCount'), C(m.vault, VAULT, 'peekFloor'), C(m.vault, VAULT, 'floorCost'), C(m.vault, VAULT, 'mintUnit'), C(m.vault, VAULT, 'taxBps'), C(m.vault, VAULT, 'unit')]),
        ...ix.curves.flatMap((c) => [C(c.collection, NGU, 'quoteBuy', [1n]), C(c.collection, NGU, 'quoteSell', [1n]), C(c.collection, NGU, 'minted')]),
      ]),
      gasPrices.get(chainId).catch(() => 0n),
    ]);
    const vaultState = new Map(vaults.map((m, i) => {
      const r = (n) => state[i * perVault + n];
      const inventory = Number(r(0) ?? 0n);
      const peg = m.kind === 'peg';
      return [lc(m.vault), {
        inventory,
        floorId: inventory > 0 ? r(1) : null,
        // a hook vault and a first-generation peg vault deal in one whole claim per NFT
        floorCost: peg ? r(2) : 10n ** 18n,
        mintUnit: r(3) ?? 10n ** 18n,
        taxBps: Number(r(4) ?? 0),
        v2: r(5) != null,
      }];
    }));
    const curveAt = vaults.length * perVault;
    const curves = ix.curves.map((c, i) => {
      const [buy, sell, minted] = [state[curveAt + i * 3], state[curveAt + i * 3 + 1], state[curveAt + i * 3 + 2]];
      if (minted == null) return null;
      const soldOut = minted >= c.maxSupply;
      return { ...c, minted, soldOut, buy: !soldOut && buy != null && buy > 0n ? buy : null, sell: sell != null && sell > 0n ? sell : null };
    }).filter(Boolean);

    const markets = ix.markets.map((m) => ({ ...m, ...vaultState.get(lc(m.vault)), buy: null, sell: null }));
    const stocked = markets.filter((m) => m.inventory > 0);

    // buying the floor with the gas token: run the router's own call, one per vault per round so no two share state
    const gasBuys = stocked.filter(payableInGas);
    const rounds = [];
    for (const m of gasBuys) {
      let round = rounds.find((r) => !r.some((x) => same(x.vault, m.vault) || same(x.collection, m.collection)));
      if (!round) rounds.push(round = []);
      round.push(m);
    }
    // a peg pool sells into its quote: the canonical Quoter answers, and refuses a pool that cannot take it all
    const pegs = markets.filter((m) => m.kind === 'peg');
    // a hook pool is on its own pool manager, where no Quoter reaches: sell a stand-in NFT through the router
    const hooks = markets.filter((m) => m.kind === 'hook');
    const hookOverrides = {};
    for (const m of hooks) hookOverrides[m.collection] = { code: PERMISSIVE_ERC721, stateDiff: fakeSlot0(PROBE) };
    const tokenBuys = stocked.filter((m) => m.kind === 'peg' && !m.quote.native && m.floorCost != null);

    const big = PROBE_LEND / 100n;
    const [roundRows, pegSells, tokenAsks, hookRows] = await Promise.all([
      Promise.all(rounds.map((round) => simulate(chainId, PROBE, [ethOf(PROBE), ...round.flatMap((m) => [buyCall(m, big, PROBE, true), ethOf(PROBE)])], { lend: PROBE_LEND }).then((s) => s.rows, () => null))),
      sread(chainId, pegs.map((m) => quoteIn(m, m.mintUnit, true))).catch(() => pegs.map(() => null)),
      sread(chainId, tokenBuys.map((m) => quoteOut(m, m.floorCost))).catch(() => tokenBuys.map(() => null)),
      hooks.length
        ? simulate(chainId, PROBE, hooks.map((m, i) => sellCall(m, FAKE_ID + BigInt(i), 0n, PROBE)), { lend: PROBE_LEND, overrides: hookOverrides }).then((s) => s.rows, () => null)
        : null,
    ]);
    rounds.forEach((round, r) => {
      const rows = roundRows[r];
      if (!rows) return;
      round.forEach((m, i) => {
        const [before, call, after] = [rows[i * 2], rows[i * 2 + 1], rows[i * 2 + 2]];
        if (call.ok && before.out != null && after.out != null && before.out > after.out) { m.buy = before.out - after.out; m.buyGas = call.gas; }
      });
    });
    pegs.forEach((m, i) => { if (pegSells[i]?.[0] > 0n) m.sell = pegSells[i][0]; });
    tokenBuys.forEach((m, i) => { if (tokenAsks[i]?.[0] > 0n) m.buy = tokenAsks[i][0]; });
    if (hookRows) hooks.forEach((m, i) => { const out = hookRows[i].ok ? hookRows[i].out : null; if (out != null && out > 0n) m.sell = out; });

    const cols = new Map();
    const col = (a, name) => { const key = lc(a); if (!cols.has(key)) cols.set(key, { collection: getAddress(a), name, markets: [], curve: null }); return cols.get(key); };
    for (const m of markets) col(m.collection, m.name).markets.push(m);
    for (const c of curves) col(c.collection, c.name).curve = c;
    const claims = new Map();
    for (const m of pegs) { const key = lc(m.vault); if (!claims.has(key)) claims.set(key, []); claims.get(key).push(m); }
    if (DEBUG) host.log(`book ${chainId}: ${markets.filter((m) => m.buy != null).length} buys, ${markets.filter((m) => m.sell != null).length} sells priced, ${Date.now() - t0} ms`);
    return { chainId, at: Date.now(), gasPrice, markets, curves, cols, claims };
  },
});

// ───────────────────────── Seaport venues: the bet board and OpenSea ─────────────────────────

const nowS = () => Math.floor(Date.now() / 1000);

/** One board entry as an ask (an NFT for the gas token or its wrapper) or a bid (a token for an NFT), or null. */
export function normaliseBet(bet) {
  const c = bet?.components;
  if (!c || typeof bet.signature !== 'string' || Number(bet.chainId) !== HOME) return null;
  if (bet.counterparty && !same(bet.counterparty, ZERO)) return null; // promised to someone else
  if (Number(c.endTime) < nowS() + 60 || Number(c.startTime) > nowS()) return null;
  if (Number(c.orderType) !== 0 || !same(c.zone, ZERO) || c.conduitKey !== ZERO32) return null;
  const offer = Array.isArray(c.offer) ? c.offer : [], cons = Array.isArray(c.consideration) ? c.consideration : [];
  if (![...offer, ...cons].every((x) => x && isAddress(x.token) && String(x.startAmount) === String(x.endAmount))) return null;
  const ethLike = (x) => (Number(x.itemType) === 0 && same(x.token, ZERO)) || (Number(x.itemType) === 1 && same(x.token, WETH));
  if (offer.length === 1 && Number(offer[0].itemType) === 2 && String(offer[0].startAmount) === '1' && cons.length > 0 && cons.every(ethLike)) {
    const native = cons.every((x) => Number(x.itemType) === 0);
    if (!native && !cons.every((x) => Number(x.itemType) === 1)) return null;
    return {
      kind: 'ask', venue: 'board', hash: bet.hash, components: c, signature: bet.signature, collection: lc(offer[0].token), tokenId: BigInt(offer[0].identifierOrCriteria),
      total: cons.reduce((a, x) => a + BigInt(x.startAmount), 0n), money: native ? 'NATIVE' : lc(WETH), offerer: c.offerer,
    };
  }
  if (offer.length === 1 && Number(offer[0].itemType) === 1 && cons.length === 1 && [2, 4].includes(Number(cons[0].itemType)) && String(cons[0].startAmount) === '1') {
    const any = Number(cons[0].itemType) === 4;
    if (any && BigInt(cons[0].identifierOrCriteria) !== 0n) return null; // a set of ids needs the set: skipped
    return {
      kind: 'bid', venue: 'board', hash: bet.hash, components: c, signature: bet.signature, collection: lc(cons[0].token), tokenId: any ? null : BigInt(cons[0].identifierOrCriteria),
      net: BigInt(offer[0].startAmount), money: lc(offer[0].token), offerer: c.offerer,
    };
  }
  return null;
}
const orderParameters = (c) => ({
  offerer: c.offerer, zone: c.zone,
  offer: c.offer.map((o) => ({ itemType: Number(o.itemType), token: o.token, identifierOrCriteria: BigInt(o.identifierOrCriteria), startAmount: BigInt(o.startAmount), endAmount: BigInt(o.endAmount) })),
  consideration: c.consideration.map((o) => ({ itemType: Number(o.itemType), token: o.token, identifierOrCriteria: BigInt(o.identifierOrCriteria), startAmount: BigInt(o.startAmount), endAmount: BigInt(o.endAmount), recipient: o.recipient })),
  orderType: Number(c.orderType), startTime: BigInt(c.startTime), endTime: BigInt(c.endTime), zoneHash: c.zoneHash, salt: BigInt(c.salt), conduitKey: c.conduitKey,
  totalOriginalConsiderationItems: BigInt(c.consideration.length),
});
/** The Seaport call that fills a board order: an ask is bought, a bid is sold into with `tokenId`. */
export function fillBet(order, tokenId = null) {
  const parameters = orderParameters(order.components);
  if (order.kind === 'ask' || order.tokenId != null) {
    if (order.kind === 'bid' && order.tokenId !== BigInt(tokenId)) throw new Error('that bid wants a different NFT');
    return C(SEAPORT, SEAPORT_ABI, 'fulfillOrder', [{ parameters, signature: order.signature }, ZERO32], order.kind === 'ask' && order.money === 'NATIVE' ? order.total : 0n);
  }
  return C(SEAPORT, SEAPORT_ABI, 'fulfillAdvancedOrder', [
    { parameters, numerator: 1n, denominator: 1n, signature: order.signature, extraData: '0x' },
    [{ orderIndex: 0n, side: 1, index: 0n, identifier: BigInt(tokenId), criteriaProof: [] }], ZERO32, ZERO,
  ]);
}

const boards = keyed({
  fresh: BOARD_FRESH_MS,
  stale: 5 * 60_000,
  load: async () => {
    const r = await fetch(BOARD_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
    if (!r.ok) throw new Error(`the bet board answered ${r.status}`);
    const j = await r.json();
    const by = new Map();
    for (const bet of Array.isArray(j) ? j : j?.bets || []) {
      let n = null;
      try { n = normaliseBet(bet); } catch { /* one malformed order must not cost the rest */ }
      if (!n) continue;
      if (!by.has(n.collection)) by.set(n.collection, { asks: [], bids: [] });
      by.get(n.collection)[n.kind === 'ask' ? 'asks' : 'bids'].push(n);
    }
    for (const g of by.values()) {
      g.asks.sort((a, b) => (a.total < b.total ? -1 : 1));
      g.bids.sort((a, b) => (a.net > b.net ? -1 : 1));
    }
    return by;
  },
});
const NO_ORDERS = { asks: [], bids: [] };
/** `wait: false` reads what is already known and starts a refresh behind it: a scan of every collection never waits on a feed. */
async function boardFor(chainId, collection, wait = true) {
  if (chainId !== HOME) return NO_ORDERS;
  const by = wait ? await boards.get('board').catch(() => null) : (boards.get('board').catch(() => {}), boards.peek('board'));
  return by?.get(lc(collection)) || NO_ORDERS;
}

const openseaKey = () => { const k = process.env.OPENSEA_API_KEY; return typeof k === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(k) ? k : null; };
const openseaGate = gateOf(2);
async function opensea(path, body = null) {
  const key = openseaKey();
  if (!key) return null;
  return openseaGate(async () => {
    const r = await fetch(`${OPENSEA_API}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { accept: 'application/json', 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(6_000),
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`OpenSea answered ${r.status}`);
    return r.json();
  });
}
const sumOf = (items) => items.reduce((a, x) => a + BigInt(x.startAmount), 0n);
/** An OpenSea listing of one ERC-721 at a fixed price, or null. `total` is everything the buyer pays, fees included. */
export function normaliseListing(l, slug) {
  const p = l?.protocol_data?.parameters;
  if (!p || !same(l.protocol_address, SEAPORT) || !Array.isArray(p.offer) || !Array.isArray(p.consideration)) return null;
  if (p.offer.length !== 1 || Number(p.offer[0].itemType) !== 2 || String(p.offer[0].startAmount) !== '1' || !p.consideration.length) return null;
  if ([...p.offer, ...p.consideration].some((i) => String(i.startAmount) !== String(i.endAmount))) return null;
  const money = lc(p.consideration[0].token);
  if (!p.consideration.every((c) => [0, 1].includes(Number(c.itemType)) && lc(c.token) === money)) return null;
  if (Number(p.endTime) < nowS() + 120 || Number(p.startTime) > nowS()) return null;
  return { kind: 'ask', venue: 'opensea', slug, hash: l.order_hash, protocol: l.protocol_address, parameters: p, collection: lc(p.offer[0].token), tokenId: BigInt(p.offer[0].identifierOrCriteria), total: sumOf(p.consideration), money: money === ZERO ? 'NATIVE' : money, offerer: p.offerer };
}
/** An OpenSea collection offer for one ERC-721, or null. `net` is what the seller keeps after the order's own fees. */
export function normaliseOffer(o, slug) {
  const p = o?.protocol_data?.parameters;
  if (!p || !same(o.protocol_address, SEAPORT) || o.criteria?.trait || !Array.isArray(p.offer) || !Array.isArray(p.consideration)) return null;
  const pay = p.offer[0];
  if (p.offer.length !== 1 || Number(pay.itemType) !== 1) return null;
  const nfts = p.consideration.filter((c) => Number(c.itemType) >= 2);
  if (nfts.length !== 1 || ![2, 4].includes(Number(nfts[0].itemType)) || String(nfts[0].startAmount) !== '1') return null;
  if (Number(nfts[0].itemType) === 4 && BigInt(nfts[0].identifierOrCriteria) !== 0n) return null;
  if ([...p.offer, ...p.consideration].some((i) => String(i.startAmount) !== String(i.endAmount))) return null;
  const fees = p.consideration.filter((c) => Number(c.itemType) < 2);
  if (fees.some((c) => Number(c.itemType) !== 1 || !same(c.token, pay.token))) return null;
  if (Number(p.endTime) < nowS() + 120 || Number(p.startTime) > nowS()) return null;
  const gross = BigInt(pay.startAmount);
  return { kind: 'bid', venue: 'opensea', slug, hash: o.order_hash, protocol: o.protocol_address, parameters: p, collection: lc(nfts[0].token), tokenId: Number(nfts[0].itemType) === 2 ? BigInt(nfts[0].identifierOrCriteria) : null, net: gross - sumOf(fees), money: lc(pay.token), offerer: p.offerer };
}
/** OpenSea's book for one collection: its cheapest listings and best collection offers. A minute fresh. */
const openseaBooks = keyed({
  fresh: OPENSEA_FRESH_MS,
  stale: 10 * 60_000,
  max: 200,
  load: async (k) => {
    const [chain, collection] = k.split(':');
    const net = CHAINS.get(Number(chain))?.opensea;
    if (!net || !openseaKey()) return NO_ORDERS;
    const slug = (await opensea(`/chain/${net}/contract/${collection}`))?.collection;
    if (typeof slug !== 'string' || !/^[a-z0-9-]{1,100}$/.test(slug)) return NO_ORDERS;
    const [l, o] = await Promise.all([opensea(`/listings/collection/${slug}/best?limit=5`), opensea(`/offers/collection/${slug}?limit=10`)]);
    const asks = (l?.listings || []).map((x) => normaliseListing(x, slug)).filter((x) => x && x.collection === collection).sort((a, b) => (a.total < b.total ? -1 : 1));
    const bids = (o?.offers || []).map((x) => normaliseOffer(x, slug)).filter((x) => x && x.collection === collection).sort((a, b) => (a.net > b.net ? -1 : 1));
    return { asks, bids, net };
  },
});
let seaRefreshes = 0;
/**
 * `wait: false` reads what is already known. OpenSea is rate limited, so a scan of every collection only ever
 * starts a couple of refreshes behind itself; the books fill in over the next few requests.
 */
async function openseaFor(chainId, collection, wait = true) {
  if (!openseaKey() || !CHAINS.get(chainId)?.opensea) return NO_ORDERS;
  const k = `${chainId}:${lc(collection)}`;
  if (wait) return (await Promise.race([openseaBooks.get(k).catch(() => null), sleep(4_000).then(() => null)])) || openseaBooks.peek(k) || NO_ORDERS;
  if (seaRefreshes < 2) { seaRefreshes++; openseaBooks.get(k).catch(() => {}).finally(() => { seaRefreshes--; }); }
  return openseaBooks.peek(k) || NO_ORDERS;
}

const sameShape = (a, b) => JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? v.toLowerCase() : v)) === JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? v.toLowerCase() : v));
/**
 * OpenSea builds the transaction that fills one of its orders, for a named wallet. That transaction is somebody
 * else's bytes: it is taken only when it calls Seaport, with one of the entry points listed above, carries the
 * order that was priced and no more of the gas token than the listing's price, and then it is run before it is
 * returned like every other leg.
 */
async function fillOpenSea(order, chainId, who, tokenId) {
  const net = CHAINS.get(chainId).opensea;
  const body = order.kind === 'ask'
    ? { listing: { hash: order.hash, chain: net, protocol_address: order.protocol }, fulfiller: { address: who } }
    : { offer: { hash: order.hash, chain: net, protocol_address: order.protocol }, fulfiller: { address: who }, consideration: { asset_contract_address: order.collection, token_id: String(tokenId) } };
  const d = await opensea(order.kind === 'ask' ? '/listings/fulfillment_data' : '/offers/fulfillment_data', body);
  const t = d?.fulfillment_data?.transaction;
  if (!t || !same(t.to, SEAPORT) || typeof t.function !== 'string') throw new Error('OpenSea did not return a Seaport transaction');
  const fn = t.function.split('(')[0];
  const item = SEAPORT_ABI.find((x) => x.type === 'function' && x.name === fn);
  if (!item) throw new Error('OpenSea used a Seaport entry point this module does not take');
  const coerce = (v, abi) => {
    if (abi.type.endsWith('[]')) return (v || []).map((x) => coerce(x, { ...abi, type: abi.type.slice(0, -2) }));
    if (abi.type === 'tuple') return Object.fromEntries(abi.components.map((c) => [c.name, coerce(v?.[c.name], c)]));
    if (/^u?int/.test(abi.type)) return BigInt(v ?? 0);
    if (abi.type === 'bool') return Boolean(v);
    return v;
  };
  const args = item.inputs.map((inp) => coerce(t.input_data?.[inp.name], inp));
  const value = BigInt(t.value || 0);
  if (value !== (order.kind === 'ask' && order.money === 'NATIVE' ? order.total : 0n)) throw new Error('OpenSea asked for a different amount than the order');
  const p = order.parameters;
  if (fn.startsWith('fulfillBasicOrder')) {
    const b = args[0];
    if (!same(b.offerer, p.offerer) || BigInt(b.salt) !== BigInt(p.salt) || BigInt(b.startTime) !== BigInt(p.startTime) || BigInt(b.endTime) !== BigInt(p.endTime)) throw new Error('OpenSea returned a different order');
    const extra = b.additionalRecipients.reduce((a, r) => a + BigInt(r.amount), 0n);
    if (order.kind === 'ask' && BigInt(b.considerationAmount) + extra !== order.total) throw new Error('OpenSea returned a different price');
  } else {
    const o = args[0];
    for (const f of ['offerer', 'offer', 'consideration', 'salt', 'startTime', 'endTime', 'zone', 'conduitKey']) {
      if (!sameShape(o.parameters[f], coerce(p[f], item.inputs[0].components.find((c) => c.name === 'parameters').components.find((c) => c.name === f)))) throw new Error('OpenSea returned a different order');
    }
    if (fn === 'fulfillAdvancedOrder' && !(same(args[3], who) || same(args[3], ZERO))) throw new Error('OpenSea named a different recipient');
  }
  const conduitKey = t.input_data?.fulfillerConduitKey ?? t.input_data?.parameters?.fulfillerConduitKey ?? ZERO32;
  return { call: C(SEAPORT, [item], fn, args, value), conduitKey };
}
const conduits = keyed({
  fresh: 24 * 3600_000,
  max: 64,
  load: async (k) => {
    const [chain, key] = k.split(':');
    if (key === ZERO32) return SEAPORT;
    const [r] = await mread(Number(chain), [C(CONDUIT_CONTROLLER, CONDUITS, 'getConduit', [key])]);
    if (!r?.[1]) throw new Error('unknown Seaport conduit');
    return r[0];
  },
});

// ───────────────────────── options: the ways into an NFT and the ways out of one ─────────────────────────

const the = (venue) => (venue.startsWith('the ') || venue === 'OpenSea' ? venue : `the ${venue}`);
/** A pool, said the way a person would point at it: by the claim it trades, or as the collection's staccpad pool. */
const poolName = (m) => {
  const quote = m.quote.native ? '' : `/${m.quote.symbol}`;
  return m.kind === 'peg' ? `${m.claimSymbol || m.name}${quote} pool` : `staccpad ${m.quote.symbol} pool`;
};
const routerName = (m) => (m.kind === 'peg' ? 'staccpad pool router' : 'staccpad router');

/** The Seaport order books for one collection. `wait: false` reads only what is already known and never holds a request up. */
async function ordersFor(chainId, collection, wait) {
  const [board, sea] = await Promise.all([boardFor(chainId, collection, wait), openseaFor(chainId, collection, wait)]);
  return { asks: [...board.asks.slice(0, 2), ...sea.asks.slice(0, 2)], bids: [...board.bids.slice(0, 2), ...sea.bids.slice(0, 2)] };
}

/**
 * Every way to get one NFT of `col` for `money` ('NATIVE' or a token address), cheapest estimate first.
 * `not` leaves out a vault (so a claim is never bought out of its own pool to be vaulted back).
 */
async function acquires(book, col, money, { not = null, wait = true } = {}) {
  const out = [];
  for (const m of col.markets) {
    if (m.buy == null || m.inventory <= 0 || (not && same(m.vault, not))) continue;
    const gas = money === 'NATIVE' && payableInGas(m);
    if (!gas && moneyOf(m) !== money) continue;
    out.push({ type: 'pool', m, money, viaValue: gas, cost: m.buy, tokenId: m.floorId, venue: poolName(m), contract: { address: m.router, name: routerName(m) } });
  }
  if (money === 'NATIVE' && col.curve?.buy != null) {
    out.push({ type: 'curve', curve: col.curve, money, viaValue: true, cost: col.curve.buy, tokenId: nextCurveId(col.curve), venue: `${col.name} curve`, contract: { address: col.curve.collection, name: `${col.name} curve` } });
  }
  for (const ask of (await ordersFor(book.chainId, col.collection, wait)).asks) {
    if (ask.money !== money) continue;
    out.push({ type: 'ask', order: ask, money, viaValue: money === 'NATIVE', cost: ask.total, tokenId: ask.tokenId, venue: ask.venue === 'board' ? 'the bet board' : 'OpenSea', contract: { address: SEAPORT, name: 'Seaport' } });
  }
  const own = (book.claims.get(money) || []).find((m) => same(m.collection, col.collection) && m.inventory > 0 && m.floorCost != null);
  if (own) out.push({ type: 'redeem', m: own, money, viaValue: false, cost: own.floorCost, tokenId: own.floorId, venue: `the ${own.claimSymbol || own.name} vault`, contract: { address: own.vault, name: `${own.claimSymbol || own.name} vault` } });
  return out.sort((a, b) => (a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : 0));
}

/**
 * Every way to turn one NFT of `col` into `money`. With money 'NATIVE', venues that pay the wrapper count too:
 * a last step unwraps it. `not` leaves out a vault. Best estimate first.
 */
async function disposes(book, col, money, { not = null, tokenId = null, wait = true } = {}) {
  const out = [];
  const wrapped = lc(CHAINS.get(book.chainId).wrapped.address);
  const takes = (m) => (m === money ? { unwrap: false } : money === 'NATIVE' && m === wrapped ? { unwrap: true } : null);
  for (const m of col.markets) {
    if (m.sell == null || (not && same(m.vault, not)) || (m.kind === 'peg' && m.gated)) continue;
    const t = takes(moneyOf(m));
    if (!t) continue;
    out.push({ type: 'pool', m, money: moneyOf(m), unwrap: t.unwrap, out: m.sell, venue: poolName(m), spender: m.router, contract: { address: m.router, name: routerName(m) } });
  }
  if (col.curve?.sell != null && money === 'NATIVE') {
    out.push({ type: 'curve', curve: col.curve, money: 'NATIVE', unwrap: false, out: col.curve.sell, venue: `${col.name} curve`, spender: null, contract: { address: col.curve.collection, name: `${col.name} curve` } });
  }
  for (const bid of (await ordersFor(book.chainId, col.collection, wait)).bids) {
    const t = takes(bid.money);
    if (!t || (bid.tokenId != null && tokenId != null && bid.tokenId !== tokenId)) continue;
    out.push({ type: 'bid', order: bid, money: bid.money, unwrap: t.unwrap, out: bid.net, venue: bid.venue === 'board' ? 'the bet board' : 'OpenSea', spender: SEAPORT, contract: { address: SEAPORT, name: 'Seaport' } });
  }
  const own = (book.claims.get(money) || []).find((m) => same(m.collection, col.collection) && !m.gated);
  if (own) out.push({ type: 'deposit', m: own, money, unwrap: false, out: own.mintUnit, venue: `the ${own.claimSymbol || own.name} vault`, spender: own.vault, contract: { address: own.vault, name: `${own.claimSymbol || own.name} vault` } });
  return out.sort((a, b) => (a.out > b.out ? -1 : a.out < b.out ? 1 : 0));
}

const nftLabel = (name, tokenId) => `${name} #${tokenId}`;
const collectionContract = (col) => ({ address: col.collection, name: `${col.name} NFTs` });

/** The calls that take one NFT in through `a`, paying at most `max`. An approval for the money comes first when it is a token. */
async function acquireLegs(a, { chainId, who, max, col, payToken, skipApprove = false }) {
  const legs = [];
  const label = nftLabel(col.name, a.tokenId);
  const paid = { token: payToken, amount: a.cost.toString() };
  const refund = `At most ${human(max, payToken.decimals)} ${payToken.symbol}. What is not spent comes straight back.`;
  if (a.type === 'pool') {
    if (!a.viaValue && !skipApprove) legs.push({ kind: 'approve', label: `Let the ${a.venue} take up to ${human(max, payToken.decimals)} ${payToken.symbol}`, note: 'This exact amount, not unlimited.', call: C(payToken.address, ERC20, 'approve', [a.m.router, max]), contract: { address: payToken.address, name: payToken.symbol } });
    legs.push({ kind: 'buy', label: `Buy ${label} from the ${a.venue}`, note: refund, call: a.snipe ? snipeCall(a.m, a.tokenId, max, who, a.viaValue) : buyCall(a.m, max, who, a.viaValue), in: paid, contract: a.contract });
  } else if (a.type === 'curve') {
    legs.push({ kind: 'mint', label: `Mint ${label} on the ${a.venue}`, note: refund, call: C(a.curve.collection, NGU, 'buy', [1n, who], max), in: paid, contract: a.contract });
  } else if (a.type === 'ask') {
    if (!a.viaValue && !skipApprove) legs.push({ kind: 'approve', label: `Let Seaport take ${human(a.cost, payToken.decimals)} ${payToken.symbol}`, note: 'This exact amount, not unlimited.', call: C(payToken.address, ERC20, 'approve', [SEAPORT, a.cost]), contract: { address: payToken.address, name: payToken.symbol } });
    const call = a.order.venue === 'board' ? fillBet(a.order) : (await fillOpenSea(a.order, chainId, who, a.tokenId)).call;
    legs.push({ kind: 'buy', label: `Buy ${label} from ${a.venue}`, note: 'A signed sell order, filled through Seaport at its listed price.', call, in: paid, contract: a.contract });
  } else {
    legs.push({ kind: 'redeem', label: `Take ${label} out of ${a.venue}`, note: `Burns ${human(a.cost, 18)} ${payToken.symbol}: one NFT's worth and the vault's fees.`, call: C(a.m.vault, VAULT, 'redeemFloor', [who]), in: paid, contract: a.contract });
  }
  return legs;
}

/**
 * The calls that turn one held NFT into money through `d`, for at least `minOut`. The NFT's approval comes first:
 * for this one NFT, or (`approveAll`) once for several sold in a row; `skipApprove` when an earlier leg gave it.
 */
async function disposeLegs(d, { chainId, who, tokenId, minOut, col, outToken, approveAll = false, skipApprove = false }) {
  const legs = [];
  const label = nftLabel(col.name, tokenId);
  const got = { token: outToken, amount: d.out.toString() };
  let spender = d.spender;
  let fill = null;
  if (d.type === 'bid') {
    if (d.order.venue === 'board') fill = { call: fillBet(d.order, tokenId) };
    else { fill = await fillOpenSea(d.order, chainId, who, tokenId); spender = await conduits.get(`${chainId}:${fill.conduitKey}`); }
  }
  if (spender && !skipApprove) {
    legs.push(approveAll
      ? { kind: 'approve', label: `Let ${the(d.venue)} take your ${col.name} NFTs`, note: 'Needed once. It covers the NFTs in the steps after it.', call: C(col.collection, ERC721, 'setApprovalForAll', [spender, true]), contract: collectionContract(col) }
      : { kind: 'approve', label: `Let ${the(d.venue)} take ${label}`, note: 'Only this one NFT. Nothing else in the wallet is touched.', call: C(col.collection, ERC721, 'approve', [spender, tokenId]), contract: collectionContract(col) });
  }
  const floorNote = `You get at least ${human(minOut, outToken.decimals)} ${outToken.symbol}, or this step does not happen.`;
  if (d.type === 'pool') legs.push({ kind: 'sell', pays: true, label: `Sell ${label} into the ${d.venue}`, note: floorNote, call: sellCall(d.m, tokenId, minOut, who), out: got, contract: d.contract, strand: { vault: d.m.vault, router: d.m.router } });
  else if (d.type === 'curve') legs.push({ kind: 'redeem', pays: true, label: `Redeem ${label} on the ${d.venue}`, note: floorNote, call: C(d.curve.collection, NGU, 'sell', [[tokenId], who, minOut]), out: got, contract: d.contract });
  else if (d.type === 'bid') legs.push({ kind: 'sell', pays: true, label: `Sell ${label} to the best offer on ${d.venue}`, note: 'A signed buy order, filled through Seaport at its price.', call: fill.call, out: got, contract: d.contract });
  else legs.push({ kind: 'vault', pays: true, label: `Put ${label} into ${d.venue}`, note: `Mints ${human(d.out, 18)} ${outToken.symbol} to your wallet. The vault takes no fee on the way in.`, call: C(d.m.vault, VAULT, 'deposit', [tokenId, who]), out: got, contract: d.contract });
  return legs;
}
const unwrapLeg = (chainId, amount, outToken, plural = false) => {
  const w = wrappedToken(chainId);
  return { kind: 'unwrap', label: `Turn ${human(amount)} ${w.symbol} back into ${outToken.symbol}`, note: `If the ${plural ? 'sales pay' : 'sale pays'} more than ${plural ? 'their' : 'its'} minimum, the small extra stays in your wallet as ${w.symbol}.`, call: C(w.address, WRAPPED, 'withdraw', [amount]), in: { token: w, amount: amount.toString() }, out: { token: outToken, amount: amount.toString() }, contract: { address: w.address, name: w.symbol } };
};

// ───────────────────────── running a plan before it is offered ─────────────────────────

/**
 * Run `legs` in order as `who` and measure what moved. A leg is a call to send, or `{ read: true, call }` (a
 * question asked between two legs, whose failure stops nothing). Balances of the watched tokens are taken before,
 * after, and after every leg named in `marks`. A sale that leaves claims behind in a router is a failed run: that
 * pool could not take the whole NFT, and the rest would be lost.
 */
async function trial(chainId, who, legs, watch, { lend = null, overrides = null, marks = [] } = {}) {
  const tokens = [...new Set(watch)];
  const strands = legs.map((l) => l.strand).filter(Boolean);
  const reads = [...tokens.map((t) => balOf(t, who)), ...strands.map((s) => C(s.vault, ERC20, 'balanceOf', [s.router]))];
  const want = new Set(marks);
  const calls = [...reads];
  legs.forEach((l, i) => { calls.push(l.call); if (want.has(i)) calls.push(...reads); });
  calls.push(...reads);
  const { rows, block } = await simulate(chainId, who, calls, { lend, overrides });
  const take = (at) => rows.slice(at, at + reads.length).map((r) => r.out);
  const asMap = (vals) => new Map(tokens.map((t, i) => [t, vals[i]]));
  let at = reads.length;
  const first = take(0);
  const steps = [];
  const mark = new Map();
  legs.forEach((_, i) => { steps.push(rows[at++]); if (want.has(i)) { mark.set(i, asMap(take(at))); at += reads.length; } });
  const last = take(at);
  const bad = steps.findIndex((r, i) => !r.ok && !legs[i].read);
  const stranded = strands.some((_, i) => { const b = first[tokens.length + i], a = last[tokens.length + i]; return b == null || a == null || a > b; });
  const sent = steps.filter((_, i) => !legs[i].read);
  return {
    ok: bad < 0 && !stranded, failedAt: bad, error: bad >= 0 ? steps[bad].error : null, stranded, steps, block,
    before: asMap(first), after: asMap(last), mark,
    delta: new Map(tokens.map((t, i) => [t, first[i] != null && last[i] != null ? last[i] - first[i] : null])),
    gasTotal: sent.reduce((a, r) => a + r.gas, 0n),
  };
}

/** Why a run failed, as a refusal for the reader. */
const refusal = (t) => (t.stranded && t.failedAt < 0
  ? fail('POOL_CANNOT_PAY', 'That pool cannot take a whole NFT right now.', 404)
  : fail('WOULD_REVERT', `The chain refused this when it was tried: ${reason(t.error)}. Nothing was sent.`, 400));

/**
 * A balance of an ERC-20 for the stand-in wallet, for the length of one run. Which storage slot holds balances
 * is found by reading a known holder's, never assumed; a token it cannot be found for is simply not lent.
 */
const balanceSlots = keyed({
  fresh: 24 * 3600_000,
  max: 400,
  load: async (k) => {
    const [chain, token, holder] = k.split(':');
    const chainId = Number(chain);
    const [real] = await mread(chainId, [C(token, ERC20, 'balanceOf', [holder])]);
    if (real == null || real === 0n) return 'none';
    // plain layouts (the mapping in one of the first slots) and OpenZeppelin's namespaced one
    const bases = [...Array.from({ length: 12 }, (_, i) => BigInt(i)), 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n];
    const slots = bases.map((b) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, b])));
    const words = await Promise.all(slots.map((s) => rpc(chainId, 'eth_getStorageAt', [token, s, 'latest']).catch(() => null)));
    const at = words.findIndex((w) => typeof w === 'string' && w.length > 2 && BigInt(w) === real);
    return at < 0 ? 'none' : bases[at].toString();
  },
});
async function lendToken(chainId, token, knownHolder, who, amount) {
  const base = await balanceSlots.get(`${chainId}:${lc(token)}:${lc(knownHolder)}`).catch(() => 'none');
  if (base === 'none') return null;
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, BigInt(base)]));
  return { [getAddress(token)]: { stateDiff: { [slot]: `0x${amount.toString(16).padStart(64, '0')}` } } };
}

// ───────────────────────── shaping a plan ─────────────────────────

const TX = (chainId, call) => ({ chainId, to: getAddress(call.to), value: BigInt(call.value || 0n).toString(), data: call.data });
const txLeg = (chainId, l, withTx) => ({
  kind: l.kind, chainId, label: l.label, in: l.in ?? null, out: l.out ?? null, feeNative: null, note: l.note ?? null,
  exec: { type: 'tx', tx: withTx ? TX(chainId, l.call) : null },
});
const routerAlias = (chainId, token) => (token.address === 'NATIVE' ? (CHAINS.get(chainId).gas === 'POL' ? 'MATIC' : CHAINS.get(chainId).gas) : token.address);
/** A swap through the pools: the page (or any caller) asks the router for the transaction when it gets there. */
const routerLeg = (chainId, tokenIn, tokenOut, amountIn, amountOut, note) => ({
  kind: 'swap', chainId, label: `Swap ${human(amountIn, tokenIn.decimals)} ${tokenIn.symbol} for ${tokenOut.symbol} through the pools`,
  in: { token: tokenIn, amount: amountIn.toString() }, out: { token: tokenOut, amount: amountOut.toString() }, feeNative: null, note,
  exec: { type: 'router', query: { tokenInAddress: routerAlias(chainId, tokenIn), tokenInChainId: String(chainId), tokenOutAddress: routerAlias(chainId, tokenOut), tokenOutChainId: String(chainId), amount: amountIn.toString(), type: 'exactIn' } },
});
const contractsOf = (chainId, legs) => {
  const seen = new Map();
  for (const c of legs.map((l) => l.contract).filter(Boolean)) if (!seen.has(lc(c.address))) seen.set(lc(c.address), { chainId, address: getAddress(c.address), name: c.name });
  return [...seen.values()];
};
/**
 * The page's executor refuses a step that calls a contract the plan did not list, or that sends more of the gas
 * token than the pay box shows plus the tolerance. A plan that would trip either is a bug here, so it is caught
 * here and never handed out.
 */
function seal(plan, slippage) {
  const listed = new Set(plan.contracts.map((c) => `${c.chainId}:${lc(c.address)}`));
  let value = 0n;
  for (const l of plan.legs) {
    if (l.exec.type !== 'tx' || !l.exec.tx) continue;
    if (l.exec.tx.chainId !== l.chainId || !listed.has(`${l.chainId}:${lc(l.exec.tx.to)}`)) throw new Error(`plan leg calls ${l.exec.tx.to}, which the plan does not list`);
    value += BigInt(l.exec.tx.value);
  }
  const budget = plan.pay.token?.address === 'NATIVE' ? upBy(BigInt(plan.pay.amount ?? '0'), slippage) : 0n;
  if (value > budget) throw new Error('plan legs send more of the gas token than the plan shows');
  return plan;
}
const checked = (owner, n, block) => (owner
  ? { label: 'Checked', value: 'Tried on the live chain for this wallet', sub: `${n === 1 ? 'The step' : `All ${n} steps, in order,`} went through${block ? ` at block ${block}` : ''}.`, tone: 'ok' }
  : { label: 'Checked', value: 'Priced by trying it on the live chain', sub: 'Connect a wallet and the steps are built and tried for it.' });
const feeFact = (fee, gas) => ({ label: 'Network fees', value: `about ${human(fee, 18, 3)} ${gas}`, sub: 'For every step together, from a test run of them.' });
/** A token the page named that no venue here describes: its own words, cleaned, and never trusted for an amount. */
const namedToken = (chainId, thing) => ({ chainId, address: getAddress(thing.address), symbol: clean(String(thing.symbol ?? ''), 16) || 'token', name: clean(String(thing.name ?? ''), 48) || clean(String(thing.symbol ?? ''), 16) || 'token', decimals: Number.isInteger(thing.decimals) && thing.decimals >= 0 && thing.decimals <= 36 ? thing.decimals : 18, logo: null, tags: [] });
/** The token `money` names on this chain, as the venues know it. */
function tokenOf(book, money, thing) {
  const chainId = book.chainId;
  const wrapped = wrappedToken(chainId);
  let t;
  if (money === 'NATIVE') t = gasToken(chainId);
  else if (money === lc(wrapped.address)) t = wrapped;
  else if (book.claims.has(money)) t = claimToken(book.claims.get(money)[0]);
  else { const m = book.markets.find((x) => moneyOf(x) === money); t = m ? quoteToken(m) : namedToken(chainId, thing); }
  return dress(t, thing);
}

/** A wallet that was named has to hold what the plan says it pays: a plan it cannot start is not an answer. */
async function mustHold(chainId, owner, money, token, amount) {
  if (!owner) return;
  const [held] = await mread(chainId, [balOf(money, getAddress(owner))]);
  if (held != null && held < amount) throw fail('INSUFFICIENT_BALANCE', `This wallet holds ${human(held, token.decimals)} ${token.symbol} on ${chainName(chainId)} and this needs ${human(amount, token.decimals)}.`, 400);
}

// ───────────────────────── loops: the same token on both sides ─────────────────────────

/**
 * A curve only takes back the ids it sold to buyers. Where a curve mints companions into a pool, the pool's floor
 * may be one, so for each such pool find a buyer id in its vault (the floor when it is one, else one of the next
 * few) and what taking exactly that id costs. Done once per book.
 */
async function withBuyerIds(book) {
  if (book.buyerIds) return book.buyerIds;
  book.buyerIds = (async () => {
    const todo = [...book.cols.values()].filter((c) => c.curve?.sell != null && c.curve.companions > 0)
      .flatMap((c) => c.markets.filter((m) => m.inventory > 0 && payableInGas(m)).map((m) => ({ c, m })));
    if (!todo.length) return book;
    const LOOK = 8;
    const span = (m) => Math.min(LOOK, m.inventory);
    const ids = await mread(book.chainId, todo.flatMap(({ m }) => Array.from({ length: span(m) }, (_, i) => C(m.vault, VAULT, 'inventoryAt', [BigInt(i)]))));
    let at = 0;
    const found = todo.map(({ c, m }) => { const mine = [m.floorId, ...ids.slice(at, at + span(m))].filter((x) => x != null); at += span(m); return { c, m, mine: [...new Set(mine)] }; });
    const flags = await mread(book.chainId, found.flatMap(({ c, mine }) => mine.map((x) => C(c.collection, NGU, 'isCompanion', [x]))));
    at = 0;
    const picks = [];
    for (const { m, mine } of found) {
      const mineFlags = flags.slice(at, at + mine.length); at += mine.length;
      const i = mineFlags.findIndex((f) => f === false);
      m.buyerId = i < 0 ? null : mine[i];
      if (m.buyerId != null && m.buyerId !== m.floorId) picks.push(m);
    }
    const big = PROBE_LEND / 100n;
    await Promise.all(picks.map(async (m) => {
      const rows = await simulate(book.chainId, PROBE, [ethOf(PROBE), snipeCall(m, m.buyerId, big, PROBE, true), ethOf(PROBE)], { lend: PROBE_LEND }).then((s) => s.rows, () => null);
      m.snipeCost = rows && rows[1].ok && rows[0].out != null && rows[2].out != null && rows[0].out > rows[2].out ? rows[0].out - rows[2].out : null;
    }));
    return book;
  })().catch(() => book);
  return book.buyerIds;
}

/**
 * Every loop through one NFT that starts and ends in the gas token, with the book's estimate of what it leaves.
 * A loop is one way in and one way out of the same collection, never the same pool twice. Best estimate first.
 */
async function loopCandidates(book) {
  const list = [];
  await Promise.all([...book.cols.values()].map(async (col) => {
    const [ins, outs] = await Promise.all([acquires(book, col, 'NATIVE', { wait: false }), disposes(book, col, 'NATIVE', { wait: false })]);
    for (const a of ins) {
      for (const d of outs) {
        if (a.type === 'pool' && d.type === 'pool' && a.m.poolId === d.m.poolId) continue;
        if (a.type === 'curve' && d.type === 'curve') continue;
        if (d.type === 'bid' && d.order.tokenId != null && d.order.tokenId !== a.tokenId) continue;
        if (a.type === 'ask' && d.type === 'bid' && same(a.order.offerer, d.order.offerer)) continue;
        if (d.type === 'curve' && a.type === 'pool' && a.m.buyerId !== undefined) {
          // the curve takes a buyer id: the floor when it is one, else that id taken by name
          if (a.m.buyerId == null) continue;
          if (a.m.buyerId !== a.tokenId) {
            if (a.m.snipeCost == null) continue;
            list.push({ col, a: { ...a, tokenId: a.m.buyerId, snipe: true, cost: a.m.snipeCost }, d, cost: a.m.snipeCost, out: d.out, edge: d.out - a.m.snipeCost });
            continue;
          }
        }
        list.push({ col, a, d, cost: a.cost, out: d.out, edge: d.out - a.cost });
      }
    }
  }));
  return list.sort((x, y) => (x.edge > y.edge ? -1 : x.edge < y.edge ? 1 : 0));
}

/**
 * Build one loop's legs for `who` and run them. Without `tight`, the limits are loose and the run measures what
 * the loop costs and pays. With it, the limits are the ones that get signed: the buy may cost `slippage` more,
 * and the sale must pay enough that the loop cannot end at a loss.
 */
async function runLoop(chainId, c, who, { slippage, tight = null, lend = null }) {
  const eth = gasToken(chainId);
  const wrapped = lc(CHAINS.get(chainId).wrapped.address);
  const max = c.a.type === 'ask' ? c.a.cost : tight ? upBy(tight.cost, slippage) : c.cost * 3n + 10n ** 15n;
  let minOut = 0n;
  if (tight) {
    const floor = downBy(tight.out, slippage), even = tight.cost + tight.fee + 1n;
    minOut = even > floor && even <= tight.out ? even : floor;
  }
  const outToken = c.d.unwrap ? wrappedToken(chainId) : eth;
  const aLegs = await acquireLegs({ ...c.a, cost: tight ? tight.cost : c.a.cost }, { chainId, who, max, col: c.col, payToken: eth });
  const dLegs = await disposeLegs({ ...c.d, out: tight ? tight.out : c.d.out }, { chainId, who, tokenId: c.a.tokenId, minOut, col: c.col, outToken });
  const legs = [...aLegs, ...dLegs];
  if (c.d.unwrap && tight) legs.push(unwrapLeg(chainId, minOut, eth));
  const t = await trial(chainId, who, legs, ['NATIVE', wrapped], { lend, marks: [aLegs.length - 1] });
  if (!t.ok) return { legs, t };
  const mid = t.mark.get(aLegs.length - 1);
  const cost = t.before.get('NATIVE') - mid.get('NATIVE');
  const out = (t.after.get('NATIVE') - mid.get('NATIVE')) + (t.after.get(wrapped) - t.before.get(wrapped));
  return { legs, t, cost, out, minOut, max, basis: tight ? tight.cost : c.cost };
}

/**
 * The loops that pay right now, best first: the top few by estimate, each one run on the chain. A few seconds
 * fresh, so a burst of requests shares one pass.
 */
const bestLoops = keyed({
  fresh: LOOP_FRESH_MS,
  stale: LOOP_FRESH_MS,
  max: 16,
  load: async (k) => {
    const chainId = Number(k);
    const book = await withBuyerIds(await books.get(chainId));
    const t1 = Date.now();
    const cands = await loopCandidates(book);
    const gasPrice = book.gasPrice || 0n;
    const tried = [];
    const firsts = new Set();
    // the best few by estimate, and no two that begin with the same buy (the second would be the same loop, worse)
    for (const c of cands) {
      if (tried.length >= TRIALS) break;
      const start = `${lc(c.col.collection)}:${c.a.type}:${c.a.m?.poolId ?? c.a.order?.hash ?? ''}`;
      if (firsts.has(start)) continue;
      firsts.add(start);
      tried.push(c);
    }
    const runs = (await Promise.all(tried.map(async (c) => {
      const r = await runLoop(chainId, c, PROBE, { slippage: 1, lend: PROBE_LEND }).catch(() => null);
      if (!r?.t.ok || r.cost <= 0n) return null;
      const fee = feeFor(r.t.gasTotal + (c.d.unwrap ? UNWRAP_GAS : 0n), gasPrice);
      return { c, cost: r.cost, out: r.out, fee, net: r.out - r.cost - fee, block: r.t.block };
    }))).filter(Boolean).sort((a, b) => (a.net > b.net ? -1 : a.net < b.net ? 1 : 0));
    const estimate = cands.filter((c) => c.cost > 0n)[0] || null;
    if (DEBUG) host.log(`loops ${chainId}: ${cands.length} candidates, ${tried.length} run, ${runs.filter((x) => x.net > 0n).length} pay, ${Date.now() - t1} ms`);
    return { chainId, at: Date.now(), candidates: cands.length, runs, estimate: estimate ? { cost: estimate.cost, edge: estimate.edge } : null };
  },
});

/** The same gas token on both sides: the best loop, built and run for the wallet, or an honest no. */
async function planLoop({ chainId, input, output, owner, slippage }) {
  const budget = amountOf(input);
  const gas = CHAINS.get(chainId).gas;
  const found = await bestLoops.get(chainId);
  const paying = found.runs.filter((x) => x.net > 0n);
  if (!paying.length) {
    const best = found.runs[0];
    if (best) throw fail('NO_EDGE', `No loop pays right now. The best one loses ${pctOf(-best.net, best.cost)}%.`, 404);
    const est = found.estimate;
    throw fail('NO_EDGE', est && est.edge < 0n ? `No loop pays right now. The best one loses ${pctOf(-est.edge, est.cost)}%.` : 'No loop pays right now.', 404);
  }
  const affordable = budget == null ? paying : paying.filter((x) => x.cost <= budget);
  if (!affordable.length) {
    const cheapest = paying.slice().sort((a, b) => (a.cost < b.cost ? -1 : 1))[0];
    throw fail('AMOUNT_TOO_SMALL', `A loop pays right now, but it takes ${human(cheapest.cost)} ${gas} to start. Type at least that much.`, 400);
  }
  const who = owner ? getAddress(owner) : PROBE;
  const gasPrice = (await gasPrices.get(chainId).catch(() => 0n)) || 0n;
  let said = null;
  for (const run of affordable.slice(0, 2)) {
    // built again with the limits that get signed, and run as the wallet that will sign: these exact legs, in order
    let r;
    try {
      r = await runLoop(chainId, run.c, who, { slippage, tight: run, lend: owner ? null : PROBE_LEND });
      // the price moved since the pass that found it: build the limits again from what this run measured
      if (r.t.ok && (r.cost !== run.cost || r.out !== run.out)) r = await runLoop(chainId, run.c, who, { slippage, tight: { cost: r.cost, out: r.out, fee: run.fee }, lend: owner ? null : PROBE_LEND });
    } catch (e) { said = e; continue; }
    if (!r.t.ok) { said = refusal(r.t); continue; }
    if (r.cost !== r.basis) { said = fail('MOVING', 'Prices are moving too fast to pin this loop down. Try again in a moment.', 409); continue; }
    const fee = feeFor(r.t.gasTotal, gasPrice);
    const net = r.out - r.cost - fee;
    if (net <= 0n) { said = fail('NO_EDGE', 'No loop pays right now. The best one stopped paying while it was being checked.', 404); continue; }
    const label = nftLabel(run.c.col.name, run.c.a.tokenId);
    return seal({
      routing: 'PLAN', op: id,
      headline: `Buy ${label} for ${human(r.cost)} ${gas}, sell it for ${human(r.out)} ${gas}: about ${human(net)} ${gas} left after fees`,
      pay: { label: `${gas} on ${chainName(chainId)}`, amount: r.cost.toString(), token: dress(gasToken(chainId), input) },
      receive: { label: `${gas} back on ${chainName(chainId)}`, amount: r.out.toString(), token: dress(gasToken(chainId), output) },
      legs: r.legs.map((l) => txLeg(chainId, l, !!owner)),
      facts: [
        { label: 'You put in', value: `${human(r.cost)} ${gas}`, sub: `${run.c.a.type === 'curve' ? 'Mints' : 'Buys'} ${label} ${run.c.a.type === 'curve' ? 'on' : 'from'} ${the(run.c.a.venue)}.` },
        { label: 'You get back', value: `${human(r.out)} ${gas}`, sub: `Sells it ${run.c.d.type === 'curve' ? 'back to' : run.c.d.type === 'bid' ? 'to the best offer on' : 'into'} ${the(run.c.d.venue)}.` },
        feeFact(fee, gas),
        { label: 'Left after fees', value: `${human(net)} ${gas}`, sub: `${pctOf(net, r.cost)}% on what you put in.`, tone: 'ok' },
        checked(owner, r.legs.length, r.t.block),
      ],
      warnings: [SEPARATE, ALPHA],
      contracts: contractsOf(chainId, r.legs),
      loop: { collection: run.c.col.collection, tokenId: run.c.a.tokenId.toString(), cost: r.cost.toString(), out: r.out.toString(), fee: fee.toString(), net: net.toString() },
    }, slippage);
  }
  bestLoops.drop(String(chainId));
  throw said?.planError ? said : fail('NO_EDGE', 'No loop pays right now.', 404);
}

// ───────────────────────── wrap and unwrap ─────────────────────────

async function planWrap({ chainId, input, output, owner, wrap }) {
  const amount = amountOf(input);
  if (amount == null) throw fail('AMOUNT_REQUIRED', 'Type the amount first.', 400);
  const eth = gasToken(chainId), w = wrappedToken(chainId);
  const [from, to] = wrap ? [dress(eth, input), dress(w, output)] : [dress(w, input), dress(eth, output)];
  const leg = {
    kind: wrap ? 'wrap' : 'unwrap', label: `Turn ${human(amount)} ${from.symbol} into ${to.symbol}`, note: 'One for one. The same coin in a different wrapper.',
    call: wrap ? C(w.address, WRAPPED, 'deposit', [], amount) : C(w.address, WRAPPED, 'withdraw', [amount]),
    in: { token: from, amount: amount.toString() }, out: { token: to, amount: amount.toString() }, contract: { address: w.address, name: w.symbol },
  };
  let block = 0;
  if (owner) {
    const t = await trial(chainId, getAddress(owner), [leg], ['NATIVE', lc(w.address)]);
    if (!t.ok) throw fail('INSUFFICIENT_BALANCE', `This wallet does not hold ${human(amount)} ${from.symbol} on ${chainName(chainId)}.`, 400);
    block = t.block;
  }
  return seal({
    routing: 'PLAN', op: id,
    headline: `${human(amount)} ${from.symbol} becomes ${human(amount)} ${to.symbol}, one for one`,
    pay: { label: `${from.symbol} on ${chainName(chainId)}`, amount: amount.toString(), token: from },
    receive: { label: `${to.symbol} on ${chainName(chainId)}`, amount: amount.toString(), token: to },
    legs: [txLeg(chainId, leg, !!owner)],
    facts: [{ label: 'Rate', value: 'One for one', sub: 'No fee and no price: the wrapper holds the coin and hands it back on demand.', tone: 'ok' }, checked(owner, 1, block)],
    warnings: [],
    contracts: contractsOf(chainId, [leg]),
  }, 0);
}

// ───────────────────────── a claim on one side: the vault as a venue ─────────────────────────

/** A claim burns a cut of itself on the way out of a pool: what arrives of what the pool sends. */
const afterTax = (claims, m) => (claims * BigInt(10_000 - (m.taxBps || 0))) / 10_000n;
const sumTo = (list, n) => list.slice(0, n).reduce((a, x) => a + x, 0n);

/**
 * How many NFTs to route through the venue: for every count from none up, what the venue leg gives plus what the
 * claim's own pool gives for the rest. `venue[i]` is what NFT i adds on the receive side and `spend[i]` what it
 * takes from the amount. Null when no count beats the pool alone by more than the extra steps cost.
 */
async function split({ chainId, amount, spend, venue, pool, selling, tax, extraFeeIn }) {
  const used = spend.reduce((acc, x) => [...acc, acc[acc.length - 1] + x], [0n]).filter((s) => s <= amount);
  const rests = used.map((s) => amount - s);
  const quotes = pool ? await sread(chainId, rests.map((r) => quoteIn(pool, r > 0n ? r : 1n, selling))).catch(() => rests.map(() => null)) : rests.map(() => null);
  const rows = used.map((_, n) => {
    const rest = rests[n];
    const got = rest === 0n ? 0n : quotes[n]?.[0] != null ? tax(quotes[n][0]) : null;
    return { n, rest, swapped: got ?? 0n, whole: got != null, viaVenue: sumTo(venue, n) };
  });
  const plain = rows[0].whole ? rows[0].swapped : 0n;
  // the pool has to be able to take the rest; with no pool at all, only an amount that is used up exactly fits
  const fits = rows.filter((r) => r.n > 0 && (r.whole || (!pool && r.rest < (spend[r.n] ?? r.rest + 1n))));
  const best = fits.sort((x, y) => (x.viaVenue + x.swapped > y.viaVenue + y.swapped ? -1 : 1))[0];
  if (!best) return null;
  const gained = best.viaVenue + best.swapped - plain;
  if (gained <= 0n || gained <= extraFeeIn(best.n, plain)) return null;
  return { ...best, plain, spent: best.whole ? amount : used[best.n] };
}

/**
 * Tokens in, claims out. The pool sells claims at its price; the vault mints them for an NFT. When the NFT is
 * cheaper elsewhere than its claims are in the pool, buy it there and vault it, and send what is left of the
 * amount through the pool. Returned only when that gives more claims than the pool alone.
 */
async function planInto({ chainId, input, output, owner, slippage, book, vaultMarkets }) {
  const amount = amountOf(input);
  if (amount == null) throw fail('AMOUNT_REQUIRED', 'Type the amount you are paying first.', 400);
  const money = keyOfToken(input);
  const v = vaultMarkets[0];
  // paying with a token: the stand-in wallet holds none, so only the wallet itself can be run
  if (v.gated || (money !== 'NATIVE' && !owner)) throw PASS();
  const col = book.cols.get(lc(v.collection));
  const a0 = (await acquires(book, col, money, { not: v.vault })).filter((a) => a.type !== 'redeem' && a.cost <= amount)[0];
  if (!a0) throw PASS();
  const pool = vaultMarkets.find((m) => moneyOf(m) === money) || null;
  // a quick no: the pool already sells one NFT's worth of claims for less than the NFT costs anywhere else
  if (pool?.buy != null && a0.cost * v.floorCost * 10_000n >= pool.buy * v.mintUnit * BigInt(10_000 - v.taxBps)) throw PASS();
  const payToken = tokenOf(book, money, input);
  const claim = dress(claimToken(v), output);
  const who = owner ? getAddress(owner) : PROBE;
  const lend = owner ? null : PROBE_LEND;
  const gasPrice = book.gasPrice || 0n;
  const spender = a0.type === 'ask' ? SEAPORT : a0.type === 'pool' ? a0.m.router : null;
  await mustHold(chainId, owner, money, payToken, amount);

  // the ladder: buy from the cheapest venue again and again, learning each next NFT and its price from the run
  const K = a0.type === 'pool' ? Math.max(1, Math.min(MAX_NFTS, a0.m.inventory, Number(amount / a0.cost))) : 1;
  const probe = [];
  if (money !== 'NATIVE' && spender) probe.push({ call: C(payToken.address, ERC20, 'approve', [spender, amount]) });
  const buyAt = [];
  for (let i = 0; i < K; i++) {
    if (a0.type === 'pool') probe.push({ read: true, call: C(a0.m.vault, VAULT, 'peekFloor') });
    const buy = (await acquireLegs(a0, { chainId, who, max: a0.type === 'ask' ? a0.cost : amount, col, payToken, skipApprove: true })).pop();
    buyAt.push(probe.push(buy) - 1);
  }
  const first = await trial(chainId, who, probe, [money], { lend, marks: buyAt });
  const ladder = [];
  let prev = first.before.get(money);
  for (const at of buyAt) {
    const bal = first.mark.get(at)?.get(money);
    const floor = a0.type === 'pool' ? first.steps[at - 1].out : a0.tokenId;
    if (!first.steps[at].ok || prev == null || bal == null || floor == null || prev <= bal) break;
    ladder.push({ tokenId: floor, cost: prev - bal });
    prev = bal;
  }
  if (!ladder.length) {
    if (owner && first.before.get(money) != null && first.before.get(money) < a0.cost) throw fail('INSUFFICIENT_BALANCE', `This wallet holds ${human(first.before.get(money), payToken.decimals)} ${payToken.symbol} on ${chainName(chainId)} and one NFT costs ${human(a0.cost, payToken.decimals)}.`, 400);
    throw PASS();
  }
  const pick = await split({
    chainId, amount, pool, selling: false, tax: (x) => afterTax(x, v),
    spend: ladder.map((r) => r.cost), venue: ladder.map(() => v.mintUnit),
    // each NFT is two more transactions than a swap: it has to bring more than they cost, counted in claims
    extraFeeIn: (n, plain) => (money === 'NATIVE' && plain > 0n ? (feeFor(BigInt(n) * 450_000n, gasPrice) * plain) / amount : 0n),
  });
  if (!pick) throw PASS();

  // the legs as they get signed, and one run of all of them
  const picked = ladder.slice(0, pick.n);
  const legs = [];
  if (money !== 'NATIVE' && spender) {
    const total = picked.reduce((s, r) => s + (a0.type === 'ask' ? r.cost : upBy(r.cost, slippage)), 0n);
    legs.push({ kind: 'approve', label: `Let ${the(a0.venue)} take up to ${human(total, payToken.decimals)} ${payToken.symbol}`, note: 'This exact amount, not unlimited.', call: C(payToken.address, ERC20, 'approve', [spender, total]), contract: { address: payToken.address, name: payToken.symbol } });
  }
  for (const r of picked) legs.push(...await acquireLegs({ ...a0, cost: r.cost, tokenId: r.tokenId }, { chainId, who, max: a0.type === 'ask' ? r.cost : upBy(r.cost, slippage), col, payToken, skipApprove: true }));
  const ids = picked.map((r) => r.tokenId);
  const vaultName = `the ${claim.symbol} vault`;
  const what = pick.n === 1 ? nftLabel(col.name, ids[0]) : `${pick.n} ${col.name} NFTs`;
  legs.push(pick.n === 1
    ? { kind: 'approve', label: `Let ${vaultName} take ${what}`, note: 'Only this one NFT. Nothing else in the wallet is touched.', call: C(col.collection, ERC721, 'approve', [v.vault, ids[0]]), contract: collectionContract(col) }
    : { kind: 'approve', label: `Let ${vaultName} take your ${col.name} NFTs`, note: 'Needed once. It covers the NFTs vaulted in the next step.', call: C(col.collection, ERC721, 'setApprovalForAll', [v.vault, true]), contract: collectionContract(col) });
  legs.push({
    kind: 'vault', label: `Put ${what} into ${vaultName}`, note: `Mints ${claim.symbol} to your wallet. The vault takes no fee on the way in.`,
    call: pick.n === 1 ? C(v.vault, VAULT, 'deposit', [ids[0], who]) : C(v.vault, VAULT, 'depositBatch', [ids, who]),
    out: { token: claim, amount: pick.viaVenue.toString() }, contract: { address: v.vault, name: `${claim.symbol} vault` },
  });
  const t = await trial(chainId, who, legs, [money, lc(v.vault)], { lend });
  if (!t.ok) throw refusal(t);
  const minted = t.delta.get(lc(v.vault));
  if (minted == null || minted <= 0n) throw PASS();
  legs[legs.length - 1].out.amount = minted.toString();
  const out = minted + pick.swapped;
  if (out <= pick.plain) throw PASS();
  const fee = feeFor(t.gasTotal, gasPrice);
  const planLegs = legs.map((l) => txLeg(chainId, l, !!owner));
  const viaPool = pick.rest > 0n && pick.whole;
  if (viaPool) planLegs.push(routerLeg(chainId, payToken, claim, pick.rest, pick.swapped, `The rest of your ${payToken.symbol}, through the ${claim.symbol} pool.${v.taxBps ? ` ${claim.symbol} burns ${v.taxBps / 100}% of what leaves a pool, and the amount shown is what arrives.` : ''}`));
  return seal({
    routing: 'PLAN', op: id,
    headline: `${human(pick.spent, payToken.decimals)} ${payToken.symbol} becomes ${human(out)} ${claim.symbol}: ${count(pick.n, 'NFT', 'NFTs')} bought and vaulted${viaPool ? ', the rest through the pool' : ''}`,
    pay: { label: `${payToken.symbol} on ${chainName(chainId)}`, amount: pick.spent.toString(), token: payToken },
    receive: { label: `${claim.symbol} on ${chainName(chainId)}`, amount: out.toString(), token: claim },
    legs: planLegs,
    facts: [
      { label: 'You get', value: `${human(out)} ${claim.symbol}`, sub: pick.plain > 0n ? `The pool alone gives ${human(pick.plain)} for the same ${payToken.symbol}. This is ${pctOf(out - pick.plain, pick.plain)}% more.` : 'The pool cannot fill this amount on its own right now.', tone: 'ok' },
      { label: 'How', value: `${count(pick.n, 'NFT', 'NFTs')} from ${the(a0.venue)}`, sub: `${picked.map((r) => `#${r.tokenId} for ${human(r.cost, payToken.decimals)} ${payToken.symbol}`).join(', ')}. Vaulted, ${pick.n === 1 ? 'it mints' : 'they mint'} ${human(minted)} ${claim.symbol}.` },
      feeFact(fee, CHAINS.get(chainId).gas),
      checked(owner, legs.length, t.block),
    ],
    warnings: [SEPARATE, ALPHA],
    contracts: contractsOf(chainId, legs),
    venue: { nfts: pick.n, plainOut: pick.plain.toString() },
  }, slippage);
}

/**
 * Claims in, tokens out. The pool buys claims at its price; the vault hands the floor NFT over for one NFT's worth.
 * When that NFT sells for more elsewhere than its claims do in the pool, redeem it and sell it there, and send the
 * rest of the claims through the pool. Returned only when that pays more than the pool alone.
 */
async function planOutOf({ chainId, input, output, owner, slippage, book, vaultMarkets }) {
  const amount = amountOf(input);
  if (amount == null) throw fail('AMOUNT_REQUIRED', 'Type the amount you are paying first.', 400);
  const money = keyOfToken(output);
  const v = vaultMarkets[0];
  const col = book.cols.get(lc(v.collection));
  if (v.inventory <= 0 || v.floorCost == null || v.floorCost > amount) throw PASS();
  const d0 = (await disposes(book, col, money, { not: v.vault })).filter((d) => d.type !== 'deposit')[0];
  if (!d0) throw PASS();
  const pool = vaultMarkets.find((m) => moneyOf(m) === money) || null;
  // a quick no: one NFT's worth of claims already sells for more in the pool than the NFT does anywhere else
  if (pool?.sell != null && d0.out * v.mintUnit <= pool.sell * v.floorCost) throw PASS();
  const claim = dress(claimToken(v), input);
  const outToken = tokenOf(book, money, output);
  const paidIn = d0.unwrap ? wrappedToken(chainId) : outToken;
  const paidKey = keyOfToken(paidIn);
  const who = owner ? getAddress(owner) : PROBE;
  // the stand-in wallet is lent the claims for the run; a real wallet uses its own
  const overrides = owner ? null : await lendToken(chainId, v.vault, POOL_MANAGERS[chainId], who, amount);
  if (!owner && !overrides) throw PASS();
  const lend = owner ? null : PROBE_LEND;
  const gasPrice = book.gasPrice || 0n;
  const redeem = () => ({ kind: 'redeem', call: C(v.vault, VAULT, 'redeemFloor', [who]), contract: { address: v.vault, name: `${claim.symbol} vault` } });

  // run 1: take NFTs out one after another, learning which each one is and what it burned
  const K = Math.max(1, Math.min(MAX_NFTS, v.inventory, Number(amount / v.floorCost)));
  const probe = [];
  const outAt = [];
  for (let i = 0; i < K; i++) { probe.push({ read: true, call: C(v.vault, VAULT, 'peekFloor') }); outAt.push(probe.push(redeem()) - 1); }
  const first = await trial(chainId, who, probe, [lc(v.vault)], { lend, overrides, marks: outAt });
  const took = [];
  let prev = first.before.get(lc(v.vault));
  for (const at of outAt) {
    const bal = first.mark.get(at)?.get(lc(v.vault));
    const tokenId = first.steps[at - 1].out;
    if (!first.steps[at].ok || prev == null || bal == null || tokenId == null) break;
    took.push({ tokenId, burned: prev - bal });
    prev = bal;
  }
  if (!took.length) {
    if (owner && first.before.get(lc(v.vault)) != null && first.before.get(lc(v.vault)) < v.floorCost) throw fail('INSUFFICIENT_BALANCE', `This wallet holds ${human(first.before.get(lc(v.vault)))} ${claim.symbol} and one NFT costs ${human(v.floorCost)}.`, 400);
    throw PASS();
  }
  // run 2: take them out and sell each one, measuring what every sale pays
  const many = took.length > 1;
  const sales = [];
  for (const [i, r] of took.entries()) sales.push(await disposeLegs(d0, { chainId, who, tokenId: r.tokenId, minOut: 0n, col, outToken: paidIn, approveAll: many, skipApprove: many && i > 0 }));
  const measure = [...took.map(redeem), ...sales.flat()];
  const payAt = measure.map((l, i) => (l.pays ? i : -1)).filter((i) => i >= 0);
  const second = await trial(chainId, who, measure, [paidKey], { lend, overrides, marks: payAt });
  const paid = [];
  let had = second.before.get(paidKey);
  for (const at of payAt) {
    const bal = second.mark.get(at)?.get(paidKey);
    if (second.failedAt >= 0 && second.failedAt <= at) break;
    if (had == null || bal == null || bal <= had) break;
    paid.push(bal - had);
    had = bal;
  }
  if (!paid.length) throw PASS();

  const pick = await split({
    chainId, amount, pool, selling: true, tax: (x) => x,
    spend: took.slice(0, paid.length).map((r) => r.burned), venue: paid,
    extraFeeIn: (n) => (money === 'NATIVE' ? feeFor(BigInt(n) * 500_000n, gasPrice) : 0n),
  });
  if (!pick) throw PASS();

  // the legs as they get signed, with their limits, and one run of all of them
  const picked = took.slice(0, pick.n);
  const legs = picked.map((r) => ({ ...redeem(), label: `Take ${nftLabel(col.name, r.tokenId)} out of the ${claim.symbol} vault`, note: `Burns ${human(r.burned)} ${claim.symbol}: one NFT's worth and the vault's fees.`, in: { token: claim, amount: r.burned.toString() } }));
  for (const [i, r] of picked.entries()) {
    legs.push(...await disposeLegs({ ...d0, out: paid[i] }, { chainId, who, tokenId: r.tokenId, minOut: downBy(paid[i], slippage), col, outToken: paidIn, approveAll: pick.n > 1, skipApprove: pick.n > 1 && i > 0 }));
  }
  if (d0.unwrap) legs.push(unwrapLeg(chainId, picked.reduce((a, _, i) => a + downBy(paid[i], slippage), 0n), outToken, pick.n > 1));
  const wrapped = lc(CHAINS.get(chainId).wrapped.address);
  const t = await trial(chainId, who, legs, [...new Set(['NATIVE', wrapped, money])], { lend, overrides });
  if (!t.ok) throw refusal(t);
  const sold = money === 'NATIVE' ? (t.delta.get('NATIVE') ?? 0n) + (t.delta.get(wrapped) ?? 0n) : t.delta.get(money) ?? 0n;
  const out = sold + pick.swapped;
  if (sold <= 0n || out <= pick.plain) throw PASS();
  const fee = feeFor(t.gasTotal, gasPrice);
  const planLegs = legs.map((l) => txLeg(chainId, l, !!owner));
  const viaPool = pick.rest > 0n && pick.whole;
  if (viaPool) planLegs.push(routerLeg(chainId, claim, outToken, pick.rest, pick.swapped, `The rest of your ${claim.symbol}, through its pool.`));
  return seal({
    routing: 'PLAN', op: id,
    headline: `${human(pick.spent)} ${claim.symbol} becomes ${human(out, outToken.decimals)} ${outToken.symbol}: ${count(pick.n, 'NFT', 'NFTs')} taken out and sold${viaPool ? ', the rest through the pool' : ''}`,
    pay: { label: `${claim.symbol} on ${chainName(chainId)}`, amount: pick.spent.toString(), token: claim },
    receive: { label: `${outToken.symbol} on ${chainName(chainId)}`, amount: out.toString(), token: outToken },
    legs: planLegs,
    facts: [
      { label: 'You get', value: `${human(out, outToken.decimals)} ${outToken.symbol}`, sub: pick.plain > 0n ? `The pool alone pays ${human(pick.plain, outToken.decimals)}. This is ${pctOf(out - pick.plain, pick.plain)}% more.` : 'The pool cannot take this amount on its own right now.', tone: 'ok' },
      { label: 'How', value: `${count(pick.n, 'NFT', 'NFTs')} sold ${d0.type === 'curve' ? 'back to' : d0.type === 'bid' ? 'to the best offer on' : 'into'} ${the(d0.venue)}`, sub: picked.map((r, i) => `#${r.tokenId} for ${human(paid[i], outToken.decimals)} ${outToken.symbol}`).join(', ') },
      feeFact(fee, CHAINS.get(chainId).gas),
      checked(owner, legs.length, t.block),
    ],
    warnings: [SEPARATE, ALPHA],
    contracts: contractsOf(chainId, legs),
    venue: { nfts: pick.n, plainOut: pick.plain.toString() },
  }, slippage);
}
/** Uniswap's v4 PoolManager per chain: where a claim's pools keep it, so a holder the balance slot can be found from. */
const POOL_MANAGERS = {
  4663: '0x8366a39CC670B4001A1121B8F6A443A643e40951', 8453: '0x498581fF718922c3f8e6A244956aF099B2652b2b', 42161: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32',
  10: '0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3', 130: '0x1F98400000000000000000000000000000000004', 81457: '0x1631559198A9e474033433b2958daBC135ab6446',
  1868: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32', 57073: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32', 7777777: '0x0575338e4C17006aE181B47900A84404247CA30f',
  56: '0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF', 137: '0x67366782805870060151383F4BbFF9daB53e5cD6', 43114: '0x06380C0e0912312B5150364B9DC4542BA0DbBc85',
};

// ───────────────────────── a loop first, then the swap ─────────────────────────

/**
 * The gas token in, any other token out, and a loop pays: run the loop first, then swap what the wallet started
 * with plus what the loop left. The swap comes out larger than the pools alone give for the same amount.
 */
async function planBoost({ chainId, input, output, owner, slippage, book }) {
  const amount = amountOf(input);
  if (amount == null) throw PASS();
  const found = await bestLoops.get(chainId);
  const run = found.runs.find((x) => x.net > 0n && x.cost <= amount);
  if (!run) throw PASS();
  const who = owner ? getAddress(owner) : PROBE;
  const [plain, r] = await Promise.all([
    classicQuote({ chainId, tokenIn: 'NATIVE', tokenOut: getAddress(output.address), amount }),
    runLoop(chainId, run.c, who, { slippage, tight: run, lend: owner ? null : PROBE_LEND }),
    mustHold(chainId, owner, 'NATIVE', gasToken(chainId), amount),
  ]);
  if (!plain || plain.amountOut <= 0n) throw PASS();
  if (!r.t.ok || r.cost > r.basis) throw PASS();
  const fee = feeFor(r.t.gasTotal, book.gasPrice || 0n);
  // what is certain to be in the wallet for the swap: the sale's minimum, less the most the buy can cost and the loop's own fees
  const sure = r.minOut - r.max - fee;
  if (sure <= 0n) throw PASS();
  // the pools were asked about `amount`. The extra is priced at the same rate less the swap's own price impact,
  // twice over and again for how much larger the swap becomes, so the number shown leans low, never high.
  const larger = Number((sure * 100n) / amount) / 100;
  const haircut = BigInt(Math.round(Math.min(5_000, Math.max(0, plain.priceImpactBps) * 2 * Math.max(1, larger))));
  const extraOut = (((plain.amountOut * sure) / amount) * (10_000n - haircut)) / 10_000n;
  if (extraOut <= 0n) throw PASS();
  const out = plain.amountOut + extraOut;
  const gas = CHAINS.get(chainId).gas;
  const eth = dress(gasToken(chainId), input);
  const outToken = tokenOf(book, keyOfToken(output), output);
  const label = nftLabel(run.c.col.name, run.c.a.tokenId);
  return seal({
    routing: 'PLAN', op: id,
    headline: `${human(amount)} ${gas} becomes about ${human(out, outToken.decimals)} ${outToken.symbol}: a loop through ${label} adds ${human(sure)} ${gas} before the swap`,
    pay: { label: `${gas} on ${chainName(chainId)}`, amount: amount.toString(), token: eth },
    receive: { label: `${outToken.symbol} on ${chainName(chainId)}`, amount: out.toString(), token: outToken },
    legs: [
      ...r.legs.map((l) => txLeg(chainId, l, !!owner)),
      routerLeg(chainId, eth, outToken, amount + sure, out, `Your ${human(amount)} ${gas} and the ${human(sure)} ${gas} the loop left, through the pools.`),
    ],
    facts: [
      { label: 'You get', value: `about ${human(out, outToken.decimals)} ${outToken.symbol}`, sub: `The pools alone give ${human(plain.amountOut, outToken.decimals)} for ${human(amount)} ${gas}. This is ${pctOf(extraOut, plain.amountOut)}% more.`, tone: 'ok' },
      { label: 'The loop', value: `Buy ${label} for ${human(r.cost)} ${gas}, sell it for ${human(r.out)} ${gas}`, sub: `Uses ${human(r.cost)} of your ${gas} for a moment and hands it back with at least ${human(sure)} more, after its own fees.` },
      feeFact(fee, gas),
      checked(owner, r.legs.length, r.t.block),
    ],
    warnings: [SEPARATE, 'The last step is priced when you reach it, so the final amount can differ a little from the one shown.', ALPHA],
    contracts: contractsOf(chainId, r.legs),
    loop: { collection: run.c.col.collection, tokenId: run.c.a.tokenId.toString(), cost: r.cost.toString(), out: r.out.toString(), fee: fee.toString(), added: sure.toString(), plainOut: plain.amountOut.toString() },
  }, slippage);
}

// ───────────────────────── an NFT on one side ─────────────────────────

async function planSellNft({ chainId, input, output, owner, slippage }) {
  const tokenId = tokenIdOf(input.tokenId);
  const book = await books.get(chainId);
  const col = book.cols.get(lc(input.collection));
  if (!col) throw PASS();
  const money = keyOfToken(output);
  const outs = (await disposes(book, col, money, { tokenId })).slice(0, TRIALS);
  if (!outs.length) throw PASS();
  const name = nftLabel(col.name, tokenId);
  const [holder] = await mread(chainId, [C(col.collection, ERC721, 'ownerOf', [tokenId])]);
  if (!isAddress(holder)) throw fail('NOT_FOUND', `${name} does not exist on ${chainName(chainId)}.`, 404);
  if (owner && !same(holder, owner)) throw fail('NOT_OWNER', `This wallet does not hold ${name}.`, 400);
  if (book.markets.some((m) => same(m.vault, holder))) throw fail('NOT_OWNER', `${name} is already in a pool.`, 400);
  const who = getAddress(owner || holder); // with no wallet yet, price it as whoever holds it
  const wrapped = lc(CHAINS.get(chainId).wrapped.address);
  const outToken = tokenOf(book, money, output);
  const paidIn = (d) => (d.unwrap ? wrappedToken(chainId) : outToken);
  const tries = await Promise.all(outs.map(async (d) => {
    try {
      const legs = await disposeLegs(d, { chainId, who, tokenId, minOut: 0n, col, outToken: paidIn(d) });
      const t = await trial(chainId, who, legs, [keyOfToken(paidIn(d))]);
      return t.ok ? { d, got: t.delta.get(keyOfToken(paidIn(d))) ?? 0n } : { d, t };
    } catch (e) { return { d, e }; }
  }));
  const works = tries.filter((x) => x.got > 0n).sort((a, b) => (a.got > b.got ? -1 : 1));
  const best = works[0];
  if (!best) {
    const said = tries.find((x) => x.e?.planError);
    if (said) throw said.e;
    const ran = tries.find((x) => x.t);
    throw ran ? refusal(ran.t) : PASS();
  }
  const d = best.d;
  const minOut = downBy(best.got, slippage);
  const legs = await disposeLegs({ ...d, out: best.got }, { chainId, who, tokenId, minOut, col, outToken: paidIn(d) });
  if (d.unwrap) legs.push(unwrapLeg(chainId, minOut, outToken));
  const t = await trial(chainId, who, legs, [...new Set(['NATIVE', wrapped, money])]);
  if (!t.ok) throw refusal(t);
  const got = money === 'NATIVE' ? (t.delta.get('NATIVE') ?? 0n) + (t.delta.get(wrapped) ?? 0n) : t.delta.get(money) ?? 0n;
  if (got <= 0n) throw PASS();
  const others = works.slice(1).map((x) => `${x.d.venue} ${human(x.got, outToken.decimals)}`);
  return seal({
    routing: 'PLAN', op: id,
    headline: `Sell ${name} for ${human(got, outToken.decimals)} ${outToken.symbol} ${d.type === 'curve' ? 'on' : d.type === 'bid' ? 'to the best offer on' : d.type === 'deposit' ? 'by putting it into' : 'into'} ${the(d.venue)}`,
    pay: { label: name, amount: null, token: null },
    receive: { label: outToken.symbol, amount: got.toString(), token: outToken },
    legs: legs.map((l) => txLeg(chainId, l, !!owner)),
    facts: [
      { label: 'You get', value: `${human(got, outToken.decimals)} ${outToken.symbol}`, sub: d.type === 'bid' || d.type === 'deposit' ? 'A fixed amount: it arrives in full or the step does not happen.' : `At least ${human(minOut, outToken.decimals)} ${outToken.symbol}, or the sale does not happen.`, tone: 'ok' },
      { label: 'Best of', value: count(works.length, 'venue', 'venues'), sub: others.length ? `The others would pay: ${others.join(', ')}.` : 'No other venue would buy it right now.' },
      feeFact(feeFor(t.gasTotal, book.gasPrice || 0n), CHAINS.get(chainId).gas),
      checked(owner, legs.length, t.block),
    ],
    warnings: [ALPHA],
    contracts: contractsOf(chainId, legs),
  }, slippage);
}

async function planBuyNft({ chainId, input, output, owner, slippage }) {
  const book = await withBuyerIds(await books.get(chainId));
  const col = book.cols.get(lc(output.collection));
  if (!col) throw PASS();
  const wanted = output.tokenId == null ? null : tokenIdOf(output.tokenId);
  const money = keyOfToken(input);
  // the stand-in wallet can only pay with the gas token; a token is tried with the wallet that holds it
  if (money !== 'NATIVE' && !owner) throw PASS();
  const ins = (await acquires(book, col, money)).filter((a) => wanted == null || a.tokenId === wanted).slice(0, TRIALS);
  if (!ins.length) throw PASS();
  const who = owner ? getAddress(owner) : PROBE;
  const lend = owner ? null : PROBE_LEND;
  const payToken = tokenOf(book, money, input);
  const tries = await Promise.all(ins.map(async (a) => {
    try {
      const legs = await acquireLegs(a, { chainId, who, max: a.type === 'ask' ? a.cost : a.cost * 2n + 10n ** 12n, col, payToken });
      const t = await trial(chainId, who, legs, [money], { lend });
      return t.ok ? { a, cost: -(t.delta.get(money) ?? 0n) } : { a, t };
    } catch (e) { return { a, e }; }
  }));
  const works = tries.filter((x) => x.cost > 0n).sort((x, y) => (x.cost < y.cost ? -1 : 1));
  const best = works[0];
  if (!best) {
    const said = tries.find((x) => x.e?.planError);
    if (said) throw said.e;
    const ran = tries.find((x) => x.t);
    throw ran ? refusal(ran.t) : PASS();
  }
  const a = { ...best.a, cost: best.cost };
  const max = a.type === 'ask' || a.type === 'redeem' ? a.cost : upBy(a.cost, slippage);
  const legs = await acquireLegs(a, { chainId, who, max, col, payToken });
  const t = await trial(chainId, who, legs, [money], { lend });
  if (!t.ok) throw refusal(t);
  const spent = -(t.delta.get(money) ?? 0n);
  if (spent <= 0n) throw PASS();
  // the page allows a step the amount shown plus the tolerance, and the limit above was built from `a.cost`
  const cost = spent > a.cost ? spent : a.cost;
  const name = nftLabel(col.name, a.tokenId);
  const others = works.slice(1).map((x) => `${x.a.venue} ${human(x.cost, payToken.decimals)}`);
  return seal({
    routing: 'PLAN', op: id,
    headline: `${a.type === 'curve' ? 'Mint' : a.type === 'redeem' ? 'Take' : 'Buy'} ${name} for ${human(cost, payToken.decimals)} ${payToken.symbol} ${a.type === 'curve' ? 'on' : a.type === 'redeem' ? 'out of' : 'from'} ${the(a.venue)}`,
    pay: { label: `${payToken.symbol} on ${chainName(chainId)}`, amount: cost.toString(), token: payToken },
    receive: { label: name, amount: null, token: null },
    legs: legs.map((l) => txLeg(chainId, l, !!owner)),
    facts: [
      { label: 'You pay', value: `${human(cost, payToken.decimals)} ${payToken.symbol}`, sub: a.type === 'ask' ? 'The listed price, fees included.' : `At most ${human(max, payToken.decimals)} ${payToken.symbol}, or the buy does not happen.`, tone: 'ok' },
      { label: 'Best of', value: count(works.length, 'venue', 'venues'), sub: others.length ? `The others would cost: ${others.join(', ')}.` : 'No other venue sells one right now.' },
      feeFact(feeFor(t.gasTotal, book.gasPrice || 0n), CHAINS.get(chainId).gas),
      checked(owner, legs.length, t.block),
    ],
    warnings: [ALPHA],
    contracts: contractsOf(chainId, legs),
  }, slippage);
}

// ───────────────────────── the module contract ─────────────────────────

/** Two things on one chain this module reads: two tokens, or an NFT and a token. Which venue, if any, is plan's to find. */
export function match(input, output) {
  if (!input || !output || typeof input !== 'object' || typeof output !== 'object') return false;
  const chainId = Number(input.chainId);
  if (!CHAINS.has(chainId) || Number(output.chainId) !== chainId) return false;
  if (isTokenThing(input) && isTokenThing(output)) return true;
  if (isNftThing(input) && isTokenThing(output)) return tokenIdOf(input.tokenId) != null;
  if (isTokenThing(input) && isNftThing(output)) return output.tokenId == null || tokenIdOf(output.tokenId) != null;
  return false;
}

/** The dispatcher gives a module 14 seconds. Past this the venues are still being read: say so rather than be cut off. */
const PLAN_DEADLINE_MS = 11_500;

export async function plan(args = {}) {
  const { input, output } = args;
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // an ordinary pair simply goes the ordinary way; a loop or an NFT has no other way, so it is told to ask again
      const plain = isTokenThing(input) && isTokenThing(output) && keyOfToken(input) !== keyOfToken(output);
      reject(plain ? PASS() : fail('SLOW', 'The venues are still being read. Try again in a few seconds.', 504));
    }, PLAN_DEADLINE_MS);
  });
  const work = planNow(args);
  work.catch(() => {}); // when the deadline wins, the work still finishes and warms the caches for the next call
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

async function planNow({ input, output, owner = null, slippage = 1 } = {}) {
  if (!match(input, output)) throw fail('BAD_REQUEST', 'This needs two things on the same chain: two tokens, or an NFT and a token.', 400);
  if (owner != null && (!isAddress(owner) || same(owner, ZERO))) throw fail('BAD_REQUEST', 'That wallet address is not valid.', 400);
  const s = Number(slippage);
  const tolerance = Number.isFinite(s) && s >= 0 ? Math.min(20, Math.max(0.01, s)) : 1;
  const chainId = Number(input.chainId);
  const ctx = { chainId, input, output, owner, slippage: tolerance };
  try {
    if (input.kind === 'nft') return await planSellNft(ctx);
    if (output.kind === 'nft') return await planBuyNft(ctx);
    const [a, b] = [keyOfToken(input), keyOfToken(output)];
    const wrapped = lc(CHAINS.get(chainId).wrapped.address);
    if (a === 'NATIVE' && b === wrapped) return await planWrap({ ...ctx, wrap: true });
    if (a === wrapped && b === 'NATIVE') return await planWrap({ ...ctx, wrap: false });
    if (a === b) {
      if (a === 'NATIVE') return await planLoop(ctx);
      throw fail('NO_EDGE', `No loop pays in that token right now. Loops start and end in ${CHAINS.get(chainId).gas}.`, 404);
    }
    const book = await books.get(chainId);
    const tries = [];
    if (book.claims.has(b) && !book.claims.has(a)) tries.push(planInto({ ...ctx, book, vaultMarkets: book.claims.get(b) }));
    if (book.claims.has(a) && !book.claims.has(b)) tries.push(planOutOf({ ...ctx, book, vaultMarkets: book.claims.get(a) }));
    if (a === 'NATIVE' && b !== wrapped) tries.push(planBoost({ ...ctx, book }));
    if (!tries.length) throw PASS();
    const settled = await Promise.allSettled(tries);
    const good = settled.filter((x) => x.status === 'fulfilled').map((x) => x.value).sort((x, y) => (BigInt(x.receive.amount) > BigInt(y.receive.amount) ? -1 : 1));
    if (good.length) return good[0];
    const said = settled.map((x) => x.reason).find((e) => e?.planError && e.code !== 'NO_OP');
    throw said || settled[0].reason;
  } catch (e) {
    if (e?.planError) throw e;
    host.log(`arb failed: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`);
    throw fail('UPSTREAM_UNAVAILABLE', `${chainName(chainId)} could not be read just now. Try again in a moment.`, 503);
  }
}

/** For the picker: the same token on the other side is a real choice here, and says what it does. */
export async function catalog(kind, { chainId = null, input = null } = {}) {
  if (kind !== 'token' || !isTokenThing(input) || input.address !== 'NATIVE') return [];
  const chain = Number(input.chainId);
  if (chainId != null && chainId !== chain) return [];
  if (chain !== HOME) return [];
  const t = gasToken(chain);
  return [{ kind: 'token', id: `token:${chain}:native`, label: t.symbol, sub: 'Back to the same coin: the best loop right now', ...t }];
}

export function register() {}

/** For the host's status page and for tests: what the last pass over the venues saw. Reads the cache, asks nothing. */
export function peek(chainId = HOME) {
  const book = books.peek(chainId), loops = bestLoops.peek(chainId);
  return {
    bookAt: book?.at ?? null, markets: book?.markets.length ?? 0, curves: book?.curves.length ?? 0,
    priced: book ? book.markets.filter((m) => m.buy != null || m.sell != null).length : 0,
    loopsAt: loops?.at ?? null, loops: loops ? loops.runs.map((x) => ({ collection: x.c.col.name, from: x.c.a.venue, to: x.c.d.venue, cost: x.cost.toString(), net: x.net.toString() })) : [],
    opensea: !!openseaKey(), rpc: { ...stats },
  };
}
/** For a host that wants the first request to be quick. Never throws. */
export const warm = (chainId = HOME) => bestLoops.get(chainId).then(() => true, () => false);
/** For tests. */
export const _internals = { books, indexes, bestLoops, loopCandidates, acquires, disposes, split, trial, seal, human, pctOf, upBy, downBy, keyed, simulate, mread, sread, lendToken, tokenIdOf, reason, CHAINS, PROBE };
