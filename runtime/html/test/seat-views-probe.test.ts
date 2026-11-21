// Scratch probe for the seat-views spike. Not kept.
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import {
  ACLManager,
  type Cell,
  hostValueOf,
  readProjected,
  Runtime,
} from "@commonfabric/runner";
import {
  createRenderConfidentialityResolver,
  createRuntimeCfcModulePolicySource,
  createRuntimeListMembershipProvider,
} from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { readRefusal } from "../src/worker/display-fit.ts";
import type { RenderPolicy } from "../src/worker/types.ts";

const SOURCE = await Deno.readTextFile(
  Deno.env.get("SEAT_VIEWS_SOURCE") ?? new URL(
    "../../../patterns/examples/cfc-exchange-rules/seat-views.tsx",
    import.meta.url,
  ),
);

const MAIN = `/// <cts-enable />
import { pattern } from "commonfabric";
import Table, { peek } from "./seat-views.tsx";

export default pattern(() => {
  const own = Table({} as Parameters<typeof Table>[0]);
  return own;
});
`;

Deno.test("seat views probe", async () => {
  const alice = await Identity.fromPassphrase("seat views alice");
  const bob = await Identity.fromPassphrase("seat views bob");
  const carol = await Identity.fromPassphrase("seat views carol");
  const space = alice.did();
  const storageManager = StorageManager.emulate({ as: alice });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
  });
  const refusal = (cell: Cell<unknown>, viewer: string) => {
    const policy: RenderPolicy = {
      declassifyConfidentiality: [],
      maxConfidentiality: [cfcAtom.user(viewer)],
    };
    const resolveConfidentiality = createRenderConfidentialityResolver({
      actingPrincipal: viewer,
      memberSpaces: [space],
      modulePolicyResolver: createRuntimeCfcModulePolicySource(runtime).resolve,
      listMembershipProvider: createRuntimeListMembershipProvider(
        runtime,
        viewer,
      ),
    });
    const read = readProjected(cell, hostValueOf);
    return readRefusal(cell, [read.consumed], policy, {
      resolveConfidentiality,
    });
  };
  const errors: unknown[] = [];
  runtime.scheduler.onError((e: unknown) => {
    errors.push(e);
    console.log("SCHEDULER ERROR", String((e as Error)?.message ?? e));
  });
  try {
    await new ACLManager(runtime, space).set(space, "OWNER");
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [
        { name: "/main.tsx", contents: MAIN },
        { name: "/seat-views.tsx", contents: `/// <cts-enable />\n${SOURCE}` },
      ],
    }, { space, tx });
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "seat views table",
      undefined,
      tx,
    );
    runtime.run(tx, pattern, {}, result);
    runtime.prepareTxForCommit(tx);
    console.log("start commit", (await tx.commit().settled).error);
    await result.pull();
    await runtime.idle();

    const send = async (event: unknown) => {
      const sendTx = runtime.edit();
      // deno-lint-ignore no-explicit-any
      (result.withTx(sendTx) as any).key("move").send(event);
      const { error } = await sendTx.commit().settled;
      if (error) console.log("send error", error);
      await runtime.idle();
      await result.pull();
    };
    const cell = (...path: string[]) =>
      path.reduce(
        (at, key) => at.key(key as never) as Cell<unknown>,
        result as Cell<unknown>,
      );
    const dump = (label: string) => {
      console.log(`--- ${label}`);
      for (const name of ["view0", "view1", "view2"]) {
        console.log(name, JSON.stringify(cell(name).get()));
        for (
          const [who, id] of [["alice", alice], ["bob", bob], [
            "carol",
            carol,
          ]] as const
        ) {
          const r = refusal(cell(name), id.did());
          console.log(
            `  ${who}:`,
            r === undefined ? "RELEASED" : "refused",
          );
        }
      }
      for (const name of ["occupants0", "occupants1"]) {
        console.log(name, JSON.stringify(cell(name).get()));
      }
    };
    const labels = (name: string) => {
      const read = readProjected(cell(name), hostValueOf);
      console.log(`labels of ${name}:`, JSON.stringify(read.consumed, null, 1));
    };

    const listed = (name: string) => {
      const link = cell(name).getAsNormalizedFullLink();
      const pos = { space: link.space, id: link.id, path: [...link.path] };
      for (const [who, id] of [["alice", alice], ["bob", bob]] as const) {
        console.log(
          `listed ${name} ${who}`,
          createRuntimeListMembershipProvider(runtime, id.did()).listed(pos),
          JSON.stringify(pos),
        );
      }
    };
    await send({ kind: "setup" });
    dump("after setup");
    await send({ kind: "sit", seat: 0 });
    await send({ kind: "sit", seat: 1, occupant: bob.did() });
    dump("after sit");
    await send({ kind: "deal" });
    dump("after deal");
    listed("occupants0");
    listed("occupants1");
    console.log(
      "refusal view0 alice",
      JSON.stringify(refusal(cell("view0"), alice.did())),
    );
    console.log(
      "refusal view0.seat alice",
      JSON.stringify(refusal(cell("view0", "seat"), alice.did())),
    );
    labels("occupants0");
    console.log("errors", errors.length);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
