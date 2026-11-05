import type { JSONSchema } from "@commonfabric/api";
import { isObjectNotArray } from "@commonfabric/js-values/types";

type FrameworkProvidedContract = Readonly<{
  /** Compiler-owned graph metadata; never derived from authored schemas. */
  frameworkProvidedPaths?: readonly (readonly string[])[];
}>;

/**
 * Trusted, compiler-emitted call contract for one dynamic factory node.
 *
 * This is graph metadata, not authored input and not part of Factory@1 state.
 * The runner compares it with the trusted artifact's normalized schemas before
 * any implementation code can run.
 */
export type FactoryContract =
  & FrameworkProvidedContract
  & (
    | Readonly<{
      kind: "pattern";
      argumentSchema: JSONSchema;
      resultSchema: JSONSchema;
    }>
    | Readonly<{
      kind: "module";
      argumentSchema?: JSONSchema;
      resultSchema?: JSONSchema;
    }>
    | Readonly<{
      kind: "handler";
      contextSchema?: JSONSchema;
      eventSchema?: JSONSchema;
    }>
  );

/** Read a schema-declared factory contract without granting authored data. */
export function factoryContractFromSchema(
  schema: JSONSchema | undefined,
): FactoryContract | undefined {
  if (!isObjectNotArray(schema) || !("asFactory" in schema)) return undefined;
  const contract = schema.asFactory;
  if (!isObjectNotArray(contract)) {
    throw new TypeError("Invalid asFactory schema contract");
  }
  switch (contract.kind) {
    case "pattern":
      return {
        kind: "pattern",
        argumentSchema: contract.argumentSchema as JSONSchema,
        resultSchema: contract.resultSchema as JSONSchema,
      };
    case "module":
      return {
        kind: "module",
        ...(Object.hasOwn(contract, "argumentSchema")
          ? { argumentSchema: contract.argumentSchema as JSONSchema }
          : {}),
        ...(Object.hasOwn(contract, "resultSchema")
          ? { resultSchema: contract.resultSchema as JSONSchema }
          : {}),
      };
    case "handler":
      return {
        kind: "handler",
        ...(Object.hasOwn(contract, "contextSchema")
          ? { contextSchema: contract.contextSchema as JSONSchema }
          : {}),
        ...(Object.hasOwn(contract, "eventSchema")
          ? { eventSchema: contract.eventSchema as JSONSchema }
          : {}),
      };
    default:
      throw new TypeError("Invalid asFactory schema contract kind");
  }
}
