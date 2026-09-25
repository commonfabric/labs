/**
 * A handler receives runtime cells, and a cell carries the transaction it is
 * bound to. Every case here compiles an attacker pattern handed a victim
 * piece's cell, dispatches its handler, and has it try to set the
 * transaction's trust state: the implementation identity its writes are
 * authored by, or the acting principal. The victim's `name` may be written
 * only by the victim's own `setName` handler.
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";

await ensureCompilerStack();

const signer = await Identity.fromPassphrase(
  "runner-cfc-implementation-identity-authorization",
);
const space = signer.did();
const OTHER_PRINCIPAL =
  "did:key:z6MkotherOtherOtherOtherOtherOtherOtherOtherOth";

const VICTIM_FILE = "/packages/patterns/app/main.tsx";
const ATTACKER_FILE = "/attacker/main.tsx";

const victimProgram = (): RuntimeProgram => ({
  main: VICTIM_FILE,
  files: [{
    name: VICTIM_FILE,
    contents: [
      "/// <cts-enable />",
      "import {",
      "  handler,",
      "  pattern,",
      "  type Stream,",
      "  Writable,",
      "  WriteAuthorizedBy,",
      '} from "commonfabric";',
      "",
      "const setName = handler<",
      "  { name: string },",
      "  { name: Writable<string> }",
      ">((event, state) => {",
      '  state.name.set("set:" + event.name);',
      "});",
      "",
      "type Output = {",
      "  name: WriteAuthorizedBy<string, typeof setName>;",
      "  setName: Stream<{ name: string }>;",
      "};",
      "",
      "export default pattern<{ seed?: string }, Output>(() => {",
      "  const name = new Writable<",
      "    WriteAuthorizedBy<string, typeof setName>",
      '  >("initial").for("name");',
      "  return { name, setName: setName({ name }) };",
      "});",
    ].join("\n"),
  }],
});

const victimHandlerIdentity = {
  kind: "verified",
  moduleIdentity: computeModuleHashes(victimProgram()).get(VICTIM_FILE)!,
  sourceFile: VICTIM_FILE,
  bindingPath: ["setName"],
};

// The attacker is handed the victim's `name` cell and a `note` of its own. Its
// handler runs `claim`, a function body that sees `tx`, the transaction the
// victim's cell is bound to. For an event whose `step` is `"probe"` it records
// in `note` what `claim` returned, or the name and message of what it threw,
// and writes nothing else, so that record commits whatever the claim did. For
// any other step it swallows what `claim` threw and writes the event's `value`
// into the victim's `name`.
const attackerProgram = (claim: string): RuntimeProgram => ({
  main: ATTACKER_FILE,
  files: [{
    name: ATTACKER_FILE,
    contents: [
      "/// <cts-enable />",
      'import { handler, pattern, type Stream, Writable } from "commonfabric";',
      "",
      "type Event = { step: string; value?: string };",
      "",
      "const setName = handler<",
      "  Event,",
      "  { name: Writable<string>; note: Writable<string> }",
      ">((event, state) => {",
      "  const tx: any = (state.name as any).tx;",
      "  let outcome: string;",
      "  try {",
      "    outcome = String((() => {",
      claim,
      "    })());",
      "  } catch (error) {",
      "    outcome = 'threw ' + (error as Error).name + ': ' +",
      "      (error as Error).message;",
      "  }",
      "  if (event.step === 'probe') state.note.set(outcome);",
      "  else state.name.set(event.value ?? '');",
      "});",
      "",
      "export default pattern<",
      "  { name: Writable<string>; note: Writable<string> },",
      "  { setName: Stream<Event> }",
      ">(({ name, note }) => ({ setName: setName({ name, note }) }));",
    ].join("\n"),
  }],
});

describe("cfc-implementation-identity-authorization", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const runVictim = async () => {
    const victimPattern = await runtime.patternManager.compilePattern(
      victimProgram(),
      { space },
    );
    // deno-lint-ignore no-explicit-any
    const victim = runtime.getCell<any>(
      space,
      `victim-${crypto.randomUUID()}`,
      victimPattern.resultSchema,
    ) as Cell<any>;
    await runtime.runSynced(victim, victimPattern, {});
    await runtime.idle();
    return victim;
  };

  const runAttacker = async (claim: string) => {
    const victim = await runVictim();
    const attackerPattern = await runtime.patternManager.compilePattern(
      attackerProgram(claim),
      { space },
    );
    // deno-lint-ignore no-explicit-any
    const attacker = runtime.getCell<any>(
      space,
      `attacker-${crypto.randomUUID()}`,
      attackerPattern.resultSchema,
    ) as Cell<any>;
    const note = runtime.getCell<string>(
      space,
      `note-${crypto.randomUUID()}`,
      { type: "string" },
    );
    await runtime.runSynced(attacker, attackerPattern, {
      name: victim.key("name"),
      note,
    });
    await runtime.idle();
    const send = async (event: Record<string, unknown>) => {
      await runtime.editWithRetry((tx) =>
        attacker.key("setName").withTx(tx).send(event)
      );
      await runtime.idle();
    };
    return {
      victim,
      probe: async () => {
        await send({ step: "probe" });
        return await note.pull();
      },
      write: (value: string) => send({ step: "write", value }),
    };
  };

  it("keeps the declared handler's writes verified", async () => {
    const victim = await runVictim();

    await runtime.editWithRetry((tx) =>
      victim.key("setName").withTx(tx).send({ name: "owner" })
    );
    await runtime.idle();

    expect(await victim.key("name").pull()).toBe("set:owner");
  });

  describe("a handler holding a cell", () => {
    it("cannot claim another handler's verified identity through the cell's transaction", async () => {
      const attack = await runAttacker(
        `tx.setCfcImplementationIdentity(${
          JSON.stringify(victimHandlerIdentity)
        }); return 'claimed';`,
      );

      expect(await attack.probe()).toBe(
        "threw TypeError: tx.setCfcImplementationIdentity is not a function",
      );
      await attack.write("overwritten");
      expect(await attack.victim.key("name").pull()).toBe("initial");
    });

    it("cannot claim a builtin identity through the cell's transaction", async () => {
      const attack = await runAttacker(
        "tx.setCfcImplementationIdentity(" +
          "{ kind: 'builtin', builtinId: 'generateObject' });" +
          " return tx.getCfcState().implementationIdentity?.kind;",
      );

      expect(await attack.probe()).toBe(
        "threw TypeError: tx.setCfcImplementationIdentity is not a function",
      );
    });

    it("cannot name the acting principal through the cell's transaction", async () => {
      const attack = await runAttacker(
        "tx.setCfcTrustSnapshot(" +
          `{ id: "claimed", actingPrincipal: "${OTHER_PRINCIPAL}" });` +
          " return tx.getCfcState().trustSnapshot?.actingPrincipal;",
      );

      expect(await attack.probe()).toBe(
        "threw TypeError: tx.setCfcTrustSnapshot is not a function",
      );
    });
  });
});
