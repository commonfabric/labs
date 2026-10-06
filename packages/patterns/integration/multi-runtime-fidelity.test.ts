/**
 * The multi-runtime harness carries a `FabricValue` whole, in both directions.
 *
 * Each runtime lives in its own worker realm, so every command and every
 * answer crosses `postMessage`. Both cross as a `codec-realm` encoding, which
 * is what lets a test write the whole `FabricValue` domain into a pattern and
 * read back what it wrote. The two cases below fail differently without it:
 * structured cloning strips a fabric instance to `{}` on the way in, and a
 * JSON round trip flattens a weird number on the way out.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { assert, assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { debugStr } from "@commonfabric/data-model";
import { isLinkRef } from "@commonfabric/data-model/cell-rep";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabric-value-echo",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");
const BYTES: (string | number)[] = ["bytes"];
const WEIRD: (string | number)[] = ["weird"];

const CONTENT = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

describe("multi-runtime harness value fidelity", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: ["fidelity-alice"],
    });
    [alice] = harness.sessions;
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("reads back a fabric instance written through a command", async () => {
    const written = await alice.set(BYTES, new FabricBytes(CONTENT));
    assert(written.ok, `set failed: ${written.error?.message}`);
    await harness.settle();

    const read = await alice.read(BYTES);
    assert(
      read instanceof FabricBytes,
      `read back ${
        (read as { constructor?: { name?: string } })?.constructor?.name ??
          String(read)
      }, not a FabricBytes`,
    );
    assertEquals(read.slice(), CONTENT);
  });

  it("carries a logger-count breakdown across the boundary", async () => {
    // Nothing else that runs calls this command -- `storm-driver.ts` and
    // `lunch-poll-diagnose.ts` are tools and the adoption bench is ignored --
    // so this is what stands between a breakdown the encoding refuses and a
    // diagnostic that fails only when someone reaches for it.
    const counts = await alice.loggerCounts();
    assert(
      typeof counts.total === "number",
      debugStr`no total in $quote,long${counts}`,
    );
    assert(
      Object.keys(counts).length > 1,
      "a breakdown naming no logger at all",
    );
  });

  it("reads a whole result, with a link where the schema says cell", async () => {
    // A schema-aware read hands back a live `Cell` at every `asCell`
    // location, and a cell belongs to the runtime's own realm. `setWeird` is
    // a stream, which is one such location; a pattern's `[UI]` tree is full of
    // them. Reading the whole result at all is half the assertion.
    await alice.send("setWeird", { weird: 41 });
    await harness.settle();

    const whole = await alice.read() as Record<string, unknown>;
    assertEquals(
      whole.weird,
      41,
      debugStr`weird came back as $quote${whole.weird}`,
    );
    assert(
      isLinkRef(whole.setWeird),
      debugStr`setWeird came back as $quote,long${whole.setWeird}, ` +
        "not the link that reaches it",
    );
    // The containers around it stay containers: the same read annotates each
    // one with the cell it came from, and an annotation is not a cell the
    // schema asked for.
    assert(
      isObjectNotArray(whole.$UI) && whole.$UI.name === "div",
      debugStr`the view came back as $quote,long${whole.$UI}`,
    );
  });

  it("reads back a weird number as itself", async () => {
    // `-0` and `NaN` are the two a JSON round trip cannot represent: it writes
    // the first as `0` and the second as `null`. Named rather than
    // stringified, since `String(-0)` is `"0"` and would report a failure as
    // reading back what was written.
    for (const [name, weird] of [["-0", -0], ["NaN", NaN]] as const) {
      const written = await alice.set(WEIRD, weird);
      assert(written.ok, `set failed: ${written.error?.message}`);
      await harness.settle();

      const read = await alice.read(WEIRD);
      assert(
        Object.is(read, weird),
        `${name}: read back ${Object.is(read, -0) ? "-0" : String(read)}`,
      );
    }
  });
});

describe("multi-runtime harness identity fidelity", () => {
  let harness: MultiRuntimeHarness;

  beforeAll(async () => {
    // Every other harness test asks for `implementation: "noble"`, whose key
    // pair holds material. The default holds handles instead, and that is the
    // arm a realm boundary cannot carry as anything but a `FabricKeyPair`.
    const identity = await Identity.fromPassphrase("fidelity-native");
    assert(
      !identity.keyPair.hasMaterial,
      "the default implementation stopped producing key handles, so this " +
        "test no longer covers the arm it names",
    );

    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [{ label: "native", identity }],
    });
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("starts a runtime from an identity holding key handles", async () => {
    // Reaching a read at all is the assertion: the session's runtime only
    // exists if its worker rebuilt the identity from what crossed, and a
    // `CryptoKey` reduced to `{}` on the way would have failed `init`.
    const session = harness.sessions[0];
    assertEquals(await session.read(["weird"]), 0);

    const written = await session.set(["weird"], 7);
    assert(written.ok, `set failed: ${written.error?.message}`);
    await harness.settle();
    assertEquals(await session.read(["weird"]), 7);
  });
});
