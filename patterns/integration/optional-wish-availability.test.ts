/** Optional consumers remain usable when a discovered capability is retired. */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  isObsolete,
  isUnavailable,
  UNAVAILABLE_PENDING,
  UNAVAILABLE_SYNCING,
  unavailableError,
  unavailableObsolete,
} from "@commonfabric/data-model/availability";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import {
  type Cell,
  isCell,
  raw,
  Runtime,
  sendEvent,
  systemPatternSource,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("optional wish availability");
const space = signer.did();

/** Reads text from the cell-backed view nodes rendered by these consumers. */
function textOf(value: unknown): string {
  if (isCell(value)) return textOf(value.get());
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (typeof value !== "object" || value === null) return "";
  const node = value as Record<string, unknown>;
  return textOf(node.$UI) + textOf(node.children);
}

/** Finds rendered elements without importing authored pattern modules. */
function elementsOf(
  value: unknown,
  name: string,
): Readonly<Record<string, unknown>>[] {
  if (isCell(value)) return elementsOf(value.get(), name);
  if (Array.isArray(value)) {
    return value.flatMap((child) => elementsOf(child, name));
  }
  if (!isObjectNotArray(value)) return [];
  return [
    ...(value.name === name ? [value] : []),
    ...elementsOf(value.$UI, name),
    ...elementsOf(value.children, name),
  ];
}

/** Reads an element's cell-backed prop as the renderer would. */
function propOf(
  node: Readonly<Record<string, unknown>>,
  name: string,
): unknown {
  const props = isCell(node.props) ? node.props.get() : node.props;
  if (!isObjectNotArray(props)) throw new Error("Expected element props.");
  return isCell(props[name]) ? props[name].get() : props[name];
}

describe("optional-wish-availability", () => {
  let runtime: Runtime;
  let controlled: Map<string, Cell<unknown>>;
  let errors: unknown[];
  let observers: (() => void)[];

  beforeEach(() => {
    errors = [];
    observers = [];
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
      errorHandlers: [(error) => {
        errors.push(error);
      }],
    });
    controlled = new Map();
    for (const ref of ["wish", "fetchJson", "generateText"]) {
      const delegate = runtime.moduleRegistry.getModule(ref).implementation;
      if (typeof delegate !== "function") {
        throw new Error(`Expected the ${ref} builtin.`);
      }
      runtime.moduleRegistry.addModuleByRef(
        ref,
        raw((...args) => {
          const [inputs, sendResult] = args;
          const schema = {
            type: "object",
            properties: {
              query: { type: "string" },
              scope: { type: "array", items: { type: "string" } },
            },
          } as const;
          const { query } = inputs.asSchema<{ query?: string }>(schema).get();
          const isControlled = ref === "wish"
            ? query !== undefined &&
              [...controlled.keys()].some((key) =>
                key === query || key.startsWith(`${query}:`)
              )
            : controlled.has(ref);
          if (!isControlled) return delegate(...args);
          return (tx) => {
            const { query, scope } = inputs.withTx(tx).asSchema<
              { query?: string; scope?: string[] }
            >(schema).get();
            const result = ref === "wish"
              ? controlled.get(`${query}:${scope?.[0]}`) ??
                controlled.get(query ?? "")
              : controlled.get(ref);
            if (result) {
              const value = result.withTx(tx).getRaw();
              sendResult(tx, {
                result: isUnavailable(value) ? value : result,
                $UI: "Profile setup",
              });
            }
          };
        }),
      );
    }
  });

  afterEach(async () => {
    for (const stop of observers.reverse()) stop();
    await runtime.idle();
    await runtime.storageManager.synced();
    await runtime.dispose();
    expect(errors).toEqual([]);
  });

  async function instantiate(
    path: string,
    input: Record<string, unknown> = {},
    mainExport?: string,
    sourceOrigin?: string,
  ) {
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: fromFileUrl(new URL(`../${path}`, import.meta.url)),
        root: fromFileUrl(new URL("../..", import.meta.url)),
      },
    );
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern({
      ...program,
      ...(mainExport ? { mainExport } : {}),
    }, {
      space,
      tx,
    });
    const result = runtime.run(
      tx,
      pattern,
      input,
      runtime.getCell(space, path, undefined, tx),
      sourceOrigin === undefined ? {} : { sourceOrigin },
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await result.pull();
    observers.push(result.key("$UI").sink(() => {}));
    await runtime.idle();
    return result;
  }

  it("keeps the profile setup surface visible while participation identity is pending or syncing", async () => {
    const profile = runtime.getCell(space, "viewer profile result");
    const name = runtime.getCell(space, "viewer name result");
    await runtime.editWithRetry((tx) => {
      profile.withTx(tx).setRaw(UNAVAILABLE_PENDING);
      name.withTx(tx).setRaw(UNAVAILABLE_PENDING);
    });
    controlled.set("#profile", profile);
    controlled.set("#profileName", name);
    const app = await instantiate("system/default-app/default-app.tsx");
    expect(textOf(app.key("$UI"))).toContain("Profile setup");
    expect(app.key("participants").get()).toEqual([]);
    await runtime.editWithRetry((tx) =>
      profile.withTx(tx).setRaw(UNAVAILABLE_SYNCING)
    );
    await runtime.idle();
    expect(textOf(app.key("$UI"))).toContain("Profile setup");
    expect(app.key("participants").get()).toEqual([]);
  });

  it("keeps discovered retired folksonomy aggregators disconnected while local tags remain editable", async () => {
    const aggregator = runtime.getCell(space, "aggregator result");
    const tags = runtime.getCell<string[]>(space, "local tags");
    await runtime.editWithRetry((tx) => {
      aggregator.withTx(tx).setRaw(
        unavailableObsolete("Use a new aggregator."),
      );
      tags.withTx(tx).set(["glaze"]);
    });
    controlled.set("#folksonomyAggregator", aggregator);
    const editor = await instantiate("dev/experimental/folksonomy-tags.tsx", {
      scope: "donuts",
      tags,
    });
    const demo = await instantiate("dev/experimental/folksonomy-demo.tsx");
    expect(textOf(demo.key("$UI"))).toContain("Aggregator not found.");
    expect(textOf(demo.key("$UI"))).not.toContain(
      "Connected to folksonomy-aggregator",
    );
    sendEvent(editor.key("addTag"), { tag: "sprinkles" });
    await runtime.idle();
    expect(editor.key("tags").get()).toEqual(["glaze", "sprinkles"]);
    expect(tags.get()).toEqual(["glaze", "sprinkles"]);
    const postEvent = runtime.getCell(space, "replacement aggregator events", {
      asCell: ["stream"],
    });
    await runtime.editWithRetry((tx) =>
      aggregator.withTx(tx).set({ events: [], suggestions: {}, postEvent })
    );
    await runtime.idle();
    expect(textOf(demo.key("$UI"))).toContain(
      "Connected to folksonomy-aggregator",
    );
  });

  it("updates agent state without sending events to a retired optional activity log", async () => {
    const result = runtime.getCell(space, "activity log result");
    await runtime.editWithRetry((tx) =>
      result.withTx(tx).setRaw(unavailableObsolete("Use the replacement log."))
    );
    controlled.set("#activityLog", result);
    const agent = await instantiate("apps/agent/agent.tsx", {
      agentName: "Donut checker",
    });
    sendEvent(agent.key("markRunning"), undefined);
    await runtime.idle();
    expect(agent.key("status").get()).toBe("running");
    sendEvent(agent.key("markIdle"), {
      summary: "Checked",
      learned: "Use glaze",
    });
    await runtime.idle();
    expect(agent.key("status").get()).toBe("idle");
    expect(agent.key("lastRunSummary").get()).toBe("Checked");
    expect(agent.key("learned").get()).toBe("Use glaze");
    sendEvent(agent.key("markError"), { summary: "No donuts" });
    await runtime.idle();
    expect(agent.key("status").get()).toBe("error");
    expect(agent.key("lastRunSummary").get()).toBe("ERROR: No donuts");
    const retained = result.getRaw();
    expect(isObsolete(retained)).toBe(true);
    if (!isObsolete(retained)) {
      throw new Error("Expected the retired log marker.");
    }
    expect(retained.obsoleteMessage).toBe("Use the replacement log.");
    const destination = runtime.getCell(space, "replacement log events", {
      asCell: ["stream"],
    });
    const received: unknown[] = [];
    const stop = runtime.scheduler.addEventHandler((_tx, event) => {
      received.push(event);
    }, destination.getAsNormalizedFullLink());
    try {
      expect(received).toEqual([]);
      await runtime.editWithRetry((tx) =>
        result.withTx(tx).set({ logEvent: destination })
      );
      await runtime.idle();
      sendEvent(agent.key("markRunning"), undefined);
      await runtime.idle();
      await runtime.storageManager.synced();
      expect(received).toEqual([{ agent: "Donut checker", action: "started" }]);
    } finally {
      stop();
    }
  });

  it("does not queue a comment against a transient profile picture and attributes a fresh submit after recovery", async () => {
    const profile = runtime.getCell(space, "topic viewer profile");
    const ownedProfile = await instantiate(
      "system/profile-home/profile-home.tsx",
      { initialName: "Ada" },
      undefined,
      systemPatternSource("system/profile-home/profile-home.tsx"),
    );
    const firstPicture = new FabricBytes(new Uint8Array([1, 2]));
    const nextPicture = new FabricBytes(new Uint8Array([3, 4]));
    sendEvent(ownedProfile.key("setName"), { name: "Ada" });
    sendEvent(ownedProfile.key("setPicture"), { picture: firstPicture });
    await runtime.idle();
    await runtime.editWithRetry((tx) => profile.withTx(tx).set(ownedProfile));
    controlled.set("#profile", profile);
    const topic = await instantiate("apps/topics/topic.tsx", {
      title: "Donuts",
    });
    await runtime.editWithRetry((tx) =>
      topic.withTx(tx).key("commentDraft").set("Keep this draft")
    );
    for (const marker of [UNAVAILABLE_PENDING, UNAVAILABLE_SYNCING]) {
      await runtime.editWithRetry((tx) => profile.withTx(tx).setRaw(marker));
      await runtime.idle();
      sendEvent(topic.key("submitComment"), undefined);
      await runtime.idle();
      await runtime.storageManager.synced();
      expect(topic.key("comments").get()).toEqual([]);
      expect(topic.key("commentDraft").get()).toBe("Keep this draft");
    }
    sendEvent(ownedProfile.key("setName"), { name: "Grace" });
    sendEvent(ownedProfile.key("setPicture"), { picture: nextPicture });
    await runtime.idle();
    await runtime.editWithRetry((tx) => profile.withTx(tx).set(ownedProfile));
    await runtime.idle();
    await runtime.storageManager.synced();
    expect(topic.key("comments").get()).toEqual([]);
    sendEvent(topic.key("submitComment"), undefined);
    await runtime.idle();
    await runtime.storageManager.synced();
    const comments = topic.key("comments").get() as {
      body: string;
      author: { name: string; picture: FabricBytes };
    }[];
    expect(comments).toHaveLength(1);
    expect(comments[0].author.name).toBe("Grace");
    expect(comments[0].body).toBe("Keep this draft");
    expect(comments[0].author.picture.slice()).toEqual(nextPicture.slice());
    expect(topic.key("commentDraft").get()).toBe("");
  });

  it("keeps the shared-note editor and text verbs usable while the viewer's profile is pending", async () => {
    const profile = runtime.getCell(space, "note viewer profile");
    const name = runtime.getCell(space, "note viewer name");
    await runtime.editWithRetry((tx) => {
      profile.withTx(tx).setRaw(UNAVAILABLE_PENDING);
      name.withTx(tx).setRaw(UNAVAILABLE_PENDING);
    });
    controlled.set("#profile", profile);
    controlled.set("#profileName", name);
    const note = await instantiate("apps/shared-note/main.tsx", {
      title: "Donuts",
      content: "Glaze",
    });
    expect(textOf(note.key("$UI"))).toContain("Profile setup");
    expect(elementsOf(note.key("$UI"), "cf-code-editor")).toHaveLength(1);
    sendEvent(note.key("appendLine"), { text: "Sprinkles" });
    await runtime.idle();
    expect(note.key("content").get()).toBe("Glaze\nSprinkles");
    expect(note.key("comments").get()).toEqual([]);
  });

  it("renders a manual parking reporter's initials without an available profile face", async () => {
    const profile = runtime.getCell(space, "parking viewer profile");
    const name = runtime.getCell(space, "parking viewer name");
    await runtime.editWithRetry((tx) => {
      profile.withTx(tx).setRaw(UNAVAILABLE_PENDING);
      name.withTx(tx).setRaw(UNAVAILABLE_PENDING);
    });
    controlled.set("#profile", profile);
    controlled.set("#profileName", name);
    const lot = await instantiate("dev/factory-outputs/lot-watch/main.tsx");
    sendEvent(lot.key("setReporterName"), { name: "Manual reporter" });
    await runtime.idle();
    const avatars = elementsOf(lot.key("$UI"), "cf-avatar");
    expect(avatars).toHaveLength(1);
    expect(propOf(avatars[0], "name")).toBe("Manual reporter");
    expect(propOf(avatars[0], "bytes")).toBeUndefined();
    expect(propOf(avatars[0], "src")).toBe("");
  });

  it("disables joining a roster with a retired profile even when its name remains available", async () => {
    const profile = runtime.getCell(space, "roster viewer profile");
    const name = runtime.getCell(space, "roster viewer name");
    await runtime.editWithRetry((tx) => {
      profile.withTx(tx).setRaw(unavailableObsolete("Choose a new profile."));
      name.withTx(tx).set("Ada");
    });
    controlled.set("#profile", profile);
    controlled.set("#profileName", name);
    const roster = await instantiate("examples/shared-profile-roster/main.tsx");
    const buttons = elementsOf(roster.key("$UI"), "cf-button");
    expect(buttons).toHaveLength(1);
    expect(propOf(buttons[0], "disabled")).toBe(true);
    sendEvent(roster.key("join"), undefined);
    await runtime.idle();
    expect(roster.key("roster").key("participants").get()).toEqual([]);
    expect(roster.key("viewer").key("joined").get()).not.toBe(true);
  });

  it("keeps the GitHub fallback renderable after fetch or summary failure", async () => {
    const commits = runtime.getCell(space, "GitHub commits result");
    const summary = runtime.getCell(space, "GitHub summary result");
    await runtime.editWithRetry((tx) => {
      commits.withTx(tx).setRaw(unavailableError("GitHub refused", "network"));
      summary.withTx(tx).setRaw(
        unavailableError("Summary refused", "provider"),
      );
    });
    controlled.set("fetchJson", commits);
    controlled.set("generateText", summary);
    const subject = await instantiate(
      "../connectors/github/activity-view/main.tsx",
      { repoUrl: "https://github.com/example/donuts" },
    );
    expect(textOf(subject.key("$UI"))).toContain("No commits found");
    await runtime.editWithRetry((tx) =>
      commits.withTx(tx).set([{
        sha: "abc",
        html_url: "https://github.com/example/donuts/commit/abc",
        commit: {
          message: "Add glaze",
          author: { name: "Ada", date: "2026-10-01T00:00:00Z" },
        },
      }])
    );
    await runtime.idle();
    expect(textOf(subject.key("$UI"))).toContain("Add glaze");
    expect(textOf(subject.key("$UI"))).not.toContain("Generating summary...");
    await runtime.editWithRetry((tx) =>
      summary.withTx(tx).set("Glaze is available.")
    );
    await runtime.idle();
    expect(textOf(subject.key("$UI"))).toContain("Glaze is available.");
    expect(textOf(subject.key("$UI"))).toContain("Add glaze");
  });

  it("shows journal retirement guidance beside the retained snapshot and clears it on recovery", async () => {
    const journal = runtime.getCell(space, "journal result");
    const now = runtime.getCell(space, "journal clock result");
    await runtime.editWithRetry((tx) => {
      journal.withTx(tx).set([{
        timestamp: 1,
        narrative: "Kept journal entry",
      }]);
      now.withTx(tx).set(60_000);
    });
    controlled.set("#journal", journal);
    controlled.set("#now/60", now);
    const subject = await instantiate("system/journal/journal.tsx");
    expect(textOf(subject.key("$UI"))).toContain("Kept journal entry");
    await runtime.editWithRetry((tx) =>
      journal.withTx(tx).setRaw(unavailableObsolete("Use the new journal."))
    );
    await runtime.idle();
    expect(textOf(subject.key("$UI"))).toContain("Use the new journal.");
    expect(textOf(subject.key("$UI"))).toContain("Kept journal entry");
    await runtime.editWithRetry((tx) => {
      journal.withTx(tx).set([]);
      now.withTx(tx).setRaw(unavailableObsolete("Use the new clock."));
    });
    await runtime.idle();
    expect(textOf(subject.key("$UI"))).toContain("Use the new clock.");
    expect(textOf(subject.key("$UI"))).toContain("Kept journal entry");
    await runtime.editWithRetry((tx) =>
      now.withTx(tx).setRaw(unavailableObsolete(""))
    );
    await runtime.idle();
    expect(textOf(subject.key("$UI"))).toContain(
      "The journal clock is no longer served.",
    );
    expect(textOf(subject.key("$UI"))).toContain("Kept journal entry");
    await runtime.editWithRetry((tx) => now.withTx(tx).set(120_000));
    await runtime.idle();
    expect(textOf(subject.key("$UI"))).not.toContain("Use the new clock.");
    expect(textOf(subject.key("$UI"))).not.toContain("Kept journal entry");
  });

  it("reports failed catalog roots separately without hiding healthy rooms and clears the diagnostic on recovery", async () => {
    const healthySpace = (await Identity.fromPassphrase("healthy catalog root"))
      .did();
    const failedSpace = (await Identity.fromPassphrase("failed catalog root"))
      .did();
    const healthyRoot = runtime.getCell(space, "healthy root");
    const failedRoot = runtime.getCell(space, "failed root");
    const healthyRoom = runtime.getCell(space, "healthy room");
    const recoveredRoom = runtime.getCell(space, "recovered room");
    const catalog = runtime.getCell(space, "catalog");
    await runtime.editWithRetry((tx) => {
      healthyRoom.withTx(tx).set({ about: { kind: "group", title: "Donuts" } });
      recoveredRoom.withTx(tx).set({
        about: { kind: "group", title: "Glaze" },
      });
      healthyRoot.withTx(tx).set({ chatRoom: healthyRoom });
      failedRoot.withTx(tx).setRaw(unavailableError("Root refused", "network"));
      catalog.withTx(tx).set({
        entries: Object.fromEntries(
          [healthySpace, failedSpace].map((
            did,
          ) => [did, {
            space: did,
            host: "http://localhost:8000",
            kind: "photo-album",
            state: "saved",
            revision: "1:initial",
            since: 1,
          }]),
        ),
        offers: {},
      });
    });
    controlled.set(`#default:${healthySpace}`, healthyRoot);
    controlled.set(`#default:${failedSpace}`, failedRoot);
    const manager = await instantiate("system/fabrichat/manager.tsx", {
      sharedSpaceCatalog: catalog,
    }, "FabriChatManagerCore");
    const rooms = manager.key("rooms").asSchema<{ room: Cell<unknown> }[]>({
      type: "array",
      items: { type: "object", properties: { room: { asCell: ["cell"] } } },
    });
    observers.push(
      rooms.sink(() => {}),
      manager.key("discoveryErrors").sink(() => {}),
    );
    await runtime.idle();
    expect(rooms.get()).toHaveLength(1);
    expect(rooms.get()[0].room.equals(healthyRoom)).toBe(true);
    expect(manager.key("discoveryErrors").get()).toEqual([{
      space: failedSpace,
      message: "Root refused",
      kind: "network",
    }]);
    for (const waiting of [UNAVAILABLE_PENDING, UNAVAILABLE_SYNCING]) {
      await runtime.editWithRetry((tx) =>
        failedRoot.withTx(tx).setRaw(waiting)
      );
      await runtime.idle();
      expect(manager.key("discoveryErrors").get()).toEqual([]);
      expect(rooms.get()).toHaveLength(1);
      expect(rooms.get()[0].room.equals(healthyRoom)).toBe(true);
    }
    await runtime.editWithRetry((tx) =>
      failedRoot.withTx(tx).setRaw(
        unavailableObsolete("Use the new catalog root."),
      )
    );
    await runtime.idle();
    expect(rooms.get()).toHaveLength(1);
    expect(rooms.get()[0].room.equals(healthyRoom)).toBe(true);
    expect(manager.key("discoveryErrors").get()).toEqual([{
      space: failedSpace,
      message: "Use the new catalog root.",
      kind: "obsolete",
    }]);
    await runtime.editWithRetry((tx) =>
      failedRoot.withTx(tx).setRaw(unavailableObsolete(""))
    );
    await runtime.idle();
    expect(manager.key("discoveryErrors").get()).toEqual([{
      space: failedSpace,
      message: "This catalog root is no longer served.",
      kind: "obsolete",
    }]);
    await runtime.editWithRetry((tx) =>
      failedRoot.withTx(tx).set({ chatRoom: recoveredRoom })
    );
    await runtime.idle();
    expect(manager.key("discoveryErrors").get()).toEqual([]);
    expect(rooms.get()).toHaveLength(2);
    expect(rooms.get().some((entry) => entry.room.equals(healthyRoom))).toBe(
      true,
    );
    expect(rooms.get().some((entry) => entry.room.equals(recoveredRoom))).toBe(
      true,
    );
  });
});
