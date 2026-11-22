import type {
  ApiUsageState,
  ApiUsageRecord,
  ApiUsageDay,
} from "../shared/contracts";
import type { Database } from "./db";
import type { UpstreamFetch } from "./types";
import { apiBudget } from "./api-budget";

export function withApiUsage(
  db: Database,
  fetcher: UpstreamFetch = (input, init) => fetch(input, init),
  clock = Date.now,
  onRecorded?: (id: string) => void,
  accountID = 1,
): UpstreamFetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const endpoint = ["/api/v2/member", "/api/members/show.json"].includes(
      url.pathname,
    )
      ? "member"
      : url.pathname === "/api/v2/notifications"
        ? "notifications"
        : null;
    if (url.origin !== "https://www.v2ex.com" || !endpoint)
      return fetcher(input, init);
    db.apiRequests++;
    const id = crypto.randomUUID(),
      at = clock();
    const day = new Date(at).toISOString().slice(0, 10);
    let recorded = false;
    try {
      await db.batch([
        db.statement(
          "INSERT INTO api_usage(id,source,endpoint,attempted_at,notifier_id) VALUES(?,?,?,?,?)",
          id,
          "notifier",
          endpoint,
          at, accountID,
        ),
        db.statement(
          `INSERT INTO api_daily(day,source,endpoint,attempts,notifier_id) VALUES(?,?,?,1,?)
          ON CONFLICT(notifier_id,day,source,endpoint) DO UPDATE SET attempts=attempts+1`,
          day,
          "notifier",
          endpoint, accountID,
        ),
      ]);
      recorded = true;
      onRecorded?.(id);
    } catch {
      console.error(JSON.stringify({ event: "api_usage_write_failed" }));
    }
    let response: Response | undefined;
    try {
      response = await fetcher(input, init);
      return response;
    } finally {
      if (recorded) {
        const finished = clock(),
          budget = response ? apiBudget(response, finished) : null;
        try {
          await db.batch([
            db.statement(
              `UPDATE api_usage SET finished_at=?,status=?,network_error=?,budget_limit=?,remaining=?,reset_at=?,retry_after_at=?,backoff_until=?,backoff_reason=? WHERE id=?`,
              finished,
              response?.status ?? null,
              Number(!response),
              budget?.budget_limit ?? null,
              budget?.remaining ?? null,
              budget?.reset_at ?? null,
              budget?.retry_after_at ?? null,
              budget?.backoff_until ?? 0,
              budget?.backoff_reason ?? "",
              id,
            ),
            db.statement(
              `UPDATE api_daily SET responses=responses+?,http_errors=http_errors+?,network_errors=network_errors+?,rate_limited=rate_limited+? WHERE day=? AND source=? AND endpoint=? AND notifier_id=?`,
              Number(!!response),
              Number(!!response && !response.ok),
              Number(!response),
              Number(response?.status === 429),
              day,
              "notifier",
              endpoint, accountID,
            ),
          ]);
        } catch {
          console.error(JSON.stringify({ event: "api_usage_write_failed" }));
        }
      }
    }
  };
}

/** Attach the actual cooldown after the bounded body has identified an access denial. */
export async function recordApiBackoff(
  db: Database,
  id: string | undefined,
  until: number,
  reason: "http_403" | "access_restricted",
) {
  if (!id) return;
  try {
    await db.run(
      "UPDATE api_usage SET backoff_until=MAX(backoff_until,?),backoff_reason=? WHERE id=?",
      until,
      reason,
      id,
    );
  } catch {
    console.error(JSON.stringify({ event: "api_usage_write_failed" }));
  }
}

export async function apiUsageState(
  db: Database,
  now = Date.now(),
  accountID = 1,
): Promise<ApiUsageState> {
  const [meta, daily, recent, latestBudget, backoff, hour] = await Promise.all([
    db.one<{ recording_since: number }>(
      "SELECT recording_since FROM api_usage_meta WHERE id=1",
    ),
    db.all<ApiUsageDay>(
      "SELECT day,endpoint,SUM(attempts) AS attempts,SUM(responses) AS responses,SUM(http_errors) AS http_errors,SUM(network_errors) AS network_errors,SUM(rate_limited) AS rate_limited FROM api_daily WHERE notifier_id=? GROUP BY day,endpoint ORDER BY day DESC,endpoint LIMIT 70", accountID,
    ),
    db.all<ApiUsageRecord>(
      "SELECT id,endpoint,attempted_at,finished_at,status,network_error,budget_limit,remaining,reset_at,retry_after_at,backoff_until,backoff_reason FROM api_usage WHERE notifier_id=? ORDER BY attempted_at DESC,id DESC LIMIT 20", accountID,
    ),
    db.one<ApiUsageRecord>(
      "SELECT id,endpoint,attempted_at,finished_at,status,network_error,budget_limit,remaining,reset_at,retry_after_at,backoff_until,backoff_reason FROM api_usage WHERE notifier_id=? AND (budget_limit IS NOT NULL OR remaining IS NOT NULL OR reset_at IS NOT NULL) ORDER BY attempted_at DESC,id DESC LIMIT 1", accountID,
    ),
    db.one<ApiUsageRecord>(
      "SELECT id,endpoint,attempted_at,finished_at,status,network_error,budget_limit,remaining,reset_at,retry_after_at,backoff_until,backoff_reason FROM api_usage WHERE notifier_id=? AND backoff_until>? ORDER BY backoff_until DESC,attempted_at DESC LIMIT 1",
      accountID, now,
    ),
    db.one<{ attempts: number }>(
      "SELECT COUNT(*) AS attempts FROM api_usage WHERE notifier_id=? AND attempted_at>=?",
      accountID, now - 3600000,
    ),
  ]);
  return {
    recording_since: meta.recording_since,
    daily,
    recent,
    latest_budget: latestBudget ?? null,
    active_backoff: backoff ?? null,
    hour_attempts: hour.attempts,
  };
}
