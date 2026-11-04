/** Result schema and its host and sandbox output paths for a root run. */
import type { JSONSchema } from "@commonfabric/api";

/** The result contract offered to the model and validated by the host. */
export interface CfHarnessStructuredResultConfig {
  path: string;
  sandboxPath: string;
  schema: JSONSchema;
}
