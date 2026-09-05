import express, { type Express, type Request, type Response } from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";

import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { HBAR_ASSET_ID, HEDERA_TESTNET_CAIP2 } from "@x402/hedera";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { analyze } from "./analyze.js";

export interface ServiceConfig {
  payTo: string;
  facilitatorUrl: string;

  feePayer: string;
  priceTinybar: bigint;
  network?: string;
}

export function createService(cfg: ServiceConfig): Express {
  const app = express();
  const network = (cfg.network ?? HEDERA_TESTNET_CAIP2) as Network;

  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: "allowance-inference",
      network,
      payTo: cfg.payTo,
      priceTinybar: cfg.priceTinybar.toString(),
    });
  });

  const facilitator = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });

  app.use(
    paymentMiddlewareFromConfig(
      {
        "GET /v1/analyze": {
          accepts: {
            scheme: "exact",
            network,
            payTo: cfg.payTo,
            // AssetAmount: atomic units as a string, asset as an id.
            // Tinybars for HBAR; 0.0.0 is HBAR's asset id.
            price: {
              asset: HBAR_ASSET_ID,
              amount: cfg.priceTinybar.toString(),
            },
            extra: { feePayer: cfg.feePayer },
            maxTimeoutSeconds: 60,
          },
          description: "Sentiment and salience analysis, priced per call",
          mimeType: "application/json",
          serviceName: "allowance-inference",
        },
      },
      facilitator,
      [{ network, server: new ExactHederaScheme() }],
    ),
  );

  app.get("/v1/analyze", (req: Request, res: Response) => {
    const text = String(req.query.text ?? "");
    if (!text) {
      res.status(400).json({ error: "text query parameter is required" });
      return;
    }
    res.json({ ...analyze(text), pricedIn: "HBAR" });
  });

  return app;
}
