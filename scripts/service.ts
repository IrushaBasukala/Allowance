import "dotenv/config";
import { createService } from "../packages/service/src/index.js";
import { loadConfig } from "./config.js";

const PORT = Number(process.env.PORT ?? 4021);

function main() {
  //   const cfg = loadConfig();
  const cfg = loadConfig({ requireOwner: false });

  const payTo = process.env.X402_PAY_TO?.trim() || cfg.accountId;
  const facilitatorUrl =
    process.env.X402_FACILITATOR_URL ?? "https://api.testnet.blocky402.com";
  const feePayer = process.env.X402_FEE_PAYER;
  const priceTinybar = BigInt(process.env.X402_PRICE_TINYBAR ?? "1000000");

  if (!feePayer) {
    throw new Error(
      "Missing X402_FEE_PAYER — run: npm run x402:check\n" +
        "  The facilitator co-signs every transfer, so payment requirements\n" +
        "  must name its account or the client signer will refuse to build one.",
    );
  }

  const app = createService({
    payTo,
    facilitatorUrl,
    feePayer,
    priceTinybar,
    network: process.env.X402_NETWORK,
  });

  app.listen(PORT, () => {
    console.log(`\n  allowance inference service`);
    console.log(`  listening      http://localhost:${PORT}`);
    console.log(`  free           GET /health`);
    console.log(`  metered        GET /v1/analyze?text=...`);
    console.log(`  price          ${Number(priceTinybar) / 1e8} HBAR per call`);
    console.log(`  paid to        ${payTo}`);
    console.log(`  facilitator    ${facilitatorUrl}`);
    console.log(`  fee payer      ${feePayer}`);
    console.log(`\n  Try it unpaid — you should get a 402:`);
    console.log(
      `    curl -i "http://localhost:${PORT}/v1/analyze?text=hello"\n`,
    );
  });
}

try {
  main();
} catch (e) {
  console.error("\n" + (e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
}
