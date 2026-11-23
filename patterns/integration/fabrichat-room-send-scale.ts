/**
 * Measures a send into a FabriChat room on the runtime as it runs patterns
 * today, for a comparison with the compiled path
 * (`base/pattern-compiler/compare/fabrichat/scale.ts`): the room of
 * `../system/fabrichat/room.tsx`, with the labels and the write policies it
 * declares, in one person's runtime in a Deno worker on an in-process
 * storage server. No toolshed and no browser.
 *
 * `deno run -A --no-check patterns/integration/fabrichat-room-send-scale.ts [sizes]`
 *
 * Run from the repository root. `sizes` is a list of numbers of messages
 * separated by commas, `10,100,1000` by default. For each size the script
 * prints one line of JSON per step:
 *
 * - `start`: the harness is made, the person's home lists a profile, and
 *   the person's runtime has run the room.
 * - `seed`: `sendMessage` is sent an event, and the harness settled, until
 *   the room holds the size, or until ten minutes have passed, in which
 *   case the step says how many messages the room holds.
 * - `send`: three more events, each timed until the harness has settled.
 * - `read`: for how many messages the result holds the reader's rights,
 *   and the text of the last.
 *
 * `SCALE_SERVER_EXECUTION=on` runs the room under server execution; the
 * default runs it in the person's runtime.
 */

import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-room-profile-wish",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

// The reviewed action a send is admitted from, as
// `../system/fabrichat/schemas.tsx` names it.
const SEND_ACTION = { surface: "ChatSendSurface", action: "ChatSend" };

/** The longest the sends that fill a room may take, in milliseconds. */
const SEED_BUDGET_MS = 10 * 60 * 1000;

const print = (step: Record<string, unknown>) =>
  console.log(JSON.stringify(step));

const serverExecution = Deno.env.get("SCALE_SERVER_EXECUTION") === "on";
const cfc = { experimental: { serverExecution } };

for (const size of (Deno.args[0] ?? "10,100,1000").split(",").map(Number)) {
  const base = {
    arm: "today",
    pattern: "FabriChatRoom",
    size,
    serverExecution,
  };
  let began = performance.now();
  const person = await Identity.fromPassphrase(
    `fabrichat-room-send-scale-${size}`,
    { implementation: "noble" },
  );
  const harness = await MultiRuntimeHarness.create({
    programPath: PROGRAM_PATH,
    rootPath: ROOT_PATH,
    sessions: [{ label: "setup", identity: person, cfc }],
  });
  try {
    const [setup] = harness.sessions;
    const profile = await setup.createOwnProfile("Sender");
    await setup.send("holdProfile", { profile });
    await harness.settle();
    await setup.client().call("selectProfile", { path: ["profile"] });
    await harness.settle();
    const sender = await harness.addSession({
      label: "sender",
      identity: person,
      cfc,
    });
    await harness.settle();
    const canSend = await sender.read(["canSend"]);
    print({ ...base, step: "start", ms: performance.now() - began, canSend });

    began = performance.now();
    let held = 0;
    while (held < size && performance.now() - began < SEED_BUDGET_MS) {
      await sender.send(
        "sendMessage",
        { body: `message ${held}` },
        SEND_ACTION,
      );
      await harness.settle();
      held += 1;
    }
    print({ ...base, step: "seed", ms: performance.now() - began, held });

    for (let index = 0; index < 3; index++) {
      began = performance.now();
      await sender.send("sendMessage", { body: `timed ${index}` }, SEND_ACTION);
      await harness.settle();
      print({ ...base, step: "send", ms: performance.now() - began, held });
    }

    began = performance.now();
    const rights = await sender.read(["messageRights", "length"]) as number;
    const last = await sender.read([
      "messageRights",
      rights - 1,
      "message",
      "body",
    ]);
    print({
      ...base,
      step: "read",
      ms: performance.now() - began,
      rights,
      last,
    });
  } finally {
    await harness.dispose();
  }
}
