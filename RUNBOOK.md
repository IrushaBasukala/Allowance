# Runbook

Every command in this project, in the order you would run them, with what each
one proves.

---

## Part 0 — Install

```bash
npm install
```

Installs everything. No build step follows: `tsx` runs TypeScript sources
directly, so there is no compile-and-watch loop to explain.

---

## Part 1 — Prove the logic before touching a network

These need no credentials, no internet, and no Hedera account. Run them first,
because if the decision logic is wrong, nothing downstream matters.

### `npm run check`

```bash
npm run check     # = npm run typecheck && npm run test
```

**What it proves:** 94 tests across 7 files, and a clean typecheck against the
real SDK types — `@x402/*`, `@hashgraph/sdk`, and Ledger's DMK packages, not
against interfaces we assumed.

**Why it matters:** the evaluator is a pure function with no I/O and no clock,
so every decision path — signature failure, expiry, per-call limit, window
exhaustion, sybil reputation, fail-closed on unavailable data — is testable in
milliseconds. That design is why the suite runs in under a second rather than
needing a testnet.

Worth knowing which tests exist for the _wrong_ reasons too. One test asserts
that the old nested `price: { asset, amount }` shape is **rejected**, because
we once tested against that assumed shape, passed, and had every live payment
refused as `UNREADABLE_REQUIREMENTS`. A test that passes while the system is
broken is not a test.

### `npm run demo`

```bash
npm run demo
```

**What it proves:** nine payment scenarios evaluated offline — allows,
refusals, sybil detection, and two reputation-outage cases.

**Why it matters:** it shows the guard reaching a decision for every reason
code without a network. The two outage scenarios are the interesting pair: an
unknown counterparty is refused when reputation is unreachable (fail closed),
while an allowlisted one still goes through. That is the allowlist doing its
real job — a bypass for parties the owner already trusts, so an infrastructure
failure degrades the agent rather than stopping it.

---

## Part 2 — One-time setup

Create a Hedera **testnet** account at <https://portal.hedera.com>, choosing
**ECDSA** (not ED25519). ECDSA gives the account an EVM address, which the
x402 payment path and the ERC-8004 registries both need.

You need **two** accounts: one that pays (the agent) and one that gets paid
(the service). A Hedera transfer cannot name the same account twice, so a
single account fails at consensus with an unhelpful error.

```bash
cp .env.example .env
```

### `npm run key:owner`

```bash
npm run key:owner
```

**What it does:** generates a fresh secp256k1 key and prints an
`OWNER_PRIVATE_KEY=` line for `.env`.

**Why it exists as a separate key:** three principals, three powers.

| Key                   | Who         | Can                  |
| --------------------- | ----------- | -------------------- |
| `HEDERA_PRIVATE_KEY`  | the agent   | spend, within limits |
| `OWNER_PRIVATE_KEY`   | the human   | set the limits       |
| `SERVICE_PRIVATE_KEY` | the service | receive payment      |

If the owner key and the agent key were the same, the agent could sign itself
a larger allowance and the entire guarantee would be theatre. `scripts/config.ts`
refuses to start when they match.

### `npm run topic:create`

```bash
npm run topic:create
```

**What it does:** creates the HCS topic every decision is written to. Prints an
`HCS_RECEIPT_TOPIC=` line for `.env`.

**Why the topic has no submit key:** that makes it public-write, which looks
careless and is not. A submit key would let _us_ control who appends —
including letting us suppress our own denials. An audit trail whose owner can
censor entries is not one. Append-only is the property we need; exclusive write
is its opposite. Malformed messages from third parties are filtered at read
time.

### `npm run x402:check`

```bash
npm run x402:check
```

**What it proves:** the Blocky402 facilitator is reachable, supports
`hedera:testnet`, and still advertises the fee payer in your `.env`.

**Why it matters:** the facilitator co-signs and submits every transfer, so
its account must appear in the payment requirements — the client signer throws
`"feePayer is required in paymentRequirements.extra"` without it. That value is
theirs, not yours, and it can rotate. **Run this again immediately before
recording a demo**: a rotated fee payer produces a signature error that points
nowhere near the real cause.

### `npm run seed:reputation`

```bash
npm run seed:reputation
```

**What it does:** registers the service as an ERC-8004 agent on Hedera testnet,
then has three throwaway accounts each leave one review. Prints a
`SERVICE_AGENT_ID=` line.

**Why the service registers itself:** the Identity Registry sets `agentWallet`
to whoever registers, and changing it later needs an EIP-712 signature from the
new wallet anyway. The party being paid owns its identity; we only read it.

**Why three separate accounts:** `giveFeedback()` rejects the agent's own
owner — the contract enforces it. Real reputation needs real third parties. It
also has to be three _distinct_ clients: fifty reviews from one address is one
endorsement, which is exactly what `minFeedbackCount` is for.

### `npm run doctor`

```bash
npm run doctor
```
OR

```bash
npx tsx scripts/doctor
```

**What it proves:** every environment variable at once — account IDs
well-formed, keys parseable, owner and agent keys distinct, topic set, `payTo`
not the same as the agent, and the facilitator live.

**Why it exists:** setup originally failed one variable at a time — fix one,
rerun, hit the next. This reports the whole picture in one pass, and never
prints a secret (keys appear only as lengths and derived addresses).

---

## Part 3 — The demo

Three terminals.

### Terminal 1 — `npm run service`

```bash
npm run service 
```
OR 

```bash 
npx tsx scripts/service
```

**What it does:** starts the x402-gated inference endpoint on port 4021.

**What to show:** hit it unpaid and get a **402**:

```bash
curl -i "http://localhost:4021/v1/analyze?text=hello"
```

The body is literally `{}` — everything a client needs (price, recipient,
network, fee payer) travels base64-encoded in a `payment-required` **header**.
That is x402 working as designed: the negotiation is for machines with no UI.

**Priced in HBAR, not USDC**, deliberately. USDC on Hedera is an HTS token
requiring a `TokenAssociateTransaction` on the receiving account first — an
extra failure mode (`TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`) that surfaces only at
consensus. HBAR is native and needs no association.

### Terminal 2 — the console

```bash
npm run console        # then open http://localhost:4022
```
OR 

```bash
start packages/console/index.html
```

Or just double-click `packages/console/index.html` — it is a single
self-contained file with no build step, which matters for async judging: a
judge opens it and sees live data rather than running an install.

**What it shows:** every decision, read live from the public HCS topic through
a public mirror node, polling every four seconds. Rows group by envelope. Only
declines get colour — real statements do not paint approvals green, they just
list them; only exceptions get marked.

The topic field is editable and the mirror node URL is printed beneath it. That
is the credibility move: a judge who suspects hardcoded data can paste a
different topic, or click the URL and read the raw source.

### Terminal 3 — `npm run pay`

```bash
npm run pay
```
OR

```bash
npx tsx scripts/pay
```

**This is the demo.** Watch the console while it runs.

What happens, and why each part matters:

1. **The envelope is signed.** Limits: 0.02 HBAR per call, 0.03 HBAR per hour.
   Allowlist: **empty**, on purpose — so every counterparty must earn its way
   through public reputation rather than being pre-approved.

2. **First payment clears** at `910/1000 over 3 clients`. Read that line
   carefully: the agent paid an account **its owner never listed**, because
   three independent parties left verifiable feedback in an on-chain registry.

3. **Second and third clear**, exhausting the hourly budget.

4. **The fourth is refused** — `WINDOW_EXHAUSTED`, blocked _before_ any
   transaction is built. Not a rejected payment; a payment that never existed.

5. **The replay reconciles.** The script rebuilds spend from scratch by reading
   the topic through a mirror node and compares it to what the agent believes
   it spent:

   ```
   spend from log  0.0300 HBAR
   paid requests   3  (0.0300 HBAR)
   reconciles      YES
   ```

   The left figure is computable by a stranger without trusting us. When they
   match, the audit trail _is_ the system's memory, not a log kept beside it.

6. **A HashScan link** to the topic. Your denials sit on a public ledger,
   permanently.

---

## Part 4 — Optional, for depth

### `npm run check:reputation`

```bash
npm run check:reputation 0.0.10272951
```

**What it proves:** live reputation for a counterparty, and what the policy
would decide against it. Pass the **account id** rather than the agent id — that
is the string x402 actually hands the guard, so it exercises the whole
resolution chain: account → EVM address → `getAgentWallet` verification →
`getClients` → `getSummary`.

It also prints latency and re-runs the query through `guarded()` with a
timeout. That number matters: the lookup sits on the payment path, and if a
registry read exceeds the budget, every reputation-gated payment fails closed.

**Why two contract calls rather than log scanning:** we originally scanned
`NewFeedback` logs, believing `getSummary()` could not aggregate without
knowing the client list. `getClients(agentId)` returns exactly that list. The
mirror node made the mistake expensive rather than merely inelegant — a topic
filter there requires a closed timestamp range of at most seven days, so
scanning a registry deployed months ago meant roughly thirty windowed queries
per lookup.

### `npm run receipts:live`

```bash
npm run receipts:live
```

Writes receipts to HCS and replays them, without involving x402 or the service.
Useful for isolating the receipt layer when something breaks further up.

### `npx tsx scripts/ledger-check.ts`

Connects to a Ledger via Speculos and prints the device address. **This does
not currently run** — see the README's "hardware trust root: implemented,
unverified" section. Ledger's own Ethereum app does not build against their own
SDK, so there is no binary for the emulator to run.

---

## Command reference

| Command                    | Device/network needed | Purpose                              |
| -------------------------- | --------------------- | ------------------------------------ |
| `npm install`              | no                    | dependencies                         |
| `npm run check`            | no                    | typecheck + 94 tests                 |
| `npm run demo`             | no                    | nine scenarios, offline              |
| `npm run key:owner`        | no                    | generate the human's key             |
| `npm run topic:create`     | Hedera                | create the receipt topic             |
| `npm run x402:check`       | internet              | verify facilitator + fee payer       |
| `npm run seed:reputation`  | Hedera                | register agent, seed 3 reviews       |
| `npm run doctor`           | internet              | validate the whole environment       |
| `npm run service`          | Hedera                | the x402-gated endpoint              |
| `npm run pay`              | Hedera                | **the demo**                         |
| `npm run console`          | internet              | the statement UI                     |
| `npm run check:reputation` | internet              | live reputation for one counterparty |
| `npm run receipts:live`    | Hedera                | receipts layer in isolation          |

---

## If something fails

Run `npm run doctor` first — it catches most misconfiguration in one pass.

| Symptom                                  | Cause                                                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEDERA_PRIVATE_KEY could not be parsed` | truncated paste; use the portal's copy button, not the visible text                                                                                       |
| Service returns 500, not 402             | facilitator unreachable — `npm run x402:check`                                                                                                            |
| Every payment `UNREADABLE_REQUIREMENTS`  | `guard.ts` and `guard.test.ts` out of sync on the requirements shape                                                                                      |
| Reputation always `NO_HISTORY`           | `SERVICE_AGENT_ID` missing, or the agent is bound to the wrong account — the on-chain `getAgentWallet` check rejects a stale hint rather than trusting it |
| Transfer rejected at consensus           | `X402_PAY_TO` equals `HEDERA_ACCOUNT_ID`; an account cannot appear twice in one transfer                                                                  |

For a full run with stack traces:

```bash
DEBUG=1 npm run pay
```
