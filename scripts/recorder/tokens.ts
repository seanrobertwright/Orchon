// Strings shaped like a key or a token, and their scrub. Nothing here knows the developer's own
// values: a string is caught by its shape alone.

/** What a key or a token is written as once it is scrubbed. */
export const TOKEN = '<token>'

/**
 * Strings shaped like a key or a token: Anthropic's keys and OAuth tokens, other `sk-` keys,
 * GitHub's tokens, a JSON web token, and whatever follows `Bearer`.
 */
const TOKEN_SHAPES: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9]{2,8}-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /(?<=\bBearer\s+)(?!<token>)[A-Za-z0-9._~+/=-]{16,}/g
]

/** Every token-shaped string of `text`, replaced by `<token>`. */
export function scrubTokens(text: string): string {
  return TOKEN_SHAPES.reduce((scrubbed, pattern) => scrubbed.replace(pattern, TOKEN), text)
}

/** Whether `text` holds a token-shaped string. */
export const holdsToken = (text: string): boolean => TOKEN_SHAPES.some((pattern) => new RegExp(pattern.source, pattern.flags).test(text))
