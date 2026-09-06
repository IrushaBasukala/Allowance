import "dotenv/config";
import { createPublicClient, http, parseAbi, defineChain } from "viem";
import { ERC8004 } from "../packages/reputation/src/index.js";

const RPC = process.env.HEDERA_JSON_RPC ?? "https://testnet.hashio.io/api";
const MIRROR = "https://testnet.mirrornode.hedera.com";

const chain = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const identityAbi = parseAbi([
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
]);
const reputationAbi = parseAbi([
  "function getClients(uint256 agentId) view returns (address[])",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);

async function main() {
  const payTo = process.env.X402_PAY_TO?.trim();
  const agentIdRaw = process.env.SERVICE_AGENT_ID?.trim();

  console.log(`\n  1. .env`);
  console.log(`     X402_PAY_TO       ${payTo ?? "MISSING"}`);
  console.log(`     SERVICE_AGENT_ID  ${agentIdRaw ?? "MISSING"}`);
  if (!payTo || !agentIdRaw) {
    console.log(
      `\n     Both are required — without them there is no hint to verify.\n`,
    );
    return;
  }
  const agentId = BigInt(agentIdRaw);

  const res = await fetch(`${MIRROR}/api/v1/accounts/${payTo}`);
  const body = (await res.json()) as { evm_address?: string };
  const wallet = body.evm_address;
  console.log(`\n  2. ${payTo} -> ${wallet ?? "NO EVM ADDRESS"}`);
  if (!wallet) return;

  const client = createPublicClient({ chain, transport: http(RPC) });

  let onChainWallet: string;
  try {
    onChainWallet = await client.readContract({
      address: ERC8004.testnet.identityRegistry as `0x${string}`,
      abi: identityAbi,
      functionName: "getAgentWallet",
      args: [agentId],
    });
  } catch (e) {
    console.log(`\n  3. getAgentWallet(${agentId}) FAILED`);
    console.log(`     ${e instanceof Error ? e.message.slice(0, 200) : e}`);
    console.log(`     Agent ${agentId} may not exist.\n`);
    return;
  }

  const owner = await client.readContract({
    address: ERC8004.testnet.identityRegistry as `0x${string}`,
    abi: identityAbi,
    functionName: "ownerOf",
    args: [agentId],
  });

  console.log(`\n  3. agent ${agentId}`);
  console.log(`     owner        ${owner}`);
  console.log(`     agentWallet  ${onChainWallet}`);

  const match = onChainWallet.toLowerCase() === wallet.toLowerCase();
  console.log(
    `\n  4. agentWallet === ${payTo}'s address ?  ${match ? "YES" : "NO"}`,
  );
  if (!match) {
    console.log(
      `     The agent is bound to a different account, so the hint is`,
    );
    console.log(
      `     rejected. Re-run seed-reputation.ts with SERVICE_PRIVATE_KEY`,
    );
    console.log(`     set to the key for ${payTo}.\n`);
    return;
  }

  const clients = await client.readContract({
    address: ERC8004.testnet.reputationRegistry as `0x${string}`,
    abi: reputationAbi,
    functionName: "getClients",
    args: [agentId],
  });
  console.log(`\n  5. getClients -> ${clients.length} client(s)`);
  for (const c of clients) console.log(`     ${c}`);

  if (clients.length > 0) {
    const [count, value, decimals] = await client.readContract({
      address: ERC8004.testnet.reputationRegistry as `0x${string}`,
      abi: reputationAbi,
      functionName: "getSummary",
      args: [agentId, [...clients], "", ""],
    });
    console.log(
      `\n  6. getSummary -> count=${count} value=${value} decimals=${decimals}`,
    );
  }
  console.log();
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
});
