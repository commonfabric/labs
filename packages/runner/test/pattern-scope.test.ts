import { assertEquals } from "@std/assert";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getServerExecutionConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  getMetaLink,
  parseLink,
  toMemorySpaceAddress,
} from "../src/link-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type Cell, createCell } from "../src/cell.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import { type FactoryInput } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

Deno.test("Cell.key keeps base scope; schema carries the scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const cell = runtime.getCell(
      space,
      "schema scoped child key",
      {
        type: "object",
        properties: {
          name: { type: "string", scope: "user" },
          selectedRoom: {
            type: "object",
            scope: "session",
            properties: {
              room: { type: "string" },
            },
          },
        },
      },
      tx,
    );

    // key() only extends the path; it never changes the link's scope. The
    // declared scope lives in the schema and is realized on read (as a follow
    // cap) and on write (content goes to the scoped instance with a base-scope
    // redirect). It is not stamped onto the navigated link.
    assertEquals(cell.getAsNormalizedFullLink().scope, "space");
    assertEquals(cell.key("name").getAsNormalizedFullLink().scope, "space");
    assertEquals(
      cell.key("selectedRoom").getAsNormalizedFullLink().scope,
      "space",
    );
    assertEquals(
      cell.key("selectedRoom", "room").getAsNormalizedFullLink().scope,
      "space",
    );

    // The scope is carried on the schema of the navigated link.
    assertEquals(
      (cell.key("name").getAsNormalizedFullLink().schema as any)?.scope,
      "user",
    );
    assertEquals(
      (cell.key("selectedRoom").getAsNormalizedFullLink().schema as any)?.scope,
      "session",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("handler bindings preserve scoped cells selected from pattern input schema", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { handler, pattern } = createTrustedBuilder(runtime).commonfabric;

    interface Conversation {
      rooms: { name: string }[];
    }

    const addRoom = handler<
      { name?: string },
      { conversation: Cell<Conversation>; newRoomName: Cell<string> }
    >({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    }, {
      type: "object",
      properties: {
        conversation: {
          type: "object",
          properties: {
            rooms: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
              default: [],
            },
          },
          required: ["rooms"],
          default: { rooms: [] },
          asCell: ["cell"],
        },
        newRoomName: {
          type: "string",
          default: "",
          asCell: ["cell"],
        },
      },
      required: ["conversation", "newRoomName"],
    }, ({ name: eventName }, { conversation, newRoomName }) => {
      const name = eventName ?? newRoomName.get();
      if (!name) return;
      conversation.key("rooms").push({ name });
      newRoomName.set("");
    });

    const Root = pattern<{
      conversation: Conversation;
      newRoomName: string;
    }>(({ conversation, newRoomName }) => ({
      conversation,
      newRoomName,
      addRoom: addRoom({
        conversation: conversation as unknown as Cell<Conversation>,
        newRoomName: newRoomName as unknown as Cell<string>,
      }),
    }), {
      type: "object",
      properties: {
        conversation: {
          type: "object",
          scope: "space",
          properties: {
            rooms: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
              default: [],
            },
          },
          required: ["rooms"],
          default: { rooms: [] },
        },
        newRoomName: {
          type: "string",
          default: "",
          scope: "session",
        },
      },
      required: ["conversation", "newRoomName"],
    });

    const resultCell = runtime.getCell(
      space,
      "handler scoped pattern input binding",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, {
      conversation: { rooms: [] },
      newRoomName: "",
    }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const setTx = runtime.edit();
    result.key("newRoomName").withTx(setTx).set("Project");
    runtime.prepareTxForCommit(setTx);
    await setTx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    result.key("addRoom").send({});
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(result.key("conversation").get(), {
      rooms: [{ name: "Project" }],
    });
    assertEquals(result.key("newRoomName").get() as unknown, "");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("per-user pointer can create and update a space-scoped profile cell", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { handler, pattern, Writable } =
      createTrustedBuilder(runtime).commonfabric;

    interface Profile {
      name: string;
    }

    interface MyProfile {
      profile?: Cell<Profile>;
    }

    interface Message {
      authorName: string;
      authorProfile: Cell<Profile>;
      body: string;
    }

    const profileSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    } as const;
    const myProfileSchema = {
      type: "object",
      properties: {
        profile: {
          ...profileSchema,
          asCell: [{ kind: "cell", scope: "space" }],
        },
      },
      default: {},
    } as const;
    const messagesSchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          authorName: { type: "string" },
          authorProfile: {
            ...profileSchema,
            asCell: [{ kind: "cell", scope: "space" }],
          },
          body: { type: "string" },
        },
        required: ["authorName", "authorProfile", "body"],
      },
      default: [],
    } as const;

    const saveName = handler<
      { name: string },
      { myProfile: Cell<MyProfile> }
    >({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    }, {
      type: "object",
      properties: {
        myProfile: {
          ...myProfileSchema,
          asCell: [{ kind: "cell", scope: "user" }],
        },
      },
      required: ["myProfile"],
    }, ({ name }, { myProfile }) => {
      const existing = myProfile.get()?.profile;
      if (existing?.get()) {
        existing.key("name").set(name);
        return;
      }

      const profile = Writable.for<Profile>("profile");
      profile.set({ name });
      myProfile.set({ profile });
    });

    const sendMessage = handler<
      { body: string },
      { myProfile: Cell<MyProfile>; messages: Cell<Message[]> }
    >({
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
    }, {
      type: "object",
      properties: {
        myProfile: {
          ...myProfileSchema,
          asCell: [{ kind: "cell", scope: "user" }],
        },
        messages: {
          ...messagesSchema,
          asCell: [{ kind: "cell", scope: "space" }],
        },
      },
      required: ["myProfile", "messages"],
    }, ({ body }, { myProfile, messages }) => {
      const profile = myProfile.get()?.profile;
      if (!profile?.get()) {
        return;
      }

      messages.push({
        authorName: profile.key("name").get(),
        authorProfile: profile,
        body,
      });
    });

    const Root = pattern<{
      myProfile: MyProfile;
      messages: Message[];
    }>(({ myProfile, messages }) => ({
      myProfile,
      messages,
      saveName: saveName(
        ({
          myProfile: myProfile as unknown as Cell<MyProfile>,
        }) as any,
      ),
      sendMessage: sendMessage(
        ({
          myProfile: myProfile as unknown as Cell<MyProfile>,
          messages: messages as unknown as Cell<Message[]>,
        }) as any,
      ),
    }), {
      type: "object",
      properties: {
        myProfile: {
          ...myProfileSchema,
          scope: "user",
        },
        messages: {
          ...messagesSchema,
          scope: "space",
        },
      },
      required: ["myProfile", "messages"],
    });

    const resultCell = runtime.getCell(
      space,
      "scoped profile pointer creation",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, {
      myProfile: {},
      messages: [],
    }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    result.key("saveName").send({ name: "Ada" });
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const myProfileCell = result.key("myProfile").resolveAsCell();
    assertEquals(myProfileCell.getAsNormalizedFullLink().scope, "user");
    const profileCell = myProfileCell.asSchema<MyProfile>(myProfileSchema)
      .get().profile;
    if (!profileCell) {
      throw new Error("expected profile cell");
    }
    assertEquals(profileCell.getAsNormalizedFullLink().scope, "space");
    assertEquals(profileCell.get(), { name: "Ada" });
    const firstProfileRef = profileCell.getAsNormalizedFullLink();

    result.key("saveName").send({ name: "Ada Byron" });
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const updatedProfileCell = myProfileCell.asSchema<MyProfile>(
      myProfileSchema,
    ).get().profile;
    if (!updatedProfileCell) {
      throw new Error("expected updated profile cell");
    }
    assertEquals(
      updatedProfileCell.getAsNormalizedFullLink().id,
      firstProfileRef.id,
    );
    assertEquals(updatedProfileCell.getAsNormalizedFullLink().scope, "space");
    assertEquals(updatedProfileCell.get(), { name: "Ada Byron" });

    result.key("sendMessage").send({ body: "hello" });
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const messagesCell = result.key("messages").resolveAsCell();
    const message = messagesCell.asSchema<Message[]>(messagesSchema).get()[0];
    assertEquals(message.authorName, "Ada Byron");
    assertEquals(message.body, "hello");
    assertEquals(
      message.authorProfile.getAsNormalizedFullLink().id,
      firstProfileRef.id,
    );
    assertEquals(
      message.authorProfile.getAsNormalizedFullLink().scope,
      "space",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern factory .asScope() sets child pattern result scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;

    const Child = pattern(() => ({ value: "child" }));
    const Root = pattern(() => ({
      child: Child.asScope("user")({}),
    }));

    const resultCell = runtime.getCell(
      space,
      "pattern factory asScope child result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {}, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const childLink = result.key("child").resolveAsCell()
      .getAsNormalizedFullLink();
    assertEquals(childLink?.scope, "user");
    assertEquals(
      runtime.getCellFromLink(childLink!)?.getAsNormalizedFullLink().scope,
      "user",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern factory .inSpace() routes child pattern result to DID space", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  const targetSpace = (await Identity.fromPassphrase(
    "pattern factory inSpace child target",
  )).did();

  try {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;

    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    const Root = pattern(() => ({
      child: Child.inSpace(targetSpace)({ value: "child" }),
    }));

    const resultCell = runtime.getCell(
      space,
      "pattern factory inSpace child result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {}, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const childLink = result.key("child").resolveAsCell()
      .getAsNormalizedFullLink();
    assertEquals(childLink?.space, targetSpace);
    assertEquals(await result.key("child", "value").pull(), "child" as any);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern factory .inSpace() resolves named spaces during action postRun", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  const spaceName = `pattern-factory-in-space-${crypto.randomUUID()}`;
  const expectedSpace = (await createSession({
    identity: signer,
    spaceName,
  })).space;

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;

    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    const makeChild = lift(({ value }: { value: string }) =>
      Child.inSpace(spaceName)({ value })
    );
    const Root = pattern<{ value: string }>((state) => ({
      child: makeChild({ value: state.value }),
    }));

    const resultCell = runtime.getCell(
      space,
      "pattern factory named inSpace action result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { value: "named child" }, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();
    // The name-resolution retry re-runs the action on delivery turns kicked
    // by the pull above; drain them and re-pull to see the re-linked child.
    await clock.settle();
    await result.pull();

    const actionLink = parseLink(result.key("child").getRaw(), result);
    const actionResult = runtime.getCellFromLink(actionLink!);
    const childLink = actionResult.resolveAsCell().getAsNormalizedFullLink();
    assertEquals(childLink?.space, expectedSpace);
    assertEquals(
      await result.key("child", "value").pull(),
      "named child" as any,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern factory .inSpace() handler side effect can write linked child across spaces", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  const targetSpace = (await Identity.fromPassphrase(
    "pattern factory handler inSpace linked child target",
  )).did();

  try {
    const { handler, pattern } = createTrustedBuilder(runtime).commonfabric;

    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    const createChild = handler<
      { value: string },
      { profile: Cell<unknown> }
    >({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    }, {
      type: "object",
      properties: { profile: { asCell: ["cell"] } },
      required: ["profile"],
    }, ({ value }, { profile }) => {
      profile.set(Child.inSpace(targetSpace)({ value }));
    });
    const Root = pattern<{ profile: Cell<unknown> }>(
      ({ profile }) => ({
        profile,
        createChild: createChild({ profile }),
      }),
      {
        type: "object",
        properties: {
          profile: { asCell: ["cell"] },
        },
        required: ["profile"],
      } as const,
    );

    const profile = runtime.getCell(
      signer.did(),
      "pattern factory handler inSpace profile link",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell(
      space,
      "pattern factory handler inSpace linked child result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { profile }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    result.key("createChild").send({ value: "linked child" });
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();
    await profile.pull();

    const childLink = parseLink(profile.getRaw(), profile);
    assertEquals(childLink?.space, targetSpace);
    assertEquals(await profile.key("value").pull(), "linked child" as any);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern factory .inSpace() resolves named handler children to DIDs", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  const spaceName =
    `pattern-factory-in-space-annotation-${crypto.randomUUID()}`;
  const expectedSpace = (await createSession({
    identity: signer,
    spaceName,
  })).space;

  try {
    const { handler, pattern } = createTrustedBuilder(runtime).commonfabric;

    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    const createChild = handler<
      { value: string },
      { target: Cell<unknown> }
    >({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    }, {
      type: "object",
      properties: { target: { asCell: ["cell"] } },
      required: ["target"],
    }, ({ value }, { target }) => {
      target.set(Child.inSpace(spaceName)({ value }));
    });
    const Root = pattern<{ target: Cell<unknown> }>(
      ({ target }) => ({
        target,
        createChild: createChild({ target }),
      }),
      {
        type: "object",
        properties: {
          target: { asCell: ["cell"] },
        },
        required: ["target"],
      } as const,
    );

    const target = runtime.getCell(
      signer.did(),
      "pattern factory handler inSpace annotation target",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell(
      space,
      "pattern factory handler inSpace annotation result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { target }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    result.key("createChild").send({ value: "annotated child" });
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();
    await target.pull();

    // The child space is resolved before the handler write lands, so the
    // target holds a direct link to the child in the resolved space.
    const childLink = parseLink(target.getRaw(), target);
    assertEquals(childLink?.space, expectedSpace);
    assertEquals(
      await target.key("value").pull(),
      "annotated child" as any,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern factory .inSpace() rewrites named child links through writeonly bindings", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  const spaceName = `pattern-factory-in-space-writeonly-${crypto.randomUUID()}`;
  const expectedSpace = (await createSession({
    identity: signer,
    spaceName,
  })).space;

  try {
    const { handler, pattern } = createTrustedBuilder(runtime).commonfabric;

    const childSchema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    } as const;
    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    const createChild = handler<
      { value: string },
      { target: Cell<unknown> }
    >({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    }, {
      type: "object",
      properties: {
        target: { ...childSchema, asCell: ["writeonly"] },
      },
      required: ["target"],
    }, ({ value }, { target }) => {
      target.set(Child.inSpace(spaceName)({ value }));
    });
    const Root = pattern<{ target: Cell<unknown> }>(
      ({ target }) => ({
        target,
        createChild: createChild({ target }),
      }),
      {
        type: "object",
        properties: {
          target: { ...childSchema, asCell: ["cell"] },
        },
        required: ["target"],
      } as const,
    );

    const target = runtime.getCell(
      signer.did(),
      "pattern factory handler inSpace writeonly target",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell(
      space,
      "pattern factory handler inSpace writeonly result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { target }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    result.key("createChild").send({ value: "writeonly child" });
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();
    await target.pull();

    // The child space is resolved before the writeonly handler write lands, so
    // the target holds a direct link to the child in the resolved space.
    const childLink = parseLink(target.getRaw(), target);
    assertEquals(childLink?.space, expectedSpace);
    assertEquals(
      await target.key("value").pull(),
      "writeonly child" as any,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern factory .inSpace() with a cell uses that cell's space", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  const targetSpace = (await Identity.fromPassphrase(
    "pattern factory inSpace anchor cell target",
  )).did();

  try {
    const anchor = runtime.getCell(
      targetSpace,
      "inSpace anchor",
      undefined,
      tx,
    );
    const { pattern } = createTrustedBuilder(runtime).commonfabric;

    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    const Root = pattern(() => ({
      child: Child.inSpace(anchor)({ value: "anchored child" }),
    }));

    const resultCell = runtime.getCell(
      space,
      "pattern factory cell inSpace result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {}, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const childLink = result.key("child").resolveAsCell()
      .getAsNormalizedFullLink();
    assertEquals(childLink?.space, targetSpace);
    assertEquals(
      await result.key("child", "value").pull(),
      "anchored child" as any,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern factory .inSpace() without a space creates a fresh DID space during action postRun", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;

    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    const makeChild = lift(({ value }: { value: string }) =>
      Child.inSpace()({ value })
    );
    const Root = pattern<{ value: string }>((state) => ({
      child: makeChild({ value: state.value }),
    }));

    const resultCell = runtime.getCell(
      space,
      "pattern factory random inSpace action result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { value: "random child" }, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();
    // The name-resolution retry re-runs the action on delivery turns kicked
    // by the pull above; drain them and re-pull to see the re-linked child.
    await clock.settle();
    await result.pull();

    const actionLink = parseLink(result.key("child").getRaw(), result);
    const actionResult = runtime.getCellFromLink(actionLink!);
    const childLink = actionResult.resolveAsCell().getAsNormalizedFullLink();
    assertEquals(childLink?.space.startsWith("did:key:"), true);
    assertEquals(childLink?.space === space, false);
    assertEquals(
      await result.key("child", "value").pull(),
      "random child" as any,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern result schema scope overrides factory .asScope()", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;

    const Child = pattern(
      () => ({ value: "child" }),
      { type: "object", properties: {} },
      {
        type: "object",
        properties: { value: { type: "string" } },
        scope: "session",
      },
    );
    const Root = pattern(() => ({
      child: Child.asScope("user")({}),
    }));

    const resultCell = runtime.getCell(
      space,
      "pattern result schema scope override",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {}, resultCell);
    await tx.commit();
    await runtime.idle();
    await result.pull();

    const childLink = parseLink(
      result.key("child").getRaw({ lastNode: "writeRedirect" }),
      result,
    );
    assertEquals(childLink?.scope, "session");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("runtime rejects inherit scope on full normalized links", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  try {
    assertEquals(
      (() => {
        try {
          runtime.getCellFromLink({
            id: "of:unresolved-inherit-scope",
            space,
            scope: "inherit",
            path: [],
          } as any);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })(),
      "NormalizedFullLink.scope cannot be 'inherit'; resolve scope before creating a full link",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("cross-space scoped links preserve target space and resolved scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  const otherSigner = await Identity.fromPassphrase(
    "cross-space scoped link target",
  );
  const targetSpace = otherSigner.did();

  try {
    const setupTx = runtime.edit();
    const baseTarget = runtime.getCell<string>(
      targetSpace,
      "cross-space user scoped target",
      undefined,
      setupTx,
    );
    const target = createCell<string>(
      runtime,
      { ...baseTarget.getAsNormalizedFullLink(), scope: "user" },
      setupTx,
    );
    target.set("target value");
    await setupTx.commit();

    const source = runtime.getCell<{ linked?: unknown }>(
      space,
      "cross-space scoped link source",
      undefined,
      tx,
    );
    source.set({ linked: target.getAsLink({ base: source.key("linked") }) });

    const resolved = parseLink(
      source.key("linked").getRaw(),
      source.key("linked"),
    );
    assertEquals(resolved?.space, targetSpace);
    assertEquals(resolved?.scope, "user");
    assertEquals(toMemorySpaceAddress(resolved!).space, targetSpace);
    assertEquals(toMemorySpaceAddress(resolved!).scope, "user");
    assertEquals(source.key("linked").get(), "target value");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("key() does not stamp the asCell entry scope onto the container link", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const outer = runtime.getCell(
      space,
      "key-ascell container",
      {
        type: "object",
        properties: {
          // asCell field: a reference whose link lives in the container at the
          // container's own scope; the entry scope is a follow cap on the target.
          current: {
            type: "string",
            asCell: [{ kind: "cell", scope: "session" }],
          },
          // inline scoped field: addressed at its scope via write-side narrowing
          // + a base-scope redirect, not by stamping the navigated link.
          plain: { type: "string", scope: "user" },
        },
      },
      tx,
    );

    // key() only extends the path; it must NOT stamp the schema scope (asCell
    // entry or inline) onto the navigated link. Scope is carried on the schema
    // (a follow cap on reads, the target scope on writes); stamping it here reads
    // the wrong, narrower, empty scoped instance of the container.
    const current = outer.key("current");
    assertEquals(current.getAsNormalizedFullLink().scope, "space");
    const currentSchema = current.getAsNormalizedFullLink().schema as any;
    assertEquals(
      currentSchema?.asCell?.[0]?.scope ?? currentSchema?.scope,
      "session",
    );

    const plain = outer.key("plain");
    assertEquals(plain.getAsNormalizedFullLink().scope, "space");
    assertEquals(
      (plain.getAsNormalizedFullLink().schema as any)?.scope,
      "user",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("lift can read session-scoped cell passed from pattern input", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;

    const sessionTargetBase = runtime.getCell<string | null>(
      space,
      "lift captured session target",
      undefined,
      tx,
    );
    const sessionTarget = createCell<string | null>(
      runtime,
      { ...sessionTargetBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    sessionTarget.set("a");
    const sessionTargetLink = sessionTarget.getAsNormalizedFullLink();
    assertEquals(sessionTargetBase.getAsNormalizedFullLink().scope, "space");
    assertEquals(sessionTargetLink.scope, "session");
    assertEquals(sessionTarget.get(), "a");

    const isSessionOpen = lift(
      (
        { sessionTarget, id }: {
          sessionTarget: Cell<string | null>;
          id: string;
        },
      ) => sessionTarget.get() === id,
      {
        type: "object",
        properties: {
          sessionTarget: {
            anyOf: [{ type: "string" }, { type: "null" }],
            asCell: [{ kind: "cell", scope: "session" }],
          },
          id: { type: "string" },
        },
        required: ["sessionTarget", "id"],
      },
      { type: "boolean" },
    );

    const Root = pattern<{ sessionTarget: Cell<string | null> }>(
      ({ sessionTarget }) => ({
        isOpen: isSessionOpen({ sessionTarget, id: "a" }),
      }),
      {
        type: "object",
        properties: {
          sessionTarget: {
            anyOf: [{ type: "string" }, { type: "null" }],
            asCell: [{ kind: "cell", scope: "session" }],
          },
        },
        required: ["sessionTarget"],
      },
    );

    const resultCell = runtime.getCell(
      space,
      "lift reads session scoped cell passed from pattern input",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, { sessionTarget }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    // The stored argument link to the session-scoped cell must preserve its
    // own scope (and point at that cell), not be re-scoped to the container.
    const argumentCell = runtime.getCellFromLink(
      getMetaLink(result, "argument")!,
    );
    const argTarget = argumentCell.key("sessionTarget");
    const storedArgumentTargetLink = parseLink(argTarget.getRaw(), argTarget)!;
    assertEquals(storedArgumentTargetLink.id, sessionTargetLink.id);
    assertEquals(storedArgumentTargetLink.path, sessionTargetLink.path);
    assertEquals(storedArgumentTargetLink.space, sessionTargetLink.space);
    assertEquals(storedArgumentTargetLink.scope, sessionTargetLink.scope);

    assertEquals(result.key("isOpen").get() as unknown, true);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("broad computed output links to narrower scoped result", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const baseSecret = runtime.getCell<number>(
      space,
      "user scoped computation input",
      undefined,
      tx,
    );
    const secret = createCell(
      runtime,
      { ...baseSecret.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    secret.set(41);

    const Root = pattern<{ secret: number }>(({ secret }) => ({
      value: lift(
        (x: number) => x + 1,
        { type: "number" },
        { type: "number" },
      )(secret),
    }));

    const resultCell = runtime.getCell(
      space,
      "broad computed output links to narrower scoped result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { secret }, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    // Our result cell will have a link to a space scoped internal call
    // that space scoped internal cell should then have a link to a user
    // scoped cell with the value
    const internalLink = parseLink(result.key("value").getRaw(), result)!;
    const internalCell = runtime.getCellFromLink(internalLink);
    assertEquals(internalLink.scope, "space");
    const internalLinkUser = parseLink(internalCell.getRaw(), internalCell)!;
    assertEquals(internalLinkUser.scope, "user");
    assertEquals(result.key("value").get() as unknown, 42);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("opaque JS action result uses narrowest effective output scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const baseSecret = runtime.getCell<number>(
      space,
      "opaque user scoped computation input",
      undefined,
      tx,
    );
    const secret = createCell(
      runtime,
      { ...baseSecret.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    secret.set(41);

    // The nested computation is a module-scope factory (what the transformer
    // hoist produces); the action INSTANTIATES it — minting a
    // builder artifact inside an action throws (identity E5).
    const nested42 = lift(
      () => 42,
      { type: "object", properties: {} },
      { type: "number" },
    );
    const structured = lift(
      (_x: number) => ({
        nested: nested42({}),
      }),
      { type: "number" },
      {
        type: "object",
        properties: { nested: { type: "number" } },
      },
    );
    const Root = pattern<{ secret: number }>(({ secret }) => ({
      value: structured(secret),
    }));

    const resultCell = runtime.getCell(
      space,
      "opaque action result links to narrower scoped result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { secret }, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const internalLink = parseLink(result.key("value").getRaw(), result)!;
    const internalCell = runtime.getCellFromLink(internalLink);
    assertEquals(internalLink.scope, "space");
    const outputLink = parseLink(internalCell.getRaw(), internalCell)!;
    assertEquals(outputLink.scope, "user");

    const scopedOutputCell = runtime.getCellFromLink(outputLink);
    const auxiliaryLink = parseLink(
      scopedOutputCell.getRaw(),
      scopedOutputCell,
    );
    assertEquals(auxiliaryLink?.scope, "user");
    assertEquals(result.key("value").get() as unknown, { nested: 42 });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("opaque JS action result schema scope participates in effective output scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    // Hoisted factory + in-action instantiation (the transformer's hoisted
    // shape — minting inside the action throws since identity E5).
    const nested42 = lift(
      () => 42,
      { type: "object", properties: {} },
      { type: "number" },
    );
    const structured = lift(
      (_x: number) => ({
        nested: nested42({}),
      }),
      { type: "number" },
      {
        type: "object",
        properties: { nested: { type: "number" } },
        scope: "session",
      },
    );
    const Root = pattern<{ value: number }>(({ value }) => ({
      value: structured(value),
    }));

    const resultCell = runtime.getCell(
      space,
      "opaque action result schema scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { value: 41 }, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    // The result schema's scope:session participates in the effective output
    // scope: the output is addressed at the session instance. The output is
    // reachable via the result's `value` link, which carries scope:session
    // (the output's content lives in the session instance, not the base).
    const outputLink = parseLink(result.key("value").getRaw(), result);
    assertEquals(outputLink?.scope, "session");
    // Following that link resolves the session-scoped structured output.
    assertEquals(result.key("value").get() as unknown, { nested: 42 });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("map keeps outer list scope and narrows per-element result cells", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const itemBase = runtime.getCell<number>(
      space,
      "map scoped item input",
      undefined,
      tx,
    );
    const item = createCell<number>(
      runtime,
      { ...itemBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    item.set(20);

    const increment = lift(
      (x: number) => x + 1,
      { type: "number" },
      { type: "number" },
    );
    const Root = pattern<{ values: number[] }>(({ values }) => ({
      mapped: (values as any).mapWithPattern(
        pattern(({ element, index, array }: FactoryInput<any>) =>
          (((value: any) => increment(value)) as any)(element, index, array)
        ),
        {},
      ),
    }));

    const resultCell = runtime.getCell(
      space,
      "map keeps outer list scope and narrows per-element result cells",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { values: [item as any] }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawMapped = result.key("mapped").getRaw();
    const mappedLink = parseLink(rawMapped, result);
    assertEquals(mappedLink?.scope, "space");

    const mappedResultCell = runtime.getCellFromLink(mappedLink!);
    // For this, follow all the way through to the value
    // We have a non-redirect link in that chain, and we need the value anyhow
    const mappedRaw = mappedResultCell.getRaw({
      lastNode: "value",
    });
    const itemLink = Array.isArray(mappedRaw)
      ? parseLink(mappedRaw[0], mappedResultCell)
      : undefined;
    assertEquals(itemLink?.scope, "user");
    assertEquals(runtime.getCellFromLink(itemLink!).getRaw(), 21);
    assertEquals(result.key("mapped").get() as unknown, [21]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("map updates when derived list is narrowed by session input", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { handler, lift, pattern } =
      createTrustedBuilder(runtime).commonfabric;

    const selectedRoomBase = runtime.getCell<string>(
      space,
      "map derived session selected room",
      undefined,
      tx,
    );
    const selectedRoom = createCell<string>(
      runtime,
      { ...selectedRoomBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    selectedRoom.set("lobby");

    interface Message {
      body: string;
    }

    interface Conversation {
      rooms: Record<string, Message[]>;
    }

    const setConversation = handler<
      { conversation: Conversation },
      { conversation: Cell<Conversation> }
    >({
      type: "object",
      properties: {
        conversation: {
          type: "object",
          properties: {
            rooms: { type: "object" },
          },
          required: ["rooms"],
        },
      },
      required: ["conversation"],
    }, {
      type: "object",
      properties: {
        conversation: { asCell: ["cell"] },
      },
      required: ["conversation"],
    }, ({ conversation: nextConversation }, { conversation }) => {
      conversation.set(nextConversation);
    });

    const Root = pattern<{
      conversation: Conversation;
      selectedRoom: string;
    }>(({ conversation, selectedRoom }) => {
      const messages = lift(
        (
          current: { conversation: Conversation; selectedRoom: string },
        ) => current.conversation.rooms[current.selectedRoom] ?? [],
      )({ conversation, selectedRoom });
      const bodies = (messages as any).mapWithPattern(
        pattern(({ element, index, array }: FactoryInput<any>) =>
          (((message: any) =>
            lift((current: Message) => current.body)(message)) as any)(
              element,
              index,
              array,
            )
        ),
        {},
      );
      return {
        messages,
        bodies,
        setConversation: setConversation({
          conversation: conversation as unknown as Cell<Conversation>,
        }),
      };
    });

    const resultCell = runtime.getCell(
      space,
      "map updates derived session list",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {
      conversation: { rooms: { lobby: [] } },
      selectedRoom,
    }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawBodies = result.key("bodies").getRaw({
      lastNode: "writeRedirect",
    });
    const bodiesLink = parseLink(rawBodies, result);
    assertEquals(bodiesLink?.scope, "session");
    assertEquals(result.key("bodies").get() as unknown, []);

    result.key("setConversation").send({
      conversation: {
        rooms: {
          lobby: [{ body: "hello from scoped lobby" }],
        },
      },
    });
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(
      result.key("bodies").get() as unknown,
      ["hello from scoped lobby"],
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("map materializes initially populated list selected by session input", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;

    const selectedRoomBase = runtime.getCell<string>(
      space,
      "map initial session selected room",
      undefined,
      tx,
    );
    const selectedRoom = createCell<string>(
      runtime,
      { ...selectedRoomBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    selectedRoom.set("lobby");

    interface Message {
      body: string;
    }

    interface Conversation {
      rooms: Record<string, Message[]>;
    }

    const Root = pattern<{
      conversation: Conversation;
      selectedRoom: string;
    }>(({ conversation, selectedRoom }) => {
      const messages = lift(
        (
          current: { conversation: Conversation; selectedRoom: string },
        ) => current.conversation.rooms[current.selectedRoom] ?? [],
      )({ conversation, selectedRoom });
      const bodies = (messages as any).mapWithPattern(
        pattern(({ element, index, array }: FactoryInput<any>) =>
          (((message: any) =>
            lift((current: Message) => current.body)(message)) as any)(
              element,
              index,
              array,
            )
        ),
        {},
      );
      return { messages, bodies };
    });

    const resultCell = runtime.getCell(
      space,
      "map materializes initially populated session list",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {
      conversation: {
        rooms: {
          lobby: [{ body: "initial scoped lobby" }],
        },
      },
      selectedRoom,
    }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(
      result.key("bodies").get() as unknown,
      ["initial scoped lobby"],
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("ifElse selected branch materializes map over session-derived list", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { ifElse, lift, pattern } =
      createTrustedBuilder(runtime).commonfabric;

    const selectedRoomBase = runtime.getCell<string>(
      space,
      "ifElse map session selected room",
      undefined,
      tx,
    );
    const selectedRoom = createCell<string>(
      runtime,
      { ...selectedRoomBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    selectedRoom.set("lobby");

    interface Message {
      body: string;
    }

    interface Conversation {
      rooms: Record<string, Message[]>;
    }

    const Root = pattern<{
      conversation: Conversation;
      selectedRoom: string;
    }>(({ conversation, selectedRoom }) => {
      const messages = lift(
        (
          current: { conversation: Conversation; selectedRoom: string },
        ) => current.conversation.rooms[current.selectedRoom] ?? [],
      )({ conversation, selectedRoom });
      const isEmpty = lift(
        (current: Message[]) => current.length === 0,
      )(messages);
      const rendered = ifElse(
        isEmpty,
        [],
        (messages as any).mapWithPattern(
          pattern(({ element, index, array }: FactoryInput<any>) =>
            (((message: any) =>
              lift((current: Message) => current.body)(message)) as any)(
                element,
                index,
                array,
              )
          ),
          {},
        ),
      );
      return { rendered };
    });

    const resultCell = runtime.getCell(
      space,
      "ifElse selected map branch materializes",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {
      conversation: {
        rooms: {
          lobby: [{ body: "visible through selected map branch" }],
        },
      },
      selectedRoom,
    }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(
      result.key("rendered").get() as unknown,
      ["visible through selected map branch"],
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("ifElse selected VNode branch materializes map over session-derived list", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { h, ifElse, lift, pattern } =
      createTrustedBuilder(runtime).commonfabric;

    const selectedRoomBase = runtime.getCell<string>(
      space,
      "ifElse vnode map session selected room",
      undefined,
      tx,
    );
    const selectedRoom = createCell<string>(
      runtime,
      { ...selectedRoomBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    selectedRoom.set("lobby");

    interface Message {
      body: string;
    }

    interface Conversation {
      rooms: Record<string, Message[]>;
    }

    const Root = pattern<{
      conversation: Conversation;
      selectedRoom: string;
    }>(({ conversation, selectedRoom }) => {
      const messages = lift(
        (
          current: { conversation: Conversation; selectedRoom: string },
        ) => current.conversation.rooms[current.selectedRoom] ?? [],
      )({ conversation, selectedRoom });
      const isEmpty = lift(
        (current: Message[]) => current.length === 0,
      )(messages);
      const ui = ifElse(
        isEmpty,
        h("span", null, "empty"),
        h(
          "div",
          null,
          (messages as any).mapWithPattern(
            pattern(({ element, index, array }: FactoryInput<any>) =>
              (((message: any) =>
                h(
                  "span",
                  null,
                  lift((current: Message) => current.body)(message),
                )) as any)(element, index, array)
            ),
            {},
          ),
        ),
      );
      return { ui };
    });

    const resultCell = runtime.getCell(
      space,
      "ifElse selected vnode map branch materializes",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {
      conversation: {
        rooms: {
          lobby: [{ body: "visible in mapped vnode branch" }],
        },
      },
      selectedRoom,
    }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const uiLink = parseLink(
      result.key("ui").getRaw({ lastNode: "writeRedirect" }),
      result.key("ui"),
    );
    const rendered = uiLink && runtime.getCellFromLink(uiLink).getRaw() as any;
    const childRaw = Array.isArray(rendered?.children)
      ? rendered.children[0]
      : undefined;
    const nestedLink = childRaw && parseLink(childRaw, uiLink!);

    assertEquals(nestedLink?.scope, "space");
    assertEquals(
      JSON.stringify(runtime.getCellFromLink(nestedLink!).get()).includes(
        "visible in mapped vnode branch",
      ),
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("map materializes list through session boxed space-scoped reference", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { h, ifElse, lift, pattern } =
      createTrustedBuilder(runtime).commonfabric;

    interface Message {
      body: string;
    }

    interface Room {
      name: string;
      messages: Message[];
    }

    interface SelectedRoom {
      room?: Room;
    }

    const container = runtime.getCell<{
      conversation: { rooms: Room[] };
    }>(
      space,
      "boxed selected room target container",
      undefined,
      tx,
    );
    const scopedContainer = createCell<{
      conversation: { rooms: Room[] };
    }>(
      runtime,
      { ...container.getAsNormalizedFullLink(), scope: "space" },
      tx,
    );
    scopedContainer.set({
      conversation: {
        rooms: [{
          name: "Library",
          messages: [{ body: "visible through boxed room ref" }],
        }],
      },
    });
    const room = scopedContainer.key("conversation", "rooms", 0) as Cell<Room>;

    const selectedRoomBase = runtime.getCell<SelectedRoom>(
      space,
      "boxed selected room session state",
      undefined,
      tx,
    );
    const selectedRoom = createCell<SelectedRoom>(
      runtime,
      { ...selectedRoomBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    selectedRoom.set({});

    const Root = pattern<{ selectedRoom: SelectedRoom }>(
      ({ selectedRoom }) => {
        const selectedRoomRef = (selectedRoom as unknown as Cell<SelectedRoom>)
          .key("room") as Cell<Room>;
        const selectedRoomRefInputSchema = {
          type: "object",
          properties: {
            selectedRoomRef: {
              type: "object",
              properties: {
                name: { type: "string" },
                messages: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { body: { type: "string" } },
                    required: ["body"],
                  },
                },
              },
              required: ["name", "messages"],
              asCell: ["cell"],
            },
          },
          required: ["selectedRoomRef"],
        } as const;
        const messageCount = lift(
          (current: any) =>
            current.selectedRoomRef.get()?.messages?.length ?? 0,
          selectedRoomRefInputSchema,
          { type: "number" } as const,
        )({ selectedRoomRef });
        const isEmpty = lift(
          (current: number) => current === 0,
        )(messageCount);
        const ui = ifElse(
          isEmpty,
          h("span", null, "empty"),
          h(
            "div",
            null,
            (lift(
              (current: any) =>
                current.selectedRoomRef.get()?.messages as Message[],
              selectedRoomRefInputSchema,
              { type: "unknown" } as const,
            )({ selectedRoomRef }) as any).mapWithPattern(
              pattern(({ element, index, array }: FactoryInput<any>) =>
                (((message: any) =>
                  h(
                    "span",
                    null,
                    lift((current: Message) => current.body)(message),
                  )) as any)(element, index, array)
              ),
              {},
            ),
          ),
        );
        return { messageCount, ui };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "map through boxed scoped room reference",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { selectedRoom }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const updateTx = runtime.edit();
    selectedRoom.withTx(updateTx).set({ room: room as unknown as Room });
    await updateTx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(result.key("messageCount").get() as unknown, 1);
    assertEquals(
      JSON.stringify(result.key("ui").get()).includes(
        "visible through boxed room ref",
      ),
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("filter narrows output list when scoped element controls cardinality", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const itemBase = runtime.getCell<number>(
      space,
      "filter scoped item input",
      undefined,
      tx,
    );
    const item = createCell<number>(
      runtime,
      { ...itemBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    item.set(20);

    const positive = lift(
      (x: number) => x > 0,
      { type: "number" },
      { type: "boolean" },
    );
    const Root = pattern<{ values: number[] }>(({ values }) => ({
      filtered: (values as any).filterWithPattern(
        pattern(({ element, index, array }: FactoryInput<any>) =>
          (((value: any) => positive(value)) as any)(element, index, array)
        ),
        {},
      ),
    }));

    const resultCell = runtime.getCell(
      space,
      "filter narrows output list when scoped element controls cardinality",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { values: [item as any] }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawFiltered = result.key("filtered").getRaw({
      lastNode: "writeRedirect",
    });
    const filteredLink = parseLink(rawFiltered, result);
    assertEquals(filteredLink?.scope, "user");
    assertEquals(result.key("filtered").get() as unknown, [20]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("flatMap narrows output list when scoped element controls cardinality", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const itemBase = runtime.getCell<number>(
      space,
      "flatMap scoped item input",
      undefined,
      tx,
    );
    const item = createCell<number>(
      runtime,
      { ...itemBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    item.set(20);

    const expand = lift(
      (x: number) => [x, x + 1],
      { type: "number" },
      { type: "array", items: { type: "number" } },
    );
    const Root = pattern<{ values: number[] }>(({ values }) => ({
      expanded: (values as any).flatMapWithPattern(
        pattern(({ element, index, array }: FactoryInput<any>) =>
          (((value: any) => expand(value)) as any)(element, index, array)
        ),
        {},
      ),
    }));

    const resultCell = runtime.getCell(
      space,
      "flatMap narrows output list when scoped element controls cardinality",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { values: [item as any] }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawExpanded = result.key("expanded").getRaw({
      lastNode: "writeRedirect",
    });
    const expandedLink = parseLink(rawExpanded, result);
    assertEquals(expandedLink?.scope, "user");
    assertEquals(result.key("expanded").get() as unknown, [20, 21]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("ifElse output follows condition scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { ifElse, pattern } = createTrustedBuilder(runtime).commonfabric;
    const conditionBase = runtime.getCell<boolean>(
      space,
      "ifElse user scoped condition",
      undefined,
      tx,
    );
    const condition = createCell<boolean>(
      runtime,
      { ...conditionBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    condition.set(true);

    const Root = pattern<{ condition: boolean }>(({ condition }) => ({
      value: ifElse(condition, "yes", "no"),
    }));

    const resultCell = runtime.getCell(
      space,
      "ifElse output follows condition scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { condition }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawValue = result.key("value").getRaw({
      lastNode: "writeRedirect",
    });
    const valueLink = parseLink(rawValue, result);
    assertEquals(valueLink?.scope, "user");
    assertEquals(result.key("value").get() as unknown, "yes");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("session scoped derived chains update when broad inputs change", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  type RoomId = "lobby" | "workshop";
  type Conversation = {
    rooms: Record<RoomId, { body: string }[]>;
  };

  try {
    const { ifElse, lift, pattern } = createTrustedBuilder(runtime)
      .commonfabric;
    const conversationSchema = {
      type: "object",
      properties: {
        rooms: {
          type: "object",
          properties: {
            lobby: {
              type: "array",
              items: {
                type: "object",
                properties: { body: { type: "string" } },
                required: ["body"],
              },
            },
            workshop: {
              type: "array",
              items: {
                type: "object",
                properties: { body: { type: "string" } },
                required: ["body"],
              },
            },
          },
          required: ["lobby", "workshop"],
        },
      },
      required: ["rooms"],
    } as const;
    const messageListSchema = {
      type: "array",
      items: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
      },
    } as const;
    const selectMessages = lift(
      (
        { conversation, room }: {
          conversation: Conversation;
          room: RoomId;
        },
      ) => conversation.rooms[room] ?? [],
      {
        type: "object",
        properties: {
          conversation: conversationSchema,
          room: { enum: ["lobby", "workshop"] },
        },
        required: ["conversation", "room"],
      } as const,
      messageListSchema,
    );
    const countMessages = lift(
      (messages: { body: string }[]) => messages.length,
      messageListSchema,
      { type: "number" } as const,
    );
    const countLobby = lift(
      (conversation: Conversation) => conversation.rooms.lobby.length,
      conversationSchema,
      { type: "number" } as const,
    );
    const isZero = lift(
      (count: number) => count === 0,
      { type: "number" } as const,
      { type: "boolean" } as const,
    );
    const conversation = runtime.getCell<Conversation>(
      space,
      "session derived chain broad conversation",
      undefined,
      tx,
    );
    conversation.set({ rooms: { lobby: [], workshop: [] } });

    const roomBase = runtime.getCell<RoomId>(
      space,
      "session derived chain room",
      undefined,
      tx,
    );
    const room = createCell<RoomId>(
      runtime,
      { ...roomBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    room.set("lobby");

    const Root = pattern<{
      conversation: Conversation;
      room: RoomId;
    }>(({ conversation, room }) => {
      const messages = selectMessages({ conversation, room });
      const messageCount = countMessages(messages);
      const isEmpty = isZero(messageCount);

      return {
        lobbyCount: countLobby(conversation),
        messageCount,
        isEmpty,
        branch: ifElse(isEmpty, "empty", "messages"),
      };
    });

    const resultCell = runtime.getCell(
      space,
      "session derived chain result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      Root,
      { conversation, room },
      resultCell,
    );
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(result.key("lobbyCount").get() as unknown, 0);
    assertEquals(result.key("messageCount").get() as unknown, 0);
    assertEquals(result.key("isEmpty").get() as unknown, true);
    assertEquals(result.key("branch").get() as unknown, "empty");

    const updateTx = runtime.edit();
    conversation.withTx(updateTx).set({
      rooms: { lobby: [{ body: "hello" }], workshop: [] },
    });
    await updateTx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(result.key("lobbyCount").get() as unknown, 1);
    assertEquals(result.key("messageCount").get() as unknown, 1);
    assertEquals(result.key("isEmpty").get() as unknown, false);
    assertEquals(result.key("branch").get() as unknown, "messages");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("when keeps condition scope while selecting narrower value link", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern, when } = createTrustedBuilder(runtime).commonfabric;
    const valueBase = runtime.getCell<string>(
      space,
      "when user scoped selected value",
      undefined,
      tx,
    );
    const value = createCell<string>(
      runtime,
      { ...valueBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    value.set("selected");

    const Root = pattern<{ value: string }>(({ value }) => ({
      value: when(true, value),
    }));

    const resultCell = runtime.getCell(
      space,
      "when keeps condition scope while selecting narrower value link",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { value }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawValue = result.key("value").getRaw();
    const whenLink = parseLink(rawValue, result);
    assertEquals(whenLink?.scope, "space");

    const whenCell = runtime.getCellFromLink(whenLink!);
    // In this case, whenCell has a non-redirect link, so follow that
    const nextCell = runtime.getCellFromLink(parseLink(whenCell.getRaw())!);
    const selectedLink = parseLink(nextCell.getRaw());
    assertEquals(selectedLink?.scope, "user");
    assertEquals(result.key("value").get() as unknown, "selected");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("fetchJson state cells use narrowest input scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { fetchJson, pattern } = createTrustedBuilder(runtime).commonfabric;
    const urlBase = runtime.getCell<string>(
      space,
      "fetchJson user scoped url",
      undefined,
      tx,
    );
    const url = createCell<string>(
      runtime,
      { ...urlBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    url.set("");

    const Root = pattern<{ url: string }>(({ url }) => fetchJson({ url }));

    const resultCell = runtime.getCell(
      space,
      "fetchJson state cells use narrowest input scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { url }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const pendingLink = parseLink(result.key("pending").getRaw(), result);
    const resultLink = parseLink(result.key("result").getRaw(), result);
    const errorLink = parseLink(result.key("error").getRaw(), result);
    assertEquals(pendingLink?.scope, "user");
    assertEquals(resultLink?.scope, "user");
    assertEquals(errorLink?.scope, "user");
    assertEquals(result.key("pending").get() as unknown, false);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("generateText result cell uses narrowest input scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { generateText, pattern } = createTrustedBuilder(runtime)
      .commonfabric;
    const promptBase = runtime.getCell<string>(
      space,
      "generateText user scoped empty prompt",
      undefined,
      tx,
    );
    const prompt = createCell<string>(
      runtime,
      { ...promptBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    prompt.set("");

    const Root = pattern<{ prompt: string }>(({ prompt }) => ({
      text: generateText({ prompt }),
    }));

    const resultCell = runtime.getCell(
      space,
      "generateText result cell uses narrowest input scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { prompt }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawText = result.key("text").getRaw({ lastNode: "writeRedirect" });
    const textLink = parseLink(rawText, result);
    assertEquals(textLink?.scope, "user");
    assertEquals(result.key("text").key("pending").get() as unknown, false);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("llmDialog result cell uses narrowest input scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern, llmDialog } = createTrustedBuilder(runtime).commonfabric;

    const messagesBase = runtime.getCell<any[]>(
      space,
      "llmDialog user scoped messages",
      undefined,
      tx,
    );
    const messages = createCell<any[]>(
      runtime,
      { ...messagesBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    messages.set([]);

    const Root = pattern<{ messages: any[] }>(({ messages }) => ({
      dialog: llmDialog({ messages }),
    }));

    const resultCell = runtime.getCell(
      space,
      "llmDialog result cell uses narrowest input scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { messages }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawDialog = result.key("dialog").getRaw({
      lastNode: "writeRedirect",
    });
    const dialogLink = parseLink(rawDialog, result);
    assertEquals(dialogLink?.scope, "user");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("wish current-space output follows query input scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern, wish } = createTrustedBuilder(runtime).commonfabric;

    const spaceCell = runtime.getCell(space, space, undefined, tx);
    spaceCell.key("config").set({ value: "scoped" });

    const queryBase = runtime.getCell<string>(
      space,
      "wish user scoped current-space query",
      undefined,
      tx,
    );
    const query = createCell<string>(
      runtime,
      { ...queryBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    query.set("/config");

    const Root = pattern<{ query: string }>(({ query }) => ({
      found: wish({ query }),
    }));

    const resultCell = runtime.getCell(
      space,
      "wish current-space output follows query input scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { query }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const foundLink = parseLink(
      result.key("found").getRaw({ lastNode: "writeRedirect" }),
      result,
    );
    assertEquals(foundLink?.scope, "user");
    assertEquals(result.key("found").key("result").get() as unknown, {
      value: "scoped",
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("wish home-space output is at least user scoped", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern, wish } = createTrustedBuilder(runtime).commonfabric;

    const homeSpaceCell = runtime.getHomeSpaceCell(tx);
    const defaultPatternCell = runtime.getCell(
      space,
      "wish home scoped default pattern",
      undefined,
      tx,
    );
    const favoriteItem = runtime.getCell(
      space,
      "wish home scoped favorite item",
      undefined,
      tx,
    );
    favoriteItem.set({ name: "Favorite" });
    defaultPatternCell.key("favorites").set([
      { cell: favoriteItem, tags: ["favorite"] },
    ]);
    homeSpaceCell.key("defaultPattern").set(defaultPatternCell);

    const Root = pattern(() => ({
      favorites: wish({ query: "#favorites" }),
    }));

    const resultCell = runtime.getCell(
      space,
      "wish home-space output is at least user scoped",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const favoritesLink = parseLink(
      result.key("favorites").getRaw({ lastNode: "writeRedirect" }),
      result,
    );
    assertEquals(favoritesLink?.scope, "user");
    assertEquals(
      result.key("favorites").key("result").get() as unknown,
      [{ cell: favoriteItem.get(), tags: ["favorite"] }],
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("wish result schema scope overrides query-derived scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern, wish } = createTrustedBuilder(runtime).commonfabric;

    const spaceCell = runtime.getCell(space, space, undefined, tx);
    spaceCell.key("sessionConfig").set({ value: "scoped" });

    const queryBase = runtime.getCell<string>(
      space,
      "wish schema scoped current-space query",
      undefined,
      tx,
    );
    const query = createCell<string>(
      runtime,
      { ...queryBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    query.set("/sessionConfig");

    const Root = pattern<{ query: string }>(({ query }) => ({
      found: wish({
        query,
        schema: {
          type: "object",
          properties: { value: { type: "string" } },
          scope: "session",
        },
      }),
    }));

    const resultCell = runtime.getCell(
      space,
      "wish result schema scope overrides query-derived scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { query }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const foundLink = parseLink(
      result.key("found").getRaw({ lastNode: "writeRedirect" }),
      result,
    );
    assertEquals(foundLink?.scope, "session");
    assertEquals(result.key("found").key("result").get() as unknown, {
      value: "scoped",
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("scoped asCell property with no value gets an eager base-scope redirect", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const cell = runtime.getCell(
      space,
      "eager scoped redirect for omitted property",
      {
        type: "object",
        properties: {
          // Scoped reference with NO value and NO default: the object branch
          // of normalizeAndDiff must eagerly materialize the base-scope
          // redirect so later schema-less writes land in the user instance.
          myProfile: {
            type: "object",
            properties: { name: { type: "string" } },
            asCell: [{ kind: "cell", scope: "user" }],
          },
          // Sibling with a default: covered by the existing populated-keys
          // narrowing; included for contrast.
          title: { type: "string", default: "untitled" },
        },
      },
      tx,
    );

    // Write an object that OMITS the scoped property.
    cell.set({ title: "hello" } as never);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();

    // Inspect the base-scope slot through a schema-less handle (so no
    // schema-driven scope realization applies on read): it must hold a sigil
    // link to the user-scoped instance.
    const baseLink = cell.key("myProfile").getAsNormalizedFullLink();
    assertEquals(baseLink.scope, "space");
    const schemaless = createCell<{ myProfile: { name: string } }>(
      runtime,
      { ...cell.getAsNormalizedFullLink(), schema: undefined },
    );
    const storedRedirect = parseLink(
      schemaless.key("myProfile").getRaw({ lastNode: "writeRedirect" }),
      schemaless.key("myProfile"),
    );
    assertEquals(storedRedirect?.scope, "user");
    assertEquals(storedRedirect?.id, baseLink.id);

    // A schema-less write through the stored link (as a handler writing via a
    // stored cell reference would) must land in the user partition: the path
    // traverses the redirect, so the content goes to the scoped instance.
    const writeTx = runtime.edit();
    schemaless.withTx(writeTx).key("myProfile").key("name").set("Ada");
    runtime.prepareTxForCommit(writeTx);
    await writeTx.commit();
    await runtime.idle();

    const userInstance = createCell<{ name: string }>(
      runtime,
      { ...baseLink, schema: undefined, scope: "user" },
    );
    assertEquals(userInstance.getRaw(), { name: "Ada" });
    // The base slot still holds the redirect, not the content.
    assertEquals(
      parseLink(
        schemaless.key("myProfile").getRaw({ lastNode: "writeRedirect" }),
        schemaless.key("myProfile"),
      )?.scope,
      "user",
    );

    // Rewriting the object without the key must NOT strip the redirect (the
    // eager keys are exempt from the removed-keys pass).
    const rewriteTx = runtime.edit();
    cell.withTx(rewriteTx).set({ title: "hello again" } as never);
    runtime.prepareTxForCommit(rewriteTx);
    await rewriteTx.commit();
    await runtime.idle();

    assertEquals(
      parseLink(
        schemaless.key("myProfile").getRaw({ lastNode: "writeRedirect" }),
        schemaless.key("myProfile"),
      )?.scope,
      "user",
    );
    assertEquals(userInstance.getRaw(), { name: "Ada" });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("schema-less write AT a scoped slot follows the stored redirect", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const cell = runtime.getCell(
      space,
      "write at scoped slot follows redirect",
      {
        type: "object",
        properties: {
          // Mirrors PerUser<Writable<string | Default<"">>>: a scoped
          // primitive slot whose default populates the user instance and
          // leaves a redirect at the base scope.
          profileDraft: {
            type: "string",
            default: "",
            asCell: [{ kind: "cell", scope: "user" }],
          },
        },
      },
      tx,
    );

    cell.set({} as never);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();

    const baseLink = cell.key("profileDraft").getAsNormalizedFullLink();
    const schemaless = createCell<{ profileDraft: string }>(
      runtime,
      { ...cell.getAsNormalizedFullLink(), schema: undefined },
    );
    assertEquals(
      parseLink(
        schemaless.key("profileDraft").getRaw({ lastNode: "writeRedirect" }),
        schemaless.key("profileDraft").getAsNormalizedFullLink(),
      )?.scope,
      "user",
    );

    // A schema-less write AT the slot (this is what the browser renderer's
    // $value binding does: the serialized alias carries the sub-pattern's
    // scope-silent schema) must follow the stored narrower-scope link into
    // the user instance, NOT overwrite the redirect with shared base-scope
    // content.
    const writeTx = runtime.edit();
    schemaless.withTx(writeTx).key("profileDraft").set("Alice");
    runtime.prepareTxForCommit(writeTx);
    await writeTx.commit();
    await runtime.idle();

    // The base slot still holds the redirect, not the raw string.
    assertEquals(
      parseLink(
        schemaless.key("profileDraft").getRaw({ lastNode: "writeRedirect" }),
        schemaless.key("profileDraft").getAsNormalizedFullLink(),
      )?.scope,
      "user",
      "base-scope slot must keep the scoped-instance redirect",
    );
    // The content landed in the user partition.
    const userInstance = createCell<string>(
      runtime,
      { ...baseLink, schema: undefined, scope: "user" },
    );
    assertEquals(userInstance.getRaw(), "Alice");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("sub-pattern binding alias carries the parent slot's declared scope on its serialized schema", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;

    // A reusable sub-pattern whose input schema is scope-silent: it does not
    // know its caller stores the value per-user.
    const Child = pattern<{ profile: { name: string } }>(
      ({ profile }) => ({ out: profile }),
      {
        type: "object",
        properties: {
          profile: {
            type: "object",
            properties: { name: { type: "string" } },
            asCell: ["cell"],
          },
        },
        required: ["profile"],
      },
    );

    const Root = pattern<{ myProfile: { name: string } }>(
      ({ myProfile }) => ({ child: Child({ profile: myProfile }) }),
      {
        type: "object",
        properties: {
          myProfile: {
            type: "object",
            properties: { name: { type: "string" } },
            default: { name: "" },
            asCell: [{ kind: "cell", scope: "user" }],
          },
        },
        required: ["myProfile"],
      },
    );

    const resultCell = runtime.getCell(
      space,
      "sub-pattern binding alias scope folding",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const childResult = result.key("child").resolveAsCell();
    const childArgument = runtime.getCellFromLink(
      getMetaLink(childResult, "argument")!,
    );
    const storedAliasRaw = createCell<{ profile: unknown }>(
      runtime,
      { ...childArgument.getAsNormalizedFullLink(), schema: undefined },
    ).key("profile").getRaw();
    const storedAlias = parseLink(
      storedAliasRaw,
      childArgument.key("profile"),
    )!;

    // The alias targets the parent's base-scope slot (which holds the
    // scoped-instance redirect), so the link itself stays at the inherited
    // space scope...
    assertEquals(storedAlias.scope, "space");
    // ...and the parent's PerUser annotation is folded into the serialized
    // schema, making the stored link self-describing: a consumer realizes the
    // scope at read (follow cap) / write (narrowing branch) from the link
    // alone, without relying on the stored base-slot redirect existing.
    assertEquals(
      ContextualFlowControl.getSchemaScopeCap(storedAlias.schema),
      "user",
    );

    // End to end: a consumer writing through the stored alias — armed with
    // nothing but the link's own serialized schema — lands the content in the
    // user-scoped instance and leaves the base slot holding the redirect.
    const writeTx = runtime.edit();
    const consumer = runtime.getCellFromLink(
      { ...storedAlias, overwrite: undefined },
      storedAlias.schema,
      writeTx,
    );
    consumer.set({ name: "Ada" });
    runtime.prepareTxForCommit(writeTx);
    await writeTx.commit();
    await runtime.idle();

    const parentArgument = runtime.getCellFromLink(
      getMetaLink(result, "argument")!,
    );
    const parentSlot = createCell<{ myProfile: unknown }>(
      runtime,
      { ...parentArgument.getAsNormalizedFullLink(), schema: undefined },
    ).key("myProfile");
    assertEquals(
      parseLink(parentSlot.getRaw(), parentSlot)?.scope,
      "user",
      "base-scope slot must keep the scoped-instance redirect",
    );
    const userInstance = createCell<{ name: string }>(
      runtime,
      {
        ...parentArgument.getAsNormalizedFullLink(),
        path: ["myProfile"],
        schema: undefined,
        scope: "user",
      },
    );
    assertEquals(userInstance.getRaw(), { name: "Ada" });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

for (const recordScope of ["space", "user"] as const) {
  Deno.test(`child reads a ${recordScope}-scoped cell passed into a value-scoped argument slot`, async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();

    try {
      const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;

      const recordBase = runtime.getCell<{ status: string }>(
        space,
        `value-scoped argument slot ${recordScope} record`,
        undefined,
        tx,
      );
      const record = createCell<{ status: string }>(
        runtime,
        { ...recordBase.getAsNormalizedFullLink(), scope: recordScope },
        tx,
      );
      record.set({ status: "done" });

      // What `Writable<PerUser<Run>>` emits: the scope sits on the value,
      // beside a plain `asCell` entry.
      const runSchema = {
        type: "object",
        properties: { status: { type: "string" } },
        asCell: ["cell"],
        scope: "user",
      } as const;

      const readStatus = lift(
        ({ run }: { run: Cell<{ status?: string }> }) =>
          run.get()?.status ?? "missing",
        {
          type: "object",
          properties: { run: runSchema },
          required: ["run"],
        },
        { type: "string" },
      );

      const Child = pattern<{ run: Cell<{ status: string }> }>(
        ({ run }) => ({ status: readStatus({ run }) }),
        {
          type: "object",
          properties: { run: runSchema },
          required: ["run"],
        },
      );

      const Root = pattern<{ record: Cell<{ status: string }> }>(
        ({ record }) => ({ child: Child({ run: record }) }),
        {
          type: "object",
          properties: {
            record: {
              type: "object",
              properties: { status: { type: "string" } },
              asCell: ["cell"],
            },
          },
          required: ["record"],
        },
      );

      const resultCell = runtime.getCell(
        space,
        `value-scoped argument slot ${recordScope} result`,
        undefined,
        tx,
      );
      const result = runtime.run(tx, Root, { record }, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();
      await runtime.idle();
      await runtime.storageManager.synced();
      await result.pull();

      assertEquals(
        result.key("child").key("status").get() as unknown,
        "done",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
}

Deno.test("child reads a plain value passed into a value-scoped argument slot from the scoped instance", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;

    const runSchema = {
      type: "object",
      properties: { status: { type: "string" } },
      asCell: ["cell"],
      scope: "user",
    } as const;

    const readStatus = lift(
      ({ run }: { run: Cell<{ status?: string }> }) =>
        run.get()?.status ?? "missing",
      {
        type: "object",
        properties: { run: runSchema },
        required: ["run"],
      },
      { type: "string" },
    );

    const Child = pattern<{ run: Cell<{ status: string }> }>(
      ({ run }) => ({ status: readStatus({ run }) }),
      {
        type: "object",
        properties: { run: runSchema },
        required: ["run"],
      },
    );

    const resultCell = runtime.getCell(
      space,
      "value-scoped argument slot plain value result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      Child,
      { run: { status: "done" } } as never,
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(result.key("status").get() as unknown, "done");

    // The content lives in the user instance; the base slot redirects to it.
    const argument = runtime.getCellFromLink(getMetaLink(result, "argument")!);
    const baseSlot = createCell<{ run: unknown }>(
      runtime,
      { ...argument.getAsNormalizedFullLink(), schema: undefined },
    ).key("run");
    assertEquals(parseLink(baseSlot.getRaw(), baseSlot)?.scope, "user");
    const userInstance = createCell<{ status: string }>(
      runtime,
      {
        ...argument.getAsNormalizedFullLink(),
        path: ["run"],
        schema: undefined,
        scope: "user",
      },
    );
    assertEquals(userInstance.getRaw(), { status: "done" });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("a write through a value-scoped slot's handle lands in the passed cell's own instance", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    const record = runtime.getCell<{ status: string }>(
      space,
      "value-scoped slot write-back record",
      undefined,
      tx,
    );
    record.set({ status: "done" });

    const runSchema = {
      type: "object",
      properties: { status: { type: "string" } },
      asCell: ["cell"],
      scope: "user",
    } as const;
    const argumentSchema = {
      type: "object",
      properties: { run: runSchema },
      required: ["run"],
    } as const;
    const Child = pattern<{ run: Cell<{ status: string }> }>(
      ({ run }) => ({ run }),
      argumentSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "value-scoped slot write-back result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Child, { run: record } as never, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();

    // Write the way a handler does: through the handle the slot reads as.
    const writeTx = runtime.edit();
    const argument = createCell<{ run: Cell<{ status: string }> }>(
      runtime,
      {
        ...getMetaLink(result, "argument")!,
        schema: argumentSchema,
      },
      writeTx,
    );
    argument.get().run.set({ status: "finished" });
    runtime.prepareTxForCommit(writeTx);
    await writeTx.commit();
    await runtime.idle();

    // The record's shared instance holds the content, not a redirect to a
    // per-user instance other readers would find empty.
    const recordRaw = createCell<{ status: string }>(
      runtime,
      { ...record.getAsNormalizedFullLink(), schema: undefined },
    );
    assertEquals(recordRaw.getRaw(), { status: "finished" });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

for (
  const [slotSpelling, recordScope, expected] of [
    ["user-scoped", "space", "Ada"],
    ["user-scoped", "session", "missing"],
    ["user-capped handle", "space", "Ada"],
    ["user-capped handle", "session", "missing"],
  ] as const
) {
  Deno.test(`a nested binding below a ${slotSpelling} slot reads a ${recordScope}-scoped cell passed into it as ${expected}`, async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();

    try {
      const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
      const profileBase = runtime.getCell<{ name: string }>(
        space,
        `nested binding ${slotSpelling} ${recordScope} profile`,
        undefined,
        tx,
      );
      const profile = createCell<{ name: string }>(
        runtime,
        { ...profileBase.getAsNormalizedFullLink(), scope: recordScope },
        tx,
      );
      profile.set({ name: "Ada" });

      const readName = lift(
        ({ name }: { name?: string }) => name ?? "missing",
        { type: "object", properties: { name: { type: "string" } } },
        { type: "string" },
      );
      const Child = pattern<{ profile: { name: string } }>(
        ({ profile }) => ({ name: readName({ name: profile.name }) }),
        {
          type: "object",
          properties: {
            profile: slotSpelling === "user-scoped"
              ? {
                type: "object",
                properties: { name: { type: "string" } },
                scope: "user",
              }
              : {
                type: "object",
                properties: { name: { type: "string" } },
                asCell: [{ kind: "cell", scope: "user" }],
              },
          },
          required: ["profile"],
        },
      );

      const resultCell = runtime.getCell(
        space,
        `nested binding ${slotSpelling} ${recordScope} result`,
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        Child,
        { profile } as never,
        resultCell,
      );
      runtime.prepareTxForCommit(tx);
      await tx.commit();
      await runtime.idle();
      await runtime.storageManager.synced();
      await result.pull();

      assertEquals(result.key("name").get() as unknown, expected);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
}

Deno.test("a handle-scoped argument slot does not follow a narrower cell passed into it", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const recordBase = runtime.getCell<{ status: string }>(
      space,
      "handle-scoped slot session record",
      undefined,
      tx,
    );
    const record = createCell<{ status: string }>(
      runtime,
      { ...recordBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    record.set({ status: "done" });

    // What `PerUser<Writable<Run>>` emits: the scope caps the handle.
    const runSchema = {
      type: "object",
      properties: { status: { type: "string" } },
      asCell: [{ kind: "cell", scope: "user" }],
    } as const;
    const readStatus = lift(
      ({ run }: { run: Cell<{ status?: string }> }) =>
        run.get()?.status ?? "missing",
      { type: "object", properties: { run: runSchema }, required: ["run"] },
      { type: "string" },
    );
    const Child = pattern<{ run: Cell<{ status: string }> }>(
      ({ run }) => ({ status: readStatus({ run }) }),
      { type: "object", properties: { run: runSchema }, required: ["run"] },
    );

    const resultCell = runtime.getCell(
      space,
      "handle-scoped slot session result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Child, { run: record } as never, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(result.key("status").get() as unknown, "missing");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

for (const serverExecution of [false, true]) {
  for (const passed of ["a plain value", "a space-scoped cell"] as const) {
    Deno.test(
      `a session-scoped argument slot reads ${passed} passed into it${
        serverExecution ? " with server execution" : ""
      }`,
      async () => {
        const prior = getServerExecutionConfig();
        setServerExecutionConfig(serverExecution);
        try {
          const storageManager = StorageManager.emulate({ as: signer });
          const runtime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager,
          });
          const tx = runtime.edit();

          try {
            const { lift, pattern } =
              createTrustedBuilder(runtime).commonfabric;
            const name = `session slot ${passed} ${serverExecution}`;
            const draftSchema = {
              type: "object",
              properties: { text: { type: "string" } },
              asCell: ["cell"],
              scope: "session",
            } as const;
            const readText = lift(
              ({ draft }: { draft: Cell<{ text?: string }> }) =>
                draft.get()?.text ?? "missing",
              {
                type: "object",
                properties: { draft: draftSchema },
                required: ["draft"],
              },
              { type: "string" },
            );
            const Child = pattern<{ draft: Cell<{ text: string }> }>(
              ({ draft }) => ({ text: readText({ draft }) }),
              {
                type: "object",
                properties: { draft: draftSchema },
                required: ["draft"],
              },
            );

            let draft: unknown = { text: "hello" };
            if (passed === "a space-scoped cell") {
              const cell = runtime.getCell<{ text: string }>(
                space,
                `${name} draft`,
                undefined,
                tx,
              );
              cell.set({ text: "hello" });
              draft = cell;
            }
            const resultCell = runtime.getCell(
              space,
              `${name} result`,
              undefined,
              tx,
            );
            const result = runtime.run(
              tx,
              Child,
              { draft } as never,
              resultCell,
            );
            runtime.prepareTxForCommit(tx);
            await tx.commit();
            await runtime.idle();
            await runtime.storageManager.synced();
            await result.pull();

            assertEquals(result.key("text").get() as unknown, "hello");
          } finally {
            await runtime.dispose();
            await storageManager.close();
          }
        } finally {
          setServerExecutionConfig(prior);
        }
      },
    );
  }
}
