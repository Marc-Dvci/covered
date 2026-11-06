// The real PayPal client against a stub of the network, at the two edges it has: the SDK's axios adapter and fetch.
// These pin what goes over the wire. The same calls ran live on the sandbox: see probe/RESULTS-USD.md.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxPayPal } from "../server/paypal/sandbox.ts";
import { PayPalError } from "../server/paypal/types.ts";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  data?: string;
}

const AUTH_ORDER = {
  id: "ORDER1",
  status: "COMPLETED",
  purchase_units: [{ payments: { authorizations: [{ id: "AUTH1", status: "CREATED", expiration_time: "2026-12-05T10:00:00Z" }] } }],
};

/** A stubbed SDK transport: answers by the end of the URL, and keeps every request. */
function transport(answers: Record<string, { status: number; body: unknown }>) {
  const sent: Sent[] = [];
  const adapter = async (config: Sent) => {
    sent.push(config);
    const key = Object.keys(answers).find((k) => config.url.includes(k));
    const a = key ? answers[key]! : { status: 404, body: { name: "NOT_STUBBED" } };
    return {
      data: typeof a.body === "string" ? a.body : JSON.stringify(a.body),
      status: a.status,
      statusText: "",
      headers: { "content-type": "application/json" },
      config,
    };
  };
  return { sent, adapter };
}

/** A stubbed fetch for the token and the REST calls. */
function stubFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  });
  return calls;
}

const token = (url: string) => (url.endsWith("/v1/oauth2/token") ? { status: 200, body: { access_token: "TOKEN", expires_in: 3600 } } : null);
const bodyOf = (s: Sent) => JSON.parse(s.data!) as Record<string, never>;

beforeEach(() => {
  stubFetch((url) => token(url) ?? { status: 500 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a hold", () => {
  it("is an authorize order on the vaulted PayPal, merchant-initiated, with its request id and invoice", async () => {
    const t = transport({ "/v2/checkout/orders": { status: 201, body: AUTH_ORDER } });
    const pp = new SandboxPayPal("id", "secret", "USD", "Covered cooperative", t);
    const hold = await pp.authorize("VAULT1", 15750, "tag-v1", "Home cleaning, The Okafors", "covered-tag-v1");
    expect(hold).toEqual({ orderId: "ORDER1", authorizationId: "AUTH1", status: "CREATED", expiresAt: "2026-12-05T10:00:00Z" });
    const req = t.sent[0]!;
    expect(req.method.toUpperCase()).toBe("POST");
    const sentHeaders = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(sentHeaders).toMatchObject({ "paypal-request-id": "covered-hold-tag-v1", prefer: "return=representation", authorization: "Bearer TOKEN" });
    expect(bodyOf(req)).toMatchObject({
      intent: "AUTHORIZE",
      purchase_units: [{ invoice_id: "covered-tag-v1", amount: { currency_code: "USD", value: "157.50" } }],
      payment_source: {
        paypal: { vault_id: "VAULT1", stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", usage_pattern: "UNSCHEDULED_POSTPAID" } },
      },
    });
  });

  it("is refused when PayPal answers with no authorization", async () => {
    const t = transport({ "/v2/checkout/orders": { status: 201, body: { id: "ORDER1", status: "CREATED", purchase_units: [{}] } } });
    await expect(new SandboxPayPal("id", "secret", "USD", "b", t).authorize("V", 100, "r", "d", "i")).rejects.toMatchObject({ issue: "ORDER_CREATED" });
  });
});

describe("a capture", () => {
  it("takes the amount with final_capture and reads back the gross and PayPal's fee", async () => {
    const t = transport({
      "/v2/payments/authorizations/AUTH1/capture": {
        status: 201,
        body: {
          id: "CAP1",
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "140.00" },
          seller_receivable_breakdown: {
            gross_amount: { currency_code: "USD", value: "140.00" },
            paypal_fee: { currency_code: "USD", value: "5.38" },
            net_amount: { currency_code: "USD", value: "134.62" },
          },
        },
      },
    });
    const c = await new SandboxPayPal("id", "secret", "USD", "b", t).capture("AUTH1", 14000, "tag-v1", "covered-tag-v1", true);
    expect(c).toEqual({ captureId: "CAP1", status: "COMPLETED", grossCents: 14000, paypalFeeCents: 538, netCents: 13462 });
    expect(t.sent[0]!.headers["PayPal-Request-Id"]).toBe("covered-capture-tag-v1");
    expect(bodyOf(t.sent[0]!)).toMatchObject({ amount: { value: "140.00" }, final_capture: true, invoice_id: "covered-tag-v1" });
  });

  it.each([
    [
      "an issue in the details",
      422,
      { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED" }], debug_id: "DBG1" },
      "AUTHORIZATION_ALREADY_CAPTURED",
      "DBG1",
    ],
    ["only a name", 403, { name: "NOT_AUTHORIZED", debug_id: "DBG2" }, "NOT_AUTHORIZED", "DBG2"],
    ["a body that is not JSON", 502, "<html>bad gateway</html>", "UNKNOWN", undefined],
  ])("turns a refusal with %s into a PayPalError", async (_name, status, body, issue, debugId) => {
    const t = transport({ "/capture": { status, body } });
    const e = await new SandboxPayPal("id", "secret", "USD", "b", t).capture("AUTH1", 100, "r", "i", true).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PayPalError);
    expect(e).toMatchObject({ status, issue, debugId });
  });
});

describe("a void", () => {
  it("names the authorization and carries its request id", async () => {
    const t = transport({ "/v2/payments/authorizations/AUTH1/void": { status: 200, body: { id: "AUTH1", status: "VOIDED" } } });
    expect(await new SandboxPayPal("id", "secret", "USD", "b", t).void("AUTH1", "tag-v1")).toEqual({ status: "VOIDED" });
    expect(t.sent[0]!.headers["PayPal-Request-Id"]).toBe("covered-void-tag-v1");
  });
});

describe("the vault", () => {
  it("asks for an unscheduled merchant token, and returns PayPal's approval link", async () => {
    const t = transport({
      "/v3/vault/setup-tokens": { status: 201, body: { id: "SETUP1", links: [{ rel: "approve", href: "https://sandbox.paypal.com/approve", method: "GET" }] } },
    });
    const v = await new SandboxPayPal("id", "secret", "USD", "Covered cooperative", t).vaultSetup(
      "https://x/back",
      "https://x/cancel",
      "Cleaning visits",
      "a1",
    );
    expect(v).toEqual({ setupTokenId: "SETUP1", approveUrl: "https://sandbox.paypal.com/approve" });
    expect(bodyOf(t.sent[0]!)).toMatchObject({
      payment_source: {
        paypal: {
          usage_pattern: "UNSCHEDULED_POSTPAID",
          usage_type: "MERCHANT",
          experience_context: { brand_name: "Covered cooperative", return_url: "https://x/back" },
        },
      },
    });
  });

  it("refuses a setup token with no approval link", async () => {
    const t = transport({ "/v3/vault/setup-tokens": { status: 201, body: { id: "SETUP1", links: [] } } });
    await expect(new SandboxPayPal("id", "secret", "USD", "b", t).vaultSetup("a", "b", "c", "d")).rejects.toMatchObject({ issue: "NO_APPROVE_LINK" });
  });

  it("turns an approved setup token into a payment token", async () => {
    const t = transport({
      "/v3/vault/payment-tokens": {
        status: 201,
        body: { id: "VAULT1", customer: { id: "CUST1" }, payment_source: { paypal: { email_address: "buyer@example.com" } } },
      },
    });
    expect(await new SandboxPayPal("id", "secret", "USD", "b", t).vaultFinalize("SETUP1", "a1")).toEqual({
      paymentTokenId: "VAULT1",
      payerEmail: "buyer@example.com",
      customerId: "CUST1",
    });
    expect(bodyOf(t.sent[0]!)).toMatchObject({ payment_source: { token: { id: "SETUP1", type: "SETUP_TOKEN" } } });
  });
});

describe("the token", () => {
  it("is fetched once and shared across calls", async () => {
    const calls = stubFetch((url) => token(url) ?? { status: 500 });
    const t = transport({ "/void": { status: 200, body: { status: "VOIDED" } } });
    const pp = new SandboxPayPal("id", "secret", "USD", "b", t);
    await pp.void("A1", "r1");
    await pp.void("A2", "r2");
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: `Basic ${Buffer.from("id:secret").toString("base64")}` });
  });

  it("is fetched again when it has expired", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-19T07:10:00Z"), toFake: ["Date"] });
    const calls = stubFetch((url) => token(url) ?? { status: 500 });
    const t = transport({ "/void": { status: 200, body: { status: "VOIDED" } } });
    const pp = new SandboxPayPal("id", "secret", "USD", "b", t);
    await pp.void("A1", "r1");
    vi.setSystemTime(Date.parse("2026-11-19T08:30:00Z"));
    await pp.void("A2", "r2");
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(2);
  });

  it("one failed token request does not break the client for later calls", async () => {
    let fail = true;
    stubFetch((url) => (fail ? { status: 503 } : (token(url) ?? { status: 500 })));
    const t = transport({ "/void": { status: 200, body: { status: "VOIDED" } } });
    const pp = new SandboxPayPal("id", "secret", "USD", "b", t);
    await expect(pp.void("A1", "r1")).rejects.toMatchObject({ status: 503, issue: "TOKEN" });
    fail = false;
    expect(await pp.void("A1", "r1")).toEqual({ status: "VOIDED" });
  });
});

describe("payouts", () => {
  it("sends the sender batch id, one item per member, and the request id", async () => {
    const calls = stubFetch((url) => token(url) ?? { status: 201, body: { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } } });
    const pp = new SandboxPayPal("id", "secret");
    const p = await pp.payout(
      "covered-tag-v1",
      [{ itemId: "v1-marek", receiver: "m@example.com", wallet: "PAYPAL", cents: 13300, note: "The Okafors" }],
      "Your pay",
    );
    expect(p).toMatchObject({ batchId: "BATCH1", senderBatchId: "covered-tag-v1", status: "PENDING" });
    const req = calls.find((c) => c.url.endsWith("/v1/payments/payouts"))!;
    expect(req.init.headers).toMatchObject({ "PayPal-Request-Id": "covered-payout-covered-tag-v1", Authorization: "Bearer TOKEN" });
    expect(JSON.parse(req.init.body as string)).toMatchObject({
      sender_batch_header: { sender_batch_id: "covered-tag-v1" },
      items: [{ recipient_type: "EMAIL", receiver: "m@example.com", amount: { value: "133.00", currency: "USD" }, sender_item_id: "v1-marek" }],
    });
  });

  it("surfaces PayPal's refusal of a repeated batch with its message", async () => {
    stubFetch(
      (url) => token(url) ?? { status: 400, body: { name: "USER_BUSINESS_ERROR", details: [{ issue: "Batch with given sender_batch_id already exists" }] } },
    );
    await expect(new SandboxPayPal("id", "secret").payout("b", [], "s")).rejects.toMatchObject({
      status: 400,
      issue: "Batch with given sender_batch_id already exists",
    });
  });

  it("reads a batch back item by item, by sender item id", async () => {
    stubFetch(
      (url) =>
        token(url) ?? {
          status: 200,
          body: {
            batch_header: { payout_batch_id: "BATCH1", batch_status: "SUCCESS", sender_batch_header: { sender_batch_id: "covered-tag-v1" } },
            items: [{ payout_item_id: "ITEM1", transaction_id: "TXN1", transaction_status: "SUCCESS", payout_item: { sender_item_id: "v1-marek" } }],
          },
        },
    );
    expect(await new SandboxPayPal("id", "secret").getPayout("BATCH1")).toEqual({
      batchId: "BATCH1",
      senderBatchId: "covered-tag-v1",
      status: "SUCCESS",
      items: [{ itemId: "v1-marek", payoutItemId: "ITEM1", transactionId: "TXN1", status: "SUCCESS" }],
    });
  });
});

describe("Transaction Search", () => {
  it("reads every page and keeps only lines with a transaction id", async () => {
    const line = (id: string | null) => ({
      transaction_info: {
        transaction_id: id,
        transaction_event_code: "T0200",
        transaction_status: "S",
        transaction_amount: { currency_code: "USD", value: "-133.00" },
      },
    });
    const pages = [
      { transaction_details: [line("TXN1"), { transaction_info: {} }], total_pages: 2, page: 1 },
      { transaction_details: [line("TXN2")], total_pages: 2, page: 2 },
    ];
    let page = 0;
    const sent: Sent[] = [];
    const adapter = async (config: Sent) => {
      sent.push(config);
      return { data: JSON.stringify(pages[page++]), status: 200, statusText: "", headers: { "content-type": "application/json" }, config };
    };
    const rows = await new SandboxPayPal("id", "secret", "USD", "b", { adapter }).transactions("2026-11-01T00:00:00Z", "2026-11-06T00:00:00Z");
    expect(rows.map((r) => r.transactionId)).toEqual(["TXN1", "TXN2"]);
    expect(rows[0]).toMatchObject({ eventCode: "T0200", cents: -13300 });
    expect(sent).toHaveLength(2);
  });
});

describe("a webhook's signature", () => {
  const headers = {
    "paypal-transmission-sig": "SIG",
    "paypal-auth-algo": "SHA256",
    "paypal-cert-url": "https://c",
    "paypal-transmission-id": "T1",
    "paypal-transmission-time": "2026",
  };

  it.each([
    ["SUCCESS", true],
    ["FAILURE", false],
  ])("PayPal's answer %s means verified is %s", async (verification_status, ok) => {
    const calls = stubFetch((url) => token(url) ?? { status: 200, body: { verification_status } });
    expect(await new SandboxPayPal("id", "secret").verifyWebhook(headers, { id: "E1" }, "WH1")).toBe(ok);
    const req = calls.find((c) => c.url.endsWith("/verify-webhook-signature"))!;
    expect(JSON.parse(req.init.body as string)).toMatchObject({ transmission_sig: "SIG", webhook_id: "WH1", webhook_event: { id: "E1" } });
  });

  it("is refused without asking PayPal when the delivery carries no signature", async () => {
    const calls = stubFetch(() => ({ status: 500 }));
    expect(await new SandboxPayPal("id", "secret").verifyWebhook({}, { id: "E1" }, "WH1")).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
