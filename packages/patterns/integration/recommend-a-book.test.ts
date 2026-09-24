/** The authored book pair publishes a shelf within one dedicated space. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { fromFileUrl, join } from "@std/path";

import { cfcAtom } from "@commonfabric/api/cfc";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  type Cell,
  isCell,
  parseLink,
  PatternCoverageCollector,
  Runtime,
  UI,
  writePatternCoverageLcov,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  commitSnapshotShare,
  prepareSnapshotShare,
} from "../../runner/src/cfc/share-snapshot.ts";
import { markRendererTrustedEvent } from "../../runner/src/cfc/ui-contract.ts";
import { seedHomeAgentQueue } from "../../runner/test/support/agent-queue.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** Reads the native component bindings from the compiled invitation surface. */
async function elementProps(
  node: unknown,
  tag: string,
  text?: string,
): Promise<Cell<unknown> | undefined> {
  if (isCell(node)) {
    await node.pull();
    return elementProps(node.get(), tag, text);
  }
  const value = node;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = await elementProps(child, tag, text);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const element = value as Record<string, unknown>;
  if ("$UI" in element) return elementProps(element.$UI, tag, text);
  const name = isCell(element.name) ? element.name.get() : element.name;
  if (
    name === tag &&
    (text === undefined || (await childText(element.children)).includes(text))
  ) {
    return isCell(element.props) ? element.props : undefined;
  }
  return elementProps(element.children, tag, text);
}

/** Reads rendered text to identify the invitation's navigation button. */
async function childText(value: unknown): Promise<string> {
  if (isCell(value)) {
    await value.pull();
    return childText(value.get());
  }
  if (Array.isArray(value)) {
    return (await Promise.all(value.map(childText))).join(" ");
  }
  return typeof value === "string" ? value : "";
}

/** Resolves a native binding through the renderer's raw-link preference. */
function binding(props: Cell<unknown>, name: string): Cell<unknown> {
  const prop = props.key(name).asSchema(true);
  if (name.startsWith("on")) return prop.resolveAsCell();
  const raw = props.getRawUntyped({ frozen: false }) as Record<string, unknown>;
  const link = parseLink(raw[name], props.getAsNormalizedFullLink());
  return link?.id && link.space
    ? props.runtime.getCellFromLink(link)
    : prop.resolveAsCell();
}

/** Marks the trusted host action that the native confirmation sends. */
function shareClick() {
  const event = {
    type: "click",
    provenance: {
      origin: "dom",
      trusted: true,
      ui: { pattern: "ShareSnapshot" },
    },
  };
  markRendererTrustedEvent(event);
  return event;
}

describe("personalized book invitation", () => {
  it("seeds the library and publishes a reviewed invitation in the same space", async () => {
    const identity = await Identity.fromPassphrase(
      "book invitation originator",
    );
    const storage = StorageManager.emulate({ as: identity });
    const coverageDir = Deno.env.get("CF_PATTERN_COVERAGE_DIR");
    const coverage = coverageDir ? new PatternCoverageCollector() : undefined;
    const navigations: string[] = [];
    const runtime = new Runtime({
      navigateCallback: (target) => {
        navigations.push(entityRefToString(target.entityId));
      },
      patternCoverage: coverage,
      apiUrl: new URL("https://fabric.example/"),
      storageManager: storage,
      experimental: { agentBuiltin: true, serverExecution: false },
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    try {
      const program = await resolveLocalProgram(
        (request) => runtime.harness.resolve(request),
        { main: `${ROOT}recommend-a-book/library.tsx`, root: ROOT },
      );
      const profileSpace = await Identity.fromPassphrase(
        "book originator profile",
      );
      const profileTx = runtime.edit();
      const profile = runtime.getCell(profileSpace.did(), "reader-profile", {
        type: "object",
        properties: { name: { type: "string" } },
      }, profileTx);
      profile.set({ name: "Originator" });
      expect((await profileTx.commit()).error).toBeUndefined();
      const tx = runtime.edit();
      const factory = await runtime.patternManager.compilePattern(program, {
        space: identity.did(),
        tx,
      });
      const resultSchema = factory.resultSchema as {
        properties: {
          invitation: { $ref: string };
          invitations: { items: { $ref: string } };
        };
        $defs: Record<string, { required: string[] }>;
      };
      expect(resultSchema.properties.invitation.$ref).not.toBe(
        resultSchema.properties.invitations.items.$ref,
      );
      const invitationDefinition = resultSchema.properties.invitation.$ref
        .split("/").at(-1)!;
      expect(resultSchema.$defs[invitationDefinition].required).toContain(
        "library",
      );
      expect(resultSchema.$defs[invitationDefinition].required).not.toContain(
        "publish",
      );
      seedHomeAgentQueue(runtime, identity.did(), tx);
      const home = runtime.getCell(
        identity.did(),
        "test-home-default-pattern",
        undefined,
        tx,
      );
      home.key("profiles").set([profile]);
      home.key("defaultProfile").set(profile);
      const library = runtime.run(
        tx,
        factory,
        {},
        runtime.getCell(
          identity.did(),
          "personal-library",
          factory.resultSchema,
          tx,
        ),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      const run = library.key("seeding", "run");
      await waitForCellValue(runtime, run, (value) => value !== undefined, {
        stuckLabel: "the personal library submits its seeding request",
      });
      const complete = runtime.edit();
      const seed = runtime.getCell(identity.did(), "library-seed-result", {
        type: "object",
        ifc: { confidentiality: [cfcAtom.user(identity.did())] },
      }, complete);
      seed.set({
        books: [{ title: "Kindred", author: "Octavia E. Butler" }],
        favoriteAuthors: ["Ursula K. Le Guin"],
      });
      run.withTx(complete).key("result").set(seed);
      run.withTx(complete).key("state").set("completed");
      expect((await complete.commit()).error).toBeUndefined();
      await waitForCellValue(
        runtime,
        library.key("reading", "books"),
        (value) => Array.isArray(value) && value.length === 1,
        {
          stuckLabel: "the agent result seeds the visible reading list",
        },
      );
      await runtime.editWithRetry((tx) =>
        library.withTx(tx).key("addBook").send({
          title: "Solaris",
          author: "Stanisław Lem",
        })
      );
      await waitForCellValue(
        runtime,
        library.key("reading", "books"),
        (value) => Array.isArray(value) && value.length === 2,
        {
          stuckLabel: "the reader adds a book to the seeded list",
        },
      );
      await runtime.editWithRetry((tx) =>
        library.withTx(tx).key("createInvitation").send()
      );
      await waitForCellValue(
        runtime,
        library.key("invitationReady"),
        (value) => value === true,
        {
          stuckLabel: "the create action makes the invitation available",
        },
      );
      const invitation = library.key("invitation");
      expect(invitation.getAsNormalizedFullLink().space).toBe(identity.did());
      await invitation.sync();
      const view = library.key(UI).asSchema(rendererVDOMSchema);
      const shareProps = await elementProps(view, "cf-share-snapshot");
      expect(shareProps).toBeDefined();
      if (!shareProps) throw new Error("The native sharing surface is absent");
      const rawShareProps = shareProps.getRawUntyped({
        frozen: false,
      }) as Record<string, unknown>;
      expect(rawShareProps.audienceKind).toBe("space");
      const source = binding(shareProps, "$source");
      const recipient = binding(shareProps, "$recipient");
      const sharedResult = binding(shareProps, "$result");
      expect(source.equals(library.key("reading").resolveAsCell())).toBe(true);
      expect(recipient.equals(invitation.resolveAsCell())).toBe(true);
      expect(sharedResult.equals(
        library.key("publishedLibrary", "value").resolveAsCell(),
      )).toBe(true);
      const prepared = prepareSnapshotShare(source, { space: recipient });
      expect(prepared.audience).toEqual(cfcAtom.space(
        invitation.getAsNormalizedFullLink().space,
      ));
      const shared = await commitSnapshotShare(prepared.consent, shareClick());
      const committed = await runtime.commitUiCellWrite(
        sharedResult,
        shared.getAsLink(),
        { blind: true },
      );
      expect(committed.error).toBeUndefined();
      await runtime.idle();
      expect(invitation.key("library", "value", "books").get()).toEqual([
        { title: "Kindred", author: "Octavia E. Butler" },
        { title: "Solaris", author: "Stanisław Lem" },
      ]);
      expect(invitation.key("library", "value", "favoriteAuthors").get())
        .toEqual(["Ursula K. Le Guin"]);
      const publicPointer = invitation.key("library", "value").resolveAsCell();
      expect(publicPointer.equals(library.key("reading"))).toBe(false);
      expect(library.key("reading", "books").get()).toEqual([
        { title: "Kindred", author: "Octavia E. Butler" },
        { title: "Solaris", author: "Stanisław Lem" },
      ]);
      const openProps = await elementProps(
        view,
        "cf-button",
        "Open recommendation invitation",
      );
      expect(openProps).toBeDefined();
      if (!openProps) throw new Error("The invitation needs an open action");
      const open = binding(openProps, "onClick");
      open.send({});
      await runtime.settled();
      expect(navigations).toEqual([
        entityRefToString(invitation.resolveAsCell().entityId),
      ]);
    } finally {
      if (coverage && coverageDir) {
        await writePatternCoverageLcov(
          coverage,
          join(
            coverageDir,
            "recommend-a-book-integration.pattern-coverage.lcov",
          ),
          { root: ROOT, testName: "recommend-a-book integration" },
        );
      }
      await runtime.dispose();
    }
  });
});
