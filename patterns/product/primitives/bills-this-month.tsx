/**
 * Classifies email headers by subject and sender, and bank rows by merchant
 * name, transaction name, and category_primary. Scores candidate pairs by
 * shared whole merchant words and assigns the strongest matches first, leaving
 * unmatched records separate. Amounts and dates are displayed, not used to
 * verify payment.
 *
 * Month bounds and tombstone filters belong to the readers supplying the rows.
 * No model sees the mail or the transactions: the three lists
 * are a function of the words below, which is what lets the same task run over
 * a confidentiality-labeled cell without asking anything to release it.
 *
 * Among distinct merchants, a word shared by every merchant cannot identify a
 * payment. Other shared words contribute their length, capped at 12 per word,
 * so a specific match wins over a shared brand prefix. This is a text-based
 * candidate match, not confirmation that a bill was paid.
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

  /** The identifying words both sides shared, joined with commas. */
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

/** Whether a whole word or phrase appears between token boundaries. */
const mentions = (text: string, words: readonly string[]): boolean => {
  const haystack = ` ${lower(text).replace(/[^a-z0-9]+/g, " ")} `;
  return words.some((word) => haystack.includes(` ${word} `));
};

/** Distinct merchant words of at least three characters, including `gas`. */
const merchantTokens = (
  merchant: string,
): string[] => [
  ...new Set(
    lower(merchant).split(/[^a-z0-9]+/).filter((token) => token.length >= 3),
  ),
];

/** Merchant words that also appear whole in the subject or sender. */
const sharedWords = (
  header: BillHeader,
  transaction: BillTransaction,
): string[] => {
  const subject = lower(header?.subject ?? "");
  const sender = lower(header?.sender ?? "");
  return merchantTokens(transaction?.merchant_name ?? "")
    .filter((token) => mentions(subject, [token]) || mentions(sender, [token]));
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
 * Candidate matches assigned by decreasing shared-word score. Each payment
 * and email appears in at most one pair; a common merchant prefix alone is
 * insufficient when the input contains multiple distinct merchants.
 */
const sortBills = (
  headers: readonly BillHeader[],
  transactions: readonly BillTransaction[],
): Sorted => {
  const billEmails = headers.filter(isBillEmail);
  const billPayments = transactions.filter(isBillPayment);
  const merchants = new Map<string, string[]>();
  for (const payment of billPayments) {
    const words = merchantTokens(payment.merchant_name);
    if (words.length === 0) continue;
    const name = lower(payment.merchant_name).replace(/[^a-z0-9]+/g, " ")
      .trim();
    merchants.set(name, words);
  }
  const frequency = new Map<string, number>();
  for (const words of merchants.values()) {
    for (const word of words) {
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
  }
  const candidates: {
    headerIndex: number;
    paymentIndex: number;
    words: string[];
    score: number;
  }[] = [];
  for (let headerIndex = 0; headerIndex < billEmails.length; headerIndex += 1) {
    for (
      let paymentIndex = 0;
      paymentIndex < billPayments.length;
      paymentIndex += 1
    ) {
      const words = sharedWords(
        billEmails[headerIndex],
        billPayments[paymentIndex],
      )
        .filter((word) =>
          merchants.size === 1 || frequency.get(word) !== merchants.size
        );
      const score = words.reduce(
        (sum, word) => sum + Math.min(word.length, 12),
        0,
      );
      if (score > 0) {
        candidates.push({ headerIndex, paymentIndex, words, score });
      }
    }
  }
  candidates.sort((left, right) =>
    right.score - left.score || left.headerIndex - right.headerIndex ||
    left.paymentIndex - right.paymentIndex
  );
  const takenEmails = new Set<number>();
  const takenPayments = new Set<number>();
  const paid: PairedBill[] = [];
  for (const candidate of candidates) {
    if (
      takenEmails.has(candidate.headerIndex) ||
      takenPayments.has(candidate.paymentIndex)
    ) continue;
    takenEmails.add(candidate.headerIndex);
    takenPayments.add(candidate.paymentIndex);
    const header = billEmails[candidate.headerIndex];
    const transaction = billPayments[candidate.paymentIndex];
    paid.push({
      subject: header?.subject ?? "",
      sender: header?.sender ?? "",
      merchant: transaction?.merchant_name ?? "",
      amount: Number(transaction?.amount) || 0,
      date: transaction?.date ?? "",
      matchedOn: candidate.words.join(", "),
    });
  }

  const unpaid = billEmails.filter((_, index) => !takenEmails.has(index))
    .map((header) => ({
      subject: header?.subject ?? "",
      sender: header?.sender ?? "",
      received_at: header?.received_at ?? "",
    }));

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
