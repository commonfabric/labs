import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { rewriteHelperOwnedExpressionSites } from "./expression-site-lowering.ts";

export class HelperOwnedExpressionSiteLoweringTransformer
  extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    return rewriteHelperOwnedExpressionSites(context.sourceFile, context);
  }
}
