/** Controlled independent writer whose transaction waits for an explicit release. */

import { Database } from "@db/sqlite";
import { InboxStore } from "../../inbox-store.ts";

const [path, operation] = Deno.args;
const store = new InboxStore(path);
const recipient = "did:key:lock-recipient";
console.log("ready");
await Deno.stdin.read(new Uint8Array(1));
if (operation === "hold") {
  const close = Database.prototype.close;
  Database.prototype.close = function (...args) {
    console.log("closing");
    Deno.stdin.readSync(new Uint8Array(1));
    return close.apply(this, args);
  };
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (...args) {
    const statement = prepare.apply(this, args);
    if (args[0].startsWith("INSERT INTO inbox_messages")) {
      const run = statement.run.bind(statement);
      statement.run = (...values) => {
        console.log("holding");
        Deno.stdin.readSync(new Uint8Array(1));
        return run(...values);
      };
    }
    return statement;
  };
}
try {
  if (operation !== "hold") console.log("writing");
  if (operation === "enable") store.enable("did:key:new-recipient");
  else if (operation === "acknowledge") {
    store.acknowledge(recipient, {
      senderDid: recipient,
      operationId: "pending",
    });
  } else {
    store.send(recipient, {
      recipientDid: recipient,
      operationId: operation,
      payload: operation,
    });
  }
  console.log("committed");
} catch {
  console.log("refused");
} finally {
  store.close();
}
