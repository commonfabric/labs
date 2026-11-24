/**
 * @db/sqlite loads its libsqlite3 at import (env still default). Only then do we
 * point DENO_SQLITE_LOCAL at a build column-origin can't derive, so a labeled
 * read's ensureColumnOriginAvailable() fails while @db/sqlite itself keeps
 * working — the one situation the server's fail-loud branch guards.
 */

import { Server } from "../../v2/server.ts";
import { connect, loopback } from "../../v2/client.ts";
import { table } from "../../v2/sqlite/schema.ts";
import { dbOwner } from "../../v2/sqlite/row-label.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "../v2-auth-test-helpers.ts";

Deno.env.set("DENO_SQLITE_LOCAL", "1");

const SPACE = "did:key:z6Mk-column-origin-server-probe";
const server = new Server({
  ...testSessionOpenServerOptions,
  store: new URL("memory://column-origin-server-probe"),
});
const client = await connect({ transport: loopback(server) });
const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);

// A per-row label rule makes the db need column provenance (wantColumns=true).
const db = {
  id: `of:probe-${crypto.randomUUID()}`,
  tables: {
    notes: table({ id: "integer primary key", body: "text" }, () => ({
      confidentiality: dbOwner(),
    })),
  },
};

let message = "no throw";
try {
  await session.sqliteQuery(db, "SELECT body FROM notes");
} catch (e) {
  message = (e as Error).message;
}
console.log(message);
await client.close();
await server.close();
