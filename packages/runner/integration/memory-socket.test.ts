/** Exercises the memory client through a certificate-validated TLS proxy. */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";

const fixtures = new URL("./fixtures/memory-tls/", import.meta.url);

describe("memory-socket", () => {
  it("selects the Deno TLS backend and persists large writes across compression changes", async () => {
    // TLS termination forwards bytes to the ordinary memory server, leaving
    // framing, compression, authorization, and commits to the real protocol.

    const memory = StandaloneMemoryServer.start();
    const connections = new Set<Deno.Conn>();
    const forwarding: Promise<void>[] = [];
    const failures: unknown[] = [];
    let listener: Deno.TlsListener | undefined;
    let accepting: Promise<void> | undefined;
    try {
      listener = Deno.listenTls({
        hostname: "127.0.0.1",
        port: 0,
        cert: await Deno.readTextFile(new URL("localhost.crt", fixtures)),
        key: await Deno.readTextFile(new URL("localhost.key", fixtures)),
      });
      const incoming = listener;
      accepting = (async () => {
        try {
          for await (const client of incoming) {
            connections.add(client);
            const forward = (async () => {
              const upstream = await Deno.connect({
                hostname: "127.0.0.1",
                port: Number(memory.url.port),
              });
              connections.add(upstream);
              // Closing either pipe can close the peer's socket while the
              // reverse pipe is still finishing its close handshake.
              await Promise.allSettled([
                client.readable.pipeTo(upstream.writable),
                upstream.readable.pipeTo(client.writable),
              ]);
              connections.delete(client);
              connections.delete(upstream);
            })();
            forwarding.push(forward.catch((error) => {
              failures.push(error);
            }));
          }
        } catch (error) {
          if (!(error instanceof Deno.errors.BadResource)) failures.push(error);
        }
      })();
      // Trust is configured at process startup. The child uses the production
      // factory with this certificate added to its trust roots.
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--cert",
          fromFileUrl(new URL("localhost.crt", fixtures)),
          fromFileUrl(new URL("client.ts", fixtures)),
          `https://127.0.0.1:${listener.addr.port}/`,
          memory.url.href,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      expect(result.code, new TextDecoder().decode(result.stderr)).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual([
        { version: 1, compressed: true },
        { version: 2, compressed: false },
        { version: 3, compressed: true },
      ]);
    } finally {
      listener?.close();
      await accepting;
      for (const connection of connections) {
        try {
          connection.close();
        } catch (error) {
          if (!(error instanceof Deno.errors.BadResource)) failures.push(error);
        }
      }
      await Promise.all(forwarding);
      await memory.close();
    }
    expect(failures).toEqual([]);
  });
});
