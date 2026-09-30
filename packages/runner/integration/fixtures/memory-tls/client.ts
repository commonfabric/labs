/** A fresh process whose memory sockets trust the fixture's TLS certificate. */

import { expect } from "@std/expect";
// @ts-types="@types/ws"
import { WebSocket as NodeWebSocket } from "ws";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../../../src/index.ts";
import { StorageManager } from "../../../src/storage/cache.deno.ts";
import { createMemorySocket } from "../../../src/storage/memory-socket.ts";

const secureHost = new URL(Deno.args[0]);
const plainHost = new URL(Deno.args[1]);

for (
  const [host, protocol, backend] of [
    [secureHost, "wss:", NodeWebSocket],
    [plainHost, "ws:", WebSocket],
  ] as const
) {
  const address = new URL(host);
  address.protocol = protocol;
  const { socket } = createMemorySocket(address);
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", (event) => reject(event.error), {
      once: true,
    });
  });
  try {
    await opened;
    expect(socket, `${protocol} socket backend`).toBeInstanceOf(backend);
    expect(socket).toHaveProperty("binaryType", "arraybuffer");
  } finally {
    socket.close();
    await closed;
  }
}

const identity = await Identity.fromPassphrase("memory socket TLS integration");
const createRuntime = () =>
  new Runtime({
    apiUrl: secureHost,
    // This memory host has no executor; each runtime executes locally.
    storageManager: StorageManager.open({
      as: identity,
      memoryHost: secureHost,
    }),
  });
const schema = {
  type: "object",
  properties: { body: { type: "string" }, version: { type: "number" } },
  required: ["body", "version"],
} as const;
const body = Array.from(
  { length: 65_536 },
  (_, i) => `${i.toString(16).padStart(6, "0")}:abcdefghijklmnopqrstuvwxyz\n`,
).join("");
const verified = [];
const writer = createRuntime();
try {
  const cell = writer.getCell(identity.did(), "tls-persistence", schema);
  await cell.sync();
  if (!writer.storageManager.setMessageCompressionEnabled) {
    throw new Error("Remote storage must support compression controls");
  }
  for (
    const [version, compressed] of [[1, true], [2, false], [3, true]] as const
  ) {
    await writer.storageManager.setMessageCompressionEnabled(compressed);
    // Change the large field each time so every mode sends its contents.
    const value = { body: `${body}${version}`, version };
    const tx = writer.edit();
    cell.withTx(tx).set(value);
    await tx.commit();
    await writer.storageManager.synced();
    const reader = createRuntime();
    try {
      const restored = reader.getCell(
        identity.did(),
        "tls-persistence",
        schema,
      );
      await restored.sync();
      await reader.storageManager.synced();
      expect(restored.get()).toEqual(value);
      verified.push({ version, compressed });
    } finally {
      await reader.dispose();
    }
  }
} finally {
  await writer.dispose();
}
console.log(JSON.stringify(verified));
