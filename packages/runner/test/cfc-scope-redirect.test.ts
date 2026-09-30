import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { hashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";

import { ContextualFlowControl } from "../src/cfc.ts";
import {
  getCfcReferenceProvenance,
  withCfcReferenceConfidentiality,
} from "../src/cfc/reference-provenance.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("cfc-scope-redirect");
const space = signer.did();

const roomSchema = (scope: "user" | "session") => ({
  type: "object",
  scope,
  properties: { list: { type: "array", items: { type: "string" } } },
  required: ["list"],
} as const);

const parentSchema = (scope: "user" | "session") => ({
  type: "object",
  properties: { rooms: roomSchema(scope) },
} as const);

describe("CFC scope redirects", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await storage.synced();
    await runtime.dispose({ closeStorage: false });
    await storage.close();
    resetServerExecutionConfig();
  });

  for (const serverExecution of [false, true]) {
    for (const scope of ["user", "session"] as const) {
      it(`retains the ${scope} cap on an omitted scoped field (serverExecution=${serverExecution})`, async () => {
        setServerExecutionConfig(serverExecution);
        const parent = runtime.getCell<{ rooms?: unknown }>(
          space,
          "omitted",
          parentSchema(scope),
        );
        await parent.sync();
        const write = runtime.edit();
        parent.withTx(write).set({});
        expect((await write.commit()).error).toBeUndefined();
        const read = runtime.edit();
        const source = parent.withTx(read).key("rooms");
        const reference = parseLink(
          source.getRawUntyped(),
          source.getAsNormalizedFullLink(),
        );
        expect(reference?.scope).toBe(
          serverExecution && scope === "session" ? "user" : scope,
        );
        expect(ContextualFlowControl.getSchemaScopeCap(reference?.schema)).toBe(
          scope,
        );
        read.abort();
      });
      for (const existing of ["new", "scoped", "unscoped"] as const) {
        it(`retains the ${scope} cap on ${existing === "new" ? "a new" : `an existing ${existing}`} redirect (serverExecution=${serverExecution})`, async () => {
          setServerExecutionConfig(serverExecution);
          const parent = runtime.getCell<{ rooms?: unknown }>(
            space,
            "rooms",
            parentSchema(scope),
          );
          await parent.sync();
          if (existing !== "new") {
            const setup = runtime.edit();
            const target = runtime.getCellFromLink(
              {
                ...parent.key("rooms").getAsNormalizedFullLink(),
                scope,
                scopeCaps: undefined,
              },
              roomSchema(scope),
              setup,
            );
            target.set({ list: ["one"] });
            parent.withTx(setup).key("rooms").set(
              existing === "unscoped" ? target.getAsLink() : target,
            );
            expect((await setup.commit()).error).toBeUndefined();
          }

          const write = runtime.edit();
          parent.withTx(write).key("rooms").set({ list: ["one", "two"] });
          expect((await write.commit()).error).toBeUndefined();

          const cold = new Runtime({
            apiUrl: new URL("https://example.com"),
            storageManager: storage,
            cfcFlowLabels: "persist",
          });
          try {
            const read = cold.edit();
            const source = cold.getCellFromLink(
              parent.getAsNormalizedFullLink(),
              undefined,
              read,
            ).key("rooms");
            await source.sync();
            const raw = source.getRawUntyped();
            const reference = parseLink(raw, source);
            expect(reference).toBeDefined();
            expect(reference!.scope).toBe(
              serverExecution && scope === "session" ? "user" : scope,
            );
            expect(ContextualFlowControl.getSchemaScopeCap(reference!.schema))
              .toBe(scope);
            expect(getCfcReferenceProvenance(raw)?.scopeCaps).toBeDefined();
            expect(source.get()).toEqual({ list: ["one", "two"] });
            if (serverExecution && scope === "session") {
              const middle = cold.getCellFromLink(reference!, undefined, read);
              await middle.sync();
              const final = parseLink(middle.getRawUntyped(), middle);
              expect(final?.scope).toBe("session");
              expect(ContextualFlowControl.getSchemaScopeCap(final?.schema))
                .toBe(
                  "session",
                );
            }
            read.abort();
          } finally {
            await cold.dispose({ closeStorage: false });
          }
        });
      }
    }
  }

  for (const redirect of [false, true]) {
    const referenceKind = redirect ? "write redirect" : "reference";

    it(`retains confidentiality and scope on a same-binding ${referenceKind} upgrade`, async () => {
      const target = runtime.getCell(
        space,
        "private target",
        roomSchema("user"),
      );
      const output = runtime.getCell(space, "private output", {
        ifc: { confidentiality: ["private-selection"] },
      });
      await Promise.all([target.sync(), output.sync()]);
      const setup = runtime.edit();
      target.withTx(setup).set({ list: ["one"] });
      output.withTx(setup).set({
        selected: redirect
          ? target.getAsWriteRedirectLink()
          : target.getAsLink(),
      });
      expect((await setup.commit()).error).toBeUndefined();

      const acquire = runtime.edit();
      const held = runtime.getCellFromLink(
        target.getAsNormalizedFullLink(),
        undefined,
        acquire,
        withCfcReferenceConfidentiality(undefined, ["private-selection"]),
      ).asSchema(roomSchema("user")).withTx(undefined);
      acquire.abort();
      const write = runtime.edit();
      output.withTx(write).set({
        selected: redirect
          ? held.getAsWriteRedirectLink({ includeSchema: true })
          : held.getAsLink({ includeSchema: true }),
      });
      expect((await write.commit()).error).toBeUndefined();

      const cold = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: storage,
        cfcFlowLabels: "persist",
      });
      try {
        const read = cold.edit();
        const source = cold.getCellFromLink(
          output.getAsNormalizedFullLink(),
          undefined,
          read,
        ).key("selected");
        await source.sync();
        const raw = read.readValueOrThrow(source.getAsNormalizedFullLink());
        const parsed = parseLink(raw, source);
        expect(ContextualFlowControl.getSchemaScopeCap(parsed?.schema)).toBe(
          "user",
        );
        expect(parsed?.overwrite).toBe(redirect ? "redirect" : undefined);
        const resolved = source.resolveAsCell();
        expect(getCfcReferenceProvenance(resolved)?.confidentiality)
          .toContainEqual("private-selection");
        expect(resolved.get()).toEqual({ list: ["one"] });
        read.abort();
      } finally {
        await cold.dispose({ closeStorage: false });
      }
    });

    it(`keeps an existing stricter cap on a same-binding ${referenceKind} rewrite`, async () => {
      const setup = runtime.edit();
      const target = runtime.getCell(
        space,
        "stricter target",
        roomSchema("user"),
        setup,
      );
      target.set({ list: ["one"] });
      const output = runtime.getCell(
        space,
        "stricter output",
        undefined,
        setup,
      );
      output.set({
        selected: redirect
          ? target.getAsWriteRedirectLink({ includeSchema: true })
          : target,
      });
      expect((await setup.commit()).error).toBeUndefined();

      const write = runtime.edit();
      const before = write.readValueOrThrow(
        output.key("selected").getAsNormalizedFullLink(),
      );
      const independent = runtime.getCellFromLink(
        target.getAsNormalizedFullLink(),
        roomSchema("session"),
        write,
      );
      output.withTx(write).set({
        selected: redirect
          ? independent.getAsWriteRedirectLink({ includeSchema: true })
          : independent,
      });
      expect((await write.commit()).error).toBeUndefined();

      const read = runtime.edit();
      const after = read.readValueOrThrow(
        output.key("selected").getAsNormalizedFullLink(),
      );
      expect(hashStringOf(after)).toBe(hashStringOf(before));
      expect(
        ContextualFlowControl.getSchemaScopeCap(
          parseLink(after, output.key("selected"))?.schema,
        ),
      ).toBe("user");
      read.abort();
    });

    it(`still refuses an explicit widening of an acquired ${referenceKind}`, async () => {
      const setup = runtime.edit();
      const target = runtime.getCell(
        space,
        "target",
        roomSchema("user"),
        setup,
      );
      target.set({ list: ["one"] });
      expect((await setup.commit()).error).toBeUndefined();
      const write = runtime.edit();
      const widened = target.withTx(write).asSchema(roomSchema("session"));
      const output = runtime.getCell(space, "output", undefined, write);
      await output.sync();
      expect(() =>
        output.set(
          redirect
            ? widened.getAsWriteRedirectLink({ includeSchema: true })
            : widened,
        )
      ).toThrow(
        "Reference acquisition scope cap cannot be widened for storage",
      );
      write.abort();
    });
  }
});
