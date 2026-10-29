// Main API exports
export { SchemaGenerator } from "./schema-generator.ts";

// Public types for API consumers
export type {
  SchemaGenerationDiagnostic,
  SchemaGenerationOptions,
  WriterSourceIdentity,
} from "./interface.ts";
export type { MutableJSONSchemaObj } from "@commonfabric/api";
