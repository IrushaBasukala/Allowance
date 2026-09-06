import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
const account = privateKeyToAccount(key);

console.log("\nOwner signing key (development stand-in)\n");
console.log(`  address  ${account.address}`);
console.log(`  key      ${key}`);
console.log("\nAdd to .env:\n");
console.log(`  OWNER_PRIVATE_KEY=${key}`);
console.log(
  "\nThis is the human, not the agent. Keep it distinct from HEDERA_PRIVATE_KEY.\n",
);
