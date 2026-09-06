# Running Speculos (no physical Ledger required)

Speculos is Ledger's official open-source emulator. It runs a real Ethereum
app binary in an emulated environment and exposes it over HTTP — the exact
same DMK code that talks to real hardware talks to Speculos unchanged, just
with a different transport factory (`speculosTransportFactory` instead of
`webHidTransportFactory`).

This is not a shortcut we invented: Speculos is Ledger's own answer to "I
don't have a device." Other Ledger-track hackathon submissions have used it
the same way, explicitly noted as valid without physical hardware.

> **Correction from an earlier draft of this file:** it originally suggested
> looking for a pre-built app binary. There isn't a reliable one to grab —
> Speculos's own docs say plainly _"when in doubt, build from source — it is
> one Docker command."_ So that's the path below: one Docker command, not a
> download hunt. Recorded here as a reminder that this project checks rather
> than assumes, including when the assumption is our own.

## Prerequisites

- **Docker Desktop**, with WSL2 integration enabled (Windows) or just running
  (macOS/Linux). This replaces installing Python, a C toolchain, and every
  embedded-SDK dependency by hand — the Docker image ships all of it.
- **Python 3** on the host, for Speculos itself (the emulator runs on your
  machine; only the _build_ of the app happens inside Docker).

## 1. Install Speculos

```bash
# WSL (Ubuntu) on Windows, or a native shell on macOS/Linux
python3 -m venv ~/speculos-env
source ~/speculos-env/bin/activate
pip install speculos
```

## 2. Build the Ethereum app with Ledger's official Docker image

This is the "one Docker command" path — no local ARM toolchain, no manual
SDK setup.

```bash
git clone https://github.com/LedgerHQ/app-ethereum.git
cd app-ethereum

docker pull ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:latest

docker run --rm -it \
  -v "$(pwd):/app" \
  ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:latest \
  bash -c "cd /app && make -j BOLOS_SDK=\$NANOX_SDK"
```

That produces `bin/app.elf` inside the `app-ethereum` folder — the binary
Speculos will emulate. Building takes a few minutes; if it fails on a step
unrelated to what we're doing here (signing, deployment, packaging), that
step can usually be skipped — we only need the `.elf`, not a store-ready app.

## 3. Run Speculos against that binary

```bash
speculos --model nanox bin/app.elf
```

By default this exposes:

- **Port 5000** — the HTTP API `LedgerTrustRoot` talks to (`speculosUrl`,
  defaults to `http://127.0.0.1:5000`)
- **A web UI** at the same port showing the emulated device screen — this is
  what you watch to see the envelope fields rendered and to click the
  on-screen buttons that stand in for physical ones

## 4. Verify it's up before running anything else

```bash
curl http://127.0.0.1:5000/events
```

Any JSON response (even an empty event list) means Speculos is listening.
Nothing at all, or a connection refused, means the emulator did not start —
check its terminal output before touching the TypeScript side.

## 5. Then

```bash
npx tsx scripts/ledger-check.ts
```

Connects, fetches the device address, and stops there — the smallest
possible proof the whole chain works before we wire it into `pay.ts`.

## If Docker itself is the blocker

If Docker Desktop won't run in your environment, say so before spending more
time on it — there is a fallback (installing the ARM toolchain packages
directly, listed in Speculos's own README) but it is materially slower to
get right, and worth confirming is actually necessary before attempting.
