import { debugStr } from "@commonfabric/data-model";
import {
  env,
  type Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { Identity } from "@commonfabric/identity";
import { ANYONE_USER } from "@commonfabric/memory/acl";
import { ACLManager } from "@commonfabric/runner";
import { assert, assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  initializePiecesController,
  type PieceController,
  type PiecesController,
} from "./pieces-controller.ts";
import {
  clickCfButton,
  waitForActiveSpaceRoot,
  waitForRuntimeIdle,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

type EditorHost = Element & {
  collaborative?: boolean;
  participantName?: string;
  presenceUrl?: string;
  updateComplete?: Promise<unknown>;
  value?: { runtime?: () => unknown };
  _collaboration?: {
    active?: boolean;
    prepareExternalChange?: () => Promise<boolean>;
  };
  _presenceParticipantId?: string;
  _editorView?: {
    focus(): void;
    state: {
      doc: { length: number; toString(): string };
      readOnly: boolean;
    };
    dispatch(spec: unknown): void;
  };
  _handleExternalTitleChange?: (
    pieceId: string,
    piece: { key(key: unknown): { get(): string } },
  ) => void;
  releaseCollaboration?: () => Promise<void>;
};

const collaborationReady = (probe: ProbeApi): boolean => {
  const editor = probe.collect("cf-code-editor")[0] as EditorHost | undefined;
  return editor?._collaboration?.active === true &&
    editor._editorView?.state.readOnly === false;
};

const editorReady = (probe: ProbeApi): boolean =>
  (probe.collect("cf-code-editor")[0] as EditorHost | undefined)
    ?._editorView !==
    undefined;

const collaborationStopped = (probe: ProbeApi): boolean => {
  const editor = probe.collect("cf-code-editor")[0] as EditorHost | undefined;
  return editor?.collaborative === false &&
    editor._collaboration === undefined &&
    editor._editorView?.state.readOnly === false;
};

const editorContainsTokens = (
  probe: ProbeApi,
  tokens: readonly string[],
): boolean => {
  const editor = probe.collect("cf-code-editor")[0] as EditorHost | undefined;
  const content = editor?._editorView?.state.doc.toString();
  return typeof content === "string" &&
    tokens.every((token) => content.includes(token));
};

const materializedDisplayEquals = (
  probe: ProbeApi,
  expected: string,
): boolean => {
  const display = probe.collect("#materialized-content")[0];
  return display !== undefined && probe.deepText(display).trim() === expected;
};

const presenceConnected = (probe: ProbeApi): boolean =>
  typeof (probe.collect("cf-code-editor")[0] as EditorHost | undefined)
    ?._presenceParticipantId === "string";

const remoteSelectionVisible = (
  probe: ProbeApi,
  participantName: string,
): boolean =>
  probe.collect(".cm-remote-presence-name").some((element) =>
    element.textContent === participantName
  ) && probe.collect(".cm-remote-presence-selection").some((element) =>
    element.getAttribute("title") === `${participantName}'s selection`
  );

const remoteSelectionAbsent = (
  probe: ProbeApi,
  participantName: string,
): boolean =>
  probe.collect(".cm-remote-presence-name").every((element) =>
    element.textContent !== participantName
  ) && probe.collect(".cm-remote-presence-selection").every((element) =>
    element.getAttribute("title") !== `${participantName}'s selection`
  );

const reconciliationReached = (probe: ProbeApi): boolean => {
  const editor = probe.collect("cf-code-editor")[0] as EditorHost | undefined;
  const globals = globalThis as typeof globalThis & {
    __collaborationReconciliation?: unknown;
    __collaborationReconciliationError?: unknown;
  };
  return editor?._editorView?.state.readOnly === true &&
    globals.__collaborationReconciliation !== undefined &&
    globals.__collaborationReconciliationError !== undefined;
};

const epochReleaseObserved = (
  probe: ProbeApi,
  canonical: string,
): boolean => {
  const editor = probe.collect("cf-code-editor")[0] as EditorHost | undefined;
  return editor?._collaboration?.active === false ||
    editor?._editorView?.state.doc.toString() === canonical;
};

async function reconciliationReachedNow(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const result: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) result.push(...collect(element.shadowRoot));
      }
      return result;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    ) as EditorHost | undefined;
    const globals = globalThis as typeof globalThis & {
      __collaborationReconciliation?: unknown;
      __collaborationReconciliationError?: unknown;
    };
    return editor?._editorView?.state.readOnly === true &&
      globals.__collaborationReconciliation !== undefined &&
      globals.__collaborationReconciliationError !== undefined;
  });
}

async function editorContent(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const result: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) result.push(...collect(element.shadowRoot));
      }
      return result;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    ) as EditorHost | undefined;
    return editor?._editorView?.state.doc.toString() ?? "";
  });
}

async function dispatchEdit(
  page: Page,
  from: number,
  to: number,
  insert: string,
): Promise<void> {
  await page.evaluate((from, to, insert) => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const result: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) result.push(...collect(element.shadowRoot));
      }
      return result;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    ) as EditorHost | undefined;
    const view = editor?._editorView;
    if (!view) throw new Error("collaborative editor is not ready");
    view.dispatch({ changes: { from, to, insert } });
  }, { args: [from, to, insert] });
}

async function appendEdit(page: Page, insert: string): Promise<void> {
  await page.evaluate((insert) => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const result: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) result.push(...collect(element.shadowRoot));
      }
      return result;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    ) as EditorHost | undefined;
    const view = editor?._editorView;
    if (!view) throw new Error("collaborative editor is not ready");
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, to: end, insert } });
  }, { args: [insert] });
}

async function enablePresence(
  page: Page,
  participantName: string,
  presenceUrl: string,
): Promise<void> {
  await page.evaluate(async (participantName, presenceUrl) => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const result: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) result.push(...collect(element.shadowRoot));
      }
      return result;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    ) as EditorHost | undefined;
    if (!editor) throw new Error("collaborative editor is not available");
    editor.participantName = participantName;
    editor.presenceUrl = presenceUrl;
    await editor.updateComplete;
  }, { args: [participantName, presenceUrl] });
}

async function selectEditorText(
  page: Page,
  anchor: number,
  head: number,
): Promise<void> {
  await page.evaluate((anchor, head) => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const result: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) result.push(...collect(element.shadowRoot));
      }
      return result;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    ) as EditorHost | undefined;
    const view = editor?._editorView;
    if (!view) throw new Error("collaborative editor is not ready");
    view.focus();
    view.dispatch({ selection: { anchor, head } });
  }, { args: [anchor, head] });
}

async function unmountEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const result: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) result.push(...collect(element.shadowRoot));
      }
      return result;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    );
    editor?.remove();
  });
}

type RelayRecord = {
  participantId: string;
  revision: number;
  name: string;
  focused: boolean;
  cursor: { epoch: number; version: number };
  selection: unknown;
  basis: "provisional" | "confirmed";
};

type RelayClient = {
  participantId: string;
  latest?: RelayRecord;
};

type PresenceRelay = {
  url: string;
  close(): Promise<void>;
};

function startPresenceRelay(): PresenceRelay {
  const rooms = new Map<string, Map<WebSocket, RelayClient>>();
  const broadcast = (
    room: Map<WebSocket, RelayClient>,
    message: unknown,
    exclude?: WebSocket,
  ) => {
    const encoded = JSON.stringify(message);
    for (const socket of room.keys()) {
      if (socket !== exclude && socket.readyState === WebSocket.OPEN) {
        socket.send(encoded);
      }
    }
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/v1\/rooms\/([^/]+)$/);
      if (!match) return new Response("Not found", { status: 404 });

      const roomId = decodeURIComponent(match[1]);
      const room = rooms.get(roomId) ?? new Map<WebSocket, RelayClient>();
      rooms.set(roomId, room);
      const { socket, response } = Deno.upgradeWebSocket(request);
      const client: RelayClient = { participantId: crypto.randomUUID() };
      room.set(socket, client);

      const remove = () => {
        if (!room.delete(socket)) return;
        if (client.latest) {
          broadcast(room, {
            v: 1,
            type: "participant.remove",
            participantId: client.participantId,
          });
        }
        if (room.size === 0) rooms.delete(roomId);
      };
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          v: 1,
          type: "room.snapshot",
          selfParticipantId: client.participantId,
          participants: [...room.entries()].flatMap(([peer, state]) =>
            peer !== socket && state.latest ? [state.latest] : []
          ),
        }));
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          v: number;
          type: string;
          revision: number;
          name: string;
          focused: boolean;
          cursor: { epoch: number; version: number };
          selection: unknown;
          basis: "provisional" | "confirmed";
        };
        if (message.v !== 1 || message.type !== "participant.upsert") {
          socket.close(1002, "invalid_message");
          return;
        }
        client.latest = {
          participantId: client.participantId,
          revision: message.revision,
          name: message.name,
          focused: message.focused,
          cursor: message.cursor,
          selection: message.selection,
          basis: message.basis,
        };
        broadcast(room, {
          v: 1,
          type: "participant.upsert",
          ...client.latest,
        }, socket);
      });
      socket.addEventListener("close", remove);
      socket.addEventListener("error", remove);
      return response;
    },
  );
  const address = server.addr as Deno.NetAddr;
  return {
    url: `ws://${address.hostname}:${address.port}`,
    async close() {
      for (const room of rooms.values()) {
        for (const socket of room.keys()) socket.close(1001, "test ended");
      }
      await server.shutdown();
    },
  };
}

async function dispatchExternalBacklinkRename(
  page: Page,
  pieceId: string,
  title: string,
  name: string,
): Promise<void> {
  await page.evaluate((pieceId, title, name) => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const result: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) result.push(...collect(element.shadowRoot));
      }
      return result;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    ) as EditorHost | undefined;
    if (!editor?._handleExternalTitleChange) {
      throw new Error("collaborative editor title handler is not ready");
    }
    editor._handleExternalTitleChange(pieceId, {
      key: (key) => ({ get: () => key === "title" ? title : name }),
    });
  }, { args: [pieceId, title, name] });
}

async function installNextApplyGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const result: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) result.push(...collect(element.shadowRoot));
      }
      return result;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    ) as EditorHost | undefined;
    const runtime = editor?.value?.runtime?.() as
      | {
        applyOperation: (...args: unknown[]) => Promise<unknown>;
      }
      | undefined;
    if (!runtime) throw new Error("editor runtime is not available");

    const prototype = Object.getPrototypeOf(runtime) as typeof runtime;
    const original = prototype.applyOperation;
    const ownApplyDescriptor = Object.getOwnPropertyDescriptor(
      runtime,
      "applyOperation",
    );
    const gate = Promise.withResolvers<"apply" | "cancel">();
    const captured = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const globals = globalThis as typeof globalThis & {
      __releaseCollaborationApply?: () => void;
      __cancelCollaborationApply?: () => void;
      __collaborationApplyCaptured?: Promise<void>;
      __collaborationApplyCompleted?: Promise<void>;
    };
    globals.__releaseCollaborationApply = () => gate.resolve("apply");
    globals.__cancelCollaborationApply = () => gate.resolve("cancel");
    globals.__collaborationApplyCaptured = captured.promise;
    globals.__collaborationApplyCompleted = completed.promise;
    const restore = () => {
      prototype.applyOperation = original;
      if (ownApplyDescriptor === undefined) {
        delete (runtime as { applyOperation?: unknown }).applyOperation;
      } else {
        Object.defineProperty(runtime, "applyOperation", ownApplyDescriptor);
      }
    };
    const intercept = async function (
      this: typeof runtime,
      ...args: unknown[]
    ): Promise<unknown> {
      captured.resolve();
      const action = await gate.promise;
      restore();
      try {
        if (action === "cancel") {
          throw new DOMException("collaboration apply cancelled", "AbortError");
        }
        return await original.apply(this, args);
      } finally {
        completed.resolve();
      }
    };
    prototype.applyOperation = intercept;
    runtime.applyOperation = intercept;
  });
}

async function cancelApplyGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const globals = globalThis as typeof globalThis & {
      __cancelCollaborationApply?: () => void;
    };
    const cancel = globals.__cancelCollaborationApply;
    if (!cancel) throw new Error("collaboration apply gate is not installed");
    delete globals.__cancelCollaborationApply;
    cancel();
  });
}

async function awaitApplyCaptured(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const promise = (globalThis as typeof globalThis & {
      __collaborationApplyCaptured?: Promise<void>;
    }).__collaborationApplyCaptured;
    if (!promise) throw new Error("collaboration apply gate is not installed");
    await promise;
  });
}

async function releaseApplyGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const globals = globalThis as typeof globalThis & {
      __releaseCollaborationApply?: () => void;
    };
    const release = globals.__releaseCollaborationApply;
    if (!release) throw new Error("collaboration apply gate is not installed");
    delete globals.__releaseCollaborationApply;
    release();
  });
}

async function awaitApplyCompleted(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const promise = (globalThis as typeof globalThis & {
      __collaborationApplyCompleted?: Promise<void>;
    }).__collaborationApplyCompleted;
    if (!promise) throw new Error("collaboration apply gate is not installed");
    await promise;
  });
}

async function listenForReconciliation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const result: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) result.push(...collect(element.shadowRoot));
      }
      return result;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    ) as EditorHost | undefined;
    if (!editor) throw new Error("collaborative editor is not available");
    const globals = globalThis as typeof globalThis & {
      __collaborationReconciliation?: unknown;
      __collaborationReconciliationError?: unknown;
    };
    delete globals.__collaborationReconciliation;
    delete globals.__collaborationReconciliationError;
    editor.addEventListener("cf-collaboration-reconcile", (event) => {
      globals.__collaborationReconciliation = (event as CustomEvent).detail;
    }, { once: true });
    editor.addEventListener("cf-error", (event) => {
      const detail = (event as CustomEvent).detail as {
        error?: Error;
        message?: string;
      };
      globals.__collaborationReconciliationError = {
        message: detail.message,
        name: detail.error?.name,
      };
    }, { once: true });
  });
}

async function listenForCollaborationErrors(page: Page): Promise<void> {
  await page.evaluate(() => {
    const globals = globalThis as typeof globalThis & {
      __collaborationErrors?: Array<{ message?: string; name?: string }>;
      __collaborationErrorListenerInstalled?: boolean;
    };
    globals.__collaborationErrors = [];
    if (globals.__collaborationErrorListenerInstalled) return;
    globals.__collaborationErrorListenerInstalled = true;
    document.addEventListener("cf-error", (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.localName !== "cf-code-editor") return;
      const detail = (event as CustomEvent).detail as {
        error?: Error;
        message?: string;
      };
      globals.__collaborationErrors?.push({
        message: detail.message,
        name: detail.error?.name,
      });
    });
  });
}

async function collaborationErrors(
  page: Page,
): Promise<Array<{ message?: string; name?: string }>> {
  return await page.evaluate(() =>
    (globalThis as typeof globalThis & {
      __collaborationErrors?: Array<{ message?: string; name?: string }>;
    }).__collaborationErrors ?? []
  );
}

async function reconciliationDetail(page: Page): Promise<{
  localValue: string;
  canonicalValue: string;
  localCursor: { epoch: number; version: number } | null;
  canonicalCursor: { epoch: number; version: number } | null;
}> {
  return await page.evaluate(() =>
    (globalThis as typeof globalThis & {
      __collaborationReconciliation: {
        localValue: string;
        canonicalValue: string;
        localCursor: { epoch: number; version: number } | null;
        canonicalCursor: { epoch: number; version: number } | null;
      };
    }).__collaborationReconciliation
  );
}

async function reconciliationError(
  page: Page,
): Promise<{ message?: string; name?: string }> {
  return await page.evaluate(() =>
    (globalThis as typeof globalThis & {
      __collaborationReconciliationError: {
        message?: string;
        name?: string;
      };
    }).__collaborationReconciliationError
  );
}

async function releaseCollaboration(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const result: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) result.push(...collect(element.shadowRoot));
      }
      return result;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    ) as EditorHost | undefined;
    if (!editor?.releaseCollaboration) {
      throw new Error("editor collaboration release is not available");
    }
    await editor.releaseCollaboration();
  });
}

async function confirmPendingCollaborationEdits(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const result: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) result.push(...collect(element.shadowRoot));
      }
      return result;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    ) as EditorHost | undefined;
    const confirmed = await editor?._collaboration?.prepareExternalChange?.();
    if (!confirmed) {
      throw new Error("collaborative editor did not confirm pending edits");
    }
  });
}

async function disableCollaboration(page: Page): Promise<void> {
  await page.evaluate(() => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const result: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) result.push(...collect(element.shadowRoot));
      }
      return result;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    ) as EditorHost | undefined;
    if (!editor) throw new Error("collaborative editor is not available");
    editor.collaborative = false;
  });
}

describe("cf-code-editor collaboration", () => {
  const aliceShell = new ShellIntegration();
  const bobShell = new ShellIntegration();
  aliceShell.bindLifecycle();
  bobShell.bindLifecycle();

  let alice: Identity;
  let bob: Identity;
  let cc: PiecesController;
  let pieces: Record<string, PieceController>;
  let presenceRelay: PresenceRelay;
  const sinkCancels: Array<() => void> = [];
  const latestContent = new Map<string, string>();
  const contentWaiters = new Map<
    string,
    Set<{
      predicate: (value: string) => boolean;
      resolve: (value: string) => void;
    }>
  >();

  const awaitMaterialized = (
    name: string,
    predicate: (value: string) => boolean,
  ): Promise<string> => {
    const current = latestContent.get(name);
    if (current !== undefined && predicate(current)) {
      return Promise.resolve(current);
    }
    return new Promise((resolve) => {
      const waiter = { predicate, resolve };
      const waiters = contentWaiters.get(name) ?? new Set();
      waiters.add(waiter);
      contentWaiters.set(name, waiters);
    });
  };

  const navigateBoth = async (piece: PieceController): Promise<void> => {
    const view = { spaceName: SPACE_NAME, pieceId: piece.id };
    await Promise.all([
      aliceShell.goto({ frontendUrl: FRONTEND_URL, view, identity: alice }),
      bobShell.goto({ frontendUrl: FRONTEND_URL, view, identity: bob }),
    ]);
    await Promise.all([
      waitForActiveSpaceRoot(aliceShell.page(), cc.getSpace()),
      waitForActiveSpaceRoot(bobShell.page(), cc.getSpace()),
    ]);
    await Promise.all([
      waitForRuntimeIdle(aliceShell.page()),
      waitForRuntimeIdle(bobShell.page()),
    ]);
    await Promise.all([
      waitForCondition(aliceShell.page(), editorReady),
      waitForCondition(bobShell.page(), editorReady),
    ]);
    await Promise.all([
      waitForRuntimeIdle(aliceShell.page()),
      waitForRuntimeIdle(bobShell.page()),
    ]);
    await Promise.all([
      waitForCondition(aliceShell.page(), collaborationReady),
      waitForCondition(bobShell.page(), collaborationReady),
    ]);
    await Promise.all([
      listenForCollaborationErrors(aliceShell.page()),
      listenForCollaborationErrors(bobShell.page()),
    ]);
  };

  beforeAll(async () => {
    presenceRelay = startPresenceRelay();
    [alice, bob] = await Promise.all([
      Identity.generate({ implementation: "noble" }),
      Identity.generate({ implementation: "noble" }),
    ]);
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: alice,
    });
    await cc.ensureDefaultPattern();

    const source = await Deno.readTextFile(join(
      import.meta.dirname!,
      "fixtures",
      "collaborative-code-editor.tsx",
    ));
    pieces = {
      concurrent: await cc.create(source, {
        input: { content: "abc" },
        start: true,
      }),
      reload: await cc.create(source, {
        input: { content: "reload" },
        start: true,
      }),
      toggle: await cc.create(source, {
        input: { content: "toggle" },
        start: true,
      }),
      reconcile: await cc.create(source, {
        input: { content: "reset" },
        start: true,
      }),
      rename: await cc.create(source, {
        input: {
          content: "[[📝 Target (backlink-collaboration-piece)]]",
        },
        start: true,
      }),
      legacyReplace: await cc.create(source, {
        input: { content: "legacy string" },
        start: true,
      }),
      presenceUnmount: await cc.create(source, {
        input: { content: "presence" },
        start: true,
      }),
      burst: await cc.create(source, {
        input: { content: "burst" },
        start: true,
      }),
      burstBoth: await cc.create(source, {
        input: { content: "both" },
        start: true,
      }),
      burstEpoch: await cc.create(source, {
        input: { content: "epoch" },
        start: true,
      }),
    };

    await new ACLManager(cc.runtime, cc.getSpace()).set(ANYONE_USER, "WRITE");
    for (const [name, piece] of Object.entries(pieces)) {
      const result = cc.getResult(piece.getCell());
      sinkCancels.push(result.sink((value) => {
        const content = (value as { content?: string } | undefined)?.content;
        if (typeof content !== "string") return;
        latestContent.set(name, content);
        for (const waiter of contentWaiters.get(name) ?? []) {
          if (!waiter.predicate(content)) continue;
          contentWaiters.get(name)?.delete(waiter);
          waiter.resolve(content);
        }
      }));
    }
  });

  afterAll(async () => {
    for (const cancel of sinkCancels) cancel();
    await cc?.dispose();
    await presenceRelay?.close();
  });

  it("converges concurrent same-base edits in both browsers and the ordinary Cell", async () => {
    await navigateBoth(pieces.concurrent);
    const alicePage = aliceShell.page();
    const bobPage = bobShell.page();

    await Promise.all([
      installNextApplyGate(alicePage),
      installNextApplyGate(bobPage),
    ]);
    await Promise.all([
      dispatchEdit(alicePage, 1, 1, "ALICE"),
      dispatchEdit(bobPage, 1, 1, "BOB"),
    ]);
    await Promise.all([
      awaitApplyCaptured(alicePage),
      awaitApplyCaptured(bobPage),
    ]);
    await Promise.all([
      releaseApplyGate(alicePage),
      releaseApplyGate(bobPage),
    ]);
    await Promise.all([
      awaitApplyCompleted(alicePage),
      awaitApplyCompleted(bobPage),
    ]);

    await Promise.all([
      waitForCondition(alicePage, editorContainsTokens, {
        args: [["ALICE", "BOB"]],
      }),
      waitForCondition(bobPage, editorContainsTokens, {
        args: [["ALICE", "BOB"]],
      }),
    ]);
    const [aliceContent, bobContent, materialized] = await Promise.all([
      editorContent(alicePage),
      editorContent(bobPage),
      awaitMaterialized(
        "concurrent",
        (value) => value.includes("ALICE") && value.includes("BOB"),
      ),
    ]);
    assertEquals(aliceContent, bobContent);
    assertEquals(materialized, aliceContent);
    assert(
      aliceContent === "aALICEBOBbc" || aliceContent === "aBOBALICEbc",
      debugStr`unexpected canonical content: $quote,long${aliceContent}`,
    );
    assertEquals(await collaborationErrors(alicePage), []);
    assertEquals(await collaborationErrors(bobPage), []);
  });

  it("reopens the active epoch after reload and accepts further concurrent edits", async () => {
    await navigateBoth(pieces.reload);
    const alicePage = aliceShell.page();
    const bobPage = bobShell.page();

    await dispatchEdit(alicePage, 6, 6, "!");
    await Promise.all([
      waitForCondition(alicePage, editorContainsTokens, { args: [["!"]] }),
      waitForCondition(bobPage, editorContainsTokens, { args: [["!"]] }),
      awaitMaterialized("reload", (value) => value === "reload!"),
    ]);

    await alicePage.reload({ waitUntil: "load" });
    await alicePage.applyConsoleFormatter();
    await aliceShell.login(alice);
    await waitForCondition(alicePage, collaborationReady);
    await listenForCollaborationErrors(alicePage);
    assertEquals(await editorContent(alicePage), "reload!");

    await Promise.all([
      installNextApplyGate(alicePage),
      installNextApplyGate(bobPage),
    ]);
    await Promise.all([
      dispatchEdit(alicePage, 7, 7, "A"),
      dispatchEdit(bobPage, 7, 7, "B"),
    ]);
    await Promise.all([
      awaitApplyCaptured(alicePage),
      awaitApplyCaptured(bobPage),
    ]);
    await Promise.all([
      releaseApplyGate(alicePage),
      releaseApplyGate(bobPage),
    ]);
    await Promise.all([
      awaitApplyCompleted(alicePage),
      awaitApplyCompleted(bobPage),
    ]);
    await Promise.all([
      waitForCondition(alicePage, editorContainsTokens, { args: [["A", "B"]] }),
      waitForCondition(bobPage, editorContainsTokens, { args: [["A", "B"]] }),
    ]);

    const [aliceContent, bobContent, materialized] = await Promise.all([
      editorContent(alicePage),
      editorContent(bobPage),
      awaitMaterialized(
        "reload",
        (value) => value.includes("A") && value.includes("B"),
      ),
    ]);
    assertEquals(aliceContent, bobContent);
    assertEquals(materialized, aliceContent);
    assertEquals(await collaborationErrors(alicePage), []);
    assertEquals(await collaborationErrors(bobPage), []);
  });

  it("replaces a legacy string through an ordinary handler and keeps editing", async () => {
    await navigateBoth(pieces.legacyReplace);
    const alicePage = aliceShell.page();
    const bobPage = bobShell.page();

    assertEquals(await editorContent(alicePage), "legacy string");
    assertEquals(await editorContent(bobPage), "legacy string");
    await Promise.all([
      waitForCondition(alicePage, materializedDisplayEquals, {
        args: ["legacy string"],
      }),
      waitForCondition(bobPage, materializedDisplayEquals, {
        args: ["legacy string"],
      }),
    ]);

    await clickCfButton(alicePage, "#replace-content");
    await Promise.all([
      waitForCondition(alicePage, editorContainsTokens, {
        args: [["random string"]],
      }),
      waitForCondition(bobPage, editorContainsTokens, {
        args: [["random string"]],
      }),
      awaitMaterialized("legacyReplace", (value) => value === "random string"),
      waitForCondition(alicePage, materializedDisplayEquals, {
        args: ["random string"],
      }),
      waitForCondition(bobPage, materializedDisplayEquals, {
        args: ["random string"],
      }),
    ]);
    assertEquals(await editorContent(alicePage), "random string");
    assertEquals(await editorContent(bobPage), "random string");

    await dispatchEdit(
      bobPage,
      "random string".length,
      "random string".length,
      "!",
    );
    await Promise.all([
      waitForCondition(alicePage, editorContainsTokens, {
        args: [["random string!"]],
      }),
      waitForCondition(bobPage, editorContainsTokens, {
        args: [["random string!"]],
      }),
      awaitMaterialized(
        "legacyReplace",
        (value) => value === "random string!",
      ),
      waitForCondition(alicePage, materializedDisplayEquals, {
        args: ["random string!"],
      }),
      waitForCondition(bobPage, materializedDisplayEquals, {
        args: ["random string!"],
      }),
    ]);
    assertEquals(await editorContent(alicePage), "random string!");
    assertEquals(await editorContent(bobPage), "random string!");
    assertEquals(await collaborationErrors(alicePage), []);
    assertEquals(await collaborationErrors(bobPage), []);
  });

  it("removes a participant selection when its editor is unmounted", async () => {
    await navigateBoth(pieces.presenceUnmount);
    const alicePage = aliceShell.page();
    const bobPage = bobShell.page();

    try {
      await dispatchEdit(alicePage, "presence".length, "presence".length, "!");
      await Promise.all([
        waitForCondition(alicePage, editorContainsTokens, {
          args: [["presence!"]],
        }),
        waitForCondition(bobPage, editorContainsTokens, {
          args: [["presence!"]],
        }),
        awaitMaterialized(
          "presenceUnmount",
          (value) => value === "presence!",
        ),
      ]);

      await Promise.all([
        enablePresence(alicePage, "Alice", presenceRelay.url),
        enablePresence(bobPage, "Bob", presenceRelay.url),
      ]);
      await Promise.all([
        selectEditorText(alicePage, 0, 4),
        selectEditorText(bobPage, 0, 0),
      ]);
      await Promise.all([
        waitForCondition(alicePage, presenceConnected),
        waitForCondition(bobPage, presenceConnected),
      ]);

      await waitForCondition(bobPage, remoteSelectionVisible, {
        args: ["Alice"],
      });

      await unmountEditor(alicePage);
      await waitForCondition(bobPage, remoteSelectionAbsent, {
        args: ["Alice"],
      });
      assertEquals(await collaborationErrors(bobPage), []);
    } finally {
      await Promise.all([
        unmountEditor(alicePage),
        unmountEditor(bobPage),
      ]);
    }
  });

  it("dedupes a shared external title rewrite from both browsers", async () => {
    await navigateBoth(pieces.rename);
    const alicePage = aliceShell.page();
    const bobPage = bobShell.page();
    const renamed = "[[📝 New Target (backlink-collaboration-piece)]]";

    await Promise.all([
      installNextApplyGate(alicePage),
      installNextApplyGate(bobPage),
    ]);
    await Promise.all([
      dispatchExternalBacklinkRename(
        alicePage,
        "backlink-collaboration-piece",
        "New Target",
        "📝 New Target",
      ),
      dispatchExternalBacklinkRename(
        bobPage,
        "backlink-collaboration-piece",
        "New Target",
        "📝 New Target",
      ),
    ]);
    await Promise.all([
      awaitApplyCaptured(alicePage),
      awaitApplyCaptured(bobPage),
    ]);
    await Promise.all([
      releaseApplyGate(alicePage),
      releaseApplyGate(bobPage),
    ]);
    await Promise.all([
      awaitApplyCompleted(alicePage),
      awaitApplyCompleted(bobPage),
    ]);

    const [aliceContent, bobContent, materialized] = await Promise.all([
      waitForCondition(alicePage, editorContainsTokens, {
        args: [[renamed]],
      }).then(() => editorContent(alicePage)),
      waitForCondition(bobPage, editorContainsTokens, {
        args: [[renamed]],
      }).then(() => editorContent(bobPage)),
      awaitMaterialized("rename", (value) => value === renamed),
    ]);
    assertEquals(aliceContent, renamed);
    assertEquals(bobContent, renamed);
    assertEquals(materialized, renamed);
    assertEquals(await collaborationErrors(alicePage), []);
    assertEquals(await collaborationErrors(bobPage), []);
  });

  it("flushes an in-flight edit before collaborative mode is disabled", async () => {
    await navigateBoth(pieces.toggle);
    const alicePage = aliceShell.page();
    const bobPage = bobShell.page();

    await installNextApplyGate(alicePage);
    await dispatchEdit(alicePage, 6, 6, "!");
    await awaitApplyCaptured(alicePage);
    await disableCollaboration(alicePage);
    await releaseApplyGate(alicePage);
    await awaitApplyCompleted(alicePage);

    await Promise.all([
      waitForCondition(alicePage, collaborationStopped),
      waitForCondition(alicePage, editorContainsTokens, { args: [["!"]] }),
      waitForCondition(bobPage, editorContainsTokens, { args: [["!"]] }),
      awaitMaterialized("toggle", (value) => value === "toggle!"),
    ]);
    assertEquals(await editorContent(alicePage), "toggle!");
    assertEquals(await editorContent(bobPage), "toggle!");
    assertEquals(await collaborationErrors(alicePage), []);
    assertEquals(await collaborationErrors(bobPage), []);
  });

  it("preserves an unconfirmed local edit when another browser releases its epoch", async () => {
    await navigateBoth(pieces.reconcile);
    const alicePage = aliceShell.page();
    const bobPage = bobShell.page();

    await dispatchEdit(alicePage, 5, 5, "!");
    await Promise.all([
      waitForCondition(alicePage, editorContainsTokens, { args: [["!"]] }),
      waitForCondition(bobPage, editorContainsTokens, { args: [["!"]] }),
      awaitMaterialized("reconcile", (value) => value === "reset!"),
    ]);
    await confirmPendingCollaborationEdits(alicePage);

    await listenForReconciliation(alicePage);
    await installNextApplyGate(alicePage);
    await dispatchEdit(alicePage, 6, 6, "LOCAL");
    await awaitApplyCaptured(alicePage);

    await releaseCollaboration(bobPage);
    await waitForCondition(alicePage, reconciliationReached);
    const detail = await reconciliationDetail(alicePage);
    assertEquals(detail.localValue, "reset!LOCAL");
    assertEquals(detail.canonicalValue, "reset!");
    assert(detail.localCursor !== null);
    assertEquals(detail.canonicalCursor, null);
    assertEquals(await editorContent(alicePage), "reset!LOCAL");
    assertEquals(latestContent.get("reconcile"), "reset!");

    await cancelApplyGate(alicePage);
    await awaitApplyCompleted(alicePage);
    assertEquals(await reconciliationError(alicePage), {
      message: "CodeMirror operation state changed with local edits pending",
      name: "CodeMirrorReconciliationError",
    });
    assertEquals(await collaborationErrors(bobPage), []);
  });

  it("submits every edit of a burst typed during one round trip and keeps them across a reload", async () => {
    // The apply gate holds the first edit's round trip open while six more
    // edits land, the way keystrokes do when typing outruns the network.

    await navigateBoth(pieces.burst);
    const alicePage = aliceShell.page();
    const bobPage = bobShell.page();

    await installNextApplyGate(alicePage);
    await dispatchEdit(alicePage, 5, 5, "1");
    await awaitApplyCaptured(alicePage);
    for (const character of "234567") {
      await appendEdit(alicePage, character);
    }
    await releaseApplyGate(alicePage);
    await awaitApplyCompleted(alicePage);

    await Promise.all([
      waitForCondition(alicePage, editorContainsTokens, {
        args: [["burst1234567"]],
      }),
      waitForCondition(bobPage, editorContainsTokens, {
        args: [["burst1234567"]],
      }),
      awaitMaterialized("burst", (value) => value === "burst1234567"),
    ]);
    assertEquals(await editorContent(bobPage), "burst1234567");

    await alicePage.reload({ waitUntil: "load" });
    await alicePage.applyConsoleFormatter();
    await aliceShell.login(alice);
    await waitForCondition(alicePage, collaborationReady);
    await listenForCollaborationErrors(alicePage);
    assertEquals(await editorContent(alicePage), "burst1234567");
    assertEquals(await collaborationErrors(alicePage), []);
    assertEquals(await collaborationErrors(bobPage), []);
  });

  it("converges bursts typed concurrently in both browsers during one round trip", async () => {
    await navigateBoth(pieces.burstBoth);
    const alicePage = aliceShell.page();
    const bobPage = bobShell.page();
    const aliceTokens = ["A1", "A2", "A3"];
    const bobTokens = ["B1", "B2", "B3"];
    const tokens = [...aliceTokens, ...bobTokens];

    await Promise.all([
      installNextApplyGate(alicePage),
      installNextApplyGate(bobPage),
    ]);
    await Promise.all([
      dispatchEdit(alicePage, 4, 4, aliceTokens[0]),
      dispatchEdit(bobPage, 4, 4, bobTokens[0]),
    ]);
    await Promise.all([
      awaitApplyCaptured(alicePage),
      awaitApplyCaptured(bobPage),
    ]);
    for (const index of [1, 2]) {
      await Promise.all([
        appendEdit(alicePage, aliceTokens[index]),
        appendEdit(bobPage, bobTokens[index]),
      ]);
    }
    await Promise.all([
      releaseApplyGate(alicePage),
      releaseApplyGate(bobPage),
    ]);
    await Promise.all([
      awaitApplyCompleted(alicePage),
      awaitApplyCompleted(bobPage),
    ]);

    await Promise.all([
      waitForCondition(alicePage, editorContainsTokens, { args: [tokens] }),
      waitForCondition(bobPage, editorContainsTokens, { args: [tokens] }),
    ]);
    // Holding every token says each browser has integrated the other's
    // operations, not that its own are confirmed; confirming them is the
    // convergence barrier.
    await Promise.all([
      confirmPendingCollaborationEdits(alicePage),
      confirmPendingCollaborationEdits(bobPage),
    ]);
    const [aliceContent, bobContent] = await Promise.all([
      editorContent(alicePage),
      editorContent(bobPage),
    ]);
    assertEquals(aliceContent, bobContent);
    assertEquals(aliceContent.length, "both".length + 12);
    assertEquals(
      await awaitMaterialized("burstBoth", (value) => value === aliceContent),
      aliceContent,
    );
    assertEquals(await collaborationErrors(alicePage), []);
    assertEquals(await collaborationErrors(bobPage), []);
  });

  it("reports every edit of a burst when another browser releases the epoch during its round trip", async () => {
    await navigateBoth(pieces.burstEpoch);
    const alicePage = aliceShell.page();
    const bobPage = bobShell.page();

    await dispatchEdit(alicePage, 5, 5, "!");
    await Promise.all([
      waitForCondition(alicePage, editorContainsTokens, { args: [["!"]] }),
      waitForCondition(bobPage, editorContainsTokens, { args: [["!"]] }),
      awaitMaterialized("burstEpoch", (value) => value === "epoch!"),
    ]);
    await confirmPendingCollaborationEdits(alicePage);

    await listenForReconciliation(alicePage);
    await installNextApplyGate(alicePage);
    await dispatchEdit(alicePage, 6, 6, "L1");
    await awaitApplyCaptured(alicePage);
    await appendEdit(alicePage, "L2");
    await appendEdit(alicePage, "L3");

    await releaseCollaboration(bobPage);
    // Alice observes the release by failing closed or by adopting the
    // canonical value; only the first is acceptable, and the wait admits
    // both so that the second fails the assertion rather than the wait.
    await waitForCondition(alicePage, epochReleaseObserved, {
      args: ["epoch!"],
    });
    assert(
      await reconciliationReachedNow(alicePage),
      "release with pending edits did not reach reconciliation",
    );
    const detail = await reconciliationDetail(alicePage);
    assertEquals(detail.localValue, "epoch!L1L2L3");
    assertEquals(detail.canonicalValue, "epoch!");
    assert(detail.localCursor !== null);
    assertEquals(detail.canonicalCursor, null);
    assertEquals(await editorContent(alicePage), "epoch!L1L2L3");
    assertEquals(latestContent.get("burstEpoch"), "epoch!");

    await cancelApplyGate(alicePage);
    await awaitApplyCompleted(alicePage);
    assertEquals(await reconciliationError(alicePage), {
      message: "CodeMirror operation state changed with local edits pending",
      name: "CodeMirrorReconciliationError",
    });
    assertEquals(await collaborationErrors(bobPage), []);
  });
});
