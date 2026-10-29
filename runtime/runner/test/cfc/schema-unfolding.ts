/**
 * Compares two schema documents by what they unfold to rather than by how
 * they are written. Every local `#/$defs/<name>` reference is read against the
 * document root's map, the only map a reference binds to in this runtime (see
 * `cfcSchemaResolvedRoot()`), so a `$defs` below the root, a definition no
 * reference reaches, and the name a definition goes by all drop out. Two
 * documents compare alike when their unfoldings are the same tree, recursion
 * included: the walk is a bisimulation over the two reference graphs, so it
 * ends on cyclic definitions and does not care how deep either document has
 * written a recursion out inline.
 *
 * A reference whose siblings are annotations alone reads as the referenced
 * body with those annotations laid over it, which every reading of a `$ref`
 * site in this runtime agrees on: an annotation constrains no value and
 * carries no claim. A reference beside anything else, an `ifc` above all, is
 * compared as written, its siblings and its target separately, so two
 * documents compare alike only when they agree under whichever reading a
 * consumer gives such a site. A `cid:` or embedded reference compares by its
 * text.
 *
 * What this cannot see: anything a consumer reads off a document other than
 * its unfolding — the names of definitions, a map below the root, an
 * unreached definition, or where a walk that stops at the first repeated
 * schema object happens to stop.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { hashStringOf } from "@commonfabric/data-model";
import { forEachSubschema } from "@commonfabric/data-model-schema/schema-walk";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { localDefinitionName } from "../../src/cfc/schema-refs.ts";

/** Keywords that annotate a schema and constrain no value. */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  "title",
  "description",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/** One unfolded node: what it says itself, and where its subschemas lead. */
type Unfolded = {
  label: string;
  shown: unknown;
  edges: Map<string, JSONSchema>;
};

/**
 * Helper for `schemaUnfoldingDifferences()`, which unfolds the schemas of one
 * document, each schema object once, so a recursion revisits the same nodes.
 */
class DocumentUnfolding {
  #root: JSONSchema;
  #nodes = new Map<JSONSchema, Unfolded>();

  /** Constructs an instance which unfolds schemas found in `root`. */
  constructor(root: JSONSchema) {
    this.#root = root;
  }

  /** The node `schema` unfolds to, past any reference read as its body. */
  nodeOf(schema: JSONSchema): Unfolded {
    let node = this.#nodes.get(schema);
    if (node === undefined) {
      node = this.#unfold(schema, new Set());
      this.#nodes.set(schema, node);
    }
    return node;
  }

  #unfold(schema: JSONSchema, following: Set<JSONSchema>): Unfolded {
    if (!isObjectNotArray(schema)) {
      return {
        label: hashStringOf(["value", schema]),
        shown: schema,
        edges: new Map(),
      };
    }
    const { $ref, $defs: _inert, ...siblings } = schema as JSONSchemaObj;
    if (typeof $ref === "string") {
      const target = this.#target($ref);
      if (target !== undefined && this.#readsAsOverlay(siblings, target)) {
        // A chain of references that leads back to itself reaches no body,
        // and every such chain is the same node.
        if (following.has(target)) {
          return {
            label: hashStringOf(["reference cycle"]),
            shown: "reference cycle",
            edges: new Map(),
          };
        }
        following.add(target);
        return this.#unfold(
          Object.keys(siblings).length === 0
            ? target
            : { ...target as JSONSchemaObj, ...siblings },
          following,
        );
      }
      const node = this.#structural(siblings);
      const site = target === undefined ? $ref : "local";
      node.label = hashStringOf(["ref site", site, node.label]);
      node.shown = { refSite: site, siblings: node.shown };
      if (target !== undefined) node.edges.set("$ref", target);
      return node;
    }
    return this.#structural(siblings);
  }

  // Whether a `$ref` site with these siblings means its target with the
  // siblings laid over it, whichever way a consumer reads the site: the
  // runtime's resolution lays siblings over the body, the merge keeps the
  // body's own claims beneath a sibling `ifc`, and JSON Schema conjoins the
  // two. They agree when the siblings are annotations, which constrain
  // nothing; a sibling under a keyword the target does not use, an `ifc`
  // over a target that declares none above all, which is added whether
  // laid over or conjoined; and a sibling that repeats what the target says
  // under the same keyword, which changes nothing either way.
  #readsAsOverlay(siblings: JSONSchemaObj, target: JSONSchema): boolean {
    const keys = Object.keys(siblings);
    if (keys.length === 0) return true;
    if (!isObjectNotArray(target)) return false;
    const said = target as Record<string, unknown>;
    const laid = siblings as Record<string, unknown>;
    return keys.every((key) =>
      ANNOTATION_KEYWORDS.has(key) || said[key] === undefined ||
      deepEqual(laid[key], said[key])
    );
  }

  // The keywords of `schema` that hold no subschema form its label; those
  // that do are edges, keyed by keyword, member name and index.
  #structural(schema: JSONSchemaObj): Unfolded {
    const edges = new Map<string, JSONSchema>();
    const keywords = new Set<string>();
    forEachSubschema(schema, (child, keyword, key, index) => {
      keywords.add(keyword);
      edges.set(`${keyword}\u0000${key ?? ""}\u0000${index ?? ""}`, child);
    }, { includeUnused: true, visitBooleans: true });
    const label = Object.fromEntries(
      Object.entries(schema).filter(([key]) => !keywords.has(key)),
    );
    return { label: hashStringOf(["schema", label]), shown: label, edges };
  }

  #target(ref: string): JSONSchema | undefined {
    const name = localDefinitionName(ref);
    if (name === undefined || !isObjectNotArray(this.#root)) return undefined;
    const definitions = (this.#root as JSONSchemaObj).$defs;
    return isObjectNotArray(definitions) && Object.hasOwn(definitions, name)
      ? definitions[name]
      : undefined;
  }
}

/** One place two documents unfold differently. */
export type UnfoldingDifference = {
  /** The edges walked from the root to reach it. */
  path: string;

  /** What each side says there, apart from its subschemas. */
  left: unknown;
  right: unknown;
};

/**
 * Every place `left` and `right` unfold differently, reached first by a walk
 * that does not descend below a difference. Empty when the two unfold to the
 * same tree.
 */
export function schemaUnfoldingDifferences(
  left: JSONSchema,
  right: JSONSchema,
): UnfoldingDifference[] {
  const leftDocument = new DocumentUnfolding(left);
  const rightDocument = new DocumentUnfolding(right);
  const differences: UnfoldingDifference[] = [];
  const visited = new Map<Unfolded, Set<Unfolded>>();
  const pending: { left: JSONSchema; right: JSONSchema; path: string }[] = [
    { left, right, path: "" },
  ];
  while (pending.length > 0) {
    const pair = pending.pop()!;
    const leftNode = leftDocument.nodeOf(pair.left);
    const rightNode = rightDocument.nodeOf(pair.right);
    let partners = visited.get(leftNode);
    if (partners?.has(rightNode)) continue;
    if (partners === undefined) visited.set(leftNode, partners = new Set());
    partners.add(rightNode);
    const keys = [...leftNode.edges.keys()].sort();
    const otherKeys = [...rightNode.edges.keys()].sort();
    if (
      leftNode.label !== rightNode.label ||
      keys.join("\u0001") !== otherKeys.join("\u0001")
    ) {
      differences.push({
        path: pair.path || "/",
        left: { says: leftNode.shown, edges: keys },
        right: { says: rightNode.shown, edges: otherKeys },
      });
      continue;
    }
    for (const key of keys) {
      pending.push({
        left: leftNode.edges.get(key)!,
        right: rightNode.edges.get(key)!,
        path: `${pair.path}/${key.replaceAll("\u0000", ":")}`,
      });
    }
  }
  return differences;
}
