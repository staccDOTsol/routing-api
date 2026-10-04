// New AWS accounts cap Lambda memory (512 MB until the account is raised). LAMBDA_MEMORY_CAP_MB lets the same
// stack deploy there; unset, every function keeps upstream's size.
const cap = process.env.LAMBDA_MEMORY_CAP_MB ? parseInt(process.env.LAMBDA_MEMORY_CAP_MB) : undefined
export const capMemory = (mb: number) => (cap ? Math.min(mb, cap) : mb)
