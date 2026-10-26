import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { Server } from "@commonfabric/memory/v2/server";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { LoopbackStorageManager } from "@commonfabric/runner/executor/loopback-storage";
import { Identity } from "@commonfabric/identity";
import {
  ACLManager,
  type Cell,
  isCell,
  Runtime,
  runtimePresets,
  type RuntimeTelemetryEvent,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { debugVDOMSchema } from "@commonfabric/runner/schemas";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import {
  genesisAcl,
  LoopbackSessionFactory,
  TestStorageManager,
} from "@/lib/test-support/memory-acl.ts";

/** The access a viewer holds on the loom's space and on the piece's. */
type ViewerAccess = "READ" | "WRITE";

const viewChildren = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  return [node.$UI, node.children];
};

const visibleText = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return viewChildren(value).map(visibleText).join("");
};

const renderTargets = (value: unknown): Cell<unknown>[] => {
  if (!value || typeof value !== "object" || isCell(value)) return [];
  const node = value as Record<string, unknown>;
  const props = node.props as Record<string, unknown> | undefined;
  const target = node.name === "cf-render" ? props?.$cell : undefined;
  return [
    ...(isCell(target) ? [target] : []),
    ...viewChildren(node).flatMap(renderTargets),
  ];
};

/** The text each of the three published panels renders. */
const PANEL_TEXTS = ["Cold URL title", "Cold document", "Cold foreign piece"];

describe("loom-cold-reader", () => {
  /**
   * Publishes a loom root holding a URL panel, a document panel, and a piece
   * panel from another space, as the owner of both spaces, grants a viewer
   * `access` on each, and disposes the publisher. Returns what a viewer needs
   * to open the root and what the test needs to tear everything down.
   */
  const publishColdLoom = async (access: ViewerAccess) => {
    const owner = await Identity.fromPassphrase("cold-loom-owner");
    const viewerIdentity = await Identity.fromPassphrase("cold-loom-viewer");
    const space = await Identity.fromPassphrase("cold-loom-space");
    const operator = await Identity.fromPassphrase("cold-loom-operator");
    const server = new Server({
      store: new URL(`memory://cold-loom-${crypto.randomUUID()}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:cold-loom-service" },
      acl: { mode: "enforce", delegatingDids: [operator.did()] },
      subscriptionRefreshDelayMs: 0,
    });
    const factory = new LoopbackSessionFactory(server);
    const runtimes: Runtime[] = [];
    const client = (
      identity: Identity,
      served = false,
      localFold = false,
    ) => {
      const storageManager = TestStorageManager.overServer(
        { as: identity },
        factory,
      );
      const runtime = new Runtime(runtimePresets.remoteClient({
        apiUrl: new URL("http://cold-loom.test"),
        storageManager,
        experimental: {
          serverExecution: served,
          computedCellIds: true,
          localFold,
        },
        trustSnapshotProvider: () => ({
          id: identity.did(),
          actingPrincipal: identity.did(),
        }),
      }));
      runtimes.push(runtime);
      return runtime;
    };
    const stops: (() => void)[] = [];
    let host: ExecutorHost | undefined;
    const close = async () => {
      for (const stop of stops) stop();
      for (const runtime of runtimes) await runtime.dispose();
      await host?.close();
      await server.close();
    };
    try {
      await genesisAcl(factory, space, {
        [owner.did()]: "OWNER",
        [viewerIdentity.did()]: access,
      });
      const publisher = client(owner);
      const program = await resolveLocalProgram(
        publisher.harness.resolve.bind(publisher.harness),
        {
          root: fromFileUrl(new URL("../../patterns/", import.meta.url)),
          main: fromFileUrl(
            new URL("../../patterns/loom/main.tsx", import.meta.url),
          ),
        },
      );
      const compiled = await publisher.patternManager.compilePattern(
        program,
        { space: space.did() },
      );
      const panel = publisher.getCell(space.did(), { fixture: "url-panel" });
      await publisher.editWithRetry((tx) => {
        panel.withTx(tx).set({
          kind: "url",
          url: "https://example.com/",
          titleOverride: "Cold URL title",
        });
      });
      const document = publisher.getCell(space.did(), {
        fixture: "document",
      });
      const documentPanel = publisher.getCell(space.did(), {
        fixture: "document-panel",
      });
      await publisher.editWithRetry((tx) => {
        document.withTx(tx).set({
          source: {
            kind: "page-excerpt",
            title: "Cold document",
            body: "Original source",
          },
          notes: "Reader notes",
        });
        documentPanel.withTx(tx).set({ kind: "document", content: document });
      });
      const foreignSpace = await Identity.fromPassphrase("cold-loom-foreign");
      await genesisAcl(factory, foreignSpace, {
        [owner.did()]: "OWNER",
        [viewerIdentity.did()]: access,
      });
      const piecePattern = await publisher.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `import { pattern, UI, type VNode } from "commonfabric";
            export default pattern<{}, { [UI]: VNode }>(() => ({
              [UI]: <p>Cold foreign piece</p>,
            }));`,
        }],
      }, { space: foreignSpace.did() });
      const piece = publisher.getCell(foreignSpace.did(), {
        fixture: "piece",
      });
      await publisher.runSynced(piece, piecePattern, {});
      const piecePanel = publisher.getCell(space.did(), {
        fixture: "piece-panel",
      });
      await publisher.editWithRetry((tx) => {
        piecePanel.withTx(tx).set({ kind: "piece", piece });
      });
      const root = publisher.getCell(space.did(), { fixture: "loom-root" });
      await publisher.runSynced(root, compiled, {
        title: "Cold shared root",
        panels: [panel, documentPanel, piecePanel],
      });
      const rootRef = root.getAsLink();
      const documentRef = document.getAsLink();
      await publisher.dispose();
      runtimes.splice(runtimes.indexOf(publisher), 1);
      const serve = () => {
        host = new ExecutorHost({
          server,
          serviceIdentity: operator.did(),
          ensureSpaceRoots: false,
          createRuntime: (servedSpace) => {
            const storageManager = LoopbackStorageManager.connect(server, {
              as: operator,
              servingHomeSpace: servedSpace,
            });
            const runtime = new Runtime({
              apiUrl: new URL("http://cold-loom.test"),
              storageManager,
              servingPosture: true,
              experimental: { serverExecution: true, computedCellIds: true },
            });
            return Promise.resolve({
              runtime,
              dispose: () => runtime.dispose(),
            });
          },
        });
      };
      return {
        access,
        owner,
        viewerIdentity,
        space,
        rootRef,
        documentRef,
        client,
        serve,
        stops,
        close,
      };
    } catch (error) {
      await close();
      throw error;
    }
  };

  type ColdLoom = Awaited<ReturnType<typeof publishColdLoom>>;

  /**
   * Opens the root as the viewer, served or run locally, and checks that every
   * panel renders, that the viewer's bindings reach the published document,
   * that a later edit by the owner reaches the viewer, and that nothing the
   * viewer pushed was refused. Returns the viewer's runtime.
   */
  const expectPanelsRendered = async (
    loom: ColdLoom,
    served: boolean,
    localFold = false,
  ) => {
    const { access, viewerIdentity, space, rootRef, documentRef, client } =
      loom;
    const { stops } = loom;
    if (served) loom.serve();
    const viewer = client(viewerIdentity, served, localFold);
    let refusals = 0;
    viewer.telemetry.addEventListener("telemetry", (event) => {
      const { marker } = event as RuntimeTelemetryEvent;
      if (
        marker.type === "storage.push.error" &&
        marker.error === "AuthorizationError"
      ) {
        refusals++;
      }
    });
    expect(
      (await new ACLManager(viewer, space.did()).get())?.[viewerIdentity.did()],
    ).toBe(access);
    const viewedRoot = viewer.getCellFromLink(rootRef);
    if (!served) await viewer.start(viewedRoot);
    const ui = viewedRoot.asSchema(debugVDOMSchema);
    stops.push(ui.sink(() => {}));
    await ui.pull();
    await viewer.idle();
    const value = served
      ? await waitForCellValue(
        viewer,
        ui,
        (value) =>
          ["Cold URL title", "Cold document", "Open piece"].every((text) =>
            visibleText(value).includes(text)
          ),
        { stuckLabel: `cold ${access} root served` },
      )
      : await ui.pull();
    const renderedChildren: unknown[] = [];
    for (const target of renderTargets(value)) {
      await target.sync();
      if (!served) await viewer.start(target);
      const childUi = target.asSchema(debugVDOMSchema);
      stops.push(childUi.sink(() => {}));
      await childUi.pull();
      await viewer.idle();
      renderedChildren.push(
        served
          ? await waitForCellValue(
            viewer,
            childUi,
            (value) => visibleText(value).includes("Cold foreign piece"),
            { stuckLabel: `cold ${access} linked piece served` },
          )
          : await childUi.pull(),
      );
    }
    const views = [value, ...renderedChildren];
    for (const text of PANEL_TEXTS) {
      expect(visibleText(views)).toContain(text);
    }
    expect(visibleText(views)).toContain("Open in new tab");
    expect(visibleText(views)).toContain("Original source");
    const textareas: Cell<unknown>[] = [];
    const collectNotesBindings = (value: unknown) => {
      if (!value || typeof value !== "object" || isCell(value)) return;
      const node = value as Record<string, unknown>;
      const props = node.props as Record<string, unknown> | undefined;
      if (node.name === "cf-textarea" && isCell(props?.$value)) {
        textareas.push(props.$value);
      }
      for (const child of viewChildren(value)) collectNotesBindings(child);
    };
    collectNotesBindings(value);
    expect(textareas).toHaveLength(1);
    const updater = client(loom.owner);
    const boundNotes = updater.getCellFromLink(textareas[0].getAsLink());
    await boundNotes.sync();
    await updater.editWithRetry((tx) => {
      boundNotes.withTx(tx).set("Collaborative edit through UI binding");
    });
    const updatedDocument = updater.getCellFromLink(documentRef);
    await updatedDocument.sync();
    await updater.editWithRetry((tx) => {
      updatedDocument.withTx(tx).key("source").key("body").set(
        "Refreshed source",
      );
    });
    const refreshed = await waitForCellValue(
      viewer,
      ui,
      (value) => visibleText(value).includes("Refreshed source"),
      { stuckLabel: `published source refresh in ${access} view` },
    );
    expect(visibleText(refreshed)).toContain("Cold document");
    const viewerDocument = viewer.getCellFromLink(documentRef);
    await viewerDocument.sync();
    expect(viewerDocument.key("notes").get()).toBe(
      "Collaborative edit through UI binding",
    );
    expect(
      (await new ACLManager(viewer, space.did()).get())?.[viewerIdentity.did()],
    ).toBe(access);
    expect(refusals).toBe(0);
    return viewer;
  };

  it("renders panel content for a cold READ viewer with serverExecution=true", async () => {
    const loom = await publishColdLoom("READ");
    try {
      await expectPanelsRendered(loom, true);
    } finally {
      await loom.close();
    }
  });

  it("renders panel content for a cold WRITE viewer with serverExecution=true", async () => {
    const loom = await publishColdLoom("WRITE");
    try {
      await expectPanelsRendered(loom, true);
    } finally {
      await loom.close();
    }
  });

  it("renders panel content for a cold WRITE viewer that runs it locally", async () => {
    const loom = await publishColdLoom("WRITE");
    try {
      await expectPanelsRendered(loom, false);
    } finally {
      await loom.close();
    }
  });

  it("renders panel content for a cold READ viewer that runs it locally under localFold", async () => {
    // The viewer's runtime holds its derivations before any push, so the
    // fold has nothing to keep and the flag changes nothing about the view.

    const loom = await publishColdLoom("READ");
    try {
      await expectPanelsRendered(loom, false, true);
    } finally {
      await loom.close();
    }
  });

  it("renders panel content for a cold READ viewer that runs it locally", async () => {
    // The viewer's own run derives the state the panels rest on, the panel
    // list's result container first, into instances the space refuses a READ
    // principal's writes to. The viewer's runtime holds those derivations
    // and pushes none of them, so the view is the one a served viewer sees.

    const loom = await publishColdLoom("READ");
    try {
      const viewer = await expectPanelsRendered(loom, false);
      expect(viewer.localDerivation?.heldCount(loom.space.did()))
        .toBeGreaterThan(0);
    } finally {
      await loom.close();
    }
  });
});
