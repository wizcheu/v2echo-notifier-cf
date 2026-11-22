export function retryAfter(value: string | null, now: number) {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  const at = Number.isFinite(seconds)
    ? now + Math.max(0, seconds) * 1000
    : Date.parse(value);
  return Number.isFinite(at) ? Math.max(now, at) : 0;
}

/** Only numeric quota metadata is retained; no tokens, headers, URLs or content. */
export function apiBudget(response: Response, now: number) {
  const numeric = (name: string) => {
    const raw =
      response.headers.get(`x-rate-limit-${name}`) ??
      response.headers.get(`x-ratelimit-${name}`);
    if (!raw?.trim()) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 && n <= 1e12 ? n : null;
  };
  const rawLimit = numeric("limit");
  const limit = rawLimit && rawLimit > 0 ? rawLimit : null;
  const remaining = numeric("remaining");
  const reset = numeric("reset");
  const resetAt = reset && reset < 1e10 ? reset * 1000 : null;
  const retryAt = Math.min(
    now + 48 * 3600000,
    retryAfter(response.headers.get("retry-after"), now),
  );
  const reserve =
    remaining !== null && remaining <= Math.max(10, (limit ?? 600) * 0.1);
  let until = retryAt;
  if (reserve)
    until = Math.max(
      until,
      resetAt && resetAt > now
        ? Math.min(resetAt, now + 48 * 3600000)
        : now + 3600000,
    );
  // Preserve the notifier's conservative fallback when the server cannot offer a usable reset.
  if (response.status === 429)
    until = Math.max(
      until,
      retryAt > now
        ? retryAt
        : resetAt && resetAt > now
          ? Math.min(resetAt, now + 48 * 3600000)
          : now + 3600000,
    );
  return {
    budget_limit: limit,
    remaining,
    reset_at: resetAt,
    retry_after_at: retryAt || null,
    backoff_until: until,
    backoff_reason:
      response.status === 429
        ? "http_429"
        : reserve
          ? "reserve"
          : retryAt > now
            ? "retry_after"
            : "",
  };
}
