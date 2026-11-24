/** Optional consumers remain usable when a discovered capability is retired. */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  hasError,
  isObsolete,
  isPending,
  isUnavailable,
  UNAVAILABLE_PENDING,
  UNAVAILABLE_SYNCING,
  unavailableError,
  unavailableObsolete,
} from "@commonfabric/data-model/availability";
import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
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
import {
  HIFI_SYSTEM,
  REWRITE_SYSTEM,
} from "../showcase/inductor/lofi/induction.ts";

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

/** Finds a native pending marker in a rendered slot of the view tree. */
function hasPendingViewSlot(value: unknown): boolean {
  if (isPending(value)) return true;
  if (isCell(value)) return hasPendingViewSlot(value.get());
  if (Array.isArray(value)) return value.some(hasPendingViewSlot);
  if (!isObjectNotArray(value)) return false;
  return hasPendingViewSlot(value.$UI) || hasPendingViewSlot(value.children);
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
  let controlledErrorCodes: Map<string, Cell<string | undefined>>;
  let errors: unknown[];
  let observers: (() => void)[];
  let wishQueries: (string | undefined)[];
  let navigations: unknown[];

  beforeEach(() => {
    errors = [];
    observers = [];
    wishQueries = [];
    navigations = [];
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
      navigateCallback: (target) => {
        navigations.push(target);
      },
      errorHandlers: [(error) => {
        errors.push(error);
      }],
    });
    controlled = new Map();
    controlledErrorCodes = new Map();
    for (const ref of ["wish", "fetchJson", "generateText", "generateObject"]) {
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
              system: { type: "string" },
              scope: { type: "array", items: { type: "string" } },
            },
          } as const;
          const { query, system } = inputs.asSchema<
            { query?: string; system?: string }
          >(schema).get();
          const generationKey = `${ref}:${system}`;
          if (ref === "wish") wishQueries.push(query);
          const isControlled = ref === "wish"
            ? query !== undefined &&
              [...controlled.keys()].some((key) =>
                key === query || key.startsWith(`${query}:`)
              )
            : controlled.has(generationKey) || controlled.has(ref);
          if (!isControlled) return delegate(...args);
          return (tx) => {
            const { query, scope } = inputs.withTx(tx).asSchema<
              { query?: string; scope?: string[] }
            >(schema).get();
            const result = ref === "wish"
              ? controlled.get(`${query}:${scope?.[0]}`) ??
                controlled.get(query ?? "")
              : controlled.get(generationKey) ?? controlled.get(ref);
            if (result) {
              const value = result.withTx(tx).getRaw();
              sendResult(tx, {
                result: isUnavailable(value) ? value : result,
                $UI: "Profile setup",
                errorCode: controlledErrorCodes.get(query ?? "")?.withTx(tx)
                  .get(),
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
    instanceName = path,
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
      runtime.getCell(space, instanceName, undefined, tx),
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
    expect(retained.message).toBe("Use the replacement log.");
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

  for (const retired of ["profile", "name"] as const) {
    it(`keeps editing and shows retired ${retired} guidance without enabling chat submission`, async () => {
      const profile = runtime.getCell(space, "retired chat profile");
      const name = runtime.getCell(space, "retired chat name");
      const ownedProfile = await instantiate(
        "system/profile-home/profile-home.tsx",
        { initialName: "Ada" },
        undefined,
        systemPatternSource("system/profile-home/profile-home.tsx"),
      );
      const guidance = `Use the replacement ${retired}.`;
      await runtime.editWithRetry((tx) => {
        profile.withTx(tx).set(ownedProfile);
        name.withTx(tx).set("Ada");
        (retired === "profile" ? profile : name).withTx(tx)
          .setRaw(unavailableObsolete(guidance));
      });
      controlled.set("#profile", profile);
      controlled.set("#profileName", name);
      const chat = await instantiate("examples/profile-group-chat/main.tsx");
      const note = await instantiate("apps/shared-note/main.tsx", {
        title: "Donuts",
        content: "Glaze",
      });
      expect(textOf(chat.key("$UI"))).toContain(guidance);
      expect(textOf(note.key("$UI"))).toContain(guidance);
      const send = elementsOf(chat.key("$UI"), "cf-button")
        .find((button) => textOf(button).trim() === "Send");
      expect(send).toBeDefined();
      expect(propOf(send!, "disabled")).toBe(true);
      await runtime.editWithRetry((tx) =>
        chat.key("draft").withTx(tx).set("Fresh draft")
      );
      for (
        const state of [
          UNAVAILABLE_PENDING,
          UNAVAILABLE_SYNCING,
          unavailableError("Profile lookup refused"),
        ]
      ) {
        await runtime.editWithRetry((tx) =>
          (retired === "profile" ? profile : name).withTx(tx).setRaw(state)
        );
        await runtime.idle();
        const unavailableSend = elementsOf(chat.key("$UI"), "cf-button")
          .find((button) => textOf(button).trim() === "Send");
        expect(propOf(unavailableSend!, "disabled")).toBe(true);
        expect(chat.key("messages").get()).toEqual([]);
        expect(chat.key("draft").get()).toBe("Fresh draft");
      }
      sendEvent(note.key("appendLine"), { text: "Sprinkles" });
      await runtime.idle();
      expect(note.key("content").get()).toBe("Glaze\nSprinkles");
      await runtime.editWithRetry((tx) => {
        profile.withTx(tx).set(ownedProfile);
        name.withTx(tx).set("Ada");
      });
      await runtime.idle();
      expect(textOf(chat.key("$UI"))).not.toContain(guidance);
      expect(textOf(note.key("$UI"))).not.toContain(guidance);
      const recoveredSend = elementsOf(chat.key("$UI"), "cf-button")
        .find((button) => textOf(button).trim() === "Send");
      expect(propOf(recoveredSend!, "disabled")).toBe(false);
      expect(chat.key("messages").get()).toEqual([]);
      sendEvent(chat.key("sendMessage"), undefined);
      await runtime.settled();
      expect(chat.key("messages").get()).toHaveLength(1);
      expect(chat.key("messages").key(0).key("author").get()).toBe("Ada");
      expect(chat.key("messages").key(0).key("body").get()).toBe("Fresh draft");
    });
  }

  for (const game of ["battleship/multiplayer/lobby", "scrabble/scrabble"]) {
    it(`shows a name-only failure beside usable ${game} controls and recovers`, async () => {
      const profile = runtime.getCell(space, "game viewer profile");
      const name = runtime.getCell(space, "game viewer name");
      await runtime.editWithRetry((tx) => {
        profile.withTx(tx).set({ name: "Ada" });
        name.withTx(tx).setRaw(unavailableError("Name lookup refused"));
      });
      controlled.set("#profile", profile);
      controlled.set("#profileName", name);
      const gamePiece = await instantiate(`showcase/${game}.tsx`);
      expect(textOf(gamePiece.key("$UI"))).toContain("Profile setup");
      expect(textOf(gamePiece.key("$UI"))).toContain("Name lookup refused");
      const join = elementsOf(gamePiece.key("$UI"), "cf-button")
        .find((button) =>
          textOf(button).trim() === "Join" ||
          textOf(button).trim() === "Create a profile to join"
        );
      expect(join).toBeDefined();
      expect(propOf(join!, "disabled")).toBe(true);
      for (const hint of ["Use the replacement name.", ""]) {
        await runtime.editWithRetry((tx) =>
          name.withTx(tx).setRaw(unavailableObsolete(hint))
        );
        await runtime.idle();
        expect(textOf(gamePiece.key("$UI"))).toContain(
          hint || "This profile name is no longer served.",
        );
        expect(textOf(gamePiece.key("$UI"))).toContain("Reset");
      }
      await runtime.editWithRetry((tx) => name.withTx(tx).set("Ada"));
      await runtime.idle();
      expect(textOf(gamePiece.key("$UI"))).not.toContain("Name lookup refused");
      const recovered = elementsOf(gamePiece.key("$UI"), "cf-button")
        .find((button) => textOf(button).trim() === "Join as Ada");
      expect(recovered).toBeDefined();
      expect(propOf(recovered!, "disabled")).toBe(false);
    });
  }

  it("shows Ring Loops name failures without removing the sequencer or tempo verb", async () => {
    const name = runtime.getCell(space, "ring viewer name");
    await runtime.editWithRetry((tx) =>
      name.withTx(tx).setRaw(unavailableError("Ring name refused"))
    );
    controlled.set("#profileName", name);
    const rings = await instantiate("showcase/iframe-ring-loops/main.tsx");
    expect(textOf(rings.key("$UI"))).toContain("Ring name refused");
    expect(elementsOf(rings.key("$UI"), "cf-iframe")).toHaveLength(1);
    sendEvent(rings.key("setTempo"), { bpm: 123 });
    await runtime.settled();
    expect(rings.key("state").key("tempoBpm").get()).toBe(123);
    for (const hint of ["Use the replacement name.", ""]) {
      await runtime.editWithRetry((tx) =>
        name.withTx(tx).setRaw(unavailableObsolete(hint))
      );
      await runtime.idle();
      expect(textOf(rings.key("$UI"))).toContain(
        hint || "This profile name is no longer served.",
      );
      expect(elementsOf(rings.key("$UI"), "cf-iframe")).toHaveLength(1);
    }
    await runtime.editWithRetry((tx) => name.withTx(tx).set("Ada"));
    await runtime.idle();
    expect(textOf(rings.key("$UI"))).not.toContain("Ring name refused");
    expect(elementsOf(rings.key("$UI"), "cf-iframe")).toHaveLength(1);
  });

  it("preserves a failed room-root lookup but permits confirmed absence and root-room independence", async () => {
    const root = runtime.getCell(space, "room root");
    const code = runtime.getCell<string | undefined>(
      space,
      "room root error code",
    );
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).setRaw(unavailableError("Room root refused", "network"));
      code.withTx(tx).set("failed");
    });
    controlled.set("#default", root);
    controlledErrorCodes.set("#default", code);
    const room = await instantiate(
      "system/fabrichat/room.tsx",
      {},
      "FabriChatRoomCore",
    );
    expect(hasError(room.key("participants").get())).toBe(true);
    const own = await instantiate(
      "system/fabrichat/room.tsx",
      {
        about: { kind: "group", title: "Independent room" },
      },
      "FabriChatRoomCore",
      undefined,
      "independent room",
    );
    expect(own.key("participants").get()).toEqual([]);
    await runtime.editWithRetry((tx) => code.withTx(tx).set("no-match"));
    await runtime.idle();
    expect(room.key("participants").get()).toEqual([]);
    await runtime.editWithRetry((tx) =>
      root.withTx(tx).set({ participants: [] })
    );
    await runtime.idle();
    expect(room.key("participants").get()).toEqual([]);
  });

  it("shows terminal classifier guidance while retaining editing and recovers both model adapters", async () => {
    const model = runtime.getCell(space, "classifier model results");
    await runtime.editWithRetry((tx) =>
      model.withTx(tx).setRaw(UNAVAILABLE_SYNCING)
    );
    controlled.set("generateObject", model);
    const classifier = await instantiate(
      "apps/self-improving-classifier/self-improving-classifier.tsx",
      {
        config: {
          question: "Is this a bill?",
          minExamplesForRules: 1,
          autoClassifyThreshold: 0.85,
          prefillThreshold: 0.7,
          suggestionThreshold: 0.5,
          harmAsymmetry: "equal",
          enableLLMFallback: true,
        },
        currentItem: {
          id: "current",
          receivedAt: 0,
          fields: { subject: "Glaze" },
        },
        examples: [{
          input: { id: "old", receivedAt: 0, fields: { subject: "Invoice" } },
          label: true,
          decidedBy: "suggestion-accepted",
          reasoning: "A bill",
          confidence: 0.9,
          labeledAt: 0,
          wasCorrection: true,
          isInteresting: false,
        }],
      },
    );
    expect(textOf(classifier.key("$UI"))).toContain("Classifying...");
    await runtime.editWithRetry((tx) =>
      model.withTx(tx).setRaw(
        unavailableObsolete("Use the new classifier model."),
      )
    );
    await runtime.idle();
    const text = textOf(classifier.key("$UI"));
    expect(text).toContain(
      "Classification failed: Use the new classifier model.",
    );
    expect(text).toContain(
      "Rule suggestions unavailable: Use the new classifier model.",
    );
    expect(elementsOf(classifier.key("$UI"), "cf-input").length)
      .toBeGreaterThan(0);
    await runtime.editWithRetry((tx) =>
      model.withTx(tx).set({
        itemId: "current",
        classification: true,
        confidence: 0.9,
        reasoning: "Recovered model",
        suggestions: [],
      })
    );
    await runtime.idle();
    expect(textOf(classifier.key("$UI"))).not.toContain(
      "Use the new classifier model.",
    );
    expect(textOf(classifier.key("$UI"))).toContain("Recovered model");
  });

  it("adapts native inductor labels and rewrite failures without confusing retirement with loading", async () => {
    const labels = runtime.getCell(space, "inductor label result");
    const rewrite = runtime.getCell(space, "inductor rewrite result");
    await runtime.editWithRetry((tx) => {
      labels.withTx(tx).setRaw(UNAVAILABLE_SYNCING);
      rewrite.withTx(tx).setRaw(
        unavailableObsolete("Use the replacement rewrite model."),
      );
    });
    controlled.set(`generateObject:${HIFI_SYSTEM}`, labels);
    controlled.set(`generateObject:${REWRITE_SYSTEM}`, rewrite);
    const inductor = await instantiate(
      "showcase/inductor/lofi/lofi-inductor.tsx",
      {
        goal: "Is this a bill?",
        items: [{ id: "mail-1", fields: { subject: "Invoice" } }],
        rewriteAfter: 1,
      },
    );
    expect(inductor.key("rows").key(0).key("hifi").get()).toBeNull();
    expect(inductor.key("summary").key("labelled").get()).toBe(0);
    await runtime.editWithRetry((tx) =>
      labels.withTx(tx).setRaw(
        unavailableObsolete("Use the replacement label model."),
      )
    );
    await runtime.idle();
    expect(inductor.key("rows").key(0).key("hifi").get()).toBeNull();
    expect(inductor.key("summary").key("labelled").get()).toBe(0);
    await runtime.editWithRetry((tx) =>
      labels.withTx(tx).set({ label: true, reasoning: "An invoice" })
    );
    await runtime.idle();
    expect(inductor.key("summary").key("labelled").get()).toBe(1);
    expect(inductor.key("rewrite").get()).toEqual({
      status: "failed",
      reason: "the model call failed: Use the replacement rewrite model.",
    });
    expect(textOf(inductor.key("$UI"))).toContain(
      "Use the replacement rewrite model.",
    );
    await runtime.editWithRetry((tx) =>
      rewrite.withTx(tx).set({ rules: [], reasoning: "Recovered" })
    );
    await runtime.idle();
    expect(inductor.key("rewrite").key("status").get()).toBe("ready");
    expect(textOf(inductor.key("$UI"))).not.toContain(
      "Use the replacement rewrite model.",
    );
  });

  it("presents genuine profile lookup failures separately from no-profile absence", async () => {
    const profile = runtime.getCell(space, "failed demo profile");
    const name = runtime.getCell(space, "failed demo name");
    await runtime.editWithRetry((tx) => {
      profile.withTx(tx).set({ initialNameApplied: "Ada" });
      name.withTx(tx).setRaw(unavailableError("Profile name lookup refused"));
    });
    controlled.set("#profile", profile);
    controlled.set("#profileName", name);
    const demo = await instantiate("examples/shared-profile-demo/main.tsx");
    expect(textOf(demo.key("$UI"))).toContain("Profile name lookup refused");
    expect(
      elementsOf(demo.key("$UI"), "div").some((node) =>
        propOf(node, "role") === "alert" &&
        textOf(node).includes("Profile name lookup refused")
      ),
    ).toBe(true);
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
    const failedFetch = textOf(subject.key("$UI"));
    expect(failedFetch).toContain("GitHub refused");
    expect(failedFetch).not.toContain("No commits found");
    await runtime.editWithRetry((tx) => commits.withTx(tx).set([]));
    await runtime.idle();
    expect(textOf(subject.key("$UI"))).toContain("No commits found");
    expect(textOf(subject.key("$UI"))).not.toContain("GitHub refused");
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
    expect(textOf(subject.key("$UI"))).toContain("Summary refused");
    expect(textOf(subject.key("$UI"))).not.toContain("Generating summary...");
    await runtime.editWithRetry((tx) =>
      summary.withTx(tx).setRaw(UNAVAILABLE_SYNCING)
    );
    await runtime.idle();
    expect(textOf(subject.key("$UI"))).toContain("Generating summary...");
    expect(textOf(subject.key("$UI"))).toContain("Add glaze");
    await runtime.editWithRetry((tx) =>
      summary.withTx(tx).set("Glaze is available.")
    );
    await runtime.idle();
    expect(textOf(subject.key("$UI"))).toContain("Glaze is available.");
    expect(textOf(subject.key("$UI"))).not.toContain("Summary refused");
    expect(textOf(subject.key("$UI"))).toContain("Add glaze");
  });

  it("shows retired note guidance without treating the retired note as absence", async () => {
    const note = runtime.getCell(space, "wish example note");
    await runtime.editWithRetry((tx) =>
      note.withTx(tx).setRaw(
        unavailableObsolete("Use the replacement note."),
      )
    );
    controlled.set("#note", note);
    const example = await instantiate(
      "examples/wish-note-example/wish-note-example.tsx",
    );
    expect(textOf(example.key("$UI"))).toContain("Use the replacement note.");
    await runtime.editWithRetry((tx) =>
      note.withTx(tx).setRaw(unavailableObsolete())
    );
    await runtime.idle();
    expect(textOf(example.key("$UI"))).toContain(
      "This note output has been retired.",
    );
    await runtime.editWithRetry((tx) =>
      note.withTx(tx).set({
        content: "Recovered note",
        $UI: {
          type: "vnode",
          name: "div",
          props: {},
          children: ["Recovered view"],
        },
      })
    );
    await runtime.idle();
    expect(textOf(example.key("$UI"))).not.toContain("retired");
    expect(textOf(example.key("$UI"))).toContain("Recovered note");
  });

  it("registers a navigated backlink without inserting it into the current editor", async () => {
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: fromFileUrl(new URL("../system/notes/note.tsx", import.meta.url)),
        root: fromFileUrl(new URL("../..", import.meta.url)),
      },
    );
    const main = program.main.replace(/[^/]+$/, "backlink-navigation.test.tsx");
    const contents = `
      import { pattern, Writable } from "commonfabric";
      import { handleNewBacklink } from "./note.tsx";
      import type { MentionablePiece, MinimalPiece } from "./schemas.tsx";
      export default pattern(({ mentionable, pieceRegistry }: {
        mentionable: Writable<MentionablePiece[]>;
        pieceRegistry: Writable<MinimalPiece[]>;
      }) => ({ create: handleNewBacklink({ mentionable, pieceRegistry }) }));
    `;
    const mentionable = runtime.getCell(space, "backlink mentions");
    const registry = runtime.getCell(space, "backlink registry");
    const first = runtime.getCell(space, "inserted backlink");
    const second = runtime.getCell(space, "navigated backlink");
    const tx = runtime.edit();
    mentionable.withTx(tx).set([]);
    registry.withTx(tx).set([]);
    first.withTx(tx).set({ $NAME: "Inserted", mentioned: [], backlinks: [] });
    second.withTx(tx).set({ $NAME: "Navigated", mentioned: [], backlinks: [] });
    const pattern = await runtime.patternManager.compilePattern({
      ...program,
      main,
      files: [...program.files, { name: main, contents }],
    }, { space, tx });
    const result = runtime.run(tx, pattern, {
      mentionable,
      pieceRegistry: registry,
    }, runtime.getCell(space, "backlink handler fixture", undefined, tx));
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    sendEvent(result.key("create"), {
      detail: { piece: first, navigate: false },
    });
    await runtime.settled();
    expect(mentionable.get()).toHaveLength(1);
    expect(registry.get()).toHaveLength(1);
    expect(navigations).toEqual([]);
    sendEvent(result.key("create"), {
      detail: { piece: second, navigate: true },
    });
    await runtime.settled();
    expect(mentionable.get()).toHaveLength(1);
    expect(registry.get()).toHaveLength(2);
    expect(navigations).toHaveLength(1);
    expect(isCell(navigations[0]) && navigations[0].equals(second)).toBe(true);
  });

  it("keeps photo analysis visibly waiting while extraction inputs synchronize", async () => {
    const extraction = runtime.getCell(space, "photo aisle extraction");
    await runtime.editWithRetry((tx) =>
      extraction.withTx(tx).setRaw(UNAVAILABLE_SYNCING)
    );
    controlled.set("generateObject", extraction);
    const tab = await instantiate("apps/store-mapper/store-mapper.tsx", {
      aisles: [],
      uploadedPhotos: [{
        id: "photo-1",
        name: "aisles.png",
        url: "data:image/png;base64,AA==",
      }],
      hiddenPhotoIds: [],
    }, "AislesTab");
    expect(textOf(tab.key("$UI"))).toContain("Analyzing photo...");
    await runtime.editWithRetry((tx) =>
      extraction.withTx(tx).setRaw(
        unavailableObsolete("Use the new photo analyzer."),
      )
    );
    await runtime.idle();
    expect(textOf(tab.key("$UI"))).toContain("Use the new photo analyzer.");
    expect(textOf(tab.key("$UI"))).not.toContain("Analyzing photo...");
    await runtime.editWithRetry((tx) =>
      extraction.withTx(tx).setRaw(unavailableObsolete(""))
    );
    await runtime.idle();
    expect(textOf(tab.key("$UI"))).toContain(
      "This photo analysis output has been retired.",
    );
    await runtime.editWithRetry((tx) =>
      extraction.withTx(tx).set({
        aisles: [{ name: "8", products: ["Bread"] }],
      })
    );
    await runtime.idle();
    expect(textOf(tab.key("$UI"))).not.toContain("Analyzing photo...");
    expect(textOf(tab.key("$UI"))).toContain("Bread");
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

  it("waits for a pending summary index and renders its entries after recovery", async () => {
    const index = runtime.getCell(space, "summary index result");
    const code = runtime.getCell<string | undefined>(
      space,
      "summary index error code",
    );
    const piece = runtime.getCell(space, "summary index piece");
    await runtime.editWithRetry((tx) => {
      index.withTx(tx).setRaw(UNAVAILABLE_PENDING);
      piece.withTx(tx).set({
        $NAME: "Donuts",
        summary: "Choose glazed donuts",
      });
    });
    controlled.set("#summaryIndex", index);
    controlledErrorCodes.set("#summaryIndex", code);
    const tester = await instantiate(
      "examples/summary-index-tester/summary-index-tester.tsx",
    );
    expect(tester.key("$NAME").get()).toBe("Summary Index Tester");
    expect(hasPendingViewSlot(tester.key("$UI"))).toBe(true);
    expect(textOf(tester.key("$UI"))).not.toContain("Index: 0 entries");
    await runtime.editWithRetry((tx) => {
      index.withTx(tx).setRaw(
        unavailableError("Summary index refused", "network"),
      );
      code.withTx(tx).set("failed");
    });
    await runtime.idle();
    expect(textOf(tester.key("$UI"))).not.toContain("Index: 0 entries");
    await runtime.editWithRetry((tx) => code.withTx(tx).set("no-match"));
    await runtime.idle();
    expect(textOf(tester.key("$UI"))).toContain("Index: 0 entries");
    await runtime.editWithRetry((tx) =>
      index.withTx(tx).setRaw(unavailableObsolete("Use the new summary index."))
    );
    await runtime.idle();
    expect(textOf(tester.key("$UI"))).not.toContain("Index: 0 entries");
    await runtime.editWithRetry((tx) =>
      index.withTx(tx).set({
        entries: [{ piece, name: "Donuts", summary: "Choose glazed donuts" }],
        search: { pattern: {}, extraParams: { entries: [] } },
      })
    );
    await runtime.idle();
    expect(tester.key("$NAME").get()).toBe("Summary Index Tester");
    expect(textOf(tester.key("$UI"))).toContain("Index: 1 entries");
    expect(textOf(tester.key("$UI"))).toContain("Choose glazed donuts");
  });

  it("lists recorded membership metadata without discovering or reading catalog roots, regardless of their availability", async () => {
    const catalogSpace = (await Identity.fromPassphrase("catalog root")).did();
    const root = runtime.getCell(space, "catalog root");
    const catalog = runtime.getCell(space, "catalog");
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).set({ about: { kind: "group", title: "Donuts" } });
      catalog.withTx(tx).set({
        entries: {
          [catalogSpace]: {
            space: catalogSpace,
            host: "http://localhost:8000",
            kind: "photo-album",
            state: "saved",
            revision: "1:initial",
            since: 1,
          },
        },
        offers: {},
      });
    });
    controlled.set(`#default:${catalogSpace}`, root);
    const manager = await instantiate("system/fabrichat/manager.tsx", {
      sharedSpaceCatalog: catalog,
    }, "FabriChatManagerCore");
    const rooms = manager.key("rooms").asSchema<
      { room: Cell<unknown>; title: string }[]
    >({
      type: "array",
      items: {
        type: "object",
        properties: { room: { asCell: ["cell"] }, title: { type: "string" } },
      },
    });
    observers.push(rooms.sink(() => {}));
    await runtime.idle();
    expect(rooms.get()).toEqual([]);
    await runtime.editWithRetry((tx) =>
      manager.key("roomMembership").withTx(tx).set([{
        room: root,
        kind: "group",
        title: "Recorded conversation",
        since: new FabricEpochNsec(1n),
        state: "saved",
        revision: "membership:1",
      }])
    );
    await runtime.idle();
    expect(rooms.get()).toHaveLength(1);
    expect(rooms.get()[0].title).toBe("Recorded conversation");
    expect(rooms.get()[0].room.equals(root)).toBe(true);
    for (
      const value of [
        unavailableError("Root refused", "network"),
        UNAVAILABLE_PENDING,
        UNAVAILABLE_SYNCING,
        unavailableObsolete("Use the new catalog root."),
        unavailableObsolete(""),
        { about: { kind: "group", title: "Recovered root" } },
      ]
    ) {
      await runtime.editWithRetry((tx) => root.withTx(tx).setRaw(value));
      await runtime.idle();
      expect(rooms.get()).toHaveLength(1);
      expect(rooms.get()[0].title).toBe("Recorded conversation");
      expect(rooms.get()[0].room.equals(root)).toBe(true);
      expect(wishQueries).not.toContain("#default");
    }
  });
});
