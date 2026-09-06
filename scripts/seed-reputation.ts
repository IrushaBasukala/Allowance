import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEventLogs,
  parseAbi,
  parseEther,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ERC8004 } from "../packages/reputation/src/index.js";

const RELAY = process.env.HEDERA_JSON_RPC ?? "https://testnet.hashio.io/api";
const MIRROR = "https://testnet.mirrornode.hedera.com";

const hederaTestnet = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [RELAY] } },
});

const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);

const reputationAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);

/** Hedera account id -> EVM address, via the mirror node. */
async function evmAddressFor(accountId: string): Promise<`0x${string}`> {
  const res = await fetch(`${MIRROR}/api/v1/accounts/${accountId}`);
  if (!res.ok) throw new Error(`mirror node ${res.status} for ${accountId}`);
  const body = (await res.json()) as { evm_address?: string };
  if (!body.evm_address) throw new Error(`no EVM address for ${accountId}`);
  return body.evm_address as `0x${string}`;
}

function normaliseKey(raw: string): Hex {
  const k = raw.trim().replace(/^0x/i, "");
  if (k.length !== 64) {
    throw new Error(
      `Expected a 64-character raw hex key, saw ${k.length}. ` +
        `The portal's DER key (100 chars) will not work here — use the ` +
        `HEX Encoded Private Key field.`,
    );
  }
  return `0x${k}`;
}

async function main() {
  const serviceKeyRaw = process.env.SERVICE_PRIVATE_KEY;
  if (!serviceKeyRaw) {
    throw new Error(
      "Missing SERVICE_PRIVATE_KEY.\n\n" +
        "  This is the private key of the account in X402_PAY_TO — the one\n" +
        "  that receives payments. Copy it from portal.hedera.com.\n" +
        "  The service registers its OWN agent identity, because the registry\n" +
        "  sets agentWallet to whoever registers.",
    );
  }

  const funderKey = normaliseKey(process.env.HEDERA_PRIVATE_KEY!);
  const serviceKey = normaliseKey(serviceKeyRaw);
  const funder = privateKeyToAccount(funderKey);
  const service = privateKeyToAccount(serviceKey);

  const identity = ERC8004.testnet.identityRegistry as `0x${string}`;
  const reputation = ERC8004.testnet.reputationRegistry as `0x${string}`;

  const pub = createPublicClient({
    chain: hederaTestnet,
    transport: http(RELAY),
  });

  console.log(`\n  relay      ${RELAY}`);
  console.log(`  identity   ${identity}`);
  console.log(`  reputation ${reputation}`);
  console.log(`  service    ${service.address}`);
  console.log(`  funder     ${funder.address}\n`);

  // 1. Register the service as an agent, from its own account.
  const serviceWallet = createWalletClient({
    account: service,
    chain: hederaTestnet,
    transport: http(RELAY),
  });

  console.log("  Registering agent...");
  const agentURI =
    process.env.AGENT_URI ?? "https://allowance.example/agent-card.json";

  const registerHash = await serviceWallet.writeContract({
    address: identity,
    abi: identityAbi,
    functionName: "register",
    args: [agentURI],
    gas: 1_000_000n,
  });
  const registerReceipt = await pub.waitForTransactionReceipt({
    hash: registerHash,
  });

  const registered = parseEventLogs({
    abi: identityAbi,
    eventName: "Registered",
    logs: registerReceipt.logs,
  });
  const agentId = registered[0]?.args.agentId;
  if (agentId === undefined) {
    throw new Error("register() emitted no Registered event");
  }
  console.log(`  agentId    ${agentId}`);

  const wallet = await pub.readContract({
    address: identity,
    abi: identityAbi,
    functionName: "getAgentWallet",
    args: [agentId],
  });
  console.log(`  agentWallet ${wallet}`);
  if (wallet.toLowerCase() !== service.address.toLowerCase()) {
    console.log(`  WARNING: agentWallet does not match the service address.`);
  }

  const funderWallet = createWalletClient({
    account: funder,
    chain: hederaTestnet,
    transport: http(RELAY),
  });

  const reviews = [
    { score: 92, tag: "quality" },
    { score: 88, tag: "quality" },
    { score: 95, tag: "latency" },
  ];

  console.log(`\n  Seeding ${reviews.length} reviews from distinct clients...`);

  for (const [i, review] of reviews.entries()) {
    const clientKey = generatePrivateKey();
    const client = privateKeyToAccount(clientKey);

    const fundHash = await funderWallet.sendTransaction({
      to: client.address,
      value: parseEther("2"), // generous: Hedera gas is denominated in tinybar
    });
    await pub.waitForTransactionReceipt({ hash: fundHash });

    const clientWallet = createWalletClient({
      account: client,
      chain: hederaTestnet,
      transport: http(RELAY),
    });

    const feedbackHash = await clientWallet.writeContract({
      address: reputation,
      abi: reputationAbi,
      functionName: "giveFeedback",
      args: [
        agentId,
        BigInt(review.score),
        0, // valueDecimals: a plain 0-100 rating
        review.tag,
        "",
        "",
        "",
        `0x${"00".repeat(32)}`,
      ],
      gas: 1_000_000n,
    });
    await pub.waitForTransactionReceipt({ hash: feedbackHash });

    console.log(
      `    ${i + 1}. ${client.address.slice(0, 10)}... scored ${review.score} (${review.tag})`,
    );
  }

  console.log(`\n  Done. Add to .env:\n`);
  console.log(`    SERVICE_AGENT_ID=${agentId}\n`);
  console.log(
    `    https://hashscan.io/testnet/address/${ERC8004.testnet.reputationRegistry}\n`,
  );
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
});
