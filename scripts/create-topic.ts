import "dotenv/config";
import {
  createReceiptTopic,
  makeClient,
} from "../packages/receipts/src/index.js";
import { loadConfig } from "./config.js";

async function main() {
  const cfg = loadConfig();
  const client = makeClient({
    accountId: cfg.accountId,
    privateKey: cfg.hederaKey,
    network: cfg.network,
    keyType: cfg.keyType,
  });

  console.log(
    `Creating receipt topic on ${cfg.network} as ${cfg.accountId}...`,
  );
  const topicId = await createReceiptTopic(client);

  console.log(`\n  Topic created: ${topicId}`);
  console.log(`\n  Add this to .env:\n    HCS_RECEIPT_TOPIC=${topicId}`);
  console.log(
    `\n  View it: https://hashscan.io/${cfg.network}/topic/${topicId}\n`,
  );
  client.close();
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
});
