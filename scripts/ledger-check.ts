import { LedgerTrustRoot } from "../packages/envelope/src/index.js";

async function main() {
  const root = new LedgerTrustRoot({ transport: "speculos" });

  console.log("\n  Connecting to Speculos at http://127.0.0.1:5000 ...");
  await root.connect();
  console.log("  Connected.");

  const addr = await root.address();
  console.log(`\n  Device address (m/44'/60'/0'/0/0): ${addr}`);
  console.log("\n  This is the account whose key exists ONLY inside the");
  console.log("  emulated device. No string anywhere holds it.\n");

  await root.disconnect();
  console.log("  Disconnected.\n");
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
});
