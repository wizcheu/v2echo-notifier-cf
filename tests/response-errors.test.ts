import { describe, expect, it } from "vitest";
import { accessWaitMessage, responseDiagnostic } from "../worker/notifier/response-errors";

it("explains the pause and gives the next retry time in Beijing time across midnight", () => {
  const until = Date.parse("2026-11-12T15:59:59.500Z");
  expect(accessWaitMessage(false, until)).toBe(
    "V2EX 网页请求已暂停：上次访问受限或站点要求稍后重试；请在 11-13 00:00:00（北京时间）后再试",
  );
  expect(accessWaitMessage(true, until)).toContain("V2EX API 请求已暂停：上次访问受限、剩余请求额度较低或站点要求稍后重试");
});

describe("safe response diagnostics", () => {
  it("keeps the response category and validated Cloudflare trace ID", () => {
    const response = new Response("private body", {
      status: 403,
      headers: {
        "content-type": "application/problem+json; charset=utf-8",
        "cf-ray": "0123456789abcdef-SIN",
      },
    });
    expect(responseDiagnostic(response)).toBe(
      "（响应：JSON；Cloudflare 请求编号：0123456789abcdef-SIN）",
    );
  });
  it("does not echo arbitrary header values or upstream bodies", () => {
    const response = new Response("private body", {
      status: 403,
      headers: {
        "content-type": "private-secret",
        "cf-ray": "private-secret",
      },
    });
    expect(responseDiagnostic(response)).toBe("（响应：未知类型）");
    expect(
      responseDiagnostic(
        new Response(null, { headers: { "content-type": "text/html" } }),
      ),
    ).toBe("（响应：HTML）");
    expect(
      responseDiagnostic(
        new Response(null, { headers: { "content-type": "text/plain" } }),
      ),
    ).toBe("（响应：纯文本）");
  });
});
