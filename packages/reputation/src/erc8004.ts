export const ERC8004 = {
  testnet: {
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
  mainnet: {
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  },
} as const;

export const TOPIC = {
  NewFeedback:
    "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc",
  FeedbackRevoked:
    "0x25156fd3288212246d8b008d5921fde376c71ed14ac2e072a506eb06fde6d09d",
  Registered:
    "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a",
  MetadataSet:
    "0x2c149ed548c6d2993cd73efe187df6eccabe4538091b33adbd25fafdb8a1468b",
} as const;

export const AGENT_WALLET_KEY = "agentWallet";
