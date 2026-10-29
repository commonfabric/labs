import { assert, assertEquals } from "@std/assert";
import { CompilerError, TransformerError } from "@commonfabric/js-compiler";
import { SlugAssignedError } from "@commonfabric/piece";
import { SlugResolutionError } from "@commonfabric/runner";
import { ValidationError } from "@cliffy/command";
import { IdentityKeyfileError } from "../lib/identity.ts";
import { renderCliError } from "../mod.ts";

Deno.test("renderCliError prints a TransformerError's message, not its stack", () => {
  const e = new TransformerError([], new Map());
  assertEquals(renderCliError(e), e.message);
  assert(renderCliError(e) !== e.stack);
});

Deno.test("renderCliError prints a CompilerError's message, not its stack", () => {
  const e = new CompilerError([]);
  assertEquals(renderCliError(e), e.message);
  assert(renderCliError(e) !== e.stack);
});

Deno.test("renderCliError prints a ValidationError's message, not its stack", () => {
  const e = new ValidationError("bad option");
  assertEquals(renderCliError(e), e.message);
  assert(renderCliError(e) !== e.stack);
});

Deno.test("renderCliError prints a SlugResolutionError's message, not its stack", () => {
  // Every one of these says what a name in the space points at, or does not:
  // a sentence a person acts on, buried by a stack over it.
  const e = new SlugResolutionError("no member 999 in top", "missing-member");
  assertEquals(renderCliError(e), e.message);
  assert(renderCliError(e) !== e.stack);
});

Deno.test("renderCliError prints a SlugAssignedError's message, not its stack", () => {
  // A refusal to take a name someone holds says what it points at and how to
  // take it anyway. Without this the class falls through to the plain-Error
  // arm below and every such refusal reaches the operator as a stack.
  const e = new SlugAssignedError("top", "/of:fid1:abc", "Pass --force.");
  assertEquals(renderCliError(e), e.message);
  assert(renderCliError(e) !== e.stack);
});

Deno.test("renderCliError prints an IdentityKeyfileError's message, not its stack", () => {
  // The message names the keyfile's path, what is wrong with it, and what to
  // do; a stack over it buries the one line the operator acts on.
  const e = new IdentityKeyfileError(
    "/home/me/.config/commonfabric/identity.key",
    "does not exist",
    "Point --identity or CF_IDENTITY at an existing keyfile.",
  );
  assertEquals(renderCliError(e), e.message);
  assert(renderCliError(e) !== e.stack);
});

Deno.test("renderCliError prints a plain Error's stack", () => {
  const e = new Error("boom");
  assertEquals(renderCliError(e), e.stack);
});

Deno.test("renderCliError falls back to the message when an Error has no stack", () => {
  const e = new Error("boom");
  e.stack = undefined;
  assertEquals(renderCliError(e), "boom");
});

Deno.test("renderCliError passes a non-Error value through unchanged", () => {
  assertEquals(renderCliError("oops"), "oops");
  assertEquals(renderCliError(42), 42);
});
