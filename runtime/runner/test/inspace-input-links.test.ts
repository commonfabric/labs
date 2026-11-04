import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";

import type { PatternFactory } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

/** Where the child the parent creates is placed. */
type Placement = { target: MemorySpace } | "parent's space";

/** Which cell of the parent is handed to the child. */
type Handed = "input" | "derived";

/** What creates the child, and where the handed cell goes in its argument. */
type Shape = {
  /**
   * What creates the child: the parent's handler, when sent an event, or a
   * `lift()` in the parent's body. Defaults to `handler`.
   */
  creator?: "handler" | "lift";

  /**
   * Where the handed cell goes: as `topic` in the child's argument, nested
   * one object deeper as `wrap.topic`, or as the whole argument. Defaults to
   * `topic`.
   */
  position?: "topic" | "nested" | "whole";
};

/** A parent and the child it creates. */
type Family = {
  /** The parent, whose argument holds `topic`. */
  parent: Cell<unknown>;

  /** The child the parent creates, whose result holds `topic`. */
  child: Cell<{ topic: string }>;
};

/**
 * Runs, in `home`, a parent whose argument holds `topic`. The parent creates a
 * child, placed by `placement` and shaped as the last argument says, and hands
 * it the cell `handed` names: the parent's own input, or a cell the parent
 * derives from it. When a handler creates the child, this sends it an event.
 */
async function createChild(
  runtime: Runtime,
  home: MemorySpace,
  placement: Placement,
  handed: Handed,
  { creator = "handler", position = "topic" }: Shape = {},
): Promise<Family> {
  const { handler, lift, pattern } = createTrustedBuilder(runtime)
    .commonfabric;
  const place = <T, R>(factory: PatternFactory<T, R>) =>
    placement === "parent's space"
      ? factory
      : factory.inSpace(placement.target);
  const Child = pattern<{ topic: string }>(({ topic }) => ({ topic }));
  const Wrapped = pattern<{ wrap: { topic: string } }>(({ wrap }) => ({
    topic: wrap.topic,
  }));
  const Whole = pattern<string>((topic) => ({ topic }));
  const spawn = (topic: Cell<string>) => {
    switch (position) {
      case "topic":
        return place(Child)({ topic });
      case "nested":
        return place(Wrapped)({ wrap: { topic } });
      case "whole":
        return place(Whole)(topic);
    }
  };
  const create = handler<
    Record<string, never>,
    { topic: Cell<string>; room: Cell<unknown> }
  >(
    { type: "object" },
    {
      type: "object",
      properties: {
        topic: { type: "string", asCell: ["cell"] },
        room: { asCell: ["cell"] },
      },
      required: ["topic", "room"],
    },
    (_event, { topic, room }) => {
      room.set(spawn(topic));
    },
  );
  const make = lift(
    ({ topic }: { topic: Cell<string> }) => spawn(topic),
    {
      type: "object",
      properties: { topic: { type: "string", asCell: ["cell"] } },
      required: ["topic"],
    },
  );
  const shout = lift((topic: string) => `${topic}!`);
  const Parent = pattern<{ topic: string; room: Cell<unknown> }>(
    ({ topic, room }) => {
      const given = handed === "input" ? topic : shout(topic);
      return creator === "handler"
        ? { create: create({ topic: given, room }) }
        : { child: make({ topic: given }) };
    },
    {
      type: "object",
      properties: {
        topic: { type: "string" },
        room: { asCell: ["cell"] },
      },
      required: ["topic", "room"],
    },
  );
  const tx = runtime.edit();
  const room = runtime.getCell(home, "room-reference", undefined, tx);
  const root = runtime.getCell(home, "parent", undefined, tx);
  const result = runtime.run(
    tx,
    Parent,
    { topic: "lunch", room },
    root,
  );
  runtime.prepareTxForCommit(tx);
  expect((await tx.commit().settled).error).toBeUndefined();
  await runtime.idle();
  await result.pull();
  if (creator === "handler") {
    result.key("create").send({});
    await runtime.idle();
  }
  await runtime.storageManager.synced();
  const holder = creator === "handler" ? room : result.key("child");
  await holder.pull();
  return {
    parent: result,
    child: holder.resolveAsCell() as Cell<{ topic: string }>,
  };
}

/**
 * Runs `body` against a runtime acting for a principal whose home space is
 * the first argument it gets, beside a second space the principal may write.
 */
async function withRuntime(
  body: (
    runtime: Runtime,
    home: MemorySpace,
    other: MemorySpace,
  ) => Promise<void>,
): Promise<void> {
  const creator = await Identity.fromPassphrase("inspace-input-links-home");
  const other = (await Identity.fromPassphrase("inspace-input-links-room"))
    .did();
  const storage = EmulatedStorageManager.emulate({ as: creator });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    await body(runtime, creator.did(), other);
  } finally {
    await runtime.dispose();
    await storage.close();
  }
}

describe("inspace-input-links", () => {
  // A handler or a `lift()` running in one space creates a child with
  // `inSpace()` in another, and hands it a cell of its own space as an
  // argument. The stored link is what the assertions on it read:
  // `parseLink()` fills a link's missing space from the document holding it,
  // so a link that names no space reads as one into the child's space.

  describe("a child in another space", () => {
    it("stores, in its argument, a link into the space of the parent's input", async () => {
      await withRuntime(async (runtime, home, other) => {
        const { child } = await createChild(
          runtime,
          home,
          { target: other },
          "input",
        );
        expect(child.space).toBe(other);
        const argument = child.getArgumentCell<{ topic: string }>()!;
        const link = parseLink(argument.key("topic").getRaw(), argument);
        expect(link?.space).toBe(home);
      });
    });

    it("reads the parent's input", async () => {
      await withRuntime(async (runtime, home, other) => {
        const { child } = await createChild(
          runtime,
          home,
          { target: other },
          "input",
        );
        expect(await child.key("topic").pull()).toBe("lunch");
      });
    });

    it("writes through to the parent's input", async () => {
      await withRuntime(async (runtime, home, other) => {
        const { parent, child } = await createChild(
          runtime,
          home,
          { target: other },
          "input",
        );
        const tx = runtime.edit();
        child.getArgumentCell<{ topic: string }>()!.key("topic").withTx(tx)
          .set("dinner");
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();
        const input = parent.getArgumentCell<{ topic: string }>()!;
        expect(await input.key("topic").pull()).toBe("dinner");
      });
    });

    it("reads a cell the parent derives", async () => {
      await withRuntime(async (runtime, home, other) => {
        const { child } = await createChild(
          runtime,
          home,
          { target: other },
          "derived",
        );
        expect(await child.key("topic").pull()).toBe("lunch!");
      });
    });

    it("reads the parent's input handed as its whole argument", async () => {
      await withRuntime(async (runtime, home, other) => {
        const { child } = await createChild(
          runtime,
          home,
          { target: other },
          "input",
          { position: "whole" },
        );
        expect(child.space).toBe(other);
        expect(await child.key("topic").pull()).toBe("lunch");
      });
    });

    it("reads the parent's input nested in its argument", async () => {
      await withRuntime(async (runtime, home, other) => {
        const { child } = await createChild(
          runtime,
          home,
          { target: other },
          "input",
          { position: "nested" },
        );
        expect(child.space).toBe(other);
        expect(await child.key("topic").pull()).toBe("lunch");
      });
    });

    it("reads the parent's input when a `lift()` creates it", async () => {
      await withRuntime(async (runtime, home, other) => {
        const { child } = await createChild(
          runtime,
          home,
          { target: other },
          "input",
          { creator: "lift" },
        );
        expect(child.space).toBe(other);
        expect(await child.key("topic").pull()).toBe("lunch");
      });
    });
  });

  describe("a child in the parent's space", () => {
    it("reads the parent's input", async () => {
      await withRuntime(async (runtime, home) => {
        const { child } = await createChild(
          runtime,
          home,
          "parent's space",
          "input",
        );
        expect(child.space).toBe(home);
        expect(await child.key("topic").pull()).toBe("lunch");
      });
    });
  });
});
