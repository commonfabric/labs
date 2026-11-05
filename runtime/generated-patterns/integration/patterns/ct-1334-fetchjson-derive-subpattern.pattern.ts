import { computed, fetchJson, pattern } from "commonfabric";

// CT-1334: Sub-pattern combining fetchJson() with a computed() projection that
// captures a pattern parameter in a template literal.
//
// The `token` from the sub-pattern's destructured input is captured inside
// computed() via `${token}`. The ts-transformer must extract it as an
// explicit input so the projection receives the resolved value.
//
// NOTE on the explicit fetchJson<T>: this test asserts the *materialized*
// contact names, so `page.result` must carry a concrete schema. With no type
// arg, the only inference site (`result?: T`) is absent, so TS
// infers `T = unknown`; the transformer then emits the computed's input schema
// for `page.result` as `{ type: "unknown" }`. A `{type:"unknown"}` field does
// not schema-materialize across the computed capture boundary at runtime
// (runner traverse.ts returns it as `undefined`), so the body would read
// `pageResult === undefined` and `pending` would stay `true` forever.
//
// Why the old `derive` form worked untyped (investigated 2026-05): the derive
// lowering emitted a permissive `true` schema for captured fields (materializes
// anything), whereas the computed lowering emits each field's *inferred* type —
// so an `unknown`-inferred field becomes `{type:"unknown"}`, which does not
// materialize. The old `true` was a legacy hack from before the framework handled
// unknown types properly; `{type:"unknown"}` is the CORRECT behavior (confirmed
// w/ Berni), so typing the call is the right fix, not restoring `true`.
//
// An `unknown`-inferred capture fails this way silently — a reference
// carrying no fields at runtime rather than a compile error. The transformer now emits a
// `reactive-capture:unknown-type` warning for such captures, so the silent case
// surfaces at build time; typing the call (as below) is the fix and supplies the
// schema the assertion semantically requires.

const FetchPage = pattern<
  { token: string },
  { contacts: string[]; pending: boolean }
>(({ token }) => {
  const url = computed(() => {
    if (!token) return "";
    return `http://localhost:59999/api/contacts?token=${token}`;
  });

  const options = computed(() => ({
    headers: { Authorization: `Bearer ${token}` },
  }));

  const page = fetchJson<{ connections: { name: string }[] }>({
    url,
    options,
  });

  const pageResultRef = page.result;
  const pageErrorRef = page.error;
  const pagePendingRef = page.pending;

  return computed(() => {
    const pageResult: any = pageResultRef;
    const pageError: any = pageErrorRef;
    const pagePending: boolean = pagePendingRef;
    if (pagePending || !pageResult) {
      return { contacts: [] as string[], pending: true };
    }
    if (pageError) {
      return { contacts: [] as string[], pending: false };
    }
    const contacts = (pageResult.connections || []).map(
      (c: any) => c.name as string,
    );
    return { contacts, pending: false };
  });
});

export const fetchJsonDeriveSubpattern = pattern<
  { token: string },
  { contacts: string[]; pending: boolean }
>(({ token }) => {
  const fetchResult = FetchPage({ token }) as any;
  return {
    contacts: fetchResult.contacts,
    pending: fetchResult.pending,
  };
});

export default fetchJsonDeriveSubpattern;
