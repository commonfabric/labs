import { toSchema } from "commonfabric";

interface LinkedData {
  "@link": string;
  "@context": string;
  "@type": string;
  "kebab-case": number;
  "with space": boolean;
  "with-special-chars!": string;
  "default": string;
  "enum": number;
  "class": boolean;
  normalProperty: string;
}

const linkedDataSchema = toSchema<LinkedData>();
// FIXTURE: special-property-names
// Verifies: toSchema handles property names that are JSON-LD keywords, kebab-case, or JS reserved words
//   toSchema<LinkedData>() → schema with "@link", "kebab-case", "with space", "default", "enum", etc.
// Context: property names requiring quoting; ensures no mangling of special characters
export { linkedDataSchema };
