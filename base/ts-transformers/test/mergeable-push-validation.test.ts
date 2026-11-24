import { assert, assertEquals } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

const DIAGNOSTIC_TYPE = "mergeable-push:read-then-push";

function getReadThenPushWarnings(
  diagnostics: readonly TransformationDiagnostic[],
): readonly TransformationDiagnostic[] {
  return diagnostics.filter((d) =>
    d.type === DIAGNOSTIC_TYPE && d.severity === "warning"
  );
}

Deno.test("Mergeable push validation", async (t) => {
  await t.step(
    "warns on a dedup-then-push to the same collection",
    async () => {
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "interface User { name: string; }",
        "",
        "export const addUser = handler<{ name: string }, {",
        "  users: Cell<User[]>;",
        "}>((event, { users }) => {",
        "  const existing = users.get();",
        "  if (existing.some((u) => u.name === event.name)) return;",
        "  users.push({ name: event.name });",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const warnings = getReadThenPushWarnings(diagnostics);
      assertEquals(warnings.length, 1);
      // The message points at the two recommended alternatives, not at
      // splitting handlers: the push depends on the read here.
      assert(warnings[0]!.message.includes("addUnique"));
      assert(warnings[0]!.message.includes("set"));
      assert(!warnings[0]!.message.includes("its own handler"));
      // It is non-fatal: no error of this type.
      assertEquals(
        diagnostics.filter((d) =>
          d.type === DIAGNOSTIC_TYPE && d.severity === "error"
        ).length,
        0,
      );
    },
  );

  await t.step(
    "warns when the push is enclosed in a read-derived guard",
    async () => {
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "interface User { name: string; }",
        "",
        "export const addUser = handler<{ name: string }, {",
        "  users: Cell<User[]>;",
        "}>((event, { users }) => {",
        "  const existing = users.get();",
        "  if (!existing.some((u) => u.name === event.name)) {",
        "    users.push({ name: event.name });",
        "  }",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const warnings = getReadThenPushWarnings(diagnostics);
      assertEquals(warnings.length, 1);
      assert(warnings[0]!.message.includes("addUnique"));
    },
  );

  await t.step(
    "warns on an iterate-dedup loop followed by a push",
    async () => {
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "interface User { name: string; }",
        "",
        "export const addUser = handler<{ name: string }, {",
        "  users: Cell<User[]>;",
        "}>((event, { users }) => {",
        "  for (const u of users.get()) {",
        "    if (u.name === event.name) return;",
        "  }",
        "  users.push({ name: event.name });",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const warnings = getReadThenPushWarnings(diagnostics);
      assertEquals(warnings.length, 1);
      assert(warnings[0]!.message.includes("addUnique"));
    },
  );

  await t.step(
    "warns with the split-handler message on an append plus independent trim",
    async () => {
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "export const addMessage = handler<{ msg: string }, {",
        "  messages: Cell<string[]>;",
        "}>((event, { messages }) => {",
        "  messages.push(event.msg);",
        "  const current = messages.get();",
        "  messages.set(current.slice(-50));",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const warnings = getReadThenPushWarnings(diagnostics);
      assertEquals(warnings.length, 1);
      // The read serves the trim, not the push: the remedy is to split the
      // handlers, and recommending addUnique would be a misdiagnosis.
      assert(warnings[0]!.message.includes("its own handler"));
      assert(!warnings[0]!.message.includes("addUnique"));
    },
  );

  await t.step(
    "does not warn when the read serves neither the push nor another write",
    async () => {
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "interface User { name: string; }",
        "",
        "export const addUser = handler<{ name: string }, {",
        "  users: Cell<User[]>;",
        "  log: Cell<User[][]>;",
        "}>((event, { users, log }) => {",
        "  const snapshot = users.get();",
        "  log.push(snapshot);",
        "  users.push({ name: event.name });",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(getReadThenPushWarnings(diagnostics).length, 0);
    },
  );

  await t.step(
    "prefers the dependent-push diagnosis when both shapes touch the same collection",
    async () => {
      // The first push precedes the guard (independent, explained by the
      // trailing set); the second is dedup-guarded (read-dependent). One
      // warning, and the stronger dependent diagnosis wins.
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "interface User { name: string; }",
        "",
        "export const addUser = handler<{ name: string }, {",
        "  users: Cell<User[]>;",
        "}>((event, { users }) => {",
        "  const existing = users.get();",
        '  users.push({ name: "audit" });',
        "  if (existing.some((u) => u.name === event.name)) return;",
        "  users.push({ name: event.name });",
        "  users.set(existing.slice(-10));",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const warnings = getReadThenPushWarnings(diagnostics);
      assertEquals(warnings.length, 1);
      assert(warnings[0]!.message.includes("addUnique"));
      assert(!warnings[0]!.message.includes("its own handler"));
    },
  );

  await t.step(
    "does not warn on an unconditional push with no read",
    async () => {
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "interface User { name: string; }",
        "",
        "export const addUser = handler<{ name: string }, {",
        "  users: Cell<User[]>;",
        "}>((event, { users }) => {",
        "  users.push({ name: event.name });",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(getReadThenPushWarnings(diagnostics).length, 0);
    },
  );

  await t.step(
    "does not warn when the read is of a different collection",
    async () => {
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "interface User { name: string; }",
        "",
        "export const addUser = handler<{ name: string }, {",
        "  users: Cell<User[]>;",
        "  log: Cell<string[]>;",
        "}>((event, { users, log }) => {",
        "  log.get();",
        "  users.push({ name: event.name });",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(getReadThenPushWarnings(diagnostics).length, 0);
    },
  );

  await t.step(
    "reports one warning even with several pushes to the same read collection",
    async () => {
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "interface User { name: string; }",
        "",
        "export const addUser = handler<{ a: string; b: string }, {",
        "  users: Cell<User[]>;",
        "}>((event, { users }) => {",
        "  const existing = users.get();",
        "  if (existing.some((u) => u.name === event.a)) return;",
        "  users.push({ name: event.a });",
        "  users.push({ name: event.b });",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(getReadThenPushWarnings(diagnostics).length, 1);
    },
  );

  await t.step(
    "reports one warning for a lift-applied callback, not one per call site",
    async () => {
      // `lift(cb)(input)` exposes both the applied outer call and the unapplied
      // inner `lift(cb)` call, and both resolve to the same callback node.
      // Without per-callback deduplication the read-then-push warns twice.
      // The pushed value derives from the read, so this is read-dependent.
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "declare const someInput: { items: number[] };",
        "",
        "export const doubled = lift((s: { items: number[] }) => {",
        "  const current = s.items;",
        "  s.items.push(current.length);",
        "  return current;",
        "})(someInput);",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(getReadThenPushWarnings(diagnostics).length, 1);
    },
  );

  await t.step(
    "does not warn on the identity-addressed addUnique fix",
    async () => {
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "interface User { name: string; }",
        "",
        "export const addUser = handler<{ name: string }, {",
        "  users: Cell<User[]>;",
        "}>((event, { users }) => {",
        "  const existing = users.get();",
        "  if (existing.some((u) => u.name === event.name)) return;",
        "  users.addUnique({ name: event.name });",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(getReadThenPushWarnings(diagnostics).length, 0);
    },
  );
});
