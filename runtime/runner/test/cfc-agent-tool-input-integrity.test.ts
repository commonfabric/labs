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
import type { Cell } from "../src/cell.ts";
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
  await tx.commit().settled;
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
    const commit = await seedTx.commit().settled;
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
    const commit = await seedTx.commit().settled;
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
    const commit = await seedTx.commit().settled;
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
      await tx.commit().settled;
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
      await tx.commit().settled;
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
      await tx.commit().settled;
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
      await tx.commit().settled;
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
      await tx.commit().settled;
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

/**
 * Runs `body` against the tool catalog of a pattern whose `sendRoute` tool
 * declares `inputSchema`, with a call into `body` that reads the routes the
 * tool has sent.
 */
const withTool = async <T>(
  inputSchema: JSONSchema,
  body: (tool: {
    runtime: Runtime;
    catalog: ReturnType<typeof llmToolExecutionHelpers.buildToolCatalog>;
    sent: () => Promise<string[]>;
  }) => Promise<T>,
): Promise<T> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  const { commonfabric } = createTrustedBuilder(runtime);
  const { pattern, handler, Writable } = commonfabric;
  try {
    const sendRoute = handler<{ route: string }, { sent: any }>(
      inputSchema,
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
        sent.push(route);
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
              inputSchema,
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
      "agent-send-route",
      resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();

    const catalog = llmToolExecutionHelpers.buildToolCatalog(
      result.key("tools") as any,
      false,
    );
    return await body({
      runtime,
      catalog,
      sent: async () =>
        ((await result.key("sent").pull()) as string[] | undefined) ?? [],
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/**
 * What the `sendRoute` tool declaring `inputSchema` commits after the model
 * calls it with `input`, or with what `input` returns when it is a function of
 * the tool's runtime: the routes it sent, or `[]` where the call was denied
 * before the tool ran.
 */
const sentAfterCall = (
  inputSchema: JSONSchema,
  input:
    | Record<string, unknown>
    | ((runtime: Runtime) => Promise<Record<string, unknown>>),
): Promise<string[]> =>
  withTool(inputSchema, async ({ runtime, catalog, sent }) => {
    await llmToolExecutionHelpers.executeToolCalls(runtime, space, catalog, [{
      type: "tool-call",
      toolCallId: "call-send-route",
      toolName: "sendRoute",
      input: typeof input === "function" ? await input(runtime) : input,
    }] as any);
    await runtime.idle();
    return await sent();
  });

/**
 * Commits `value` under `schema` to the cell `name`, written by the agent
 * kernel builtin, and returns the reference the model passes for it. A
 * function `value` is called with the cell, for a value that names it.
 */
const seedKernelCell = async (
  runtime: Runtime,
  name: string,
  schema: JSONSchema,
  value: unknown | ((cell: Cell<unknown>) => unknown),
): Promise<{ "@link": string }> => {
  const tx = runtime.edit();
  setCfcImplementationIdentity(tx, {
    kind: "builtin",
    builtinId: "agent-kernel-demo",
  });
  const cell = runtime.getCell(space, name, schema, tx);
  cell.set((typeof value === "function" ? value(cell) : value) as any);
  tx.prepareCfc();
  expect((await tx.commit().settled).ok).toBeDefined();
  await runtime.idle();
  return {
    "@link": createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space),
  };
};

describe("CFC trusted agent: a floor declared as anything but a list", () => {
  // A `requiredIntegrity` the specification types as a list (§8.8), declared
  // as anything else, refuses the call wherever the input schema declares it,
  // whatever the model supplied (§8.10.3), rather than read as no floor.

  const { toolInputMalformedFloor } = llmToolExecutionHelpers;
  const MALFORMED = { type: "string", ifc: { requiredIntegrity: {} } };

  it("reports a field the model may leave out", () => {
    expect(
      toolInputMalformedFloor({
        type: "object",
        properties: { route: { type: "string" }, note: MALFORMED },
      }, ""),
    ).toContain('field "note" declares a requiredIntegrity that is not a list');
  });

  it("reports an array's items, whatever the array holds", () => {
    expect(
      toolInputMalformedFloor({
        type: "object",
        properties: { recipients: { type: "array", items: MALFORMED } },
      }, ""),
    ).toContain('field "recipients[]"');
  });

  it("reports a floor behind a local reference in a recursive group", () => {
    expect(
      toolInputMalformedFloor({
        $ref: "#/$defs/Node",
        $defs: {
          Node: {
            type: "object",
            properties: { next: { $ref: "#/$defs/Node" }, tag: MALFORMED },
          },
        },
      }, ""),
    ).toContain('field "tag"');
  });

  it("reports a dictionary's values", () => {
    expect(
      toolInputMalformedFloor({
        type: "object",
        properties: {
          notes: { type: "object", additionalProperties: MALFORMED },
        },
      }, ""),
    ).toContain('field "notes.*"');
  });

  it("reports a floor beside a reference its branch has already followed", () => {
    expect(
      toolInputMalformedFloor({
        $ref: "#/$defs/Node",
        $defs: {
          Node: {
            type: "object",
            properties: {
              next: { $ref: "#/$defs/Node", ifc: { requiredIntegrity: {} } },
            },
          },
        },
      }, ""),
    ).toContain('field "next"');
  });

  it("reports nothing where every floor is a list", () => {
    expect(
      toolInputMalformedFloor({
        type: "object",
        properties: {
          note: { type: "string", ifc: { requiredIntegrity: [KERNEL_ATOM] } },
        },
      }, ""),
    ).toBeUndefined();
    expect(
      toolInputMalformedFloor({
        $ref: "#/$defs/Node",
        $defs: {
          Node: {
            type: "object",
            properties: {
              next: { $ref: "#/$defs/Node" },
              tag: {
                type: "string",
                ifc: { requiredIntegrity: [KERNEL_ATOM] },
              },
            },
          },
        },
      }, ""),
    ).toBeUndefined();
  });

  /** A tool input holding an optional tree of `Node`, defined by `node`. */
  const withTree = (node: Record<string, unknown>) =>
    ({
      type: "object",
      properties: {
        route: { type: "string" },
        tree: { $ref: "#/$defs/Node" },
      },
      required: ["route"],
      $defs: { Node: node },
    }) as unknown as JSONSchema;

  it("denies a call that leaves the field out, without running the tool", async () => {
    expect(
      await sentAfterCall(
        {
          type: "object",
          properties: { route: { type: "string" }, note: MALFORMED },
          required: ["route"],
        } as unknown as JSONSchema,
        { route: "a" },
      ),
    ).toEqual([]);
  });

  it("denies a call whose malformed floor sits beside a recursive reference", async () => {
    // The catalog's model-facing schema cuts the recursive `next` down to an
    // open object, so the gate reads the schema the tool declares.

    expect(
      await sentAfterCall(
        withTree({
          type: "object",
          properties: {
            next: { $ref: "#/$defs/Node", ifc: { requiredIntegrity: {} } },
          },
        }),
        { route: "a" },
      ),
    ).toEqual([]);
  });

  it("denies a literal under a floor reached through a recursive reference", async () => {
    // The same cut drops a well-formed floor below the recursion, so a literal
    // there passed the gate when it read the model-facing schema.

    expect(
      await sentAfterCall(
        withTree({
          type: "object",
          properties: {
            next: { $ref: "#/$defs/Node" },
            recipient: {
              type: "string",
              ifc: { requiredIntegrity: [KERNEL_ATOM] },
            },
          },
        }),
        { route: "a", tree: { next: { recipient: "attacker@example.com" } } },
      ),
    ).toEqual([]);
  });

  it("keeps the declared schema out of the request's tools", async () => {
    // A request serializes `llmTools` whole. A dormant definition holding a
    // value JSON cannot hold reaches the declared schema the gate reads, and
    // not the model-facing one.

    const inputSchema = {
      type: "object",
      properties: { route: { type: "string" } },
      required: ["route"],
      $defs: { Unused: { type: "integer", default: 1n } },
    } as unknown as JSONSchema;
    await withTool(inputSchema, ({ catalog }) => {
      expect(Object.keys(catalog.llmTools.sendRoute!).sort()).toEqual([
        "description",
        "inputSchema",
      ]);
      expect(() => JSON.stringify({ tools: catalog.llmTools })).not.toThrow();
      expect(
        (catalog.declaredInputSchemas?.get("sendRoute") as {
          $defs?: unknown;
        })?.$defs,
      ).toBeDefined();
      return Promise.resolve();
    });
  });

  it("runs the tool where no floor is malformed or unmet", async () => {
    expect(
      await sentAfterCall(
        withTree({
          type: "object",
          properties: {
            next: { $ref: "#/$defs/Node" },
            recipient: {
              type: "string",
              ifc: { requiredIntegrity: [KERNEL_ATOM] },
            },
          },
        }),
        { route: "a" },
      ),
    ).toEqual(["a"]);
  });
});

describe("CFC trusted agent: floors on a dictionary's values", () => {
  // A floor under `patternProperties` or `additionalProperties` gates each
  // supplied entry it applies to, as JSON Schema 2020-12 applies those
  // keywords: every pattern a key matches, and `additionalProperties` for a
  // key neither `properties` nor a pattern names.

  const FLOORED = { type: "string", ifc: { requiredIntegrity: [KERNEL_ATOM] } };

  /** A tool input whose optional `notes` dictionary is `dictionary`. */
  const withNotes = (dictionary: Record<string, unknown>) =>
    ({
      type: "object",
      properties: {
        route: { type: "string" },
        notes: { type: "object", ...dictionary },
      },
      required: ["route"],
    }) as unknown as JSONSchema;

  it("denies a literal under a floor on `additionalProperties`", async () => {
    expect(
      await sentAfterCall(withNotes({ additionalProperties: FLOORED }), {
        route: "a",
        notes: { x: "attacker" },
      }),
    ).toEqual([]);
  });

  it("denies a literal under a floor on a pattern the key matches", async () => {
    expect(
      await sentAfterCall(
        withNotes({ patternProperties: { "^to-": FLOORED } }),
        { route: "a", notes: { "to-main": "attacker" } },
      ),
    ).toEqual([]);
  });

  it("denies a literal under a pattern's floor on a key `properties` names", async () => {
    expect(
      await sentAfterCall(
        withNotes({
          properties: { to: { type: "string" } },
          patternProperties: { "^to$": FLOORED },
        }),
        { route: "a", notes: { to: "attacker" } },
      ),
    ).toEqual([]);
  });

  it("gates only the keys no pattern matches by `additionalProperties`", async () => {
    const schema = withNotes({
      patternProperties: { "^memo-": { type: "string" } },
      additionalProperties: FLOORED,
    });
    expect(
      await sentAfterCall(schema, { route: "a", notes: { "memo-1": "hi" } }),
    ).toEqual(["a"]);
    expect(
      await sentAfterCall(schema, { route: "a", notes: { to: "attacker" } }),
    ).toEqual([]);
  });

  it("leaves a key `properties` names to its own schema", async () => {
    expect(
      await sentAfterCall(
        withNotes({
          properties: { memo: { type: "string" } },
          additionalProperties: FLOORED,
        }),
        { route: "a", notes: { memo: "hi" } },
      ),
    ).toEqual(["a"]);
  });

  it("denies a call whose pattern is not a valid regular expression", async () => {
    // The keys an invalid pattern takes cannot be known, so neither can the
    // keys left to the floor on `additionalProperties`.

    expect(
      await sentAfterCall(
        withNotes({
          patternProperties: { "(": { type: "string" } },
          additionalProperties: FLOORED,
        }),
        { route: "a", notes: { x: "hi" } },
      ),
    ).toEqual([]);
  });

  it("runs the tool where an invalid pattern guards no floor", async () => {
    expect(
      await sentAfterCall(
        withNotes({ patternProperties: { "(": { type: "string" } } }),
        { route: "a", notes: { x: "hi" } },
      ),
    ).toEqual(["a"]);
  });

  it("runs the tool for an entry passed as a reference carrying the floor", async () => {
    expect(
      await sentAfterCall(
        withNotes({ additionalProperties: FLOORED }),
        async (runtime) => ({
          route: "a",
          notes: {
            to: await seedKernelCell(
              runtime,
              "dictionary-kernel-recipient",
              {
                type: "string",
                ifc: { integrity: [KERNEL_ATOM] },
              } as const satisfies JSONSchema,
              "alice@example.com",
            ),
          },
        }),
      ),
    ).toEqual(["a"]);
  });
});

describe("CFC trusted agent: floors beneath a reference", () => {
  // A reference the model passes is walked into wherever a floor applies at or
  // beneath it: each position beneath it is the referenced value's part there,
  // with the labels stored for that part. A floor on a whole referenced value
  // is met where every part of it carries one shared atom (§8.10.3).

  const FLOORED = { type: "string", ifc: { requiredIntegrity: [KERNEL_ATOM] } };
  const KERNEL_STRING = {
    type: "string",
    ifc: { integrity: [KERNEL_ATOM] },
  } as const satisfies JSONSchema;
  const PLAIN_STRING = { type: "string" } as const satisfies JSONSchema;

  /** A tool input whose optional `field` is `schema`. */
  const withField = (field: string, schema: Record<string, unknown>) =>
    ({
      type: "object",
      properties: { route: { type: "string" }, [field]: schema },
      required: ["route"],
    }) as unknown as JSONSchema;

  /** A mail object whose `recipient` and `nonce` are stored under the given schemas. */
  const mailSchema = (
    recipient: JSONSchema,
    nonce: JSONSchema = PLAIN_STRING,
    ifc?: Record<string, unknown>,
  ) =>
    ({
      type: "object",
      ...(ifc ? { ifc } : {}),
      properties: { recipient, nonce },
    }) as unknown as JSONSchema;

  const MAIL = { recipient: "attacker@example.com", nonce: "n" };

  /** The routes sent after the model passes `field` as a reference to `value` stored under `schema`. */
  const sentPassing = (
    inputSchema: JSONSchema,
    field: string,
    schema: JSONSchema,
    value: unknown | ((cell: Cell<unknown>) => unknown),
  ) =>
    sentAfterCall(inputSchema, async (runtime) => ({
      route: "a",
      [field]: await seedKernelCell(
        runtime,
        `reference-${field}`,
        schema,
        value,
      ),
    }));

  it("denies a reference whose field lacks the floor beneath it", async () => {
    expect(
      await sentPassing(
        withField("mail", {
          type: "object",
          properties: { recipient: FLOORED },
        }),
        "mail",
        mailSchema(PLAIN_STRING),
        MAIL,
      ),
    ).toEqual([]);
  });

  it("runs the tool for a reference whose field carries the floor beneath it", async () => {
    expect(
      await sentPassing(
        withField("mail", {
          type: "object",
          properties: { recipient: FLOORED },
        }),
        "mail",
        mailSchema(KERNEL_STRING),
        MAIL,
      ),
    ).toEqual(["a"]);
  });

  it("denies a reference to a dictionary whose entry lacks the floor on its values", async () => {
    expect(
      await sentPassing(
        withField("notes", { type: "object", additionalProperties: FLOORED }),
        "notes",
        { type: "object", additionalProperties: PLAIN_STRING } as JSONSchema,
        { to: "attacker@example.com" },
      ),
    ).toEqual([]);
  });

  it("denies a reference to an array whose element lacks the floor on its items", async () => {
    expect(
      await sentPassing(
        withField("recipients", { type: "array", items: FLOORED }),
        "recipients",
        { type: "array", items: PLAIN_STRING } as JSONSchema,
        ["attacker@example.com"],
      ),
    ).toEqual([]);
  });

  it("reads a field through a link the referenced value holds", async () => {
    // The field's labels are the ones stored where the link leads.

    const inputSchema = withField("mail", {
      type: "object",
      properties: { recipient: FLOORED },
    });
    const sentThrough = (target: JSONSchema) =>
      sentAfterCall(inputSchema, async (runtime) => {
        const recipient = llmToolExecutionHelpers.traverseAndCellify(
          runtime,
          space,
          await seedKernelCell(
            runtime,
            "linked-recipient",
            target,
            "alice@example.com",
          ),
        );
        return {
          route: "a",
          mail: await seedKernelCell(runtime, "linking-mail", {
            type: "object",
            properties: { recipient: { type: "string" } },
          } as JSONSchema, { recipient }),
        };
      });
    expect(await sentThrough(PLAIN_STRING)).toEqual([]);
    expect(await sentThrough(KERNEL_STRING)).toEqual(["a"]);
  });

  it("denies a field whose link carries the floor but whose target does not", async () => {
    // A label on the slot that holds a link endorses the reference, not the
    // contents of its target (§3.7.2, §8.2.4).

    expect(
      await sentAfterCall(
        withField("mail", {
          type: "object",
          properties: { recipient: FLOORED },
        }),
        async (runtime) => {
          const recipient = llmToolExecutionHelpers.traverseAndCellify(
            runtime,
            space,
            await seedKernelCell(
              runtime,
              "untrusted-recipient",
              PLAIN_STRING,
              "attacker@example.com",
            ),
          );
          return {
            route: "a",
            mail: await seedKernelCell(
              runtime,
              "trusted-slot-mail",
              mailSchema(KERNEL_STRING),
              { recipient },
            ),
          };
        },
      ),
    ).toEqual([]);
  });

  it("gates a referenced value that leads back to itself", async () => {
    const inputSchema = {
      type: "object",
      properties: { route: { type: "string" }, tree: { $ref: "#/$defs/Node" } },
      required: ["route"],
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" }, recipient: FLOORED },
        },
      },
    } as unknown as JSONSchema;
    const nodeSchema = (recipient: JSONSchema) =>
      ({
        type: "object",
        properties: { recipient, next: {} },
      }) as unknown as JSONSchema;
    const selfLinked = (cell: Cell<unknown>) => ({
      recipient: "alice@example.com",
      next: cell,
    });
    expect(
      await sentPassing(
        inputSchema,
        "tree",
        nodeSchema(PLAIN_STRING),
        selfLinked,
      ),
    ).toEqual([]);
    expect(
      await sentPassing(
        inputSchema,
        "tree",
        nodeSchema(KERNEL_STRING),
        selfLinked,
      ),
    ).toEqual(["a"]);
  });

  it("denies a value whose floor sits beside a schema reference the walk has met before", async () => {
    // The same definition reached through a reference with a floor beside it
    // is a different constraint, so meeting it again does not close the cycle.

    expect(
      await sentPassing(
        {
          type: "object",
          properties: {
            route: { type: "string" },
            tree: { $ref: "#/$defs/Node" },
          },
          required: ["route"],
          $defs: {
            Node: {
              type: "object",
              properties: {
                recipient: { type: "string" },
                next: {
                  $ref: "#/$defs/Node",
                  ifc: { requiredIntegrity: [KERNEL_ATOM] },
                },
              },
            },
          },
        } as unknown as JSONSchema,
        "tree",
        {
          type: "object",
          properties: { recipient: PLAIN_STRING, next: {} },
        } as unknown as JSONSchema,
        (cell: Cell<unknown>) => ({
          recipient: "attacker@example.com",
          next: cell,
        }),
      ),
    ).toEqual([]);
  });

  describe("a floor on the whole referenced value", () => {
    const inputSchema = withField("mail", {
      type: "object",
      ifc: { requiredIntegrity: [KERNEL_ATOM] },
    });

    it("denies a value only one field of which carries it", async () => {
      expect(
        await sentPassing(
          inputSchema,
          "mail",
          mailSchema(PLAIN_STRING, KERNEL_STRING),
          MAIL,
        ),
      ).toEqual([]);
    });

    it("denies a value whose only part leads back to it, labeled on that part alone", async () => {
      // The value holds no leaf of its own, so it counts as one, and the label
      // on its part covers only that part.

      expect(
        await sentPassing(
          inputSchema,
          "mail",
          {
            type: "object",
            properties: { self: { ifc: { integrity: [KERNEL_ATOM] } } },
          } as unknown as JSONSchema,
          (cell: Cell<unknown>) => ({ self: cell }),
        ),
      ).toEqual([]);
    });

    it("denies a value one part of which is another scope's instance lacking it", async () => {
      // A space-scoped and a user-scoped instance of one document share its
      // id and path, and hold different values and labels.

      expect(
        await sentAfterCall(inputSchema, async (runtime) => {
          const schema = {
            type: "object",
            properties: {
              recipient: PLAIN_STRING,
              nonce: KERNEL_STRING,
              next: {},
            },
          } as unknown as JSONSchema;
          const tx = runtime.edit();
          setCfcImplementationIdentity(tx, {
            kind: "builtin",
            builtinId: "agent-kernel-demo",
          });
          const shared = runtime.getCell(space, "scoped-mail", schema, tx);
          const user = runtime.getCellFromLink(
            { ...shared.getAsNormalizedFullLink(), scope: "user" },
            schema,
            tx,
          );
          user.set({ recipient: "attacker@example.com" } as any);
          shared.set({ nonce: "n", next: user } as any);
          tx.prepareCfc();
          expect((await tx.commit().settled).ok).toBeDefined();
          await runtime.idle();
          return {
            route: "a",
            mail: {
              "@link": createLLMFriendlyLink(
                shared.getAsNormalizedFullLink(),
                space,
              ),
            },
          };
        }),
      ).toEqual([]);
    });

    it("runs the tool for a value labeled as a whole", async () => {
      expect(
        await sentPassing(
          inputSchema,
          "mail",
          mailSchema(PLAIN_STRING, PLAIN_STRING, { integrity: [KERNEL_ATOM] }),
          MAIL,
        ),
      ).toEqual(["a"]);
    });

    it("runs the tool for a value every field of which carries it", async () => {
      expect(
        await sentPassing(
          inputSchema,
          "mail",
          mailSchema(KERNEL_STRING, KERNEL_STRING),
          MAIL,
        ),
      ).toEqual(["a"]);
    });
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
