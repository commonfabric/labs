// Test file with named export instead of default export
import { pattern } from "commonfabric";
import "commonfabric/schema";

const modelSchema = {
  type: "object",
  properties: {
    message: { type: "string", default: "from named export" },
  },
  default: { message: "from named export" },
} as const;
export const myNamedPattern = pattern(
  (cell) => {
    return {
      message: cell.message,
    };
  },
  modelSchema,
  modelSchema,
);

export default pattern(
  (_cell) => {
    return {
      message: "from default export",
    };
  },
  modelSchema,
  modelSchema,
);
