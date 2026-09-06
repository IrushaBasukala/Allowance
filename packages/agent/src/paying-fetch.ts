import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import type { Network } from "@x402/core/types";
// Client-side scheme — see the note in packages/service/src/server.ts about
// the three same-named classes.
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import {
  createClientHederaSigner,
  HEDERA_TESTNET_CAIP2,
  PrivateKey,
} from "@x402/hedera";
import { createGuard, type Guard, type GuardDeps } from "./guard.js";

export interface AgentConfig extends GuardDeps {
  /** The agent's Hedera account — pays for calls. NOT the owner. */
  accountId: string;
  /** DER or hex private key for that account. */
  privateKey: string;
  network?: string;
}

/**
 * A fetch that pays for 402 responses, but only within the signed envelope.
 *
 * Two SDKs coexist in this repo and must not be mixed. @x402/hedera depends on
 * @hiero-ledger/sdk (the Linux Foundation's renamed Hedera SDK), while our
 * receipts package uses @hashgraph/sdk. The classes are distinct objects, so a
 * PrivateKey from one fails an instanceof check inside the other with an error
 * that points nowhere useful.
 *
 * The rule: anything on the payment path imports Hedera classes from
 * @x402/hedera (which re-exports the Hiero ones). Anything on the receipt path
 * uses @hashgraph/sdk. Never pass an instance across that line — which is why
 * PrivateKey below comes from @x402/hedera, not @hashgraph/sdk.
 */
export function createPayingFetch(cfg: AgentConfig): {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  guard: Guard;
} {
  const network = (cfg.network ?? HEDERA_TESTNET_CAIP2) as Network;

  // Choose the parser by shape rather than trying DER first. fromStringDer()
  // accepts a raw hex key but emits a warning telling you to use
  // fromStringECDSA — noise on every run, and a hint we were guessing.
  const raw = cfg.privateKey.trim().replace(/^0x/i, "");
  const key =
    raw.length === 64
      ? PrivateKey.fromStringECDSA(raw)
      : PrivateKey.fromStringDer(raw);

  const signer = createClientHederaSigner(cfg.accountId, key, { network });

  const guard = createGuard(cfg);

  const client = new x402Client()
    .register(network, new ExactHederaScheme(signer))
    .onBeforePaymentCreation(guard.beforePaymentCreation)
    .onPaymentResponse(guard.onPaymentResponse)

    .setSpendControls(false);

  return {
    fetch: wrapFetchWithPayment(globalThis.fetch, client),
    guard,
  };
}
