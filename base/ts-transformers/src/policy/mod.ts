export { analyzeFunctionCapabilities } from "./capability-analysis.ts";
export {
  type MergeablePushMisuse,
  type MergeablePushMisuseKind,
} from "./mergeable-push-classification.ts";
export {
  classifyReactiveReceiverKind,
  type ReactiveReceiverKind,
  shouldLowerLogicalExpression,
  shouldRewriteCollectionMethod,
} from "./rewrite-policy.ts";
