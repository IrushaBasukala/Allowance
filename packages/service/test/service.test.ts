import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { analyze } from "../src/analyze.js";
import { createService } from "../src/server.js";

function startStubFacilitator(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const supported = {
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: "hedera:testnet",
        extra: { feePayer: FEE_PAYER },
      },
    ],
    extensions: [],
    signers: { "hedera:*": [FEE_PAYER] },
  };

  const server = createServer((req, res) => {
    if (req.url?.startsWith("/supported")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(supported));
      return;
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const PAY_TO = "0.0.10248326";
const FEE_PAYER = "0.0.7162784";
const PRICE = 1_000_000n; // 0.01 HBAR in tinybars

let server: Server;
let base: string;
let facilitator: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  facilitator = await startStubFacilitator();

  const app = createService({
    payTo: PAY_TO,
    facilitatorUrl: facilitator.url,
    feePayer: FEE_PAYER,
    priceTinybar: PRICE,
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await facilitator.close();
});

describe("analyze — the metered product", () => {
  it("is deterministic", () => {
    expect(analyze("this is a great secure service")).toEqual(
      analyze("this is a great secure service"),
    );
  });

  it("scores sentiment and reports salient terms", () => {
    const r = analyze("the service was fast and reliable and secure");
    expect(r.sentiment).toBe("positive");
    expect(r.salient).toEqual(
      expect.arrayContaining(["fast", "reliable", "secure"]),
    );
  });

  it("detects negative sentiment", () => {
    const r = analyze("this provider is a scam and stole my funds");
    expect(r.sentiment).toBe("negative");
    expect(r.salient).toContain("scam");
  });

  it("handles empty input without dividing by zero", () => {
    expect(analyze("")).toMatchObject({
      score: 0,
      tokens: 0,
      sentiment: "neutral",
    });
  });
});

describe("service — free endpoints", () => {
  it("serves /health without payment", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, payTo: PAY_TO });
  });
});

/** Decode the base64 payment-required header into the requirements object. */
async function requirements(): Promise<unknown> {
  const res = await fetch(`${base}/v1/analyze?text=hello`);
  const header = res.headers.get("payment-required");
  if (!header) throw new Error("no payment-required header on the 402");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

describe("service — the paywall", () => {
  it("refuses the metered route with 402 Payment Required", async () => {
    const res = await fetch(`${base}/v1/analyze?text=hello`);
    expect(res.status).toBe(402);
  });

  it("carries the requirements in the payment-required header, not the body", async () => {
    const res = await fetch(`${base}/v1/analyze?text=hello`);
    // The 402 body is {} by default. Everything a client needs travels in a
    // base64 header — which is what makes x402 work for machines with no UI.
    expect(await res.text()).toBe("{}");
    expect(res.headers.get("payment-required")).toBeTruthy();
  });

  it("advertises price, recipient and fee payer", async () => {
    const decoded = await requirements();

    expect(JSON.stringify(decoded)).toContain(PAY_TO);
    expect(JSON.stringify(decoded)).toContain(PRICE.toString());

    expect(JSON.stringify(decoded)).toContain(FEE_PAYER);
  });

  it("names the hedera:testnet network and exact scheme", async () => {
    const decoded = JSON.stringify(await requirements());
    expect(decoded).toContain("hedera:testnet");
    expect(decoded).toContain("exact");
  });

  it("declares x402 version 2", async () => {
    const decoded = (await requirements()) as { x402Version?: number };
    expect(decoded.x402Version).toBe(2);
  });

  it("gates the route regardless of query parameters", async () => {
    const res = await fetch(`${base}/v1/analyze`);
    expect(res.status).toBe(402);
  });
});
