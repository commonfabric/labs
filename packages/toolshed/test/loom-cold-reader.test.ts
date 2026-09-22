import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { Server } from "@commonfabric/memory/v2/server";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { LoopbackStorageManager } from "@commonfabric/runner/executor/loopback-storage";
import { Identity } from "@commonfabric/identity";
import {
  ACLManager,
  type Cell,
  isCell,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { debugVDOMSchema } from "@commonfabric/runner/schemas";
import {
  genesisAcl,
  LoopbackSessionFactory,
  TestStorageManager,
} from "@/lib/test-support/memory-acl.ts";

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

describe("loom-cold-reader", () => {
  for (const serverExecution of [false, true]) {
    it(`renders panel content for a cold READ viewer with serverExecution=${serverExecution}`, async () => {
      const owner = await Identity.fromPassphrase("cold-loom-owner");
      const reader = await Identity.fromPassphrase("cold-loom-reader");
      const space = await Identity.fromPassphrase("cold-loom-space");
      const operator = await Identity.fromPassphrase("cold-loom-operator");
      const server = new Server({
        store: new URL(`memory://cold-loom-${crypto.randomUUID()}`),
        authorizeSessionOpen(message, context) {
          const principal = (message.authorization as { principal?: unknown })
            ?.principal;
          return typeof principal === "string"
            ? principal
            : verifySessionOpenAuthorization(message, context);
        },
        sessionOpenAuth: { audience: "did:key:cold-loom-service" },
        acl: { mode: "enforce", delegatingDids: [operator.did()] },
        subscriptionRefreshDelayMs: 0,
      });
      let host: ExecutorHost | undefined;
      const factory = new LoopbackSessionFactory(server);
      const runtimes: Runtime[] = [];
      const client = (identity: Identity, served = false) => {
        const storageManager = TestStorageManager.overServer(
          { as: identity },
          factory,
        );
        const runtime = new Runtime(runtimePresets.remoteClient({
          apiUrl: new URL("http://cold-loom.test"),
          storageManager,
          experimental: { serverExecution: served, computedCellIds: true },
          trustSnapshotProvider: () => ({
            id: identity.did(),
            actingPrincipal: identity.did(),
          }),
        }));
        runtimes.push(runtime);
        return runtime;
      };
      const stops: (() => void)[] = [];
      try {
        await genesisAcl(factory, space, {
          [owner.did()]: "OWNER",
          [reader.did()]: "READ",
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
          [reader.did()]: "READ",
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
        await publisher.dispose();
        runtimes.splice(runtimes.indexOf(publisher), 1);
        if (serverExecution) {
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
        }
        const viewer = client(reader, serverExecution);
        expect(
          (await new ACLManager(viewer, space.did()).get())?.[reader.did()],
        ).toBe("READ");
        const viewedRoot = viewer.getCellFromLink(rootRef);
        if (!serverExecution) await viewer.start(viewedRoot);
        const ui = viewedRoot.asSchema(debugVDOMSchema);
        stops.push(ui.sink(() => {}));
        await ui.pull();
        await viewer.idle();
        const value = serverExecution
          ? await waitForCellValue(
            viewer,
            ui,
            (value) =>
              ["Cold URL title", "Cold document", "Open piece"].every((text) =>
                visibleText(value).includes(text)
              ),
            { stuckLabel: "cold READ root served" },
          )
          : await ui.pull();
        const renderedChildren: unknown[] = [];
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
        for (const target of renderTargets(value)) {
          await target.sync();
          if (!serverExecution) await viewer.start(target);
          const childUi = target.asSchema(debugVDOMSchema);
          stops.push(childUi.sink(() => {}));
          await childUi.pull();
          await viewer.idle();
          const childValue = serverExecution
            ? await waitForCellValue(
              viewer,
              childUi,
              (value) => visibleText(value).includes("Cold foreign piece"),
              {
                stuckLabel: "cold READ linked piece served",
              },
            )
            : await childUi.pull();
          renderedChildren.push(childValue);
        }
        const views = [value, ...renderedChildren];
        expect(visibleText(views)).toContain("Cold URL title");
        expect(visibleText(views)).toContain("Open in new tab");
        expect(visibleText(views)).toContain("Cold document");
        expect(visibleText(views)).toContain("Original source");
        expect(visibleText(views)).toContain("Cold foreign piece");
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
        const updater = client(owner);
        const boundNotes = updater.getCellFromLink(textareas[0].getAsLink());
        await boundNotes.sync();
        await updater.editWithRetry((tx) => {
          boundNotes.withTx(tx).set("Collaborative edit through UI binding");
        });
        const updatedDocument = updater.getCellFromLink(document.getAsLink());
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
          { stuckLabel: "published source refresh in READ view" },
        );
        expect(visibleText(refreshed)).toContain("Cold document");
        const readerDocument = viewer.getCellFromLink(document.getAsLink());
        await readerDocument.sync();
        expect(readerDocument.key("notes").get()).toBe(
          "Collaborative edit through UI binding",
        );
        expect(
          (await new ACLManager(viewer, space.did()).get())?.[reader.did()],
        ).toBe("READ");
      } finally {
        for (const stop of stops) stop();
        for (const runtime of runtimes) await runtime.dispose();
        await host?.close();
        await server.close();
      }
    });
  }
});
