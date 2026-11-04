// Mirrors schema-generator fixture: pattern-with-types (inputSchema)
// Root type must be named SchemaRoot for the fixtures runner.

import { Default } from "commonfabric";

interface Item {
  text: Default<string, "">;
}

interface InputSchemaInterface {
  title: Default<string, "untitled">;
  items: Default<Item[], []>;
}

type SchemaRoot = InputSchemaInterface;
