// What a fixture or a log may never hold, checked after scrubbing: the developer's Claude login
// folder, their home folder, their account name, a string shaped like a key or a token, and an
// email address. The check names what it found and never repeats the text itself.
import { namePattern, pathPattern, type Machine } from './scrub.ts'
import { holdsToken } from './tokens.ts'

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

/**
 * Addresses no person owns: the recorder's own, the domains set aside for examples, and the
 * `git@` of an SSH remote.
 */
const isNobodys = (address: string): boolean => {
  const [local = '', domain = ''] = address.toLowerCase().split('@')
  return local === 'git' || domain.endsWith('.invalid') || /^example\.(?:com|org|net)$/.test(domain)
}

/** The machine's Claude config folder, home folder and account name. An empty one is not looked for. */
export type LeakRules = Pick<Machine, 'claudeConfig' | 'homeFolder' | 'user'>

/** Rules that look for no folder or name of a machine: only tokens and email addresses. */
export const NO_MACHINE: LeakRules = { claudeConfig: '', homeFolder: '', user: '' }

/** What `text` holds that it must not, in a fixed order. Empty when it is clean. */
export function findLeaks(text: string, rules: LeakRules): string[] {
  const found: string[] = []
  if (rules.claudeConfig !== '' && pathPattern(rules.claudeConfig).test(text)) found.push('the Claude login folder')
  if (rules.homeFolder !== '' && pathPattern(rules.homeFolder).test(text)) found.push('the home folder')
  if (rules.user !== '' && namePattern(rules.user).test(text)) found.push('the account name')
  if (holdsToken(text)) found.push('a token')
  if ([...text.matchAll(EMAIL)].some((match) => !isNobodys(match[0]))) found.push('an email address')
  return found
}
