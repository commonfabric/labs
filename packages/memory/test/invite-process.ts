/** Independent process boundary for invitation race and crash-recovery tests. */
import * as Engine from "../v2/engine.ts";
import { executeInvite, type InviteRequest } from "../v2/invites.ts";

const options = JSON.parse(Deno.args[0]) as {
  url: string;
  request: InviteRequest;
  mode: "normal" | "before-commit" | "after-commit";
};
const engine = await Engine.open({ url: new URL(options.url) });
if (options.mode === "before-commit") {
  engine.database.function("crash_before_commit", () => {
    Deno.exit(73);
  });
  engine.database.exec(
    "CREATE TRIGGER crash_redemption AFTER INSERT ON space_invite_redemptions BEGIN SELECT crash_before_commit(); END",
  );
}
await Deno.stdout.write(new TextEncoder().encode("ready\n"));
await Deno.stdin.read(new Uint8Array(1));
try {
  const result = executeInvite(engine, options.request);
  if (options.mode === "after-commit") Deno.exit(74);
  console.log(JSON.stringify(result.result));
} catch (error) {
  console.log(
    JSON.stringify({
      error: error instanceof Error ? error.message : "failure",
    }),
  );
} finally {
  Engine.close(engine);
}
