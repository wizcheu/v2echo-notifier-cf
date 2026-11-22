import { afterEach, expect, it, vi } from "vitest";
import { NotifierError } from "../worker/notifier/model";
import { pairingLog } from "../worker/notifier/pairing-log";

afterEach(() => vi.restoreAllMocks());

const event = (spy: { mock: { calls: unknown[][] } }) =>
  JSON.parse(String(spy.mock.calls[0]?.[0]));

it("logs one fixed event per pairing outcome", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await pairingLog(null, "qr", { join: true, direct: false }, async () => "ok", () => "已生成配对二维码，等待 App 扫码");
  expect(event(info)).toEqual({
    event: "pairing",
    action: "qr",
    result: "ok",
    join: true,
    direct: false,
  });
  await expect(
    pairingLog(null, "complete", {}, async () => {
      throw new NotifierError("二维码已失效", Date.now() + 5000, "", 410, 403);
    }, () => "配对确认成功"),
  ).rejects.toThrow("二维码已失效");
  expect(event(warn)).toEqual({
    event: "pairing",
    action: "complete",
    result: "error",
    status: 410,
    upstream: 403,
    retry_at: expect.any(Number),
  });
});

it("keeps only the enumerated WatchError code and the paired flag", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  class WatchError extends NotifierError {
    constructor(readonly code: string) {
      super("绑定失败", 0, "", 403);
    }
  }
  await expect(
    pairingLog(null, "app", {}, async () => {
      throw new WatchError("notifier_account_mismatch");
    }, () => "App 已连接助手"),
  ).rejects.toThrow("绑定失败");
  expect(event(warn)).toEqual({
    event: "pairing",
    action: "app",
    result: "error",
    status: 403,
    code: "notifier_account_mismatch",
  });
  await pairingLog(
    null,
    "complete",
    {},
    async () => ({ paired: false }),
    (result) => result.paired ? "配对确认成功" : "尚未收到 App 扫码请求",
    (result) => ({ paired: result.paired }),
  );
  expect(event(info)).toEqual({
    event: "pairing",
    action: "complete",
    result: "ok",
    paired: false,
  });
});
