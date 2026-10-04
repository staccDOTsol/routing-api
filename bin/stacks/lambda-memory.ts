// New AWS accounts cap Lambda memory (512 MB until the account is raised). LAMBDA_MEMORY_CAP_MB lets the same
// stack deploy there; unset, every function keeps upstream's size.
const cap = process.env.LAMBDA_MEMORY_CAP_MB ? parseInt(process.env.LAMBDA_MEMORY_CAP_MB) : undefined
export const capMemory = (mb: number) => (cap ? Math.min(mb, cap) : mb)

/**
 * True when the cap leaves a Lambda with 1 GB or less (about half a vCPU or under). Such a Lambda cannot afford
 * Node's source-map support (loading the map alone is about 125 MB of RSS before the first quote) or upstream's
 * full route search, so the routing Lambdas ship a bundle that keeps its identifiers instead of a source map and
 * run with ROUTE_SEARCH=small.
 */
export const smallLambda = cap !== undefined && cap <= 1024

