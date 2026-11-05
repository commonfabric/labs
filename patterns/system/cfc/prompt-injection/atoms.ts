import { CFC_CONCEPT_KIND, type CfcAtom, cfcAtom } from "commonfabric/cfc";

export const DEFAULT_PROMPT_INJECTION_RISK_KIND =
  CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened;
export const DEFAULT_PROMPT_INFLUENCE_KIND = CFC_CONCEPT_KIND.PromptInfluence;

export const INJECTION_SAFE_ATOM = cfcAtom.injectionSafe();

export const promptInjectionRiskAtom = (
  source: CfcAtom,
  kind: string = DEFAULT_PROMPT_INJECTION_RISK_KIND,
) => cfcAtom.caveat(kind, source);

export const promptInfluenceAtom = (
  source: CfcAtom,
  kind: string = DEFAULT_PROMPT_INFLUENCE_KIND,
) => cfcAtom.caveat(kind, source);

export const trustedAgentKernelAtom = (name: string) => cfcAtom.builtin(name);

export const userSurfaceInputAtom = (
  user: string,
  surface: string,
  valueDigest: string,
) => cfcAtom.userSurfaceInput(user, surface, valueDigest);

export const promptSlotBoundAtom = (
  source: CfcAtom,
  role: string,
  kernelName: string,
  subject: string,
  surface: string,
  valueDigest: string,
) =>
  cfcAtom.promptSlotBound(
    source,
    role,
    kernelName,
    subject,
    surface,
    valueDigest,
  );
