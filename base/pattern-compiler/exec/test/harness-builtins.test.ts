import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";

import { type Artifact, Instance } from "../executor.ts";

/** The pattern `Stamped` of `compare/fixtures/harness-builtins.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/harness-builtins.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "Stamped")!;
};

const BUILTINS = {
  currentPrincipal: () => "did:key:ada",
  FabricEpochNsec,
};

/** What the result holds as `held`, read through the reference to it. */
const heldBy = (instance: Instance): unknown => {
  const { held } = instance.result() as { held: unknown };
  return held;
};

describe("a handler that calls built-ins the executor is handed", () => {
  it("stores what the built-in answers, and a time of the data model as it is", async () => {
    const instance = new Instance(await artifact(), {}, {
      builtins: BUILTINS,
    });
    const [stream] = instance.streams();

    const outcome = instance.send(stream.binding, { nsec: 7 });

    expect(outcome.committed).toBe(true);
    const held = heldBy(instance) as { by: string; at: FabricEpochNsec };
    expect(held.by).toBe("did:key:ada");
    expect(held.at).toBeInstanceOf(FabricEpochNsec);
    expect(held.at.value).toBe(7n);
  });

  it("refuses the event where the built-in is not handed", async () => {
    const instance = new Instance(await artifact(), {}, {});
    const [stream] = instance.streams();

    const outcome = instance.send(stream.binding, { nsec: 7 });

    expect(outcome.committed).toBe(false);
    expect(heldBy(instance)).toEqual({});
  });
});
