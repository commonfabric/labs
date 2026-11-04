/// <cts-enable />
// Browser-integration fixture for cf-iframe's real CellHandle bridge. The
// pattern binds its scoped cells and databases as one `$context` record,
// exposes the cells as sibling readouts, and leaves every mutation to the
// sandboxed guest, through the bridge. The guest also joins the presence room
// of the space-scoped cell on command, and reports the room to the page that
// embeds the piece.
import {
  action,
  cfSqlite,
  computed,
  type Default,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  sqliteDatabase,
  type SqliteDb,
  UI,
  type VNode,
  type Writable,
} from "commonfabric";

export type TextCell = Writable<string | Default<"">>;
export type RevisionCell = Writable<number | Default<0>>;

export interface BridgeFixtureInput {
  shared?: PerSpace<TextCell>;
  user?: PerUser<TextCell>;
  session?: PerSession<TextCell>;
  databaseRows?: PerSession<TextCell>;
  userDatabaseRows?: PerSession<TextCell>;
  sessionDatabaseRows?: PerSession<TextCell>;
  reloadRevision?: PerSession<RevisionCell>;
}

export interface BridgeFixtureOutput {
  [UI]: VNode;
}

// This deliberately uses the bridge wire protocol directly. The guest helper
// and React hooks have their own focused tests; this fixture pins the browser
// product boundary without requiring a module server inside the opaque guest.
const GUEST_HTML = `<!doctype html>
<html>
<body>
<div id="guest-state">connecting</div>
<script>
(() => {
  const marker = ["fvr1"];
  const encode = (value) => [marker, value];
  const decode = (value) => value[1];
  let port;
  let nextRequestId = 0;
  let nextSubscriptionId = 0;
  let readyError;
  let markReady;
  const ready = new Promise((resolve) => markReady = resolve);
  const generation = crypto.randomUUID();
  const pending = new Map();
  const subscriptions = new Map();
  const queued = [];

  const send = (message) => {
    if (port) port.postMessage(encode(message));
    else queued.push(message);
  };

  const request = (operation, fields = {}) => {
    const id = nextRequestId++;
    const message = {
      protocol: "common-fabric-bridge",
      version: 2,
      type: "request",
      id,
      operation,
      ...fields,
    };
    const result = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    send(message);
    return result;
  };

  const set = (resource, value) =>
    request("set", { resource, path: [], value });
  const call = (resource, method, value) =>
    request("call", { resource, method, value });
  const resolveIdentity = (resource) =>
    request("resolve", { resource, path: [] });
  const sink = async (resource, listener) => {
    const subscription = "guest-" + nextSubscriptionId++;
    subscriptions.set(subscription, listener);
    await request("sink", { resource, subscription });
    return subscription;
  };
  const unsink = async (resource, subscription) => {
    subscriptions.delete(subscription);
    await request("unsink", { resource, subscription });
  };

  const databaseRows = {
    database: "databaseRows",
    userDatabase: "userDatabaseRows",
    sessionDatabase: "sessionDatabaseRows",
  };

  const refreshRows = async (database) => {
    let result;
    try {
      result = await call(database, "query", {
        sql: "SELECT value FROM bridge_items ORDER BY id",
      });
    } catch (error) {
      throw new Error(database + ": " + error.message);
    }
    const rows = result.rows.map((entries) => Object.fromEntries(entries));
    await set(
      databaseRows[database],
      rows.map((row) => row.value).join(","),
    );
  };

  // This guest's membership in the presence room: the sink it is held
  // through, the id the room gave it, and every other member's latest record.
  const room = {
    subscription: undefined,
    participantId: undefined,
    participants: new Map(),
  };

  // Tells the embedding page what the room holds. A facet is a peer's, so its
  // text is read only when it is a string.
  const reportRoom = (error) => {
    globalThis.parent.parent.postMessage({
      type: "cf-iframe-bridge-test-presence",
      generation,
      ...(room.participantId !== undefined && {
        participantId: room.participantId,
      }),
      participants: [...room.participants.values()].map((participant) => {
        const text = participant.facets.status?.text;
        return {
          participantId: participant.participantId,
          name: participant.name,
          status: typeof text === "string" ? text : "",
        };
      }),
      ...(error && { error: error.message }),
    }, "*");
  };

  const receiveRoomEvent = (event, error) => {
    if (error) {
      // A failure ends the room: the guest holds nothing of it, and may join
      // again.
      if (room.subscription !== undefined) {
        subscriptions.delete(room.subscription);
      }
      room.subscription = undefined;
      room.participantId = undefined;
      room.participants = new Map();
      reportRoom(error);
      return;
    }
    if (event.kind === "snapshot") {
      room.participantId = event.participantId;
      room.participants = new Map(
        event.participants.map((participant) => [
          participant.participantId,
          participant,
        ]),
      );
    } else if (event.kind === "upsert") {
      room.participants.set(event.participant.participantId, event.participant);
    } else if (event.kind === "remove") {
      room.participants.delete(event.participantId);
    } else {
      return;
    }
    reportRoom();
  };

  const handleCommand = async (command) => {
    if (command.operation === "ping") {
      await ready;
      if (readyError) throw readyError;
    } else if (command.operation === "resolve-identity") {
      return await resolveIdentity(command.resource);
    } else if (command.operation === "write") {
      await set(command.resource, command.value);
    } else if (command.operation === "sqlite-insert") {
      const database = command.database || "database";
      await call(database, "exec", {
        sql: "INSERT INTO bridge_items (value) VALUES (?)",
        params: [command.value],
      });
    } else if (command.operation === "sqlite-query") {
      await refreshRows(command.database || "database");
    } else if (command.operation === "clear-database-rows") {
      await Promise.all(
        Object.values(databaseRows).map((resource) => set(resource, "")),
      );
    } else if (command.operation === "presence-join") {
      if (room.subscription !== undefined) {
        throw new Error("The presence room is already joined.");
      }
      room.subscription = await sink("room", receiveRoomEvent);
    } else if (command.operation === "presence-publish") {
      if (command.name !== undefined) {
        await call("room", "setName", command.name);
      }
      await call("room", "setFacet", {
        facet: "status",
        value: { text: command.value },
      });
    } else if (command.operation === "presence-leave") {
      const subscription = room.subscription;
      if (subscription === undefined) {
        throw new Error("The presence room is not joined.");
      }
      room.subscription = undefined;
      room.participantId = undefined;
      room.participants = new Map();
      await unsink("room", subscription);
      reportRoom();
    } else {
      throw new Error("Unknown command: " + command.operation);
    }
  };

  const reportError = (error) => {
    document.querySelector("#guest-state").textContent = error.message;
    globalThis.parent.postMessage({
      type: "error",
      data: {
        description: error.message,
        source: "cf-iframe multi-user fixture",
        lineno: 0,
        colno: 0,
        stacktrace: error.stack || String(error),
      },
    }, "*");
  };

  const accept = (message) => {
    if (
      !message || message.protocol !== "common-fabric-bridge" ||
      message.version !== 2
    ) return;
    if (message.type === "event") {
      subscriptions.get(message.subscription)?.(message.value, message.error);
      return;
    }
    if (message.type !== "response") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new Error(message.error.message));
  };

  globalThis.addEventListener("message", (event) => {
    if (event.source !== globalThis.parent.parent) return;
    if (event.data?.type === "cf-iframe-bridge-test-command") {
      const command = event.data.command;
      void handleCommand(command).then(
        (value) => globalThis.parent.parent.postMessage({
          type: "cf-iframe-bridge-test-result",
          id: command.id,
          generation,
          ok: true,
          value,
        }, "*"),
        (error) => {
          globalThis.parent.parent.postMessage({
            type: "cf-iframe-bridge-test-result",
            id: command.id,
            generation,
            ok: false,
            error: error.message,
          }, "*");
          reportError(error);
        },
      );
      return;
    }
    if (
      port || event.data !== "common-iframe-sandbox:port" ||
      !event.ports[0]
    ) return;
    port = event.ports[0];
    port.onmessage = (portEvent) => accept(decode(portEvent.data));
    port.start();
    for (const message of queued.splice(0)) send(message);

    void (async () => {
      for (const database of Object.keys(databaseRows)) {
        await sink(database, () => void refreshRows(database));
      }
      await Promise.all(Object.keys(databaseRows).map(refreshRows));
      document.querySelector("#guest-state").textContent = "ready";
      markReady();
      globalThis.parent.parent.postMessage({
        type: "cf-iframe-bridge-test-ready",
        generation,
      }, "*");
    })().catch((error) => {
      readyError = error;
      markReady();
      reportError(error);
    });
  });
})();
</script>
</body>
</html>`;

export default pattern<BridgeFixtureInput, BridgeFixtureOutput>((state) => {
  const { table } = cfSqlite;
  const tables = {
    bridge_items: table({
      id: "integer primary key",
      value: "text",
    }),
  };
  const database = sqliteDatabase({ tables });
  const userDatabase: PerUser<SqliteDb> = sqliteDatabase({ tables });
  const sessionDatabase: PerSession<SqliteDb> = sqliteDatabase(
    { tables },
  );
  const source = computed(() =>
    GUEST_HTML + '<span hidden data-reload="' + state.reloadRevision.get() +
    '"></span>'
  );
  const reloadGuest = action(() => {
    state.reloadRevision.set(state.reloadRevision.get() + 1);
  });

  return {
    [UI]: (
      <div style={{ padding: "16px", display: "grid", gap: "8px" }}>
        <div id="bridge-shared">{state.shared}</div>
        <div id="bridge-user">{state.user}</div>
        <div id="bridge-session">{state.session}</div>
        <div id="bridge-database-rows">{state.databaseRows}</div>
        <div id="bridge-user-database-rows">{state.userDatabaseRows}</div>
        <div id="bridge-session-database-rows">
          {state.sessionDatabaseRows}
        </div>
        <cf-button id="bridge-reload" onClick={reloadGuest}>
          Reload guest
        </cf-button>
        <div style={{ height: "120px" }}>
          <cf-iframe
            src={source}
            $context={{
              shared: state.shared,
              user: state.user,
              session: state.session,
              databaseRows: state.databaseRows,
              userDatabaseRows: state.userDatabaseRows,
              sessionDatabaseRows: state.sessionDatabaseRows,
              database,
              userDatabase,
              sessionDatabase,
              // A presence room is the one derived from its cell's resolved
              // field, and a space-scoped field is the same for every
              // session of every identity.
              room: state.shared,
            }}
            resourceKinds={{
              database: "sqlite",
              userDatabase: "sqlite",
              sessionDatabase: "sqlite",
              room: "presence",
            }}
          />
        </div>
      </div>
    ),
  };
});
