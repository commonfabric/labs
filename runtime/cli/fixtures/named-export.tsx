// Test file with named export instead of default export
import { pattern, schema } from "commonfabric";
import "commonfabric/schema";

const model = schema({
  type: "object",
  properties: {
    message: { type: "string", default: "from named export" },
  },
  default: { message: "from named export" },
});

export const myNamedPattern = pattern(
  (cell) => {
    return {
      message: cell.message,
    };
  },
  model,
  model,
);

export default pattern(
  (_cell) => {
    return {
      message: "from default export",
    };
  },
  model,
  model,
);
