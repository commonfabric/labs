// Browser-safe loopback classification for normalized URL hostnames.

/** Whether a normalized URL hostname identifies a loopback destination. */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "localhost." ||
    hostname === "[::1]" ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname) ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
