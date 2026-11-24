interface ChildNode {
  /** The main text content of the child node */
  body: string;

  /** Children of the child node */
  children: any[];

  /** Attachments associated with the child node */
  attachments: any[];
}

/** Outliner document */
type SchemaRoot = {
  /** The main text content of the node */
  body: string;

  /** Child nodes of this node */
  children: ChildNode[];

  /** Attachments associated with this node */
  attachments: any[];

  /** Version of document */
  version: number;
};
