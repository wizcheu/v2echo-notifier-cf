import { afterEach, beforeEach, expect, it, vi } from "vitest";

const token = "synthetic-browser-session-".repeat(3);
const credentials = {
  cookie: true,
  pat: true,
  source: "settings",
  updated_at: 1,
};
const account = {
  id: 1,
  account_id: 123,
  username: "alice",
  enabled: 1,
  blocked: "",
  binding_id: "binding-a",
  paired_at: 1,
  credentials,
};
const snapshot = { now: 123, daily: [], notifier: account, credentials };
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const sessionKey = "v2echo-cf-session";
const store = async () => (await import("../src/lib/api")).useStore;
let browserHasCookie = false;

beforeEach(() => {
  vi.resetModules();
  browserHasCookie = false;
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options?: RequestInit) => {
      expect(options?.credentials).toBe("same-origin");
      expect(options?.headers).not.toHaveProperty("Authorization");
      if (path === "/api/login") {
        expect(options?.method).toBe("POST");
        expect(JSON.parse(options?.body as string)).toEqual({ token });
        browserHasCookie = true;
        return Response.json({ authenticated: true });
      }
      if (path === "/api/logout") {
        expect(options?.method).toBe("POST");
        browserHasCookie = false;
        return Response.json({ authenticated: false });
      }
      if (!browserHasCookie)
        return Response.json({ error: "登录已过期" }, { status: 401 });
      if (path === "/api/accounts")
        return Response.json({
          accounts: [account],
          legacy_credentials_available: false,
        });
      if (path === "/api/accounts/1/state") return Response.json(snapshot);
      throw new Error(`Unexpected request ${path}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

it("restores the cookie session after reopening the browser without storing the admin key", async () => {
  let current = await store();
  await current.getState().refresh();
  expect(current.getState()).toMatchObject({ auth: "anonymous", error: "" });
  await current.getState().login(token);
  expect(current.getState()).toMatchObject({
    auth: "authenticated",
    data: snapshot,
    busy: false,
  });
  expect(sessionStorage.getItem(sessionKey)).toBeNull();
  expect(JSON.stringify(current.getState())).not.toContain(token);
  expect(localStorage.getItem("v2echo-cf-ui")).toBeNull();

  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.resetModules();
  current = await store();
  expect(current.getState()).toMatchObject({ auth: "checking", data: null });
  await current.getState().refresh();
  expect(current.getState()).toMatchObject({
    auth: "authenticated",
    data: snapshot,
    busy: false,
  });
  expect(
    vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/login"),
  ).toHaveLength(1);
});

it("keeps the current dashboard and session on a failed refresh, then recovers", async () => {
  const current = await store();
  await current.getState().login(token);
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Network unavailable"));
  await current.getState().refresh();
  expect(current.getState()).toMatchObject({
    auth: "authenticated",
    data: snapshot,
    error: "Network unavailable",
    busy: false,
  });
  await current.getState().refresh();
  expect(current.getState().error).toBe("");
});

it.each(["refresh", "action"] as const)(
  "returns to login when %s receives a 401",
  async (operation) => {
    const current = await store();
    await current.getState().login(token);
    browserHasCookie = false;
    if (operation === "refresh") await current.getState().refresh();
    else await current.getState().action("/notifier/tick", "POST");
    expect(current.getState()).toMatchObject({
      auth: "anonymous",
      data: null,
      error: "登录已过期",
      busy: false,
    });
    await current.getState().login(token);
    expect(current.getState().auth).toBe("authenticated");
  },
);

it("waits for a test's bounded lookup and first delivery without aborting or retrying at 35 seconds", async () => {
  const current = await store();
  await current.getState().login(token);
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  try {
    vi.mocked(fetch).mockImplementationOnce(
      (_path, init) =>
        new Promise((resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("request timed out")),
          );
          setTimeout(
            () => resolve(Response.json({ reason: "已提交推送服务" })),
            60_000,
          );
        }),
    );
    const pending = current
      .getState()
      .action("/notifier/test", "POST", { kind: "reply" });
    await vi.advanceTimersByTimeAsync(36_000);
    expect(current.getState()).toMatchObject({ busy: true, error: "" });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(await pending).toBe(true);
    expect(current.getState()).toMatchObject({
      busy: false,
      error: "",
      message: "已提交推送服务",
    });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([path]) => path === "/api/accounts/1/notifier/test",
        ),
    ).toHaveLength(1);
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

it.each([200, 401])(
  "ignores a stale %s response after logout and a new login",
  async (status) => {
    const current = await store();
    await current.getState().login(token);
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = current.getState().refresh();
    await current.getState().logout();
    expect(current.getState()).toMatchObject({
      auth: "anonymous",
      data: null,
      busy: false,
    });
    expect(browserHasCookie).toBe(false);
    await current.getState().login(token);
    resolve(
      Response.json(
        status === 200
          ? { ...snapshot, now: 999 }
          : { error: "old session expired" },
        { status },
      ),
    );
    await pending;
    expect(current.getState()).toMatchObject({
      auth: "authenticated",
      data: snapshot,
      error: "",
      busy: false,
    });
  },
);

it("stays logged out after reopening and does not claim logout succeeded on network failure", async () => {
  let current = await store();
  await current.getState().login(token);
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Network unavailable"));
  await current.getState().logout();
  expect(current.getState()).toMatchObject({
    auth: "authenticated",
    data: snapshot,
    error: "Network unavailable",
  });
  expect(browserHasCookie).toBe(true);
  await current.getState().logout();
  expect(browserHasCookie).toBe(false);
  vi.resetModules();
  current = await store();
  await current.getState().refresh();
  expect(current.getState()).toMatchObject({
    auth: "anonymous",
    data: null,
    busy: false,
  });
});

it("removes an old raw admin key and rejects a failed login without saving it", async () => {
  sessionStorage.setItem(sessionKey, token);
  const current = await store();
  expect(sessionStorage.getItem(sessionKey)).toBeNull();
  await current.getState().refresh();
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ error: "管理密钥无效" }, { status: 401 }),
  );
  await current.getState().login(token);
  expect(current.getState()).toMatchObject({
    auth: "anonymous",
    data: null,
    busy: false,
    error: "管理密钥无效",
  });
  expect(JSON.stringify(current.getState())).not.toContain(token);
  expect(sessionStorage.getItem(sessionKey)).toBeNull();
});

it("can sign in when the browser disallows session storage", async () => {
  vi.stubGlobal("sessionStorage", {
    removeItem: () => {
      throw new Error("storage unavailable");
    },
  });
  const current = await store();
  await current.getState().login(token);
  expect(current.getState()).toMatchObject({
    auth: "authenticated",
    data: snapshot,
    busy: false,
  });
});

it("discards preferences saved by the previous custom UI store", async () => {
  localStorage.setItem(
    "v2echo-cf-ui",
    JSON.stringify({
      state: {
        dark: true,
        token,
        auth: "authenticated",
        order: ["home"],
        selected: "home",
      },
      version: 0,
    }),
  );
  const current = await store();
  expect(current.getState()).toMatchObject({ auth: "checking" });
  expect(current.getState()).not.toHaveProperty("token");
  expect(current.getState()).not.toHaveProperty("dark");
  expect(current.getState()).not.toHaveProperty("themeMode");
  expect(current.getState()).not.toHaveProperty("order");
  expect(current.getState()).not.toHaveProperty("selected");
  expect(localStorage.getItem("v2echo-cf-ui")).toBeNull();
});

it("returns QR results without saving them in browser storage", async () => {
  const current = await store();
  await current.getState().login(token);
  const invitation = {
    code: "V2N-" + "a".repeat(24),
    direct: true,
    expires_at: 123456,
  };
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(invitation));
  const { performAction } = await import("../src/lib/api");
  expect(await performAction("/notifier/pair/qr", "POST", {})).toEqual(
    invitation,
  );
  expect(current.getState().busy).toBe(false);
  expect(JSON.stringify(current.getState())).not.toContain(invitation.code);
  expect(localStorage.getItem("v2echo-cf-ui")).toBeNull();
  expect(sessionStorage.getItem(sessionKey)).toBeNull();
});

it("preserves a successful pairing result when only its following state refresh fails", async () => {
  const current = await store();
  await current.getState().login(token);
  vi.mocked(fetch).mockClear();
  const result = { paired: true, reason: "paired" };
  vi.mocked(fetch)
    .mockResolvedValueOnce(Response.json(result))
    .mockRejectedValueOnce(new TypeError("Offline"));
  const { performAction } = await import("../src/lib/api");
  expect(
    await performAction("/notifier/transfer/complete", "POST", {
      code: "synthetic",
    }),
  ).toEqual(result);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(current.getState()).toMatchObject({
    busy: false,
    data: snapshot,
    message: "paired",
    error: "操作已完成，但状态刷新失败，请手动刷新。",
  });
});

it("refreshes a failed pairing's persisted cooldown without retrying the operation", async () => {
  const current = await store();
  await current.getState().login(token);
  vi.mocked(fetch).mockClear();
  const cooled = { ...snapshot, notifier: { pair_until: 999999 } };
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      Response.json({ error: "请稍后重试" }, { status: 409 }),
    )
    .mockResolvedValueOnce(Response.json(cooled));
  const { performAction } = await import("../src/lib/api");
  expect(await performAction("/notifier/pair/qr", "POST", {})).toBeNull();
  expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual([
    "/api/accounts/1/notifier/pair/qr",
    "/api/accounts/1/state",
  ]);
  expect(current.getState()).toMatchObject({
    busy: false,
    data: cooled,
    error: "请稍后重试",
  });
});

it("discards a late QR response after logout and does not refresh the new session", async () => {
  const current = await store();
  await current.getState().login(token);
  let resolve!: (response: Response) => void;
  vi.mocked(fetch).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const { performAction } = await import("../src/lib/api");
  const pending = performAction("/notifier/pair/qr", "POST", {});
  await current.getState().logout();
  await current.getState().login(token);
  vi.mocked(fetch).mockClear();
  resolve(Response.json({ code: "private-short-lived-code" }));
  expect(await pending).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(current.getState()).toMatchObject({
    auth: "authenticated",
    data: snapshot,
    busy: false,
    error: "",
  });
});
