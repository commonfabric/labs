import Std

import Cfc.Collection

namespace Cfc

namespace LabelTransition

/-!
Executable per-output dispatcher for the main non-collection branches of spec 8.9.2.
-/

inductive OutputLabelDerivation where
  | passThrough (input : Label)
  | projection (input : Label) (path : List String)
  | exactCopy (inputRef outputRef : Nat) (input : Label)
  | combinedJoin (inputs : List Label)
  deriving Repr, DecidableEq

/--
Evaluate one non-collection output derivation branch under flow-path confidentiality `pc`.
-/
def evalOutputLabelDerivation (pc : ConfLabel) : OutputLabelDerivation → Option Label
  | .passThrough input =>
      some (passThrough pc input)
  | .projection input path =>
      some (projection pc input path)
  | .exactCopy inputRef outputRef input =>
      exactCopyOf pc inputRef outputRef input
  | .combinedJoin inputs =>
      some (combinedFromClassAware pc inputs)

structure OutputLabelRequest where
  pc : ConfLabel
  derivation : OutputLabelDerivation
  addedIntegrity : IntegLabel := []
  deriving Repr, DecidableEq

def deriveOutputLabel (req : OutputLabelRequest) : Option Label :=
  (evalOutputLabelDerivation req.pc req.derivation).map (fun ℓ => Label.endorse ℓ req.addedIntegrity)

end LabelTransition

end Cfc
