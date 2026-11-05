import {
  DeepDefault,
  Default,
  NAME,
  pattern,
  toSchema,
} from "commonfabric";
import "commonfabric/schema";

interface Options {
  theme: string;
  profile: {
    name: string;
    email: string;
  };
}

interface Input {
  title: string | Default<"">;
  subtitle: string | Default<null>;
  options: Options | DeepDefault<{
    theme: "dark";
    profile: {
      name: "Ada";
    };
  }>;
}

const inputSchema = toSchema<Input>();

// FIXTURE: default-union-syntax
// Verifies: union Default and DeepDefault syntax is preserved through schema-transform fixtures
export default pattern<Input>(({ title, subtitle, options }) => ({
  [NAME]: title,
  title,
  subtitle,
  options,
}), inputSchema);
