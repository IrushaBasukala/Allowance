import {
  hashTypedData,
  recoverTypedDataAddress,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_DOMAIN,
  ENVELOPE_TYPES,
  type Envelope,
  type EnvelopeDomain,
  type TrustRoot,
} from "./types.js";

/**
 * Stable digest of an envelope. Goes into every receipt so an auditor can
 * prove which envelope a decision was made under without storing the whole thing.
 */
export function envelopeHash(
  envelope: Envelope,
  domain: EnvelopeDomain = DEFAULT_DOMAIN,
): Hex {
  return hashTypedData({
    domain,
    types: ENVELOPE_TYPES,
    primaryType: "Envelope",
    message: envelope,
  });
}

/** Sign with a raw private key. Stand-in for the device signer. */
export async function signEnvelopeLocal(
  envelope: Envelope,
  privateKey: Hex,
  domain: EnvelopeDomain = DEFAULT_DOMAIN,
): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  return account.signTypedData({
    domain,
    types: ENVELOPE_TYPES,
    primaryType: "Envelope",
    message: envelope,
  });
}

/**
 * TrustRoot backed by an ordinary EOA signature.
 *
 * This is the stub the Ledger DMK implementation replaces. The swap touches
 * this file only — if the device integration fights us, we ship with this
 * and the product is still complete.
 */
export class LocalTrustRoot implements TrustRoot {
  readonly kind = "local-eoa";

  async verify(
    envelope: Envelope,
    signature: Hex,
    domain: EnvelopeDomain = DEFAULT_DOMAIN,
  ): Promise<Address | null> {
    try {
      const recovered = await recoverTypedDataAddress({
        domain,
        types: ENVELOPE_TYPES,
        primaryType: "Envelope",
        message: envelope,
        signature,
      });
      // The signature must belong to the principal named inside the envelope.
      // Without this check a valid signature over someone else's envelope passes.
      if (getAddress(recovered) !== getAddress(envelope.principal)) return null;
      return getAddress(recovered);
    } catch {
      return null;
    }
  }
}
