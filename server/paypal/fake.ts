// A deterministic stand-in for the PayPal sandbox, used by the no-credentials quickstart and the tests.
// It keeps the rules the sandbox enforces: one hold per request id, a final capture closes the
// authorization, a voided hold cannot be captured, a sender batch id pays once.
import {
  PayPalError,
  type Capture,
  type Hold,
  type PayPal,
  type Payout,
  type PayoutItem,
  type TxnRecord,
  type VaultSetup,
  type VaultToken,
} from "./types.ts";

export class FakePayPal implements PayPal {
  readonly live = false;
  private seq = 0;
  private holds = new Map<string, { id: string; cents: number; state: "CREATED" | "CAPTURED" | "VOIDED"; byRef: string }>();
  private holdByRef = new Map<string, Hold>();
  private captures = new Map<string, Capture>();
  private payouts = new Map<string, Payout & { created: number }>();
  private txns: TxnRecord[] = [];
  /** Vault ids that refuse a hold, to exercise the at-risk path. */
  refuse = new Set<string>();
  payoutDelayMs = 1500;

  constructor(readonly currency = "USD") {}

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}${String(this.seq).padStart(8, "0")}`;
  }

  async vaultSetup(returnUrl: string): Promise<VaultSetup> {
    const id = this.id("SETUP-");
    return { setupTokenId: id, approveUrl: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}approval_token_id=${id}&demo=1` };
  }

  async vaultFinalize(setupTokenId: string): Promise<VaultToken> {
    return { paymentTokenId: `TOKEN-${setupTokenId.slice(6)}`, payerEmail: "household@households.example" };
  }

  async authorize(vaultId: string, cents: number, ref: string, _d: string, invoiceId: string): Promise<Hold> {
    const known = this.holdByRef.get(ref);
    if (known) return known;
    if (this.refuse.has(vaultId)) throw new PayPalError("authorize", 422, "INSTRUMENT_DECLINED", "fake");
    const authId = this.id("AUTH");
    const hold: Hold = { orderId: this.id("ORDER"), authorizationId: authId, status: "CREATED", expiresAt: new Date(Date.now() + 29 * 86400_000).toISOString() };
    this.holds.set(authId, { id: authId, cents, state: "CREATED", byRef: ref });
    this.holdByRef.set(ref, hold);
    this.txns.push({ transactionId: authId, eventCode: "T1105", status: "P", cents, at: new Date().toISOString(), invoiceId });
    return hold;
  }

  async capture(authorizationId: string, cents: number, ref: string, invoiceId: string, final: boolean): Promise<Capture> {
    const prior = this.captures.get(ref);
    if (prior) return prior;
    const h = this.holds.get(authorizationId);
    if (!h) throw new PayPalError("capture", 404, "INVALID_RESOURCE_ID");
    if (h.state === "VOIDED") throw new PayPalError("capture", 422, "AUTHORIZATION_VOIDED");
    if (h.state === "CAPTURED") throw new PayPalError("capture", 422, "AUTHORIZATION_ALREADY_CAPTURED");
    if (cents > h.cents) throw new PayPalError("capture", 422, "MAX_CAPTURE_AMOUNT_EXCEEDED");
    if (final) h.state = "CAPTURED";
    const fee = Math.round(cents * 0.0349) + 49;
    const c: Capture = { captureId: this.id("CAP"), status: "COMPLETED", grossCents: cents, paypalFeeCents: fee, netCents: cents - fee };
    this.captures.set(ref, c);
    this.txns.push({ transactionId: c.captureId, eventCode: "T0006", status: "S", cents, feeCents: -fee, at: new Date().toISOString(), invoiceId });
    return c;
  }

  async void(authorizationId: string): Promise<{ status: string }> {
    const h = this.holds.get(authorizationId);
    if (!h) throw new PayPalError("void", 404, "INVALID_RESOURCE_ID");
    if (h.state === "CAPTURED") throw new PayPalError("void", 422, "AUTHORIZATION_ALREADY_CAPTURED");
    h.state = "VOIDED";
    return { status: "VOIDED" };
  }

  async payout(senderBatchId: string, items: PayoutItem[]): Promise<Payout> {
    if (this.payouts.has(senderBatchId)) throw new PayPalError("payout", 400, "DUPLICATE_SENDER_BATCH_ID");
    const p = {
      batchId: this.id("BATCH"), senderBatchId, status: "PENDING", created: Date.now(),
      items: items.map((i) => ({ itemId: i.itemId, payoutItemId: this.id("ITEM"), transactionId: this.id("TXN"), status: "PENDING" })),
    };
    this.payouts.set(senderBatchId, p);
    items.forEach((it, k) => this.txns.push({ transactionId: p.items[k]!.transactionId!, eventCode: "T0000", status: "S", cents: -it.cents, at: new Date().toISOString(), note: it.note }));
    return { batchId: p.batchId, senderBatchId, status: p.status, items: p.items };
  }

  async getPayout(batchId: string): Promise<Payout> {
    const p = [...this.payouts.values()].find((x) => x.batchId === batchId);
    if (!p) throw new PayPalError("payout status", 404, "INVALID_RESOURCE_ID");
    if (Date.now() - p.created >= this.payoutDelayMs) {
      p.status = "SUCCESS";
      for (const i of p.items) i.status = "SUCCESS";
    }
    return { batchId: p.batchId, senderBatchId: p.senderBatchId, status: p.status, items: p.items };
  }

  async transactions(startIso: string, endIso: string): Promise<TxnRecord[]> {
    return this.txns.filter((t) => t.at >= startIso && t.at <= endIso);
  }

  /** The stand-in accepts only its own marker, so tests can send both a genuine and a forged delivery. */
  async verifyWebhook(headers: Record<string, string | undefined>, _event: unknown, webhookId: string): Promise<boolean> {
    return headers["paypal-transmission-sig"] === `stand-in:${webhookId}`;
  }
}
