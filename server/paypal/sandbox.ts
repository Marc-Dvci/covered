// PayPal sandbox through the PayPal Server SDK (APIMatic-generated) for Orders, Payments, Vault and
// Transaction Search. Payouts are not in the SDK, so they go through a small REST client that reuses
// the same client credentials.
import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrdersController,
  PaymentsController,
  TransactionSearchController,
  VaultController,
  type OrderRequest,
  type SetupTokenRequest,
} from "@paypal/paypal-server-sdk";
import {
  PayPalError,
  requestId,
  toAmount,
  toCents,
  type Capture,
  type Hold,
  type PayPal,
  type Payout,
  type PayoutItem,
  type TxnRecord,
  type VaultSetup,
  type VaultToken,
} from "./types.ts";

const BASE = "https://api-m.sandbox.paypal.com";

export class SandboxPayPal implements PayPal {
  readonly live = true;
  private client: Client;
  private orders: OrdersController;
  private payments: PaymentsController;
  private vault: VaultController;
  private search: TransactionSearchController;
  private token?: { value: string; until: number };

  constructor(
    private clientId: string,
    private secret: string,
    readonly currency = "USD",
    private brand = "Covered cooperative",
  ) {
    this.client = new Client({
      clientCredentialsAuthCredentials: { oAuthClientId: clientId, oAuthClientSecret: secret },
      environment: Environment.Sandbox,
      // the generated default is 0, which means no timeout at all. SDK retries stay at their generated
      // default (off): the workflow retries the whole task, and the request ids make that safe
      timeout: 30_000,
    });
    this.orders = new OrdersController(this.client);
    this.payments = new PaymentsController(this.client);
    this.vault = new VaultController(this.client);
    this.search = new TransactionSearchController(this.client);
  }

  private money(cents: number) {
    return { currencyCode: this.currency, value: toAmount(cents) };
  }

  private async sdk<T>(op: string, fn: () => Promise<{ result: T }>): Promise<T> {
    try {
      return (await fn()).result;
    } catch (e) {
      if (e instanceof ApiError) {
        let issue = "UNKNOWN";
        let debugId: string | undefined;
        try {
          const body = (typeof e.body === "string" ? JSON.parse(e.body) : e.body) as Record<string, unknown> | undefined;
          debugId = (body?.debug_id as string) ?? undefined;
          const details = body?.details as { issue?: string }[] | undefined;
          issue = details?.[0]?.issue ?? (body?.name as string) ?? issue;
        } catch {
          /* body was not JSON */
        }
        throw new PayPalError(op, e.statusCode, issue, debugId);
      }
      throw e;
    }
  }

  async vaultSetup(returnUrl: string, cancelUrl: string, description: string, ref: string): Promise<VaultSetup> {
    const body = {
      paymentSource: {
        paypal: {
          description: description.slice(0, 127),
          usagePattern: "UNSCHEDULED_POSTPAID",
          usageType: "MERCHANT",
          customerType: "CONSUMER",
          permitMultiplePaymentTokens: true,
          experienceContext: {
            brandName: this.brand,
            shippingPreference: "NO_SHIPPING",
            vaultInstruction: "ON_PAYER_APPROVAL",
            returnUrl,
            cancelUrl,
          },
        },
      },
    } as unknown as SetupTokenRequest;
    const r = await this.sdk("vault setup", () => this.vault.createSetupToken({ body, paypalRequestId: requestId("setup", ref) }));
    const approve = r.links?.find((l) => l.rel === "approve")?.href;
    if (!r.id || !approve) throw new PayPalError("vault setup", 500, "NO_APPROVE_LINK");
    return { setupTokenId: r.id, approveUrl: approve };
  }

  async vaultFinalize(setupTokenId: string, ref: string): Promise<VaultToken> {
    const r = await this.sdk("vault token", () =>
      this.vault.createPaymentToken({
        body: { paymentSource: { token: { id: setupTokenId, type: "SETUP_TOKEN" as never } } },
        paypalRequestId: requestId("token", ref),
      }),
    );
    if (!r.id) throw new PayPalError("vault token", 500, "NO_TOKEN");
    const paypal = (r.paymentSource as { paypal?: { emailAddress?: string } } | undefined)?.paypal;
    return { paymentTokenId: r.id, payerEmail: paypal?.emailAddress, customerId: r.customer?.id };
  }

  async authorize(vaultId: string, cents: number, ref: string, description: string, invoiceId: string): Promise<Hold> {
    const body = {
      intent: CheckoutPaymentIntent.Authorize,
      purchaseUnits: [
        {
          referenceId: ref.slice(0, 256),
          description: description.slice(0, 127),
          invoiceId,
          amount: this.money(cents),
        },
      ],
      paymentSource: {
        paypal: {
          vaultId,
          storedCredential: { paymentInitiator: "MERCHANT", usage: "SUBSEQUENT", usagePattern: "UNSCHEDULED_POSTPAID" },
        },
      },
    } as unknown as OrderRequest;
    const order = await this.sdk("authorize", () =>
      this.orders.createOrder({ body, paypalRequestId: requestId("hold", ref), prefer: "return=representation" }),
    );
    const auth = order.purchaseUnits?.[0]?.payments?.authorizations?.[0];
    if (!order.id || !auth?.id) throw new PayPalError("authorize", 422, `ORDER_${order.status ?? "UNKNOWN"}`);
    return { orderId: order.id, authorizationId: auth.id, status: String(auth.status), expiresAt: auth.expirationTime };
  }

  async capture(authorizationId: string, cents: number, ref: string, invoiceId: string, final: boolean): Promise<Capture> {
    const r = await this.sdk("capture", () =>
      this.payments.captureAuthorizedPayment({
        authorizationId,
        paypalRequestId: requestId("capture", ref),
        prefer: "return=representation",
        body: { amount: this.money(cents), finalCapture: final, invoiceId },
      }),
    );
    const b = r.sellerReceivableBreakdown;
    return {
      captureId: r.id ?? "",
      status: String(r.status),
      grossCents: toCents(r.amount?.value),
      paypalFeeCents: b?.paypalFee ? toCents(b.paypalFee.value) : undefined,
      netCents: b?.netAmount ? toCents(b.netAmount.value) : undefined,
    };
  }

  async void(authorizationId: string, ref: string): Promise<{ status: string }> {
    const r = await this.sdk("void", () =>
      this.payments.voidPayment({ authorizationId, paypalRequestId: requestId("void", ref), prefer: "return=representation" }),
    );
    return { status: String((r as { status?: string } | undefined)?.status ?? "VOIDED") };
  }

  // ---- REST: Payouts (not covered by the Server SDK)

  private async bearer(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const res = await fetch(`${BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalError("oauth", res.status, "TOKEN");
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, until: Date.now() + (j.expires_in - 120) * 1000 };
    return j.access_token;
  }

  private async rest(op: string, method: string, path: string, body?: unknown, rid?: string): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.bearer()}`,
      "Content-Type": "application/json",
    };
    if (rid) headers["PayPal-Request-Id"] = rid;
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    const j = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const details = j.details as { issue?: string }[] | undefined;
      throw new PayPalError(op, res.status, details?.[0]?.issue ?? (j.name as string) ?? "ERROR", j.debug_id as string);
    }
    return j;
  }

  async payout(senderBatchId: string, items: PayoutItem[], subject: string): Promise<Payout> {
    const j = await this.rest(
      "payout",
      "POST",
      "/v1/payments/payouts",
      {
        sender_batch_header: { sender_batch_id: senderBatchId, email_subject: subject, email_message: subject },
        items: items.map((it) => ({
          recipient_type: it.wallet === "VENMO" ? "PHONE" : "EMAIL",
          recipient_wallet: it.wallet,
          receiver: it.receiver,
          amount: { value: toAmount(it.cents), currency: this.currency },
          note: it.note.slice(0, 4000),
          sender_item_id: it.itemId,
        })),
      },
      requestId("payout", senderBatchId),
    );
    const h = j.batch_header as { payout_batch_id: string; batch_status: string };
    return { batchId: h.payout_batch_id, senderBatchId, status: h.batch_status, items: items.map((i) => ({ itemId: i.itemId })) };
  }

  async getPayout(batchId: string): Promise<Payout> {
    const j = await this.rest("payout status", "GET", `/v1/payments/payouts/${batchId}`);
    const h = j.batch_header as { payout_batch_id: string; batch_status: string; sender_batch_header: { sender_batch_id: string } };
    const items = (j.items as Record<string, unknown>[] | undefined) ?? [];
    return {
      batchId: h.payout_batch_id,
      senderBatchId: h.sender_batch_header.sender_batch_id,
      status: h.batch_status,
      items: items.map((i) => ({
        itemId: String((i.payout_item as { sender_item_id?: string } | undefined)?.sender_item_id ?? ""),
        payoutItemId: i.payout_item_id as string,
        transactionId: i.transaction_id as string | undefined,
        status: i.transaction_status as string | undefined,
      })),
    };
  }

  async transactions(startIso: string, endIso: string): Promise<TxnRecord[]> {
    const out: TxnRecord[] = [];
    for (let page = 1; page <= 20; page++) {
      const r = await this.sdk("transaction search", () =>
        this.search.searchTransactions({ startDate: startIso, endDate: endIso, fields: "transaction_info", pageSize: 500, page }),
      );
      for (const d of r.transactionDetails ?? []) {
        const t = d.transactionInfo;
        if (!t?.transactionId) continue;
        out.push({
          transactionId: t.transactionId,
          eventCode: t.transactionEventCode ?? "",
          status: t.transactionStatus ?? "",
          cents: toCents(t.transactionAmount?.value),
          feeCents: t.feeAmount ? toCents(t.feeAmount.value) : undefined,
          at: t.transactionInitiationDate ?? "",
          invoiceId: t.invoiceId,
          note: t.transactionNote ?? t.transactionSubject,
        });
      }
      if (!r.totalPages || page >= r.totalPages) break;
    }
    return out;
  }

  async verifyWebhook(headers: Record<string, string | undefined>, event: unknown, webhookId: string): Promise<boolean> {
    const h = (k: string) => headers[k] ?? "";
    if (!h("paypal-transmission-sig")) return false;
    const j = await this.rest("verify webhook", "POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: event,
    });
    return j.verification_status === "SUCCESS";
  }
}
