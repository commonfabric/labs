import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema } from "@commonfabric/api";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { enableMockMode } from "@commonfabric/llm/client";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { llmToolExecutionHelpers } from "../src/builtins/llm-dialog.ts";
import { decomposeSchema } from "../src/schema-decompose.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import type { CfcEnforcementMode } from "../src/cfc/types.ts";
import { createLLMFriendlyLink } from "../src/link-types.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("cfc agent tool-input integrity");
const space = signer.did();
enableMockMode();

// Epic D2 (docs/history/specs/cfc-trusted-agent-tool-integrity.md piece A/C): the CFC
// agent prompt-injection demo's central claim is structural. A routing field
// (`sendMail.recipient`) declares `ifc.requiredIntegrity: [agent-kernel]`, so a
// recipient the model lifted out of a hostile briefing — a plain model-output
// string carrying none of that integrity — must be REFUSED by the runtime
// before the handler runs (spec §13.6 / demos/01-agent-prompt-injection.md).
// The dialog tool path now validates each model-supplied input field against
// its inputSchema's requiredIntegrity at invoke time.

const KERNEL_ATOM = {
  type: "https://commonfabric.org/cfc/atom/Builtin",
  name: "agent-kernel-demo-v1",
} as const;

// A sendMail tool. `withFloor` toggles the requiredIntegrity floor on
// `recipient` so we can prove the gate fires only for floor-declaring fields.
async function setupSendMail(
  cfcEnforcementMode: CfcEnforcementMode,
  withFloor: boolean,
) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcEnforcementMode,
  });
  const tx = runtime.edit();
  const { commonfabric } = createTrustedBuilder(runtime);
  const { pattern, handler, Writable } = commonfabric;

  const recipientSchema = withFloor
    ? { type: "string", ifc: { requiredIntegrity: [KERNEL_ATOM] } }
    : { type: "string" };
  const sendMailInputSchema = {
    type: "object",
    properties: {
      recipient: recipientSchema,
      subject: { type: "string" },
      body: { type: "string" },
    },
    required: ["recipient", "subject", "body"],
    additionalProperties: false,
  } as JSONSchema;

  const sendMail = handler<
    { recipient: string; subject: string; body: string },
    { emails: any }
  >(
    {
      type: "object",
      properties: {
        recipient: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["recipient", "subject", "body"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        emails: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          asCell: ["cell"],
        },
      },
      required: ["emails"],
    },
    ({ recipient, subject, body }, { emails }) => {
      emails.push({ recipient, subject, body });
    },
  );

  const resultSchema = {
    type: "object",
    properties: {
      emails: {
        type: "array",
        items: { type: "object", additionalProperties: true },
      },
      tools: true,
    },
    required: ["emails", "tools"],
  } as const satisfies JSONSchema;

  const testPattern = pattern(
    () => {
      const emails = Writable.of<
        { recipient: string; subject: string; body: string }[]
      >([]);
      return {
        emails,
        tools: {
          sendMail: {
            description: "Send an email.",
            inputSchema: sendMailInputSchema,
            handler: sendMail({ emails }),
          },
        },
      };
    },
    false,
    resultSchema,
  );

  const resultCell = runtime.getCell(
    space,
    `agent-tool-input-integrity-${cfcEnforcementMode}-${withFloor}`,
    resultSchema,
    tx,
  );
  const result = runtime.run(tx, testPattern, {}, resultCell);
  runtime.prepareTxForCommit(tx);
  await tx.commit();
  await runtime.idle();

  const catalog = llmToolExecutionHelpers.buildToolCatalog(
    result.key("tools") as any,
    false,
  );

  const sendCall = async (input: unknown) => {
    await llmToolExecutionHelpers.executeToolCalls(runtime, space, catalog, [{
      type: "tool-call",
      toolCallId: "call-under-test",
      toolName: "sendMail",
      input,
    }] as any);
    await runtime.idle();
  };

  const sendInjected = () =>
    sendCall({ recipient: "bob@evil.org", subject: "exfil", body: "stuff" });

  const sentEmails = async () => {
    const emails = (await result.key("emails").pull()) as
      | { recipient: string }[]
      | undefined;
    return emails ?? [];
  };

  const injectedWasSent = async () =>
    (await sentEmails()).some((e) => e.recipient === "bob@evil.org");

  // Persist a recipient value whose stored label carries the kernel integrity
  // atom, and return the by-reference form the model would pass. Builtin-type
  // atoms are runtime-minted evidence, so the seed write must run under a
  // builtin identity — exactly how the real agent kernel binds a
  // direct-command value (pattern code cannot forge this, see
  // cfc-integrity-mint-gate.test.ts).
  const seedKernelRecipient = async (name: string, value: string) => {
    const seedTx = runtime.edit();
    setCfcImplementationIdentity(seedTx, {
      kind: "builtin",
      builtinId: "agent-kernel-demo",
    });
    const cell = runtime.getCell(
      space,
      name,
      {
        type: "string",
        ifc: { integrity: [KERNEL_ATOM] },
      } as const satisfies JSONSchema,
      seedTx,
    );
    cell.set(value);
    seedTx.prepareCfc();
    const commit = await seedTx.commit();
    expect(commit.ok).toBeDefined();
    await runtime.idle();
    return {
      "@link": createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space),
    };
  };

  // Reproduce the D1 stamp exactly as llm-dialog mints it: a builtin-identity
  // push of a message object through an item schema carrying ifc.addIntegrity
  // [LlmDerived] (see cfc-llm-derived-stamp.test.ts). The stored tool-result
  // message ends up with REAL, positive integrity — just not the kernel atom.
  // Returns a by-reference link to the stamped message element itself (the
  // label view surfaces the stamp at the element node, not its children — a
  // child-path reference would carry an empty view and be refused as an
  // unlabeled reference, which the plain-ref test already covers).
  const seedLlmDerivedRecipient = async (name: string, value: string) => {
    const messageSchema = {
      type: "object",
      properties: {
        role: { type: "string" },
        content: { type: "string" },
      },
    } as const satisfies JSONSchema;
    const stampingSchema = {
      type: "array",
      items: {
        ...messageSchema,
        ifc: { addIntegrity: [cfcAtom.llmDerived()] },
      },
    } as const satisfies JSONSchema;
    const seedTx = runtime.edit();
    setCfcImplementationIdentity(seedTx, {
      kind: "builtin",
      builtinId: "llm-dialog",
    });
    const list = runtime.getCell(space, name, stampingSchema, seedTx);
    list.push({ role: "tool", content: value });
    seedTx.prepareCfc();
    const commit = await seedTx.commit();
    expect(commit.ok).toBeDefined();
    await runtime.idle();

    // Premise check ON THE LINKED CELL: the stamp really landed — the refusal
    // the caller asserts must come from atom MISMATCH, not from an
    // accidentally-empty label (which the plain-literal tests already cover).
    const readTx = runtime.edit();
    const messageCell = runtime.getCell(
      space,
      name,
      { type: "array", items: messageSchema } as const satisfies JSONSchema,
      readTx,
    ).key(0);
    const view = cfcLabelViewForCell(messageCell);
    const integrity = (view?.entries ?? []).flatMap(
      (entry) => entry.label.integrity ?? [],
    );
    expect(integrity).toContainEqual(cfcAtom.llmDerived());
    const link = createLLMFriendlyLink(
      messageCell.getAsNormalizedFullLink(),
      space,
    );
    readTx.commit();
    return { "@link": link };
  };

  // The integrity-less twin of seedKernelRecipient: a plain stored value with
  // no label at all, referenced the same way.
  const seedPlainRecipient = async (name: string, value: string) => {
    const seedTx = runtime.edit();
    const cell = runtime.getCell(
      space,
      name,
      { type: "string" } as const satisfies JSONSchema,
      seedTx,
    );
    cell.set(value);
    seedTx.prepareCfc();
    const commit = await seedTx.commit();
    expect(commit.ok).toBeDefined();
    await runtime.idle();
    return {
      "@link": createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space),
    };
  };

  const dispose = async () => {
    await runtime.dispose();
    await storageManager.close();
  };

  return {
    sendCall,
    sendInjected,
    sentEmails,
    injectedWasSent,
    seedKernelRecipient,
    seedLlmDerivedRecipient,
    seedPlainRecipient,
    dispose,
  };
}

describe("CFC trusted agent: tool-input requiredIntegrity (Epic D2)", () => {
  it("refuses a sendMail whose recipient lacks the required integrity (injected)", async () => {
    const t = await setupSendMail("enforce-explicit", true);
    try {
      await t.sendInjected();
      expect(await t.injectedWasSent()).toBe(false);
    } finally {
      await t.dispose();
    }
  });

  it("refuses a caller-supplied result instead of silently overwriting it", async () => {
    // handleInvoke injects its result cell only when the input carries no
    // `result` of its own; a caller's `result` flows through UNMARKED, and
    // the tool handler's closed event schema (additionalProperties: false,
    // no `result` declared) refuses the undeclared field at dispatch —
    // never silently replaced by the injected cell, which would discard
    // caller data before the closed-world gate could see it.
    const t = await setupSendMail("disabled", false);
    try {
      await t.sendCall({
        recipient: "carol@example.org",
        subject: "hello",
        body: "text",
        result: "caller-forged",
      });
      expect(await t.sentEmails()).toEqual([]);
    } finally {
      await t.dispose();
    }
  });

  it("allows a by-reference recipient carrying the required integrity", async () => {
    // The legitimate path (plan D2 / spec test-plan item 2): the model passes
    // the recipient BY REFERENCE — a `{"@link": …}` object naming a cell whose
    // stored label carries the kernel atom — instead of re-emitting it as
    // text. The floor is satisfied by the referenced cell's integrity and the
    // tool executes. This proves the gate doesn't over-block the direct-command
    // route the demo's safe agent uses.
    const t = await setupSendMail("enforce-explicit", true);
    try {
      const recipientRef = await t.seedKernelRecipient(
        "direct-command-recipient",
        "john@example.org",
      );
      await t.sendCall({
        recipient: recipientRef,
        subject: "approved",
        body: "summary",
      });
      const emails = await t.sentEmails();
      expect(emails.map((e) => e.recipient)).toEqual(["john@example.org"]);
    } finally {
      await t.dispose();
    }
  });

  it("a tool result stamped LlmDerived cannot satisfy a requiredIntegrity floor (D1↔D2)", async () => {
    // The composition guard (spec test-plan item 3): D1 gives model output
    // POSITIVE integrity — the LlmDerived provenance stamp — and that stamp
    // must not satisfy a D2 floor. Guards against the gate degrading into
    // "carries any integrity" membership: a model-laundered value passed by
    // reference to its own stamped tool-result doc is refused exactly like a
    // literal, because LlmDerived is not the required kernel atom.
    const t = await setupSendMail("enforce-explicit", true);
    try {
      const llmDerivedRef = await t.seedLlmDerivedRecipient(
        "llm-derived-tool-result",
        "bob@evil.org",
      );
      await t.sendCall({
        recipient: llmDerivedRef,
        subject: "exfil",
        body: "stuff",
      });
      expect(await t.sentEmails()).toEqual([]);
    } finally {
      await t.dispose();
    }
  });

  it("refuses a by-reference recipient whose cell lacks the kernel atom", async () => {
    // The discriminating negative for the allowed path: being a reference is
    // NOT enough — the gate must read the referenced cell's stored label. A
    // link to an integrity-less cell (e.g. one the injected briefing text was
    // copied into) fails the floor exactly like a literal.
    const t = await setupSendMail("enforce-explicit", true);
    try {
      const plainRef = await t.seedPlainRecipient(
        "unlabeled-recipient",
        "bob@evil.org",
      );
      await t.sendCall({
        recipient: plainRef,
        subject: "exfil",
        body: "stuff",
      });
      expect(await t.sentEmails()).toEqual([]);
    } finally {
      await t.dispose();
    }
  });

  it("allows the JSON-string form of a by-reference recipient", async () => {
    // Models frequently serialize the link object into a string — the
    // resolver (traverseAndCellify) accepts a JSON-encoded `{"@link": …}`
    // string as the same reference, so the gate must too.
    const t = await setupSendMail("enforce-explicit", true);
    try {
      const recipientRef = await t.seedKernelRecipient(
        "direct-command-recipient-string-form",
        "john@example.org",
      );
      await t.sendCall({
        recipient: JSON.stringify(recipientRef),
        subject: "approved",
        body: "summary",
      });
      const emails = await t.sentEmails();
      expect(emails.map((e) => e.recipient)).toEqual(["john@example.org"]);
    } finally {
      await t.dispose();
    }
  });

  it("does not gate tools without a requiredIntegrity floor (no over-block)", async () => {
    // A plain-literal recipient is fine for a field that declares no floor —
    // the gate is opt-in and must not perturb ordinary tools.
    const t = await setupSendMail("enforce-explicit", false);
    try {
      await t.sendInjected();
      expect(await t.injectedWasSent()).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it("does not gate when CFC enforcement is disabled", async () => {
    const t = await setupSendMail("disabled", true);
    try {
      await t.sendInjected();
      expect(await t.injectedWasSent()).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it("observe mode is diagnostic — it does not deny the call", async () => {
    // observe is the dry-run mode: a floor failure must not block the handler.
    const t = await setupSendMail("observe", true);
    try {
      await t.sendInjected();
      expect(await t.injectedWasSent()).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it("closes the invoke-builtin bypass (a literal routed through invoke is refused)", async () => {
    // Routing through the generic `invoke` builtin must be checked against the
    // RESOLVED handler's argument schema (which carries the floor), not the
    // invoke tool's own path/args schema — otherwise the D2 gate is bypassable.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, handler, Writable } = commonfabric;
    try {
      const sendMail = handler<
        { recipient: string; subject: string; body: string },
        { emails: any }
      >(
        {
          type: "object",
          properties: {
            recipient: {
              type: "string",
              ifc: { requiredIntegrity: [KERNEL_ATOM] },
            },
            subject: { type: "string" },
            body: { type: "string" },
          },
          required: ["recipient", "subject", "body"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            emails: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              asCell: ["cell"],
            },
          },
          required: ["emails"],
        },
        ({ recipient, subject, body }, { emails }) => {
          emails.push({ recipient, subject, body });
        },
      );
      const resultSchema = {
        type: "object",
        properties: {
          emails: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          sendMail: { asCell: ["stream"] },
        },
        required: ["emails", "sendMail"],
      } as const satisfies JSONSchema;
      const testPattern = pattern(
        () => {
          const emails = Writable.of<
            { recipient: string; subject: string; body: string }[]
          >([]);
          return { emails, sendMail: sendMail({ emails }) };
        },
        false,
        resultSchema,
      );
      const resultCell = runtime.getCell(
        space,
        "agent-invoke-bypass",
        resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();
      await runtime.idle();

      // builtinTools=true → the generic `invoke` tool is available.
      const catalog = llmToolExecutionHelpers.buildToolCatalog(
        result.key("tools") as any,
        true,
      );
      const handlerLink = createLLMFriendlyLink(
        result.key("sendMail").getAsNormalizedFullLink(),
        space,
      );
      await llmToolExecutionHelpers.executeToolCalls(runtime, space, catalog, [{
        type: "tool-call",
        toolCallId: "call-invoke-bypass",
        toolName: "invoke",
        input: {
          path: handlerLink,
          args: { recipient: "bob@evil.org", subject: "x", body: "y" },
        },
      }] as any);
      await runtime.idle();

      const emails = (await result.key("emails").pull()) as
        | { recipient: string }[]
        | undefined;
      expect(
        (emails ?? []).some((e) => e.recipient === "bob@evil.org"),
      ).toBe(false);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not over-block when an optional floor-field is omitted", async () => {
    // A floor-declaring field the model did not supply carries no value to
    // gate — the call must proceed (the gate protects injected VALUES, not
    // omissions).
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, handler, Writable } = commonfabric;
    try {
      const note = handler<{ text: string; cc?: string }, { notes: any }>(
        {
          type: "object",
          properties: {
            text: { type: "string" },
            cc: { type: "string", ifc: { requiredIntegrity: [KERNEL_ATOM] } },
          },
          required: ["text"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            notes: {
              type: "array",
              items: { type: "string" },
              asCell: ["cell"],
            },
          },
          required: ["notes"],
        },
        ({ text }, { notes }) => {
          notes.push(text);
        },
      );
      const resultSchema = {
        type: "object",
        properties: {
          notes: { type: "array", items: { type: "string" } },
          tools: true,
        },
        required: ["notes", "tools"],
      } as const satisfies JSONSchema;
      const testPattern = pattern(
        () => {
          const notes = Writable.of<string[]>([]);
          return {
            notes,
            tools: {
              note: {
                description: "Note.",
                inputSchema: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    cc: {
                      type: "string",
                      ifc: { requiredIntegrity: [KERNEL_ATOM] },
                    },
                  },
                  required: ["text"],
                  additionalProperties: false,
                },
                handler: note({ notes }),
              },
            },
          };
        },
        false,
        resultSchema,
      );
      const resultCell = runtime.getCell(
        space,
        "agent-optional-floor",
        resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();
      await runtime.idle();

      const catalog = llmToolExecutionHelpers.buildToolCatalog(
        result.key("tools") as any,
        false,
      );
      // `cc` (the floor field) is omitted → the call proceeds.
      await llmToolExecutionHelpers.executeToolCalls(runtime, space, catalog, [{
        type: "tool-call",
        toolCallId: "call-omit",
        toolName: "note",
        input: { text: "hello" },
      }] as any);
      await runtime.idle();
      expect((await result.key("notes").pull()) ?? []).toEqual(["hello"]);

      // ...but supplying `cc` as a literal still fails its floor.
      await llmToolExecutionHelpers.executeToolCalls(runtime, space, catalog, [{
        type: "tool-call",
        toolCallId: "call-cc",
        toolName: "note",
        input: { text: "again", cc: "bob@evil.org" },
      }] as any);
      await runtime.idle();
      expect((await result.key("notes").pull()) ?? []).toEqual(["hello"]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("descends into array-items floors", async () => {
    // A floor under `items` must gate every model-supplied element.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, handler, Writable } = commonfabric;
    try {
      const broadcast = handler<{ recipients: string[] }, { sent: any }>(
        {
          type: "object",
          properties: {
            recipients: {
              type: "array",
              items: {
                type: "string",
                ifc: { requiredIntegrity: [KERNEL_ATOM] },
              },
            },
          },
          required: ["recipients"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            sent: {
              type: "array",
              items: { type: "string" },
              asCell: ["cell"],
            },
          },
          required: ["sent"],
        },
        ({ recipients }, { sent }) => {
          for (const r of recipients) sent.push(r);
        },
      );
      const resultSchema = {
        type: "object",
        properties: {
          sent: { type: "array", items: { type: "string" } },
          tools: true,
        },
        required: ["sent", "tools"],
      } as const satisfies JSONSchema;
      const testPattern = pattern(
        () => {
          const sent = Writable.of<string[]>([]);
          return {
            sent,
            tools: {
              broadcast: {
                description: "Broadcast.",
                inputSchema: {
                  type: "object",
                  properties: {
                    recipients: {
                      type: "array",
                      items: {
                        type: "string",
                        ifc: { requiredIntegrity: [KERNEL_ATOM] },
                      },
                    },
                  },
                  required: ["recipients"],
                  additionalProperties: false,
                },
                handler: broadcast({ sent }),
              },
            },
          };
        },
        false,
        resultSchema,
      );
      const resultCell = runtime.getCell(
        space,
        "agent-items-floor",
        resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();
      await runtime.idle();

      const catalog = llmToolExecutionHelpers.buildToolCatalog(
        result.key("tools") as any,
        false,
      );
      await llmToolExecutionHelpers.executeToolCalls(runtime, space, catalog, [{
        type: "tool-call",
        toolCallId: "call-items",
        toolName: "broadcast",
        input: { recipients: ["evil@x.org"] },
      }] as any);
      await runtime.idle();

      const sent = (await result.key("sent").pull()) as string[] | undefined;
      expect((sent ?? []).includes("evil@x.org")).toBe(false);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("passes elements past the slots of a floorless tuple", async () => {
    // The element past the tuple arity has no covering schema (no `items`),
    // so no floor position exists for it and the call executes.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, handler, Writable } = commonfabric;
    try {
      const routeInputSchema = {
        type: "object",
        properties: {
          route: {
            type: "array",
            prefixItems: [{ type: "string" }],
          },
        },
        required: ["route"],
        additionalProperties: false,
      } as const satisfies JSONSchema;
      const sendRoute = handler<{ route: string[] }, { sent: any }>(
        routeInputSchema,
        {
          type: "object",
          properties: {
            sent: {
              type: "array",
              items: { type: "string" },
              asCell: ["cell"],
            },
          },
          required: ["sent"],
        },
        ({ route }, { sent }) => {
          for (const r of route) sent.push(r);
        },
      );
      const resultSchema = {
        type: "object",
        properties: {
          sent: { type: "array", items: { type: "string" } },
          tools: true,
        },
        required: ["sent", "tools"],
      } as const satisfies JSONSchema;
      const testPattern = pattern(
        () => {
          const sent = Writable.of<string[]>([]);
          return {
            sent,
            tools: {
              sendRoute: {
                description: "Send along a route.",
                inputSchema: routeInputSchema,
                handler: sendRoute({ sent }),
              },
            },
          };
        },
        false,
        resultSchema,
      );
      const resultCell = runtime.getCell(
        space,
        "agent-tuple-floorless",
        resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();
      await runtime.idle();

      const catalog = llmToolExecutionHelpers.buildToolCatalog(
        result.key("tools") as any,
        false,
      );
      await llmToolExecutionHelpers.executeToolCalls(runtime, space, catalog, [{
        type: "tool-call",
        toolCallId: "call-tuple-open",
        toolName: "sendRoute",
        input: { route: ["a", "b"] },
      }] as any);
      await runtime.idle();

      const sent = (await result.key("sent").pull()) as string[] | undefined;
      expect(sent).toEqual(["a", "b"]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("descends into tuple (prefixItems) slot floors", async () => {
    // The gate descends `prefixItems`, so a floor declared on a tuple slot is
    // enforced: a model-supplied literal in that slot does not execute the
    // tool.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, handler, Writable } = commonfabric;
    try {
      const routeInputSchema = {
        type: "object",
        properties: {
          route: {
            type: "array",
            prefixItems: [
              {
                type: "string",
                ifc: { requiredIntegrity: [KERNEL_ATOM] },
              },
              { type: "string" },
            ],
          },
        },
        required: ["route"],
        additionalProperties: false,
      } as const satisfies JSONSchema;
      const sendRoute = handler<{ route: string[] }, { sent: any }>(
        routeInputSchema,
        {
          type: "object",
          properties: {
            sent: {
              type: "array",
              items: { type: "string" },
              asCell: ["cell"],
            },
          },
          required: ["sent"],
        },
        ({ route }, { sent }) => {
          for (const r of route) sent.push(r);
        },
      );
      const resultSchema = {
        type: "object",
        properties: {
          sent: { type: "array", items: { type: "string" } },
          tools: true,
        },
        required: ["sent", "tools"],
      } as const satisfies JSONSchema;
      const testPattern = pattern(
        () => {
          const sent = Writable.of<string[]>([]);
          return {
            sent,
            tools: {
              sendRoute: {
                description: "Send along a route.",
                inputSchema: routeInputSchema,
                handler: sendRoute({ sent }),
              },
            },
          };
        },
        false,
        resultSchema,
      );
      const resultCell = runtime.getCell(
        space,
        "agent-tuple-slot-floor",
        resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();
      await runtime.idle();

      const catalog = llmToolExecutionHelpers.buildToolCatalog(
        result.key("tools") as any,
        false,
      );
      await llmToolExecutionHelpers.executeToolCalls(runtime, space, catalog, [{
        type: "tool-call",
        toolCallId: "call-tuple",
        toolName: "sendRoute",
        // The third element sits past the tuple slots with no `items`
        // schema — no floor position exists for it (covered continue).
        input: { route: ["evil@x.org", "harmless note", "extra"] },
      }] as any);
      await runtime.idle();

      const sent = (await result.key("sent").pull()) as string[] | undefined;
      expect((sent ?? []).includes("evil@x.org")).toBe(false);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("CFC trusted agent: floors behind reference-form schemas (D2)", () => {
  // The gate's schema walk, driven directly: a literal value carries no
  // integrity, so any reachable floor must refuse it. The runtime only
  // participates in value cellification, which a literal never triggers.
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const gate = (schema: unknown, value: unknown) =>
    llmToolExecutionHelpers.toolInputRequiredIntegrityFailure(
      runtime,
      space,
      schema,
      value,
      "",
      {},
    );
  const registeredRefTo = (schema: JSONSchema): string => {
    const { rootRef, documents } = decomposeSchema(
      schema as Parameters<typeof decomposeSchema>[0],
    );
    for (const [hash, document] of documents) {
      registerSchemaDocument(hash, document);
    }
    return rootRef;
  };

  it("refuses a literal against a floor inside a referenced compound branch", () => {
    const rootRef = registeredRefTo({
      anyOf: [{
        type: "string",
        ifc: { requiredIntegrity: [KERNEL_ATOM] },
      }],
    } as JSONSchema);
    expect(gate({ $ref: rootRef }, "attacker@example.com")).toContain(
      "requires integrity",
    );
  });

  it("refuses a literal against a floor behind a nested local reference", () => {
    const rootRef = registeredRefTo({
      $ref: "#/$defs/Envelope",
      $defs: {
        Envelope: {
          type: "object",
          properties: {
            recipient: { $ref: "#/$defs/FlooredRecipient" },
          },
        },
        FlooredRecipient: {
          type: "object",
          ifc: { requiredIntegrity: [KERNEL_ATOM] },
          properties: {
            parent: { $ref: "#/$defs/Envelope" },
          },
        },
      },
    } as JSONSchema);
    expect(
      gate({ $ref: rootRef }, { recipient: { parent: undefined } }),
    ).toContain("requires integrity");
  });

  it("resolves a local reference under a nested object against the event root's $defs", () => {
    // The reference sits two levels down; it names the root's definition,
    // and the `$defs` that `envelope` declares of its own is inert below the
    // root, so the walk reaches the floor and refuses the literal for the
    // floor's own reason rather than reading the schema as unresolvable.
    const eventSchema = {
      type: "object",
      $defs: {
        Floored: {
          type: "object",
          ifc: { requiredIntegrity: [KERNEL_ATOM] },
        },
      },
      properties: {
        envelope: {
          type: "object",
          $defs: { Unrelated: { type: "string" } },
          properties: {
            recipient: { $ref: "#/$defs/Floored" },
          },
        },
      },
    } as JSONSchema;
    const failure = gate(eventSchema, { envelope: { recipient: {} } });
    expect(failure).toContain("requires integrity");
    expect(failure).not.toContain("cannot resolve");
  });

  it("refuses a local reference that only a nested object's own $defs could satisfy (fail closed)", () => {
    // The event root declares no `$defs`, so `#/$defs/Floored` names nothing
    // whatever `envelope` declares below it; the walk refuses rather than
    // reading a definition the document does not hold.
    const eventSchema = {
      type: "object",
      properties: {
        envelope: {
          type: "object",
          $defs: {
            Floored: {
              type: "object",
              ifc: { requiredIntegrity: [KERNEL_ATOM] },
            },
          },
          properties: {
            recipient: { $ref: "#/$defs/Floored" },
          },
        },
      },
    } as JSONSchema;
    expect(gate(eventSchema, { envelope: { recipient: {} } })).toContain(
      "cannot resolve",
    );
  });

  it("refuses a local reference it cannot resolve (fail closed)", () => {
    expect(gate({ $ref: "#/$defs/Missing" }, "x")).toContain(
      "cannot resolve",
    );
  });

  it("terminates on a self-referential compound group", () => {
    const rootRef = registeredRefTo({
      $ref: "#/$defs/Loop",
      $defs: {
        Loop: { anyOf: [{ $ref: "#/$defs/Loop" }, { type: "string" }] },
      },
    } as JSONSchema);
    expect(gate({ $ref: rootRef }, "plain")).toBe(undefined);
  });

  it("passes a referenced compound schema declaring no floor", () => {
    const rootRef = registeredRefTo({
      anyOf: [{ type: "string" }, { type: "number" }],
    } as JSONSchema);
    expect(gate({ $ref: rootRef }, "anything")).toBe(undefined);
  });
});
