import { toSchema } from "commonfabric";

interface Config {
  value: number;
}

const configSchema = toSchema<Config>({
  "default": { value: 42 },
  description: "Configuration schema",
});
// FIXTURE: with-options
// Verifies: toSchema options object (default, description) is merged into generated schema
//   toSchema<Config>({default: ..., description: ...}) → schema with "default" and "description" alongside generated properties
export { configSchema };
