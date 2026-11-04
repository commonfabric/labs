/** Base type */
interface Base {
  /** Base id */
  id: string;
}

/** Derived type */
interface SchemaRoot extends Base {
  /** Derived name */
  name: string;
}
