/**
 * A TCP port on `127.0.0.1` that was free when this returned: it binds port
 * 0, reads the port the system chose, and releases it.
 */
export function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr;
  listener.close();
  return port;
}
