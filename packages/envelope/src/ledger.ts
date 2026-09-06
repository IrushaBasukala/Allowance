import {
  DeviceManagementKitBuilder,
  type DeviceManagementKit,
  type DiscoveredDevice,
} from "@ledgerhq/device-management-kit";
import { speculosTransportFactory } from "@ledgerhq/device-transport-kit-speculos";
import { webHidTransportFactory } from "@ledgerhq/device-transport-kit-web-hid";
import {
  SignerEthBuilder,
  type SignerEth,
} from "@ledgerhq/device-signer-kit-ethereum";
import { getAddress, type Address, type Hex } from "viem";
import {
  DEFAULT_DOMAIN,
  ENVELOPE_TYPES,
  type Envelope,
  type EnvelopeDomain,
  type TrustRoot,
} from "./types.js";

export type LedgerTransportMode = "speculos" | "usb";

export interface LedgerTrustRootOptions {
  transport?: LedgerTransportMode;
  speculosUrl?: string;
  derivationPath?: string;
}

export class LedgerTrustRoot implements TrustRoot {
  readonly kind: string;
  private dmk: DeviceManagementKit | null = null;
  private sessionId: string | undefined;
  private signer: SignerEth | null = null;
  private readonly derivationPath: string;

  constructor(private readonly opts: LedgerTrustRootOptions = {}) {
    const mode = opts.transport ?? "speculos";
    this.kind = `ledger-dmk:${mode}`;
    this.derivationPath = opts.derivationPath ?? "44'/60'/0'/0/0";
  }

  async connect(): Promise<void> {
    const mode = this.opts.transport ?? "speculos";

    const builder = new DeviceManagementKitBuilder();
    if (mode === "speculos") {
      builder.addTransport(
        speculosTransportFactory(
          this.opts.speculosUrl ?? "http://127.0.0.1:5000",
        ),
      );
    } else {
      builder.addTransport(webHidTransportFactory);
    }
    this.dmk = builder.build();

    const discovered = await firstDiscovered(this.dmk);
    try {
      this.sessionId = await this.dmk.connect({ device: discovered });
    } catch (err) {
      throw new Error(
        `Ledger connect failed (${this.kind}): ${err instanceof Error ? err.message : String(err)}\n` +
          (mode === "speculos"
            ? "  Is Speculos running? See scripts/ledger-speculos.md"
            : "  Is the device connected, unlocked, and on the Ethereum app?"),
      );
    }

    this.signer = new SignerEthBuilder({
      dmk: this.dmk,
      sessionId: this.sessionId,
    }).build();
  }

  async disconnect(): Promise<void> {
    if (this.dmk && this.sessionId) {
      await this.dmk.disconnect({ sessionId: this.sessionId });
    }
    this.dmk = null;
    this.sessionId = undefined;
    this.signer = null;
  }

  async address(): Promise<Address> {
    if (!this.signer) throw new Error("LedgerTrustRoot: call connect() first");
    const result = await runDeviceAction(
      this.signer.getAddress(this.derivationPath),
      "getAddress",
    );
    return getAddress(result.address);
  }

  async signEnvelope(
    envelope: Envelope,
    domain: EnvelopeDomain = DEFAULT_DOMAIN,
  ): Promise<Hex> {
    if (!this.signer) throw new Error("LedgerTrustRoot: call connect() first");

    const owner = await this.address();
    if (getAddress(envelope.principal) !== owner) {
      throw new Error(
        `Envelope names principal ${envelope.principal}, but the connected ` +
          `device controls ${owner} at ${this.derivationPath}. Refusing to sign.`,
      );
    }

    const result = await runDeviceAction(
      this.signer.signTypedData(this.derivationPath, {
        domain,
        types: ENVELOPE_TYPES as unknown as Record<
          string,
          Array<{ name: string; type: string }>
        >,
        primaryType: "Envelope",
        message: envelope as unknown as Record<string, unknown>,
      }),
      "signTypedData",
    );

    const v = result.v.toString(16).padStart(2, "0");
    return `${result.r}${result.s.slice(2)}${v}` as Hex;
  }

  async verify(
    envelope: Envelope,
    signature: Hex,
    domain: EnvelopeDomain = DEFAULT_DOMAIN,
  ): Promise<Address | null> {
    const { recoverTypedDataAddress } = await import("viem");
    try {
      const recovered = await recoverTypedDataAddress({
        domain,
        types: ENVELOPE_TYPES,
        primaryType: "Envelope",
        message: envelope,
        signature,
      });
      if (getAddress(recovered) !== getAddress(envelope.principal)) return null;
      return getAddress(recovered);
    } catch {
      return null;
    }
  }
}

function firstDiscovered(dmk: DeviceManagementKit): Promise<DiscoveredDevice> {
  return new Promise((resolve, reject) => {
    const sub = dmk.startDiscovering({}).subscribe({
      next: (device) => {
        sub.unsubscribe();
        resolve(device);
      },
      error: (err) => reject(err),
    });
    setTimeout(() => {
      sub.unsubscribe();
      reject(new Error("No Ledger device found within 5s of discovery."));
    }, 5000);
  });
}

function runDeviceAction<T>(
  action: {
    observable: import("rxjs").Observable<{
      status: string;
      output?: T;
      error?: unknown;
    }>;
  },
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const sub = action.observable.subscribe({
      next: (state) => {
        if (state.status === "completed" && state.output !== undefined) {
          sub.unsubscribe();
          resolve(state.output);
        } else if (state.status === "error") {
          sub.unsubscribe();
          reject(new Error(`${label} failed: ${JSON.stringify(state.error)}`));
        }
      },
      error: (err) => reject(err),
    });
  });
}
