import "dotenv/config";

const url =
  process.env.X402_FACILITATOR_URL ?? "https://api.testnet.blocky402.com";
const wantNetwork = process.env.X402_NETWORK ?? "hedera:testnet";
const haveFeePayer = process.env.X402_FEE_PAYER;

interface Kind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: { feePayer?: string };
}

async function main() {
  console.log(`\nChecking ${url}/supported\n`);

  const res = await fetch(`${url}/supported`);
  if (!res.ok) {
    throw new Error(`facilitator returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { kinds?: Kind[] };
  const kinds = body.kinds ?? [];

  console.log("Networks this facilitator supports:");
  for (const k of kinds) {
    console.log(
      `  ${k.network.padEnd(46)} scheme=${k.scheme} v${k.x402Version}`,
    );
  }
  console.log();

  const match = kinds.find((k) => k.network === wantNetwork);
  if (!match) {
    console.error(`FAIL  ${wantNetwork} is not supported by this facilitator.`);
    console.error(
      `      Set X402_NETWORK to one of the networks listed above.`,
    );
    process.exit(1);
  }
  console.log(
    `OK    ${wantNetwork} is supported (scheme=${match.scheme}, v${match.x402Version})`,
  );

  const liveFeePayer = match.extra?.feePayer;
  if (!liveFeePayer) {
    console.error(`FAIL  ${wantNetwork} advertises no feePayer.`);
    console.error(
      `      The Hedera client signer cannot build a transfer without one.`,
    );
    process.exit(1);
  }

  if (!haveFeePayer) {
    console.log(`\nAdd to .env:\n  X402_FEE_PAYER=${liveFeePayer}\n`);
    process.exit(1);
  }

  if (haveFeePayer !== liveFeePayer) {
    console.error(`\nFAIL  feePayer has changed.`);
    console.error(`      .env has : ${haveFeePayer}`);
    console.error(`      live is  : ${liveFeePayer}`);
    console.error(
      `\n      Update X402_FEE_PAYER in .env, or every payment will`,
    );
    console.error(`      fail with an unhelpful signature error.\n`);
    process.exit(1);
  }

  console.log(`OK    feePayer matches (${liveFeePayer})`);
  console.log(`\nConfiguration is current.\n`);
}

main().catch((e) => {
  console.error(
    `\nCould not reach the facilitator: ${e instanceof Error ? e.message : e}\n`,
  );
  process.exit(1);
});
