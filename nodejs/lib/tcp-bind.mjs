// Binds a listening TCP socket synchronously, as `Deno.listen()` and
// `Deno.serve()` do: the port is known (and an `EADDRINUSE` thrown) before the
// call returns. Node's `server.listen()` binds on a later tick, so this goes
// through the `tcp_wrap` binding and hands the bound handle to `listen()`.

import * as net from "node:net";
import { getSystemErrorName } from "node:util";

const { TCP, constants } = process.binding("tcp_wrap");

/** Deno's error class for a bind failure's system error name. */
function bindError(code, hostname, port) {
  const message = `${getSystemErrorName(code)}: bind ${hostname}:${port}`;
  const errors = globalThis.Deno?.errors ?? {};
  const Class = {
    EADDRINUSE: errors.AddrInUse,
    EADDRNOTAVAIL: errors.AddrNotAvailable,
    EACCES: errors.PermissionDenied,
    EPERM: errors.PermissionDenied,
  }[getSystemErrorName(code)] ?? Error;
  return new Class(message);
}

/**
 * Binds `hostname` (an IP address, or `localhost`) and `port` (0 for any).
 * Returns the bound handle, for `server.listen(handle)`, and its port.
 */
export function bindTcpSync(hostname, port) {
  const address = hostname === "localhost" ? "127.0.0.1" : hostname;
  const family = net.isIP(address);
  if (family === 0) {
    throw new TypeError(`Not an IP address: ${hostname}`);
  }
  const handle = new TCP(constants.SERVER);
  const code = family === 6
    ? handle.bind6(address, port, 0)
    : handle.bind(address, port);
  if (code !== 0) {
    handle.close();
    throw bindError(code, hostname, port);
  }
  const out = {};
  handle.getsockname(out);
  return { handle, port: out.port };
}
