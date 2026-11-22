import type { HttpTransport } from "./http-proxy";

export interface Env {
  DB: D1Database;
  APP_PAIR_RATE_LIMIT: RateLimit;
  ADMIN_TOKEN: string;
  V2EX_COOKIE?: string;
  V2EX_PAT?: string;
  NOTIFIER_KEY?: string;
  PUSH_SERVICE?: Fetcher;
  outbound?: HttpTransport;
}

export type UpstreamFetch = typeof fetch;

export const MAX_BODY = 1024 * 1024;
export const FREE = {
  requests: 100_000,
  rowsRead: 5_000_000,
  rowsWritten: 100_000,
  databaseBytes: 500_000_000,
  cpuMs: 10,
};
