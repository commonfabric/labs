// For every entity named in <ids file> (one `id<TAB>scope` per line, scope
// `space` when absent), the top-level value fields that differ between the
// pristine store and the working store. Read-only on both.
//
//   deno run ... field-diff.ts <pristine db> <working db> <ids file> <out.jsonl>
//
// PIN_ROOT is the checkout imports resolve against.

const ROOT = Deno.env.get("PIN_ROOT")!;
const { openSpace } = await import(`${ROOT}/packages/state-inspector/db.ts`);
const { getValueAt } = await import(
  `${ROOT}/packages/state-inspector/reconstruct.ts`
);
const { fabricAwareEqual } = await import(
  `${ROOT}/packages/data-model/src/index.ts`
);
const { isPlainObject } = await import(`${ROOT}/packages/utils/src/types.ts`);

const [pristinePath, workingPath, idsPath, outPath] = Deno.args;
const pristine = openSpace(pristinePath);
const working = openSpace(workingPath);
const ids = (await Deno.readTextFile(idsPath)).split("\n").filter(Boolean);
const out = await Deno.open(outPath, {
  create: true,
  truncate: true,
  write: true,
});
const encoder = new TextEncoder();

/** The value at `id`, or undefined when the store holds none. */
// deno-lint-ignore no-explicit-any
const valueOf = (space: any, id: string, scope: string) => {
  const at = getValueAt(space, { id, scope, branch: "" });
  return at.pathExists ? at.document.value : undefined;
};

for (const line of ids) {
  const [id, scope = "space"] = line.split("\t");
  const row: Record<string, unknown> = { id, scope };
  try {
    const before = valueOf(pristine, id, scope);
    const after = valueOf(working, id, scope);
    // Plain objects only: a special object (bytes, a fabric instance) keeps its
    // state where `Object.keys` cannot see it, so it is compared whole.
    if (isPlainObject(before) && isPlainObject(after)) {
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      row.changed = [...keys].filter((key) =>
        !fabricAwareEqual(before[key], after[key])
      ).sort();
      row.added = [...keys].filter((key) =>
        !Object.hasOwn(before, key) && Object.hasOwn(after, key)
      ).sort();
    } else {
      row.changed = fabricAwareEqual(before, after) ? [] : ["<whole value>"];
    }
  } catch (error) {
    row.error = String(error).slice(0, 300);
  }
  await out.write(encoder.encode(JSON.stringify(row) + "\n"));
}
out.close();
Deno.exit(0);
