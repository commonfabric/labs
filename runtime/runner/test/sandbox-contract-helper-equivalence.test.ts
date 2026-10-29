import { assertEquals } from "@std/assert";
import ts from "typescript";
import {
  BINDING_IDENTITY_HELPER_NAME,
  createBindingIdentityHelperSource,
  createFunctionHardeningHelperSource,
  FUNCTION_HARDENING_HELPER_NAME,
} from "@commonfabric/utils/sandbox-contract";
import { stripJsTrivia } from "../src/sandbox/compiled-js-parser.ts";
import { COMMONFABRIC_TYPES } from "../../../base/ts-transformers/test/commonfabric-test-types.ts";
import { transformSource } from "../../../base/ts-transformers/test/utils.ts";

function emittedFunction(
  source: string,
  sourceFile: ts.SourceFile,
  name: string,
): string {
  const matches = sourceFile.statements.filter((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  assertEquals(
    matches.length,
    1,
    `expected exactly one emitted ${name} declaration`,
  );
  const match = matches[0]!;
  return stripJsTrivia(source, match.getStart(sourceFile), match.getEnd());
}

Deno.test("transformer hardening helpers match the sandbox verifier contract", async () => {
  const output = await transformSource(
    `/// <cts-enable />
      import { pattern, WriteAuthorizedBy } from "commonfabric";

      function saveTitle(): string {
        return "saved";
      }

      interface Output {
        savedTitle: WriteAuthorizedBy<string, typeof saveTitle>;
      }

      export default pattern<{}, Output>(() => ({
        savedTitle: "saved",
      }));
    `,
    { types: COMMONFABRIC_TYPES },
  );
  const sourceFile = ts.createSourceFile(
    "/test.tsx",
    output,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );

  assertEquals(
    emittedFunction(output, sourceFile, FUNCTION_HARDENING_HELPER_NAME),
    stripJsTrivia(
      createFunctionHardeningHelperSource(
        FUNCTION_HARDENING_HELPER_NAME,
        { typedParameter: true },
      ),
    ),
  );
  assertEquals(
    emittedFunction(output, sourceFile, BINDING_IDENTITY_HELPER_NAME),
    stripJsTrivia(
      createBindingIdentityHelperSource(
        BINDING_IDENTITY_HELPER_NAME,
        undefined,
        { typedParameter: true },
      ),
    ),
  );
});
