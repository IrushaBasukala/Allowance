import { describe, it, expect } from "vitest";
import { normalise, ERC8004, TOPIC, AGENT_WALLET_KEY } from "../src/index.js";

describe("normalise", () => {
  it("scales a 0-100 rating onto 0-1000", () => {
    expect(normalise(85n, 0)).toBe(850);
    expect(normalise(9977n, 2)).toBe(998); // 99.77 -> 997.7 -> 998
  });

  it("handles the fixed-point pair the standard actually stores", () => {
    expect(normalise(560n, 1)).toBe(560); // 56.0 -> 560
    expect(normalise(0n, 0)).toBe(0);
  });

  it("clamps rather than trusting out-of-range values", () => {
    expect(normalise(500000n, 0)).toBe(1000);
    expect(normalise(-40n, 0)).toBe(0);
  });
});

describe("registry constants", () => {
  it("uses the deterministic testnet singletons", () => {
    // Verified live: the testnet ReputationRegistry resolves to 0.0.7919998.
    expect(ERC8004.testnet.reputationRegistry).toBe(
      "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    );
    expect(ERC8004.testnet.identityRegistry).toBe(
      "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    );
  });

  it("keeps mainnet and testnet addresses distinct", () => {
    expect(ERC8004.mainnet.identityRegistry).not.toBe(
      ERC8004.testnet.identityRegistry,
    );
  });

  it("still exposes the event topics for anything reading logs", () => {
    expect(TOPIC.NewFeedback).toMatch(/^0x[0-9a-f]{64}$/);
    expect(AGENT_WALLET_KEY).toBe("agentWallet");
  });
});
