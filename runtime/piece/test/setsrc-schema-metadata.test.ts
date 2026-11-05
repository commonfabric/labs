import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { type FabricValue, valueEqual } from "@commonfabric/data-model";
import { createSession, Identity } from "@commonfabric/identity";
import { NAME, Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("setsrc schema metadata tests");

/** Packages a source-backed contract fixture. */
function program(contents: string): RuntimeProgram {
  return { main: "/main.tsx", files: [{ name: "/main.tsx", contents }] };
}

/** Publishes a defaulted display name with a producer-owned description. */
function producerProgram(): RuntimeProgram {
  return program(`
    import { Default, NAME, pattern } from "commonfabric";
    interface Output {
      /** The producer's display name. */
      [NAME]: string | Default<""> | undefined;
    }
    export default pattern<Record<string, never>, Output>(() => ({
      [NAME]: "Retained topic",
    }));
  `);
}

/** Declares a member projection independently of its producer's prose. */
function consumerProgram(version: number, extra = ""): RuntimeProgram {
  return program(`
    import { Default, lift, NAME, pattern, Writable } from "commonfabric";
    interface Row {
      /** The consumer's display name, revision ${version}. */
      [NAME]: string | Default<""> | undefined;
      ${extra}
    }
    interface Input { members: Writable<Row[] | Default<[]>>; }
    const label = lift((rows: Row[]) => rows[0]?.[NAME] ?? "empty");
    export default pattern<Input, { label: string; version: number }>(
      ({ members }) => ({ label: label(members), version: ${version} }),
    );
  `);
}

describe("setsrc schema metadata", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: await runtime.createSpace(),
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  /** Seeds a legacy retained link without depending on current link admission. */
  async function retainedMember() {
    const producer = await pieces.create(producerProgram(), { input: {} });
    const consumer = await pieces.create(consumerProgram(1), { input: {} });
    const input = pieces.getArgument(consumer.getCell()).asSchema<FabricValue>(
      undefined,
    );
    const { error } = await runtime.editWithRetry((tx) => {
      input.withTx(tx).setRawUntyped({
        members: [producer.getCell().getAsLink()],
      });
    });
    expect(error).toBeUndefined();
    return { producer, consumer, input };
  }

  it("checks and applies an update that changes only retained demand prose", async () => {
    const { producer, consumer, input } = await retainedMember();
    const original = input.getRaw();
    const candidate = consumerProgram(2);

    const check = await consumer.checkPattern(candidate);
    expect(check.compatible).toBe(true);
    expect(check.issues).toEqual({});
    expect(valueEqual(input.getRaw(), original)).toBe(true);

    await consumer.setPattern(candidate);
    expect(await consumer.result.get()).toEqual({
      label: "Retained topic",
      version: 2,
    });
    expect(valueEqual(input.getRaw(), original)).toBe(true);
    expect(await producer.result.get([NAME])).toBe("Retained topic");
  });

  it("admits an unknown optional demand and refuses a typed narrowing", async () => {
    const { consumer, input } = await retainedMember();
    const original = input.getRaw();
    const typed = consumerProgram(2, "extra?: string;");
    const check = await consumer.checkPattern(typed);
    expect(check.compatible).toBe(false);
    expect(check.issues.retainedLinks).toContain("members.0.extra");
    await expect(consumer.setPattern(typed)).rejects.toThrow("members.0.extra");
    expect(await consumer.result.get(["version"])).toBe(1);

    const unconstrained = consumerProgram(2, "extra?: unknown;");
    expect((await consumer.checkPattern(unconstrained)).compatible).toBe(true);
    await consumer.setPattern(unconstrained);
    expect(await consumer.result.get(["version"])).toBe(2);
    expect(valueEqual(input.getRaw(), original)).toBe(true);
  });
});
