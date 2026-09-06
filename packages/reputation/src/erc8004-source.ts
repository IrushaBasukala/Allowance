import {
  createPublicClient,
  http,
  parseAbi,
  defineChain,
  type PublicClient,
} from "viem";
import type { Reputation } from "@allowance/policy";
import { ERC8004 } from "./erc8004.js";
import type { ReputationSource } from "./source.js";

const MIRROR: Record<string, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet-public.mirrornode.hedera.com",
};

const RELAY: Record<string, string> = {
  testnet: "https://testnet.hashio.io/api",
  mainnet: "https://mainnet.hashio.io/api",
};

const CHAIN_ID: Record<string, number> = { testnet: 296, mainnet: 295 };

const reputationAbi = parseAbi([
  "function getClients(uint256 agentId) view returns (address[])",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);

const identityAbi = parseAbi([
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);

export interface Erc8004Options {
  rpcUrl?: string;
  mirrorUrl?: string;

  agentIds?: Record<string, string | bigint>;
}

export class Erc8004ReputationSource implements ReputationSource {
  readonly kind = "erc8004:hedera";
  private readonly client: PublicClient;
  private readonly mirror: string;
  private readonly registry: `0x${string}`;
  private readonly identity: `0x${string}`;
  private readonly hints: Record<string, bigint>;
  private readonly resolved = new Map<string, bigint | null>();

  constructor(
    network: "testnet" | "mainnet" = "testnet",
    opts: Erc8004Options = {},
  ) {
    this.mirror = opts.mirrorUrl ?? MIRROR[network]!;
    this.registry = ERC8004[network].reputationRegistry as `0x${string}`;
    this.identity = ERC8004[network].identityRegistry as `0x${string}`;

    const rpcUrl = opts.rpcUrl ?? RELAY[network]!;
    const chain = defineChain({
      id: CHAIN_ID[network]!,
      name: `Hedera ${network}`,
      nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    this.client = createPublicClient({ chain, transport: http(rpcUrl) });

    this.hints = {};
    for (const [k, v] of Object.entries(opts.agentIds ?? {})) {
      this.hints[k.toLowerCase()] = BigInt(v);
    }
  }

  private async evmAddressForAccount(
    accountId: string,
  ): Promise<string | null> {
    try {
      const res = await fetch(`${this.mirror}/api/v1/accounts/${accountId}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { evm_address?: string };
      return body.evm_address ?? null;
    } catch {
      return null;
    }
  }

  private async resolveAgentId(counterparty: string): Promise<bigint | null> {
    const key = counterparty.toLowerCase();
    const cached = this.resolved.get(key);
    if (cached !== undefined) return cached;

    const result = await this.resolveUncached(counterparty);
    this.resolved.set(key, result);
    return result;
  }

  private async resolveUncached(counterparty: string): Promise<bigint | null> {
    if (/^\d+$/.test(counterparty)) return BigInt(counterparty);

    const hint = this.hints[counterparty.toLowerCase()];
    if (hint === undefined) return null;

    const wallet = /^0x[0-9a-fA-F]{40}$/.test(counterparty)
      ? counterparty
      : await this.evmAddressForAccount(counterparty);
    if (!wallet) return null;

    try {
      const onChain = await this.client.readContract({
        address: this.identity,
        abi: identityAbi,
        functionName: "getAgentWallet",
        args: [hint],
      });
      if (onChain.toLowerCase() !== wallet.toLowerCase()) return null;
      return hint;
    } catch {
      return null;
    }
  }

  async score(counterparty: string): Promise<Reputation | null> {
    const agentId = await this.resolveAgentId(counterparty);
    if (agentId === null) return null;

    let clients: readonly `0x${string}`[];
    try {
      clients = await this.client.readContract({
        address: this.registry,
        abi: reputationAbi,
        functionName: "getClients",
        args: [agentId],
      });
    } catch {
      return null;
    }

    if (clients.length === 0) {
      return { score: 0, feedbackCount: 0, source: this.kind };
    }

    try {
      const [count, summaryValue, summaryDecimals] =
        await this.client.readContract({
          address: this.registry,
          abi: reputationAbi,
          functionName: "getSummary",
          args: [agentId, [...clients], "", ""],
        });

      return {
        score: normalise(summaryValue, Number(summaryDecimals)),

        feedbackCount: clients.length,
        source: `${this.kind}:${count}`,
      };
    } catch {
      return null;
    }
  }
}

export function normalise(value: bigint, decimals: number): number {
  const real = Number(value) / 10 ** decimals;
  const scaled = real * 10;
  return Math.max(0, Math.min(1000, Math.round(scaled)));
}
