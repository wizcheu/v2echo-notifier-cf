import { bindings, defineConfig, triggers } from "cf/config";
import { readDeployment } from "./deployment-config.ts";

const deployment = process.env.RELEASE_BUILD === "1" ? undefined : readDeployment();

export default defineConfig(({ mode }) => ({
  accountId: deployment?.accountId,
  worker: {
    name: deployment?.workerName ?? "v2echo-notifier-cf",
    entrypoint: "./worker/index.ts",
    compatibilityDate: "2026-10-19",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: !deployment?.domain,
    previewUrls: false,
    ...(deployment?.domain ? { domains: [deployment.domain] } : {}),
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
    env: {
      ...(mode !== "development" && deployment?.pushService
        ? { PUSH_SERVICE: bindings.worker({ worker: deployment.pushService }) }
        : {}),
      DB: bindings.d1({
        name: deployment?.workerName ?? "v2echo-notifier-cf",
        id:
          mode === "development" ? "00000000-0000-4000-8000-000000000001"
            : deployment?.databaseId ?? "00000000-0000-4000-8000-000000000001",
      }),
      APP_PAIR_RATE_LIMIT: bindings.rateLimit({ namespace: "4001", simple: { limit: 20, period: 60 } }),
      ADMIN_TOKEN: bindings.secret(),
      NOTIFIER_KEY: bindings.secret(),
    },
    triggers: [triggers.scheduled({ schedule: "* * * * *" })],
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, headSamplingRate: 1 },
      traces: { enabled: true, headSamplingRate: 0.01 },
    },
  },
}));
