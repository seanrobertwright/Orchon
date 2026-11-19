// The only hosts Orchon talks to: this computer's loopback address, by its three spellings.
// The settings parser, the client and discovery all ask here, so they cannot disagree.

/** The spellings as they stand in a URL, the IPv6 one in its brackets. */
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

/** Whether a URL's host, as written between `//` and the port, is this computer. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host.toLowerCase())
}
