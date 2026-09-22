/**
 * Sorts a month of email headers and bank rows into the three lists a person
 * asking "what do I owe this month" actually wants: bills that look paid,
 * bills that do not, and payments no email accounted for. It takes the rows
 * rather than the databases, so it composes with whatever read them and grows
 * no second copy of their month bounds or tombstone rules.
 *
 * Every decision here is a plain-text rule over a subject line, a sender, and
 * a merchant name. No model sees the mail or the transactions: the three lists
 * are a function of the words below, which is what lets the same task run over
 * a confidentiality-labeled cell without asking anything to release it.
 *
 * A pairing is a claim about two records, so it is made only where a merchant
 * word and a sender or subject word agree. Everything else stays in its own
 * list rather than being paired on a guess — an unmatched payment is a true
 * answer, and a wrong pairing is not.
 *
 * @hashtags bills, email, bank, payments, matching, finance, month
 * @keywords bills this month, what do I owe, unpaid bills, bill payments,
 * match email to bank, invoices, statements, due
 */
import {
  computed,
  Default,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
} from "commonfabric";

/** The part of a mail header this atom reads. There is no body column. */
export interface BillHeader {
  subject: string;
  sender: string;
  received_at?: string | Default<"">;
}

/** The part of a ledger row this atom reads. */
export interface BillTransaction {
  merchant_name: string;
  name?: string | Default<"">;
  amount: number;
  date?: string | Default<"">;
  category_primary?: string | Default<"">;
}

/** An email bill set against the payment that appears to settle it. */
export interface PairedBill {
  subject: string;
  sender: string;
  merchant: string;
  amount: number;
  date: string;

  /** The word both sides shared, which is why they were paired. */
  matchedOn: string;
}

/** An email that looks like a bill and found no payment. */
export interface UnpaidBill {
  subject: string;
  sender: string;
  received_at: string;
}

/** A payment that looks like a bill and found no email. */
export interface UnmatchedPayment {
  merchant: string;
  amount: number;
  date: string;
}

export interface BillsThisMonthInput {
  /** This month's mail headers, as a reader returned them. */
  headers?: BillHeader[] | Default<[]>;

  /** This month's bank rows, as a reader returned them. */
  transactions?: BillTransaction[] | Default<[]>;
}

export interface BillsThisMonthOutput {
  [NAME]: string;
  [UI]: VNode;

  paid: PairedBill[];
  unpaid: UnpaidBill[];
  unmatchedPayments: UnmatchedPayment[];

  paidCount: number;
  unpaidCount: number;
  unmatchedCount: number;
}

/** The words in a subject or sender that make an email look like a bill. */
const BILL_WORDS: readonly string[] = [
  "bill",
  "invoice",
  "payment due",
  "amount due",
  "statement",
  "autopay",
  "auto pay",
  "renewal",
  "receipt",
  "past due",
  "overdue",
  "subscription",
];

/** The words in a merchant name that make a payment look like a bill. */
const VENDOR_WORDS: readonly string[] = [
  "electric",
  "energy",
  "power",
  "gas",
  "water",
  "internet",
  "broadband",
  "mobile",
  "phone",
  "insurance",
  "rent",
  "mortgage",
  "utility",
  "utilities",
  "subscription",
];

/** The Plaid primaries whose rows are bills whatever the merchant is called. */
const BILL_CATEGORIES: readonly string[] = ["RENT_AND_UTILITIES"];

/** Lowercased, so every rule below compares like with like. */
const lower = (text: string): string => (text ?? "").toLowerCase();

/** Whether any of `words` appears in `text`. */
const mentions = (text: string, words: readonly string[]): boolean => {
  const haystack = lower(text);
  return words.some((word) => haystack.includes(word));
};

/** The words a merchant name offers for pairing, the short ones dropped. */
const merchantTokens = (merchant: string): string[] =>
  lower(merchant).split(/[^a-z0-9]+/).filter((token) => token.length >= 4);

/** The first merchant word that also appears in the subject or the sender. */
const sharedWord = (
  header: BillHeader,
  transaction: BillTransaction,
): string | undefined => {
  const subject = lower(header?.subject ?? "");
  const sender = lower(header?.sender ?? "");
  return merchantTokens(transaction?.merchant_name ?? "")
    .find((token) => subject.includes(token) || sender.includes(token));
};

/** Whether an email header reads as a bill. */
const isBillEmail = (header: BillHeader): boolean =>
  mentions(header?.subject ?? "", BILL_WORDS) ||
  mentions(header?.sender ?? "", BILL_WORDS);

/** Whether a transaction reads as a bill payment. */
const isBillPayment = (transaction: BillTransaction): boolean =>
  BILL_CATEGORIES.includes(transaction?.category_primary ?? "") ||
  mentions(transaction?.merchant_name ?? "", VENDOR_WORDS) ||
  mentions(transaction?.name ?? "", VENDOR_WORDS);

/** The three lists, each row appearing in exactly one of them. */
interface Sorted {
  paid: PairedBill[];
  unpaid: UnpaidBill[];
  unmatchedPayments: UnmatchedPayment[];
}

/**
 * Bills sorted into paid, unpaid, and unaccounted-for. A payment settles at
 * most one email and an email is settled at most once, so a single recurring
 * merchant cannot absorb a month of mail.
 */
const sortBills = (
  headers: readonly BillHeader[],
  transactions: readonly BillTransaction[],
): Sorted => {
  const billEmails = headers.filter(isBillEmail);
  const billPayments = transactions.filter(isBillPayment);
  const takenPayments = new Set<number>();
  const paid: PairedBill[] = [];
  const unpaid: UnpaidBill[] = [];

  for (const header of billEmails) {
    let pairedAt = -1;
    let word: string | undefined;
    for (let index = 0; index < billPayments.length; index += 1) {
      if (takenPayments.has(index)) continue;
      const shared = sharedWord(header, billPayments[index]);
      if (shared === undefined) continue;
      pairedAt = index;
      word = shared;
      break;
    }
    if (pairedAt === -1 || word === undefined) {
      unpaid.push({
        subject: header?.subject ?? "",
        sender: header?.sender ?? "",
        received_at: header?.received_at ?? "",
      });
      continue;
    }
    takenPayments.add(pairedAt);
    const transaction = billPayments[pairedAt];
    paid.push({
      subject: header?.subject ?? "",
      sender: header?.sender ?? "",
      merchant: transaction?.merchant_name ?? "",
      amount: Number(transaction?.amount) || 0,
      date: transaction?.date ?? "",
      matchedOn: word,
    });
  }

  const unmatchedPayments = billPayments
    .filter((_, index) => !takenPayments.has(index))
    .map((transaction) => ({
      merchant: transaction?.merchant_name || transaction?.name || "Unnamed",
      amount: Number(transaction?.amount) || 0,
      date: transaction?.date ?? "",
    }));

  return { paid, unpaid, unmatchedPayments };
};

/** `amount` to the cent. */
const money = (amount: number): string => (amount || 0).toFixed(2);

export const BillsThisMonth = pattern<
  BillsThisMonthInput,
  BillsThisMonthOutput
>(({ headers, transactions }) => {
  const sorted = computed(() => sortBills(headers ?? [], transactions ?? []));
  const paid = computed(() => sorted.paid);
  const unpaid = computed(() => sorted.unpaid);
  const unmatchedPayments = computed(() => sorted.unmatchedPayments);
  const paidCount = computed(() => paid.length);
  const unpaidCount = computed(() => unpaid.length);
  const unmatchedCount = computed(() => unmatchedPayments.length);
  const isEmpty = computed(() =>
    paid.length === 0 && unpaid.length === 0 && unmatchedPayments.length === 0
  );

  const paidRows = paid.map((row: PairedBill) => (
    <cf-hstack gap="2" align="center" justify="between">
      <cf-text style="flex: 1;">{row.subject}</cf-text>
      <cf-text tone="muted">{row.merchant}</cf-text>
      <cf-text style="font-variant-numeric: tabular-nums;">
        {computed(() =>
          money(row.amount)
        )}
      </cf-text>
    </cf-hstack>
  ));

  const unpaidRows = unpaid.map((row: UnpaidBill) => (
    <cf-hstack gap="2" align="center" justify="between">
      <cf-text style="flex: 1;">{row.subject}</cf-text>
      <cf-text tone="muted">{row.sender}</cf-text>
    </cf-hstack>
  ));

  const unmatchedRows = unmatchedPayments.map((row: UnmatchedPayment) => (
    <cf-hstack gap="2" align="center" justify="between">
      <cf-text style="flex: 1;">{row.merchant}</cf-text>
      <cf-text tone="muted">{row.date}</cf-text>
      <cf-text style="font-variant-numeric: tabular-nums;">
        {computed(() => money(row.amount))}
      </cf-text>
    </cf-hstack>
  ));

  return {
    [NAME]: computed(() =>
      `Bills this month (${unpaidCount} unpaid, ${paidCount} paid)`
    ),
    [UI]: (
      <cf-vstack gap="4" padding="3">
        <cf-heading level={5}>Bills this month</cf-heading>

        <cf-vstack gap="2">
          <cf-heading level={6}>
            {computed(() => `Unpaid (${unpaidCount})`)}
          </cf-heading>
          {unpaidRows}
        </cf-vstack>

        <cf-vstack gap="2">
          <cf-heading level={6}>
            {computed(() => `Paid (${paidCount})`)}
          </cf-heading>
          {paidRows}
        </cf-vstack>

        <cf-vstack gap="2">
          <cf-heading level={6}>
            {computed(() => `Payments with no email (${unmatchedCount})`)}
          </cf-heading>
          {unmatchedRows}
        </cf-vstack>

        {ifElse(
          isEmpty,
          <cf-empty-state message="Nothing this month reads as a bill." />,
          null,
        )}
      </cf-vstack>
    ),
    paid,
    unpaid,
    unmatchedPayments,
    paidCount,
    unpaidCount,
    unmatchedCount,
  };
});

export default BillsThisMonth;
