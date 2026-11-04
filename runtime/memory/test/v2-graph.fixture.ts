import type { JSONSchema } from "@commonfabric/api";
import type { URI } from "../interface.ts";

type GraphLink = {
  "/": {
    "link@1": {
      id: URI;
      path: [];
      space: string;
    };
  };
};

export type GraphDoc = {
  name: string;
  metadata: { tag: string };
  primary?: GraphLink;
  alternate?: GraphLink;
  children?: GraphLink[];
};

export type GraphFixture = {
  docs: Array<{ id: URI; value: GraphDoc }>;
  rootId: URI;
  hiddenRootId: URI;
  initialReachableIds: URI[];
  expandedReachableIds: URI[];
  schema: JSONSchema;
  expandedRootValue: GraphDoc;
};

const nodeId = (index: number) =>
  `of:test-node-${String(index).padStart(2, "0")}` as URI;

const linkTo = (space: string, id: URI): GraphLink => ({
  "/": {
    "link@1": {
      id,
      path: [],
      space,
    },
  },
});

const clone = <T>(value: T): T => structuredClone(value);

const nodeSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    metadata: {
      type: "object",
      properties: {
        tag: { type: "string" },
      },
      required: ["tag"],
      additionalProperties: false,
    },
    primary: { $ref: "#/$defs/node" },
    alternate: { $ref: "#/$defs/node" },
    children: {
      type: "array",
      items: { $ref: "#/$defs/node" },
    },
  },
  required: ["name", "metadata"],
  additionalProperties: false,
} as const satisfies JSONSchema;

export const createGraphFixture = (space: string): GraphFixture => {
  const docs = new Map<URI, GraphDoc>();
  const initialReachableIds = Array.from(
    { length: 32 },
    (_, index) => nodeId(index),
  );
  const expandedReachableIds = Array.from(
    { length: 64 },
    (_, index) => nodeId(index),
  );

  for (let index = 0; index < 64; index += 1) {
    docs.set(nodeId(index), {
      name: `Node ${String(index).padStart(2, "0")}`,
      metadata: { tag: `tag-${String(index).padStart(2, "0")}` },
    });
  }

  for (let index = 0; index < 28; index += 1) {
    const doc = docs.get(nodeId(index))!;
    const children: GraphLink[] = [];
    const left = (index * 2) + 1;
    const right = (index * 2) + 2;
    if (left < 28) {
      doc.primary = linkTo(space, nodeId(left));
      children.push(linkTo(space, nodeId(left)));
    }
    if (right < 28) {
      children.push(linkTo(space, nodeId(right)));
    }
    if (children.length > 0) {
      doc.children = children;
    }
    if (index % 3 === 0) {
      doc.alternate = linkTo(space, nodeId(28 + (index % 4)));
    }
  }

  for (let index = 28; index < 32; index += 1) {
    docs.get(nodeId(index))!.children = [
      linkTo(space, nodeId(index === 31 ? 28 : index + 1)),
    ];
  }

  for (let index = 32; index < 64; index += 1) {
    const doc = docs.get(nodeId(index))!;
    const localIndex = index - 32;
    const left = 32 + (localIndex * 2) + 1;
    const right = 32 + (localIndex * 2) + 2;
    const children: GraphLink[] = [];
    if (left < 64) {
      doc.primary = linkTo(space, nodeId(left));
      children.push(linkTo(space, nodeId(left)));
    }
    if (right < 64) {
      children.push(linkTo(space, nodeId(right)));
    }
    if (localIndex % 4 === 0) {
      doc.alternate = linkTo(space, nodeId(28 + (localIndex % 4)));
    }
    if (localIndex > 0 && localIndex % 5 === 0) {
      const parent = 32 + Math.floor((localIndex - 1) / 2);
      children.push(linkTo(space, nodeId(parent)));
    }
    if (children.length > 0) {
      doc.children = children;
    }
  }

  const rootId = nodeId(0);
  const hiddenRootId = nodeId(32);
  const expandedRootValue = clone(docs.get(rootId)!);
  expandedRootValue.alternate = linkTo(space, hiddenRootId);

  return {
    docs: [...docs.entries()]
      .map(([id, value]) => ({ id, value }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    rootId,
    hiddenRootId,
    initialReachableIds: [...initialReachableIds].sort(),
    expandedReachableIds: [...expandedReachableIds].sort(),
    schema: {
      ...nodeSchema,
      $defs: {
        node: nodeSchema,
      },
    },
    expandedRootValue,
  };
};
