import { isChallenge } from "../parsers";

export function accessWaitMessage(api: boolean, retryAt: number): string {
  const time = new Date(Math.ceil(retryAt / 1000) * 1000 + 8 * 3600000)
    .toISOString().slice(5, 19).replace("T", " ");
  const reason = api
    ? "上次访问受限、剩余请求额度较低或站点要求稍后重试"
    : "上次访问受限或站点要求稍后重试";
  return `V2EX ${api ? "API " : "网页"}请求已暂停：${reason}；请在 ${time}（北京时间）后再试`;
}

/** Bounded, allowlisted response metadata for tracing a rejected Worker request. */
export function responseDiagnostic(response: Response): string {
  const mime = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  const format =
    mime === "application/json" || mime === "application/problem+json"
      ? "JSON"
      : mime === "text/html"
        ? "HTML"
        : mime === "text/plain"
          ? "纯文本"
          : "未知类型";
  const ray = response.headers.get("cf-ray") ?? "";
  return `（响应：${format}${/^[0-9a-f]{16,32}(?:-[A-Z]{3,5})?$/i.test(ray) ? `；Cloudflare 请求编号：${ray}` : ""}）`;
}

export function errorObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* HTML and plain-text errors are handled without echoing their content. */
  }
}

/** Return only fixed diagnostic text and a numeric code, never upstream content. */
export function accessRestriction(
  response: Response,
  text: string,
): string | undefined {
  if (response.headers.get("cf-mitigated") === "challenge" || isChallenge(text))
    return "返回人机验证页";
  if (response.status !== 403) return;
  const problem = errorObject(text);
  const code =
    problem?.cloudflare_error === true
      ? problem.error_code
      : Number(
          text.match(
            /\b(?:error(?:\s+code)?\s*:?\s*)(10\d{2}|11\d{2})\b/i,
          )?.[1],
        );
  if (
    typeof code === "number" &&
    Number.isInteger(code) &&
    code >= 1000 &&
    code < 2000
  )
    return code === 1010
      ? "被 Cloudflare 拒绝访问（错误 1010，客户端特征被拦截）"
      : `被 Cloudflare 拒绝访问（错误 ${code}）`;
}

export function invalidPAT(text: string): boolean {
  const problem = errorObject(text);
  return (
    problem?.success === false &&
    typeof problem.message === "string" &&
    /\btoken\b/i.test(problem.message) &&
    /\b(expired|invalid|revoked)\b/i.test(problem.message)
  );
}
