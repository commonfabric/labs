# Direct CFC Exchange Rules

This demo is the canonical copyable form for a module-authored direct policy:

1. Export each static `exchangeRule(...)` declaration.
2. Export one `exchangeRules([...])` set that owns each rule exactly once.
3. Apply it with `Confidential<T, [PolicyOf<typeof rules>]>`.

`cfcPattern` constructs match patterns and may contain `v(...)` or
`THIS_POLICY.subject`. `cfcAtom` constructs concrete runtime atoms; the two
surfaces are intentionally separate.

`blessed-computation.tsx` releases the output of one function defined in the
policy's own module. When every write of a transaction comes from one verified
function, the runtime mints a `TransformedBy` atom naming that function's module
and export name onto what it writes, and the rule matches it with
`moduleIdentity: THIS_POLICY.moduleIdentity`, which binds to the defining
module's identity at evaluation time. Another function of the same module, a
handler copying a raw input, or a different version of the module does not
satisfy the rule. `blessed-object.tsx` does the same for a function returning an
object, whose object node is released along with its fields.

The compiler binds `PolicyOf` to the defining module export and a canonical
manifest digest. At label creation the runtime binds the concrete owning space
as the policy subject and requires that exact manifest to be installed in the
destination. Missing or mismatched manifests fail closed.

The rule can rewrite only the clause containing its exact module-policy
reference. Sibling and input-derived clauses remain conjunctive and untouched.
`imported-policy.tsx` demonstrates that importing the ruleset retains the
identity of `direct-release.tsx`; a pinned `cf:pattern:<identity>` import
follows the same defining-identity rule.

Multiple entries in `Confidential<T, [PolicyOf<A>, PolicyOf<B>]>` are separate
conjunctive clauses: both must release. Spell a deliberate weakening as
`Confidential<T, [AnyOf<[PolicyOf<A>, PolicyOf<B>]>]>`; this creates one
disjunctive clause where either policy is sufficient. `AnyOf` still uses the
runtime's authored-OR validation and cannot contain forbidden expiry or caveat
alternatives.

Run:

```sh
deno task cf check packages/patterns/cfc-exchange-rules/direct-release.tsx --show-transformed --no-run
deno task cf test packages/patterns/cfc-exchange-rules/direct-release.test.tsx
deno task cf test packages/patterns/cfc-exchange-rules/blessed-computation.test.tsx
deno task cf test packages/patterns/cfc-exchange-rules/blessed-object.test.tsx
```
