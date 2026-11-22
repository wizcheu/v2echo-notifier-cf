import { existsSync, readFileSync } from "node:fs";

export interface DeploymentConfig {
  accountId: string;
  databaseId: string;
  workerName: string;
  domain?: string;
  pushService?: string;
}

export function validateDeployment(value: unknown): DeploymentConfig {
  const v = value as Partial<DeploymentConfig> | null;
  if (!v || typeof v !== "object" || Array.isArray(v) ||
      Object.keys(v).some(k => !["accountId", "databaseId", "workerName", "domain", "pushService"].includes(k)) ||
      !/^[a-f0-9]{32}$/.test(v.accountId ?? "") ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.databaseId ?? "") ||
      v.databaseId === "00000000-0000-4000-8000-000000000001" ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(v.workerName ?? "") ||
      (v.domain !== undefined && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(v.domain)) ||
      (v.pushService !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(v.pushService))) {
    throw new Error("部署配置无效；请按 deployment.example.json 填写自己的账号、D1 和 Worker，勿填写 Secrets。");
  }
  return v as DeploymentConfig;
}

export function readDeployment(): DeploymentConfig | undefined {
  const path = new URL("./deployment.local.json", import.meta.url);
  return existsSync(path) ? validateDeployment(JSON.parse(readFileSync(path, "utf8"))) : undefined;
}
