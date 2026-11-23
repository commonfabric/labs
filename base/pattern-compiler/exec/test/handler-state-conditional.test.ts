import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";
import { Ref } from "../store.ts";

/** The pattern `Bound` of `compare/fixtures/handler-state-conditional.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/handler-state-conditional.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "Bound")!;
};

/** An instance whose counter is a document of its own. */
const started = async (own: boolean) => {
  const instance = new Instance(
    await artifact(),
    { own, counter: { $link: { doc: "counter", path: [] } } },
    { documents: [{ id: "counter", kind: "counter", value: { n: 0 } }] },
  );
  const [stream] = instance.streams();
  return { instance, binding: stream.binding };
};

describe("a handler whose state holds a conditional written at the binding", () => {
  it("writes through the cell the conditional gives", async () => {
    const { instance, binding } = await started(false);

    const outcome = instance.send(binding, {});

    expect(outcome.committed).toBe(true);
    expect(instance.store.read(new Ref("counter", []))).toEqual({ n: 1 });
  });

  it("is bound to nothing where the conditional gives `undefined`", async () => {
    const { instance, binding } = await started(true);

    const outcome = instance.send(binding, {});

    expect(outcome.committed).toBe(true);
    expect(instance.store.read(new Ref("counter", []))).toEqual({ n: 0 });
  });
});
