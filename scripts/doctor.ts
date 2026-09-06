import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { parsePrivateKey } from "../packages/receipts/src/index.js";

type Status = "ok" | "warn" | "fail";

interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

const checks: Check[] = [];
const add = (name: string, status: Status, detail: string, fix?: string) =>
  checks.push({ name, status, detail, fix });

function env(name: string): string | undefined {
  const v = process.env[name]?.trim().replace(/^["']|["']$/g, "");
  return v && !/^0x$/i.test(v) && !v.startsWith("0.0.xxx") ? v : undefined;
}

const accountId = env("HEDERA_ACCOUNT_ID");
if (!accountId) {
  add(
    "HEDERA_ACCOUNT_ID",
    "fail",
    "not set",
    "portal.hedera.com — create an ECDSA testnet account",
  );
} else if (!/^\d+\.\d+\.\d+$/.test(accountId)) {
  add(
    "HEDERA_ACCOUNT_ID",
    "fail",
    `"${accountId}" is not a Hedera account id`,
    "expected the form 0.0.12345",
  );
} else {
  add("HEDERA_ACCOUNT_ID", "ok", accountId);
}

const hederaKey = env("HEDERA_PRIVATE_KEY");
if (!hederaKey) {
  add(
    "HEDERA_PRIVATE_KEY",
    "fail",
    "not set",
    "portal.hedera.com — use the COPY icon, not the visible text",
  );
} else {
  const body = /^0x/i.test(hederaKey) ? hederaKey.slice(2) : hederaKey;
  try {
    parsePrivateKey(
      hederaKey,
      env("HEDERA_KEY_TYPE") as "ECDSA" | "ED25519" | undefined,
    );
    add("HEDERA_PRIVATE_KEY", "ok", `${body.length} hex chars, parses`);
  } catch {
    add(
      "HEDERA_PRIVATE_KEY",
      "fail",
      `${body.length} hex chars — expected 64 (raw) or 100 (DER)`,
      body.length < 64
        ? "truncated paste; use the portal's copy icon"
        : "check HEDERA_KEY_TYPE",
    );
  }
}

const ownerKey = env("OWNER_PRIVATE_KEY");
if (!ownerKey) {
  add(
    "OWNER_PRIVATE_KEY",
    "fail",
    "not set",
    "npx tsx scripts/new-owner-key.ts",
  );
} else {
  try {
    const addr = privateKeyToAccount(ownerKey as `0x${string}`).address;
    if (hederaKey && ownerKey.toLowerCase() === hederaKey.toLowerCase()) {
      add(
        "OWNER_PRIVATE_KEY",
        "fail",
        "IDENTICAL to HEDERA_PRIVATE_KEY",
        "the agent could sign itself a bigger allowance — generate a separate key",
      );
    } else {
      add("OWNER_PRIVATE_KEY", "ok", addr);
    }
  } catch {
    add(
      "OWNER_PRIVATE_KEY",
      "fail",
      "not a valid key",
      "npx tsx scripts/new-owner-key.ts",
    );
  }
}

const topic = env("HCS_RECEIPT_TOPIC");
if (!topic) {
  add(
    "HCS_RECEIPT_TOPIC",
    "fail",
    "not set",
    "npx tsx scripts/create-topic.ts",
  );
} else if (!/^\d+\.\d+\.\d+$/.test(topic)) {
  add(
    "HCS_RECEIPT_TOPIC",
    "fail",
    `"${topic}" is not a topic id`,
    "expected 0.0.12345",
  );
} else {
  add("HCS_RECEIPT_TOPIC", "ok", topic);
}

const facilitator = env("X402_FACILITATOR_URL");
add(
  "X402_FACILITATOR_URL",
  facilitator ? "ok" : "fail",
  facilitator ?? "not set",
  facilitator ? undefined : "https://api.testnet.blocky402.com",
);

const feePayer = env("X402_FEE_PAYER");
add(
  "X402_FEE_PAYER",
  feePayer ? "ok" : "fail",
  feePayer ?? "not set",
  feePayer ? undefined : "npx tsx scripts/x402-check.ts",
);

const payTo = env("X402_PAY_TO");
if (!payTo) {
  add(
    "X402_PAY_TO",
    "fail",
    `not set — would default to ${accountId ?? "your own account"}`,
    "create a SECOND testnet account; the agent cannot pay itself",
  );
} else if (payTo === accountId) {
  add(
    "X402_PAY_TO",
    "fail",
    "same as HEDERA_ACCOUNT_ID",
    "an account cannot appear twice in a transfer",
  );
} else {
  add("X402_PAY_TO", "ok", payTo);
}

async function main() {
  if (facilitator) {
    try {
      const res = await fetch(`${facilitator}/supported`);
      const body = (await res.json()) as {
        kinds?: Array<{ network: string; extra?: { feePayer?: string } }>;
      };
      const network = env("X402_NETWORK") ?? "hedera:testnet";
      const kind = body.kinds?.find((k) => k.network === network);
      if (!kind) {
        add(
          "facilitator",
          "fail",
          `${network} not supported`,
          "npx tsx scripts/x402-check.ts",
        );
      } else if (feePayer && kind.extra?.feePayer !== feePayer) {
        add(
          "facilitator",
          "fail",
          `feePayer rotated to ${kind.extra?.feePayer}`,
          "update X402_FEE_PAYER",
        );
      } else {
        add("facilitator", "ok", `reachable, ${network} supported`);
      }
    } catch {
      add(
        "facilitator",
        "warn",
        "unreachable",
        "the service returns 500, not 402, without it",
      );
    }
  }

  const mark = { ok: "  OK  ", warn: " WARN ", fail: " FAIL " };
  console.log("\n  Allowance environment check\n");
  for (const c of checks) {
    console.log(`${mark[c.status]} ${c.name.padEnd(22)} ${c.detail}`);
    if (c.fix) console.log(`       ${" ".repeat(22)} -> ${c.fix}`);
  }

  const failed = checks.filter((c) => c.status === "fail");
  console.log();
  if (failed.length === 0) {
    console.log("  Everything is set. Run:\n");
    console.log("    terminal 1:  npx tsx scripts/service.ts");
    console.log("    terminal 2:  npx tsx scripts/pay.ts\n");
  } else {
    console.log(
      `  ${failed.length} item(s) need attention. Fix them in any order.\n`,
    );
    process.exit(1);
  }
}

main();
