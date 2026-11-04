import { assert, handler, pattern, TESTS } from "commonfabric";
import {
  CustomerSupportRecipientConfirmExample,
  FinanceRecipientConfirmExample,
  PatientCaseRedactedReleaseExample,
  SecurityIncidentRedactedReleaseExample,
} from "./confirmation-release-examples.tsx";

type RecipientSuite = ReturnType<typeof FinanceRecipientConfirmExample>;
type SupportSuite = ReturnType<typeof CustomerSupportRecipientConfirmExample>;
type PatientSuite = ReturnType<typeof PatientCaseRedactedReleaseExample>;
type IncidentSuite = ReturnType<typeof SecurityIncidentRedactedReleaseExample>;

const runRecipientConfirm = handler<void, { suite: RecipientSuite }>((
  _,
  { suite },
) => {
  suite.triggerDecoy.send();
  suite.confirmRecipientRelease?.send();
});

const runSupportConfirm = handler<void, { suite: SupportSuite }>((
  _,
  { suite },
) => {
  suite.triggerDecoy.send();
  suite.confirmRecipientRelease?.send();
});

const runPatientRelease = handler<void, { suite: PatientSuite }>((
  _,
  { suite },
) => {
  suite.triggerDecoy.send();
  suite.releaseRedactedContent?.send();
});

const runIncidentRelease = handler<void, { suite: IncidentSuite }>((
  _,
  { suite },
) => {
  suite.triggerDecoy.send();
  suite.releaseRedactedContent?.send();
});

export default pattern(() => {
  const finance = FinanceRecipientConfirmExample({});
  const support = CustomerSupportRecipientConfirmExample({});
  const patient = PatientCaseRedactedReleaseExample({});
  const incident = SecurityIncidentRedactedReleaseExample({});

  const assert_finance_confirmed = assert(() =>
    finance.decoyStatus === "Host finance send shortcut is untrusted." &&
    finance.confirmedRecipientRelease!.includes("finance@example.com") &&
    finance.confirmedRecipientRelease!.includes("budget packet")
  );

  const assert_support_confirmed = assert(() =>
    support.decoyStatus === "Host support reply shortcut is untrusted." &&
    support.confirmedRecipientRelease!.includes("support lead") &&
    support.confirmedRecipientRelease!.includes("case transcript excerpt")
  );

  const assert_patient_redacted = assert(() =>
    patient.decoyStatus === "Host patient export did not release content." &&
    patient.releasedRedactedContent!.includes("[redacted-secret]") &&
    patient.releasedRedactedContent!.includes("[redacted-id]")
  );

  const assert_incident_redacted = assert(() =>
    incident.decoyStatus === "Host incident export did not release content." &&
    incident.releasedRedactedContent!.includes("Released redacted incident") &&
    incident.releasedRedactedContent!.includes("[redacted-secret]")
  );

  return {
    [TESTS]: [
      { action: runRecipientConfirm({ suite: finance }) },
      { assertion: assert_finance_confirmed },
      { action: runSupportConfirm({ suite: support }) },
      { assertion: assert_support_confirmed },
      { action: runPatientRelease({ suite: patient }) },
      { assertion: assert_patient_redacted },
      { action: runIncidentRelease({ suite: incident }) },
      { assertion: assert_incident_redacted },
    ],
    finance,
    support,
    patient,
    incident,
  };
});
