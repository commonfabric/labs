import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";

import { type Artifact, Instance } from "../executor.ts";

/** The pattern `Windowed` of `compare/fixtures/window.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL("../../compare/fixtures/window.emit.json", import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "Windowed")!;
};

type Item = { text: string; at: FabricEpochNsec };

/** An instance that holds `count` items, and the paths each change wrote. */
const filled = async (count: number) => {
  const instance = new Instance(await artifact(), {}, {
    builtins: { FabricEpochNsec },
  });
  const [stream] = instance.streams();
  const add = (index: number) =>
    instance.send(stream.binding, { text: `item ${index}`, nsec: index });
  for (let index = 0; index < count; index++) add(index);
  return { instance, add };
};

/** The paths of the result document written while `run` runs. */
const written = (instance: Instance, run: () => void): string[] => {
  const paths: string[] = [];
  const { onChange } = instance.store;
  instance.store.onChange = (change) => {
    if (change.doc === instance.id) paths.push(change.path.join("/"));
    onChange?.(change);
  };
  run();
  instance.store.onChange = onChange;
  return paths;
};

describe("a window of the newest records of a list", () => {
  it("holds the time of each record after the window moved by one", async () => {
    const { instance, add } = await filled(5);

    add(5);

    const { latest } = instance.result() as { latest: Item[] };
    expect(latest.map(({ text }) => text)).toEqual([
      "item 3",
      "item 4",
      "item 5",
    ]);
    expect(latest.map(({ at }) => at.value)).toEqual([3n, 4n, 5n]);
  });

  it("writes the window once where every position holds another record", async () => {
    const { instance, add } = await filled(5);

    const paths = written(instance, () => add(5));

    expect(paths).toEqual(["latest"]);
  });

  it("writes the one record added while the list is shorter than the window", async () => {
    const { instance, add } = await filled(1);

    const paths = written(instance, () => add(1));

    expect(paths).toEqual(["latest"]);
    expect((instance.result() as { latest: Item[] }).latest.length).toBe(2);
  });
});
