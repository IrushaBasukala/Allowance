import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  envelopeHash,
  signEnvelopeLocal,
  LocalTrustRoot,
} from "../src/envelope.js";
import {
  CounterpartyMode,
  DEFAULT_DOMAIN,
  type Envelope,
} from "../src/types.js";

const OWNER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const ATTACKER_KEY =
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;

const owner = privateKeyToAccount(OWNER_KEY);
const attacker = privateKeyToAccount(ATTACKER_KEY);

const HBAR = 100_000_000n; // 1 HBAR in tinybars

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    version: "1",
    envelopeId: `0x${"ab".repeat(32)}`,
    principal: owner.address,
    agent: "0.0.4417542",
    currency: "HBAR",
    perCall: 2n * HBAR,
    perWindow: 50n * HBAR,
    windowSeconds: 86_400n,
    counterpartyMode: CounterpartyMode.AllowlistOrReputation,
    allowlist: ["0.0.5551212"],
    minReputation: 600,
    minFeedbackCount: 5,
    notBefore: 1_756_000_000n,
    notAfter: 1_788_000_000n,
    receiptTopic: "0.0.98765",
    ...overrides,
  };
}

describe("envelopeHash", () => {
  it("is deterministic", () => {
    expect(envelopeHash(makeEnvelope())).toBe(envelopeHash(makeEnvelope()));
  });

  it("changes when any field changes", () => {
    const base = envelopeHash(makeEnvelope());
    expect(envelopeHash(makeEnvelope({ perCall: 3n * HBAR }))).not.toBe(base);
    expect(envelopeHash(makeEnvelope({ minReputation: 601 }))).not.toBe(base);
    expect(envelopeHash(makeEnvelope({ allowlist: [] }))).not.toBe(base);
  });
});

describe("LocalTrustRoot", () => {
  const trust = new LocalTrustRoot();

  it("accepts a signature from the principal", async () => {
    const env = makeEnvelope();
    const sig = await signEnvelopeLocal(env, OWNER_KEY);
    expect(await trust.verify(env, sig)).toBe(owner.address);
  });

  it("rejects a raised spending limit", async () => {
    const env = makeEnvelope();
    const sig = await signEnvelopeLocal(env, OWNER_KEY);
    const tampered = { ...env, perCall: 500n * HBAR };
    expect(await trust.verify(tampered, sig)).toBeNull();
  });

  it("rejects an appended counterparty", async () => {
    const env = makeEnvelope();
    const sig = await signEnvelopeLocal(env, OWNER_KEY);
    const tampered = { ...env, allowlist: [...env.allowlist, "0.0.6660000"] };
    expect(await trust.verify(tampered, sig)).toBeNull();
  });

  it("rejects a valid signature over someone else's envelope", async () => {
    // Attacker signs an envelope that names the owner as principal.
    // The signature itself is well-formed; the binding is what fails.
    const env = makeEnvelope();
    const sig = await signEnvelopeLocal(env, ATTACKER_KEY);
    expect(attacker.address).not.toBe(owner.address);
    expect(await trust.verify(env, sig)).toBeNull();
  });

  it("rejects replay onto another network", async () => {
    const env = makeEnvelope();
    const sig = await signEnvelopeLocal(env, OWNER_KEY);
    const mainnet = { ...DEFAULT_DOMAIN, chainId: 295 };
    expect(await trust.verify(env, sig, mainnet)).toBeNull();
  });

  it("rejects garbage", async () => {
    const env = makeEnvelope();
    expect(await trust.verify(env, `0x${"00".repeat(65)}`)).toBeNull();
  });
});
