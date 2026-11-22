import type { Context } from "./context";
import { NotifierError } from "./model";

export type PairingAction = "qr" | "complete" | "app" | "relay";
type RecordedAction = Exclude<PairingAction, "relay">;

const stages: Record<RecordedAction, string> = {
  qr: "pairing_qr",
  complete: "pairing_complete",
  app: "pairing_app",
};
const labels: Record<RecordedAction, string> = {
  qr: "生成二维码",
  complete: "确认连接",
  app: "App 连接",
};

/** Pairing is rare, so every outcome gets one fixed event. Only enumerated
 * status codes may leave the worker: never QR codes, secrets, senders or
 * account names. */
export function pairingEvent(
  action: PairingAction,
  result: "ok" | "error",
  context: Record<string, string | number | boolean> = {},
) {
  const line = JSON.stringify({ event: "pairing", action, result, ...context });
  if (result === "ok") console.info(line);
  else console.warn(line);
}

export function pairingError(
  error: unknown,
): Record<string, string | number> {
  if (!(error instanceof NotifierError)) return { status: 500 };
  // WatchError carries the stable error code the App switches on.
  const code = (error as { code?: unknown }).code;
  return {
    status: error.status,
    ...(error.upstreamStatus ? { upstream: error.upstreamStatus } : {}),
    ...(typeof code === "string" && code ? { code } : {}),
    ...(error.retryAt > 0 ? { retry_at: error.retryAt } : {}),
  };
}

/** Persist the same outcome the records page shows. The write must never
 * replace the pairing error itself, so failures are only counted. */
async function recordPairing(
  c: Context,
  action: RecordedAction,
  started: number,
  outcome: "ok" | "error",
  detail: string,
  requests: number,
  apiRequests: number,
) {
  try {
    await c.db.run(
      "INSERT INTO notification_checks(id,source,started_at,finished_at,outcome,stage_before,requests,api_requests,detail,notifier_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
      crypto.randomUUID(),
      "pairing",
      started,
      c.now,
      outcome,
      stages[action],
      c.db.outbound - requests,
      c.db.apiRequests - apiRequests,
      detail,
      c.id,
    );
  } catch {
    console.error(JSON.stringify({ event: "check_log_write_failed" }));
  }
}

export async function pairingLog<T>(
  c: Context | null,
  action: RecordedAction,
  context: Record<string, string | number | boolean>,
  job: () => Promise<T>,
  success: (result: T) => string,
  detail?: (result: T) => Record<string, string | number | boolean>,
): Promise<T> {
  // A nested step passes no context: it still logs, but the outer step owns
  // the single records row for the whole attempt.
  const started = c?.now ?? 0,
    requests = c?.db.outbound ?? 0,
    apiRequests = c?.db.apiRequests ?? 0;
  try {
    const result = await job();
    pairingEvent(action, "ok", { ...context, ...detail?.(result) });
    if (c)
      await recordPairing(c, action, started, "ok", success(result), requests, apiRequests);
    return result;
  } catch (error) {
    pairingEvent(action, "error", { ...context, ...pairingError(error) });
    if (c)
      await recordPairing(
        c,
        action,
        started,
        "error",
        `${labels[action]}失败：${error instanceof NotifierError ? error.message : "操作未完成"}`,
        requests,
        apiRequests,
      );
    throw error;
  }
}
