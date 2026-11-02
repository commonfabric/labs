import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { SpaceDeletedFunction } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { spaceDeleted } from "../../src/builder/space-access.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";
import {
  refusingServer,
  type SpaceRefusal,
} from "../support/refusing-server.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("space-deleted signer");
const home = signer.did() as MemorySpace;

/** Returns the DID of a space of its own, named by `name`. */
async function spaceNamed(name: string): Promise<MemorySpace> {
  return (await Identity.fromPassphrase(`space-deleted ${name}`))
    .did() as MemorySpace;
}

describe("spaceDeleted()", () => {
  let server: MemoryV2Server.Server;
  let refuse: (space: string, refusal: SpaceRefusal) => void;
  let runtime: Runtime;

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const refusing = refusingServer(server);
    refuse = refusing.refuse;
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(
        refusing.server as MemoryV2Server.Server,
        { as: signer },
      ),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await server.close();
  });

  /**
   * Calls `spaceDeleted()` on `target` as code in a `kind` frame of the home
   * space would, and returns what it returns.
   */
  const callIn = (
    kind: "lift" | "handler",
    target: unknown,
  ): { answer: ReturnType<typeof spaceDeleted> } => {
    const frame = pushFrame({
      runtime,
      tx: runtime.edit(),
      space: home,
      frameKind: kind,
    });
    try {
      return { answer: spaceDeleted(target) };
    } finally {
      popFrame(frame);
    }
  };

  /**
   * Runs, in the home space, a pattern whose computation `answer` returns
   * what `spaceDeleted()` returns for the space `target` names, as a string,
   * and returns the result cell.
   */
  const computedAnswer = async (
    target: MemorySpace,
  ): Promise<Cell<{ answer?: string }>> => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const inputSchema = {
      type: "object",
      properties: { target: { type: "string" } },
    } as const;
    const answer = lift(
      (input: { target?: string }) => String(spaceDeleted(input.target)),
      inputSchema,
      { type: "string" },
    );
    const answerPattern = pattern(
      ({ target }) => ({ answer: answer({ target }) }),
      inputSchema,
      { type: "object", properties: { answer: { type: "string" } } },
    );
    const tx = runtime.edit();
    const result = runtime.run(
      tx,
      answerPattern,
      { target },
      runtime.getCell(home, `space-deleted answer ${target}`, undefined, tx),
    );
    await tx.commit().settled;
    return result as Cell<{ answer?: string }>;
  };

  describe("in a reactive computation", () => {
    it("returns `undefined` until the memory server answers, then `true` for a deleted space", async () => {
      const gone = await spaceNamed("lift gone");
      refuse(gone, "deleted");
      expect(callIn("lift", gone)).toEqual({ answer: undefined });

      const answer = (await computedAnswer(gone)).key("answer");
      await waitForCellValue(runtime, answer, (v) => v === "true", {
        stuckLabel: "the deleted space's answer to arrive as `true`",
      });
    });

    it("returns `false` for a space the memory server admits the runtime to, and runs again with `true` once the space is deleted", async () => {
      const kept = await spaceNamed("lift kept");
      const answer = (await computedAnswer(kept)).key("answer");
      await waitForCellValue(runtime, answer, (v) => v === "false", {
        stuckLabel: "the admitted space's answer to arrive as `false`",
      });

      refuse(kept, "deleted");
      await waitForCellValue(runtime, answer, (v) => v === "true", {
        stuckLabel: "the answer to follow the deletion to `true`",
      });
    });

    it("leaves the computation's read scope as it is", () => {
      const tx = runtime.edit();
      const before = tx.getNarrowestReadScope();
      const frame = pushFrame({ runtime, tx, space: home, frameKind: "lift" });
      try {
        spaceDeleted(home);
      } finally {
        popFrame(frame);
      }
      expect(tx.getNarrowestReadScope()).toBe(before);
    });
  });

  describe("on a cell", () => {
    it("returns the answer for the space the cell's value lives in", async () => {
      const gone = await spaceNamed("cell gone");
      refuse(gone, "deleted");
      await runtime.storageManager.awaitSpaceAnswer!(gone);
      await runtime.storageManager.awaitSpaceAnswer!(home);

      const cell = runtime.getCell<unknown>(gone, "space-deleted cell");
      expect(callIn("lift", cell).answer).toBe(true);
      expect(callIn("lift", runtime.getCell<unknown>(home, "here")).answer)
        .toBe(false);
    });
  });

  it("returns `undefined`, recording nothing, where no memory server answers for the space", async () => {
    const supplied = await spaceNamed("store supplied");
    runtime.storageManager.installStoreReadThrough?.(supplied, () => undefined);
    expect(callIn("handler", supplied)).toEqual({ answer: undefined });
    expect(callIn("lift", supplied).answer).toBeUndefined();
  });

  it("returns `undefined` for a target passed as `undefined`", () => {
    expect(callIn("handler", undefined)).toEqual({ answer: undefined });
  });

  it("throws when called without a `target`", () => {
    const frame = pushFrame({
      runtime,
      tx: runtime.edit(),
      space: home,
      frameKind: "lift",
    });
    try {
      // The declared type refuses this call; the runtime check is for callers
      // the compiler never saw.
      const declared: SpaceDeletedFunction = spaceDeleted;
      // @ts-expect-error: `target` is required.
      expect(() => declared()).toThrow("requires a `target`");
    } finally {
      popFrame(frame);
    }
  });

  it("throws for a string target that is not a well-formed DID", () => {
    expect(() => callIn("lift", "not a did")).toThrow(
      "takes a cell or a space's DID",
    );
  });

  it("throws for a target that is neither a cell nor a string", () => {
    expect(() => callIn("lift", { space: home })).toThrow(
      "takes a cell as its target",
    );
  });

  it("throws in a pattern body", () => {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    expect(() =>
      pattern(() => {
        spaceDeleted(undefined);
        return {};
      })
    ).toThrow("can only be called from a handler or a reactive computation");
  });
});
