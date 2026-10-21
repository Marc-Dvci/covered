// The money surface Covered needs from PayPal. Two implementations: the sandbox (Server SDK + REST)
// and a deterministic stand-in for the no-credentials quickstart and the tests.

export type Wallet = "PAYPAL" | "VENMO";

export interface Hold {
  orderId: string;
  authorizationId: string;
  status: string; // CREATED | DENIED | PENDING ...
  expiresAt?: string;
  debugId?: string;
}

export interface Capture {
  captureId: string;
  status: string; // COMPLETED | PENDING | DECLINED
  grossCents: number;
  paypalFeeCents?: number;
  netCents?: number;
  debugId?: string;
}

export interface PayoutItem {
  itemId: string; // our sender_item_id
  receiver: string; // email for PAYPAL, phone for VENMO
  wallet: Wallet;
  cents: number;
  note: string;
}

export interface Payout {
  batchId: string;
  senderBatchId: string;
  status: string; // PENDING | PROCESSING | SUCCESS | DENIED ...
  items: { itemId: string; payoutItemId?: string; transactionId?: string; status?: string }[];
  debugId?: string;
}

export interface VaultSetup {
  setupTokenId: string;
  approveUrl: string;
}

export interface VaultToken {
  paymentTokenId: string;
  payerEmail?: string;
  customerId?: string;
}

export interface TxnRecord {
  transactionId: string;
  eventCode: string;
  status: string;
  cents: number;
  feeCents?: number;
  at: string;
  invoiceId?: string;
  note?: string;
}

export class PayPalError extends Error {
  constructor(
    public op: string,
    public status: number,
    public issue: string,
    public debugId?: string,
  ) {
    super(`${op} failed (${status} ${issue})${debugId ? ` debug ${debugId}` : ""}`);
  }
}

export interface PayPal {
  readonly live: boolean;
  readonly currency: string;
  vaultSetup(returnUrl: string, cancelUrl: string, description: string, ref: string): Promise<VaultSetup>;
  vaultFinalize(setupTokenId: string, ref: string): Promise<VaultToken>;
  /** Buyer-absent authorization on a saved PayPal. `ref` makes the call idempotent. */
  authorize(vaultId: string, cents: number, ref: string, description: string, invoiceId: string): Promise<Hold>;
  /** final=true releases whatever is left of the authorization. */
  capture(authorizationId: string, cents: number, ref: string, invoiceId: string, final: boolean): Promise<Capture>;
  void(authorizationId: string, ref: string): Promise<{ status: string }>;
  payout(senderBatchId: string, items: PayoutItem[], subject: string): Promise<Payout>;
  getPayout(batchId: string): Promise<Payout>;
  transactions(startIso: string, endIso: string): Promise<TxnRecord[]>;
  /** Ask PayPal whether a webhook delivery really came from PayPal for this webhook id. */
  verifyWebhook(headers: Record<string, string | undefined>, event: unknown, webhookId: string): Promise<boolean>;
}

/** PayPal-Request-Id: same logical step, same id, so a retried task never repeats a money movement. */
export function requestId(...parts: string[]): string {
  return `covered-${parts.join("-")}`.slice(0, 108);
}

export function toCents(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const [whole = "0", frac = ""] = String(value).split(".");
  const sign = whole.startsWith("-") ? -1 : 1;
  return sign * (Math.abs(parseInt(whole, 10)) * 100 + parseInt((frac + "00").slice(0, 2), 10));
}

export function toAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const c = Math.abs(cents);
  return `${sign}${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}
