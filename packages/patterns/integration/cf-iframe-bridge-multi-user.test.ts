/**
 * Browser-level multiplayer coverage for cf-iframe's CellHandle bridge.
 *
 * Alice opens one piece in two independent browser sessions and Bob opens the
 * same piece under a different identity. Every mutation is sent directly to
 * the sandboxed guest and performed through its bridge. Sibling readouts then
 * expose what each runtime sees, covering the real guest port, cf-iframe cell
 * adapter, scoped storage, runtime-client IPC, and SQLite bridge together.
 */

import { debugStr } from "@commonfabric/data-model";
import { env, type Page, waitForCondition } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { ANYONE_USER } from "@commonfabric/memory/acl";
import { ACLManager } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickCfButton,
  waitForRuntimeIdle,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

type BridgeCommand = {
  id: string;
  operation:
    | "ping"
    | "resolve-identity"
    | "write"
    | "sqlite-insert"
    | "sqlite-query"
    | "clear-database-rows";
  resource?: "shared" | "user" | "session";
  database?: "database" | "userDatabase" | "sessionDatabase";
  value?: string;
};

type BridgeValues = {
  shared: string;
  user: string;
  session: string;
  databaseRows: string;
  userDatabaseRows: string;
  sessionDatabaseRows: string;
};

type BridgeWireValue =
  | null
  | boolean
  | number
  | string
  | readonly BridgeWireValue[]
  | { readonly [key: string]: BridgeWireValue };

type BridgeTestResult = {
  generation: string;
  ok: boolean;
  value?: BridgeWireValue;
  error?: string;
};

type BridgeResolvedIdentity = {
  id: string;
  instanceId: string;
  scope?: "space" | "user" | "session";
};

type ContextHandleProbe = {
  context?: {
    ref: unknown;
    keys: string[];
    members: unknown;
    children?: unknown;
  };
  resolved?: { ref: unknown; keys: string[]; members: unknown };
  bridge?: unknown;
  error?: string;
};

async function readBridgeValues(page: Page): Promise<BridgeValues> {
  return await page.evaluate(() => {
    const find = (selector: string): Element | undefined => {
      const visit = (root: Document | ShadowRoot): Element | undefined => {
        for (const element of root.querySelectorAll("*")) {
          if (element.matches(selector)) return element;
          if (element.shadowRoot) {
            const match = visit(element.shadowRoot);
            if (match) return match;
          }
        }
        return undefined;
      };
      return visit(document);
    };
    const text = (selector: string) =>
      find(selector)?.textContent?.trim() ?? "";
    return {
      shared: text("#bridge-shared"),
      user: text("#bridge-user"),
      session: text("#bridge-session"),
      databaseRows: text("#bridge-database-rows"),
      userDatabaseRows: text("#bridge-user-database-rows"),
      sessionDatabaseRows: text("#bridge-session-database-rows"),
    };
  });
}

async function readContextHandleProbe(page: Page): Promise<ContextHandleProbe> {
  return await page.evaluate(async () => {
    const visit = (root: Document | ShadowRoot): Element | undefined => {
      for (const element of root.querySelectorAll("*")) {
        if (element.matches("cf-iframe")) return element;
        if (element.shadowRoot) {
          const match = visit(element.shadowRoot);
          if (match) return match;
        }
      }
      return undefined;
    };
    const element = visit(document) as
      | (Element & {
        _contextBridge?: {
          resources: Record<
            string,
            {
              kind: string;
              schema?: unknown;
              methods?: Record<string, unknown>;
            }
          >;
        };
        context?: {
          ref(): unknown;
          get(): unknown;
          sync(): Promise<unknown>;
          key(name: string): {
            ref(): unknown;
            resolveAsCell(): Promise<{ ref(): unknown }>;
          };
          resolveAsCell(): Promise<{
            ref(): unknown;
            get(): unknown;
            sync(): Promise<unknown>;
          }>;
        };
      })
      | undefined;
    const context = element?.context;
    if (!context) return { error: "cf-iframe has no context handle" };
    const summarize = (handle: { ref(): unknown; get(): unknown }) => {
      const value = handle.get();
      const members = value && typeof value === "object"
        ? Object.fromEntries(
          Object.entries(value).map(([key, member]) => [
            key,
            member && typeof member === "object" && "ref" in member &&
              typeof member.ref === "function"
              ? { kind: "cell", ref: member.ref() }
              : member && typeof member === "object"
              ? {
                kind: "object",
                constructor: member.constructor?.name,
                keys: Object.keys(member),
                value: member,
              }
              : { kind: typeof member },
          ]),
        )
        : {};
      return {
        ref: handle.ref(),
        keys: value && typeof value === "object" ? Object.keys(value) : [],
        members,
      };
    };
    try {
      await context.sync();
      const resolved = await context.resolveAsCell();
      await resolved.sync();
      const contextSummary = summarize(context);
      const children = await Promise.all(
        contextSummary.keys.map(async (name) => {
          const child = context.key(name);
          const childResolved = await child.resolveAsCell();
          return {
            name,
            ref: child.ref(),
            resolvedRef: childResolved.ref(),
          };
        }),
      );
      return {
        context: { ...contextSummary, children },
        resolved: summarize(resolved),
        bridge: Object.fromEntries(
          Object.entries(element?._contextBridge?.resources ?? {}).map(
            ([name, resource]) => [name, {
              kind: resource.kind,
              schema: resource.schema,
              methods: Object.keys(resource.methods ?? {}),
            }],
          ),
        ),
      };
    } catch (error) {
      return {
        context: summarize(context),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

async function installBridgeTestHarness(page: Page): Promise<void> {
  await page.evaluate(() => {
    type TestState = {
      results: Record<string, BridgeTestResult>;
      readyGeneration?: string;
      revision: number;
    };
    const host = globalThis as typeof globalThis & {
      __cfIframeBridgeTest?: TestState;
    };
    if (host.__cfIframeBridgeTest) return;
    const state: TestState = { results: {}, revision: 0 };
    host.__cfIframeBridgeTest = state;
    globalThis.addEventListener("message", (event) => {
      if (event.data?.type === "cf-iframe-bridge-test-result") {
        state.results[event.data.id] = {
          generation: event.data.generation,
          ok: event.data.ok,
          ...(event.data.value !== undefined && { value: event.data.value }),
          ...(event.data.error && { error: event.data.error }),
        };
      } else if (event.data?.type === "cf-iframe-bridge-test-ready") {
        state.readyGeneration = event.data.generation;
      } else {
        return;
      }
      document.documentElement.dataset.cfIframeBridgeEvent = String(
        ++state.revision,
      );
    });
  });
}

async function waitForGuestFrameLoaded(page: Page): Promise<void> {
  await waitForCondition(
    page,
    (probe) =>
      probe.collect("common-iframe-sandbox").some((element) =>
        element.getAttribute("load-state") === "loaded"
      ),
  );
}

async function issueCommand(
  page: Page,
  command: BridgeCommand,
): Promise<BridgeTestResult> {
  await installBridgeTestHarness(page);
  await page.evaluate((command) => {
    const visit = (root: Document | ShadowRoot): Element | undefined => {
      for (const element of root.querySelectorAll("*")) {
        if (element.matches("common-iframe-sandbox")) return element;
        if (element.shadowRoot) {
          const match = visit(element.shadowRoot);
          if (match) return match;
        }
      }
      return undefined;
    };
    const sandbox = visit(document);
    const outer = sandbox?.shadowRoot?.querySelector("iframe") as
      | HTMLIFrameElement
      | undefined;
    const guest = outer?.contentWindow?.frames[0];
    if (!guest) throw new Error("cf-iframe guest window is unavailable");
    guest.postMessage({
      type: "cf-iframe-bridge-test-command",
      command,
    }, "*");
  }, { args: [command] });
  const result = await waitForCondition(
    page,
    (probe, commandId) => {
      const host = globalThis as typeof globalThis & {
        __cfIframeBridgeTest?: {
          results: Record<string, BridgeTestResult>;
        };
      };
      const commandResult = host.__cfIframeBridgeTest?.results[commandId];
      if (commandResult) return commandResult;
      const error = probe.collect(".error-modal .error-content")[0];
      return error
        ? {
          generation: "",
          ok: false,
          error: probe.deepText(error).trim(),
        }
        : false;
    },
    { args: [command.id] },
  );
  if (!result?.ok) {
    const context = await readContextHandleProbe(page);
    throw new Error(
      debugStr`cf-iframe command $quote${command.id} failed: ` +
        `${result?.error ?? "unknown error"}\n` +
        debugStr`Context probe: $quote,indent,long${context}`,
    );
  }
  return result;
}

async function resolveBridgeIdentity(
  page: Page,
  resource: "shared" | "user" | "session",
  id: string,
): Promise<BridgeResolvedIdentity> {
  const result = await issueCommand(page, {
    id,
    operation: "resolve-identity",
    resource,
  });
  const identity = (result.value as { identity?: BridgeResolvedIdentity })
    ?.identity;
  if (!identity?.instanceId) {
    throw new Error(
      debugStr`cf-iframe resolve $quote${id} returned no instance identity`,
    );
  }
  return identity;
}

async function waitForGuestReload(
  page: Page,
  previousGeneration: string,
): Promise<void> {
  const result = await waitForCondition(
    page,
    (probe, oldGeneration) => {
      const host = globalThis as typeof globalThis & {
        __cfIframeBridgeTest?: { readyGeneration?: string };
      };
      const generation = host.__cfIframeBridgeTest?.readyGeneration;
      if (generation && generation !== oldGeneration) return { error: "" };
      const error = probe.collect(".error-modal .error-content")[0];
      return error ? { error: probe.deepText(error).trim() } : false;
    },
    { args: [previousGeneration] },
  );
  if (result?.error) {
    throw new Error(`cf-iframe reload failed: ${result.error}`);
  }
}

async function waitForBridgeRowsEmpty(page: Page): Promise<void> {
  const result = await waitForCondition(
    page,
    async (probe) => {
      const settle = (globalThis as typeof globalThis & {
        commonfabric?: { viewSettled?: () => Promise<void> };
      }).commonfabric?.viewSettled;
      if (!settle) return false;
      await settle();
      const selectors = [
        "#bridge-database-rows",
        "#bridge-user-database-rows",
        "#bridge-session-database-rows",
      ];
      if (
        selectors.every((selector) => {
          const element = probe.collect(selector)[0];
          return element && probe.deepText(element).trim() === "";
        })
      ) return { error: "" };
      const error = probe.collect(".error-modal .error-content")[0];
      return error ? { error: probe.deepText(error).trim() } : false;
    },
  );
  if (result?.error) {
    throw new Error(`cf-iframe row clearing failed: ${result.error}`);
  }
}

async function waitForBridgeRowsContaining(
  page: Page,
  expected: readonly string[],
  selector = "#bridge-database-rows",
): Promise<void> {
  const result = await waitForCondition(
    page,
    (probe, options) => {
      const { expectedRows, rowSelector } = options;
      const rows = probe.collect(rowSelector)[0];
      const values = rows
        ? probe.deepText(rows).trim().split(",").filter(Boolean)
        : [];
      if (expectedRows.every((value) => values.includes(value))) {
        return { rows: values, error: "" };
      }
      const error = probe.collect(".error-modal .error-content")[0];
      if (error) {
        return { rows: values, error: probe.deepText(error).trim() };
      }
      return false;
    },
    { args: [{ expectedRows: expected, rowSelector: selector }] },
  );
  if (result?.error) {
    throw new Error(
      `cf-iframe reported an error while waiting for SQLite rows ` +
        debugStr`$quote,long${expected}: ${result.error}`,
    );
  }
}

describe("cf-iframe bridge with multiple users", () => {
  const aliceOneShell = new ShellIntegration({
    presentation: { id: "alice-one", label: "Alice · session 1" },
  });
  const aliceTwoShell = new ShellIntegration({
    presentation: { id: "alice-two", label: "Alice · session 2" },
  });
  const bobShell = new ShellIntegration({
    presentation: { id: "bob", label: "Bob" },
  });
  const shells = [aliceOneShell, aliceTwoShell, bobShell];
  shells.forEach((shell) => shell.bindLifecycle());

  let aliceIdentity: Identity;
  let bobIdentity: Identity;
  let cc: PiecesController;
  let pieceId: string;
  let resultSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    [aliceIdentity, bobIdentity] = await Promise.all([
      Identity.generate({ implementation: "noble" }),
      Identity.generate({ implementation: "noble" }),
    ]);
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: aliceIdentity,
    });
    await new ACLManager(cc.runtime, cc.getSpace()).set(ANYONE_USER, "WRITE");
    await cc.ensureDefaultPattern();

    const sourcePath = join(
      import.meta.dirname!,
      "fixtures",
      "cf-iframe-bridge-multi-user",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    const piece = await cc.create(program, { start: true });
    pieceId = piece.id;
    resultSinkCancel = cc.getResult(piece.getCell()).sink(() => {});
  });

  afterAll(async () => {
    resultSinkCancel?.();
    await cc?.dispose();
  });

  it("preserves `PerSpace`, `PerUser`, `PerSession`, and SQLite data at their declared boundaries", async () => {
    const view = {
      spaceDid: cc.getSpace() as `did:${string}:${string}`,
      pieceId,
    };
    const identities = [aliceIdentity, aliceIdentity, bobIdentity];
    const pages = shells.map((shell) => shell.page());

    await Promise.all(shells.map((shell, index) =>
      shell.goto({
        frontendUrl: FRONTEND_URL,
        view,
        identity: identities[index],
      })
    ));
    await Promise.all(pages.map((page) => waitForRuntimeIdle(page)));
    await Promise.all(pages.map((page) => waitForGuestFrameLoaded(page)));
    const guestGenerations = await Promise.all(
      pages.map((page, index) =>
        issueCommand(page, { id: `ready-${index}`, operation: "ping" }).then(
          (result) => result.generation,
        )
      ),
    );

    expect((await aliceOneShell.state())?.identityDid).toBe(
      aliceIdentity.did(),
    );
    expect((await aliceTwoShell.state())?.identityDid).toBe(
      aliceIdentity.did(),
    );
    expect((await bobShell.state())?.identityDid).toBe(bobIdentity.did());

    const scopedIdentities = await Promise.all(
      pages.map(async (page, index) => {
        const [shared, user, session] = await Promise.all([
          resolveBridgeIdentity(page, "shared", `identity-shared-${index}`),
          resolveBridgeIdentity(page, "user", `identity-user-${index}`),
          resolveBridgeIdentity(page, "session", `identity-session-${index}`),
        ]);
        return { shared, user, session };
      }),
    );
    for (const resource of ["shared", "user", "session"] as const) {
      expect(scopedIdentities[0][resource].id).toBe(
        scopedIdentities[1][resource].id,
      );
      expect(scopedIdentities[0][resource].id).toBe(
        scopedIdentities[2][resource].id,
      );
    }
    expect(scopedIdentities[0].shared.instanceId).toBe(
      scopedIdentities[1].shared.instanceId,
    );
    expect(scopedIdentities[0].shared.instanceId).toBe(
      scopedIdentities[2].shared.instanceId,
    );
    expect(scopedIdentities[0].user.instanceId).toBe(
      scopedIdentities[1].user.instanceId,
    );
    expect(scopedIdentities[0].user.instanceId).not.toBe(
      scopedIdentities[2].user.instanceId,
    );
    expect(scopedIdentities[0].session.instanceId).not.toBe(
      scopedIdentities[1].session.instanceId,
    );
    expect(scopedIdentities[0].session.instanceId).not.toBe(
      scopedIdentities[2].session.instanceId,
    );
    expect(scopedIdentities[1].session.instanceId).not.toBe(
      scopedIdentities[2].session.instanceId,
    );
    for (const page of pages) {
      expect(await readBridgeValues(page)).toMatchObject({
        shared: "",
        user: "",
        session: "",
      });
    }

    await issueCommand(pages[0], {
      id: "shared-one",
      operation: "write",
      resource: "shared",
      value: "space-one",
    });
    await Promise.all(
      pages.map((page) =>
        waitForSettledText(page, "#bridge-shared", "space-one")
      ),
    );

    await issueCommand(pages[0], {
      id: "alice-user",
      operation: "write",
      resource: "user",
      value: "alice-user",
    });
    await waitForSettledText(pages[1], "#bridge-user", "alice-user");
    await issueCommand(pages[0], {
      id: "user-barrier",
      operation: "write",
      resource: "shared",
      value: "space-after-alice-user",
    });
    await Promise.all(
      pages.map((page) =>
        waitForSettledText(
          page,
          "#bridge-shared",
          "space-after-alice-user",
        )
      ),
    );
    expect((await readBridgeValues(pages[2])).user).toBe("");

    await issueCommand(pages[2], {
      id: "bob-user",
      operation: "write",
      resource: "user",
      value: "bob-user",
    });
    await waitForSettledText(pages[2], "#bridge-user", "bob-user");
    await issueCommand(pages[2], {
      id: "bob-user-barrier",
      operation: "write",
      resource: "shared",
      value: "space-after-bob-user",
    });
    await Promise.all(
      pages.map((page) =>
        waitForSettledText(page, "#bridge-shared", "space-after-bob-user")
      ),
    );
    expect((await readBridgeValues(pages[0])).user).toBe("alice-user");
    expect((await readBridgeValues(pages[1])).user).toBe("alice-user");
    expect((await readBridgeValues(pages[2])).user).toBe("bob-user");

    await issueCommand(pages[0], {
      id: "alice-session-one",
      operation: "write",
      resource: "session",
      value: "alice-session-one",
    });
    await waitForSettledText(
      pages[0],
      "#bridge-session",
      "alice-session-one",
    );
    await issueCommand(pages[0], {
      id: "session-one-barrier",
      operation: "write",
      resource: "shared",
      value: "space-after-session-one",
    });
    await Promise.all(
      pages.map((page) =>
        waitForSettledText(page, "#bridge-shared", "space-after-session-one")
      ),
    );
    expect((await readBridgeValues(pages[1])).session).toBe("");
    expect((await readBridgeValues(pages[2])).session).toBe("");

    await issueCommand(pages[1], {
      id: "alice-session-two",
      operation: "write",
      resource: "session",
      value: "alice-session-two",
    });
    await waitForSettledText(
      pages[1],
      "#bridge-session",
      "alice-session-two",
    );
    await issueCommand(pages[1], {
      id: "session-two-barrier",
      operation: "write",
      resource: "shared",
      value: "space-after-session-two",
    });
    await Promise.all(
      pages.map((page) =>
        waitForSettledText(page, "#bridge-shared", "space-after-session-two")
      ),
    );
    expect((await readBridgeValues(pages[0])).session).toBe(
      "alice-session-one",
    );
    expect((await readBridgeValues(pages[1])).session).toBe(
      "alice-session-two",
    );
    expect((await readBridgeValues(pages[2])).session).toBe("");

    const aliceRow = `alice-${pieceId}`;
    const bobRow = `bob-${pieceId}`;
    await issueCommand(pages[0], {
      id: "sqlite-alice",
      operation: "sqlite-insert",
      value: aliceRow,
    });
    await Promise.all(
      pages.map((page) => waitForBridgeRowsContaining(page, [aliceRow])),
    );
    await issueCommand(pages[2], {
      id: "sqlite-bob",
      operation: "sqlite-insert",
      value: bobRow,
    });
    await Promise.all(
      pages.map((page) =>
        waitForBridgeRowsContaining(page, [aliceRow, bobRow])
      ),
    );
    const durableDatabaseRows = (await readBridgeValues(pages[0])).databaseRows;
    await Promise.all(
      pages.slice(1).map((page) =>
        waitForSettledText(
          page,
          "#bridge-database-rows",
          durableDatabaseRows,
        )
      ),
    );

    const aliceUserDatabaseRow = `alice-user-db-${pieceId}`;
    const bobUserDatabaseRow = `bob-user-db-${pieceId}`;
    await issueCommand(pages[0], {
      id: "sqlite-user-alice",
      operation: "sqlite-insert",
      database: "userDatabase",
      value: aliceUserDatabaseRow,
    });
    await Promise.all(
      pages.slice(0, 2).map((page) =>
        waitForBridgeRowsContaining(
          page,
          [aliceUserDatabaseRow],
          "#bridge-user-database-rows",
        )
      ),
    );
    expect((await readBridgeValues(pages[2])).userDatabaseRows).toBe("");

    await issueCommand(pages[2], {
      id: "sqlite-user-bob",
      operation: "sqlite-insert",
      database: "userDatabase",
      value: bobUserDatabaseRow,
    });
    await waitForBridgeRowsContaining(
      pages[2],
      [bobUserDatabaseRow],
      "#bridge-user-database-rows",
    );
    expect((await readBridgeValues(pages[0])).userDatabaseRows).toBe(
      aliceUserDatabaseRow,
    );
    expect((await readBridgeValues(pages[1])).userDatabaseRows).toBe(
      aliceUserDatabaseRow,
    );

    const aliceSessionOneDatabaseRow = `alice-session-1-db-${pieceId}`;
    const aliceSessionTwoDatabaseRow = `alice-session-2-db-${pieceId}`;
    await issueCommand(pages[0], {
      id: "sqlite-session-one",
      operation: "sqlite-insert",
      database: "sessionDatabase",
      value: aliceSessionOneDatabaseRow,
    });
    await waitForBridgeRowsContaining(
      pages[0],
      [aliceSessionOneDatabaseRow],
      "#bridge-session-database-rows",
    );
    expect((await readBridgeValues(pages[1])).sessionDatabaseRows).toBe("");
    expect((await readBridgeValues(pages[2])).sessionDatabaseRows).toBe("");

    await issueCommand(pages[1], {
      id: "sqlite-session-two",
      operation: "sqlite-insert",
      database: "sessionDatabase",
      value: aliceSessionTwoDatabaseRow,
    });
    await waitForBridgeRowsContaining(
      pages[1],
      [aliceSessionTwoDatabaseRow],
      "#bridge-session-database-rows",
    );
    expect((await readBridgeValues(pages[0])).sessionDatabaseRows).toBe(
      aliceSessionOneDatabaseRow,
    );

    await issueCommand(pages[0], {
      id: "clear-database-readouts",
      operation: "clear-database-rows",
    });
    await waitForBridgeRowsEmpty(pages[0]);

    await clickCfButton(pages[0], "#bridge-reload");
    await waitForGuestReload(pages[0], guestGenerations[0]);
    expect(
      await resolveBridgeIdentity(
        pages[0],
        "session",
        "identity-session-after-reload",
      ),
    ).toEqual(scopedIdentities[0].session);
    await Promise.all([
      waitForBridgeRowsContaining(pages[0], [aliceRow, bobRow]),
      waitForBridgeRowsContaining(
        pages[0],
        [aliceUserDatabaseRow],
        "#bridge-user-database-rows",
      ),
      waitForBridgeRowsContaining(
        pages[0],
        [aliceSessionOneDatabaseRow],
        "#bridge-session-database-rows",
      ),
    ]);
    expect(await readBridgeValues(pages[0])).toEqual({
      shared: "space-after-session-two",
      user: "alice-user",
      session: "alice-session-one",
      databaseRows: durableDatabaseRows,
      userDatabaseRows: aliceUserDatabaseRow,
      sessionDatabaseRows: aliceSessionOneDatabaseRow,
    });
    expect(await readBridgeValues(pages[1])).toEqual({
      shared: "space-after-session-two",
      user: "alice-user",
      session: "alice-session-two",
      databaseRows: durableDatabaseRows,
      userDatabaseRows: aliceUserDatabaseRow,
      sessionDatabaseRows: aliceSessionTwoDatabaseRow,
    });
    expect(await readBridgeValues(pages[2])).toEqual({
      shared: "space-after-session-two",
      user: "bob-user",
      session: "",
      databaseRows: durableDatabaseRows,
      userDatabaseRows: bobUserDatabaseRow,
      sessionDatabaseRows: "",
    });
  });
});
