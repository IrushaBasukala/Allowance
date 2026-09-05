import type { Address, Hex } from "viem";

/**
 * Counterparty gating mode.
 * Kept as uint8 so an ERC-7730 descriptor can map it to readable labels
 * via metadata.enums when the envelope is Clear Signed on device.
 */
export const CounterpartyMode = {
  /** Only the addresses the owner listed. */
  AllowlistOnly: 0,
  /** Anyone who clears the reputation bar. */
  ReputationOnly: 1,
  /** On the list, OR clears the bar. The list is a bypass, not an extra hurdle. */
  AllowlistOrReputation: 2,
} as const;

export type CounterpartyModeValue =
  (typeof CounterpartyMode)[keyof typeof CounterpartyMode];

/**
 * A spending Envelope: what a human authorized an agent to spend, and on whom.
 *
 * Signed as an EIP-712 typed message rather than a transaction, so:
 *   - the human signs once, off-chain, with no gas
 *   - ERC-7730 can bind a descriptor to the EIP-712 schema for Clear Signing
 *
 * Amounts are in the currency's smallest unit (tinybars for HBAR: 1 HBAR = 1e8).
 */
export interface Envelope {
  version: string;
  envelopeId: Hex; // bytes32
  principal: Address; // the human owner
  agent: string; // ERC-8004 agent id or Hedera account id
  currency: string; // "HBAR" or an HTS token id like "0.0.12345"
  perCall: bigint;
  perWindow: bigint;
  windowSeconds: bigint;
  counterpartyMode: number;
  allowlist: string[];
  minReputation: number; // 0..1000
  minFeedbackCount: number; // guards against single-attestation gaming
  notBefore: bigint; // unix seconds
  notAfter: bigint; // unix seconds
  receiptTopic: string; // HCS topic id, e.g. "0.0.98765"
}

/**
 * EIP-712 struct definition. Field order is part of the type hash —
 * changing it changes every signature, so treat this as frozen once shipped.
 */
export const ENVELOPE_TYPES = {
  Envelope: [
    { name: "version", type: "string" },
    { name: "envelopeId", type: "bytes32" },
    { name: "principal", type: "address" },
    { name: "agent", type: "string" },
    { name: "currency", type: "string" },
    { name: "perCall", type: "uint256" },
    { name: "perWindow", type: "uint256" },
    { name: "windowSeconds", type: "uint64" },
    { name: "counterpartyMode", type: "uint8" },
    { name: "allowlist", type: "string[]" },
    { name: "minReputation", type: "uint16" },
    { name: "minFeedbackCount", type: "uint32" },
    { name: "notBefore", type: "uint64" },
    { name: "notAfter", type: "uint64" },
    { name: "receiptTopic", type: "string" },
  ],
} as const;

export interface EnvelopeDomain {
  name: string;
  version: string;
  chainId: number;
}

/** Hedera testnet. Mainnet is 295, previewnet 297. */
export const HEDERA_TESTNET_CHAIN_ID = 296;

export const DEFAULT_DOMAIN: EnvelopeDomain = {
  name: "Allowance",
  version: "1",
  chainId: HEDERA_TESTNET_CHAIN_ID,
};

/**
 * Anything that can vouch for who signed an envelope.
 *
 * Deliberately narrow: a local EOA satisfies this today, a Ledger device
 * satisfies it later, and nothing downstream needs to know which.
 */
export interface TrustRoot {
  readonly kind: string;
  /** Returns the recovered principal, or null if the signature doesn't hold. */
  verify(
    envelope: Envelope,
    signature: Hex,
    domain?: EnvelopeDomain,
  ): Promise<Address | null>;
}
