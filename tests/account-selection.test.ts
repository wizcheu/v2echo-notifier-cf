import { afterEach, beforeEach, expect, it, vi } from "vitest";

const credentials = {
  cookie: true,
  pat: true,
  source: "settings",
  updated_at: 1,
};
const account = (id: number) => ({
  id,
  account_id: id * 100,
  username: id === 1 ? "alice" : "bob",
  avatar_url: `https://cdn.v2ex.com/avatar/test/${id}_normal.png`,
  enabled: 1,
  blocked: "",
  paired_at: 10,
  binding_id: `binding-${id}`,
  credentials,
});
const snapshot = (id: number) => ({
  now: id,
  notifier: account(id),
  credentials,
  daily: [],
});
let accounts: ReturnType<typeof account>[];
const proxy = { enabled: false, configured: false, encryption_ready: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function api() {
  return import("../src/lib/api");
}
async function ready() {
  const { useStore } = await api();
  await useStore.getState().refresh();
  expect(useStore.getState().selectedAccountId).toBe(1);
  return useStore;
}

beforeEach(() => {
  vi.resetModules();
  accounts = [account(1), account(2)];
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      expect(init?.credentials).toBe("same-origin");
      if (path === "/api/accounts" && (!init?.method || init.method === "GET"))
        return Response.json({ accounts, legacy_credentials_available: false });
      if (path === "/api/proxy-settings" && init?.method === "GET")
        return Response.json(proxy);
      const state = path.match(/^\/api\/accounts\/(\d+)\/state$/);
      if (state) return Response.json(snapshot(Number(state[1])));
      throw new Error(`Unexpected request: ${init?.method} ${path}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

it("selects an explicit account and scopes every account request to it", async () => {
  const store = await ready();
  await store.getState().selectAccount(2);
  const { request } = await api();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ items: [] }));
  await request(store.getState().requestVersion, "/notifier/messages?limit=20");
  expect(vi.mocked(fetch).mock.lastCall?.[0]).toBe(
    "/api/accounts/2/notifier/messages?limit=20",
  );
  expect(store.getState().data).toEqual(snapshot(2));
  expect(store.getState().accounts.find((item) => item.id === 2)?.avatar_url).toBe(
    account(2).avatar_url,
  );
});

it.each([200, 401])(
  "discards an old account's late %s state response without affecting the selected account",
  async (status) => {
    const store = await ready();
    const pending = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    const selecting = store.getState().selectAccount(2);
    expect(store.getState().data).toBeNull();
    await store.getState().selectAccount(1);
    pending.resolve(
      Response.json(
        status === 200 ? snapshot(2) : { error: "old session expired" },
        { status },
      ),
    );
    await selecting;
    expect(store.getState()).toMatchObject({
      selectedAccountId: 1,
      data: snapshot(1),
      busy: false,
      error: "",
      auth: "authenticated",
    });
  },
);

it("cannot issue a stale request after A → B → A even though the selected id matches again", async () => {
  const store = await ready();
  const oldVersion = store.getState().requestVersion;
  await store.getState().selectAccount(2);
  await store.getState().selectAccount(1);
  vi.mocked(fetch).mockClear();
  const { request } = await api();
  await expect(
    request(oldVersion, "/notifier/events/old-event"),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("drops a pairing QR and its success message when the user switches accounts during generation", async () => {
  const store = await ready();
  const pending = deferred<Response>();
  vi.mocked(fetch).mockReturnValueOnce(pending.promise);
  const { performAction } = await api();
  const generating = performAction("/notifier/pair/qr", "POST", {});
  expect(vi.mocked(fetch).mock.lastCall?.[0]).toBe(
    "/api/accounts/1/notifier/pair/qr",
  );
  await store.getState().selectAccount(2);
  vi.mocked(fetch).mockClear();
  pending.resolve(
    Response.json({ code: "A-only-invitation", reason: "A ready" }),
  );
  expect(await generating).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(store.getState()).toMatchObject({
    selectedAccountId: 2,
    data: snapshot(2),
    message: "",
    busy: false,
  });
});

it("keeps global proxy actions outside account routes but refreshes only the initiating account", async () => {
  const store = await ready();
  await store.getState().selectAccount(2);
  vi.mocked(fetch).mockClear();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ reason: "saved" }));
  expect(
    await store.getState().action("/proxy-settings", "PUT", { enabled: false }),
  ).toBe(true);
  expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual([
    "/api/proxy-settings",
    "/api/accounts/2/state",
  ]);
});

it("supports an empty instance without falling back to legacy account 1", async () => {
  accounts = [];
  const { useStore, request } = await api();
  await useStore.getState().refresh();
  expect(useStore.getState()).toMatchObject({
    auth: "authenticated",
    accounts: [],
    selectedAccountId: null,
    data: null,
    accountsLoaded: true,
    busy: false,
  });
  vi.mocked(fetch).mockClear();
  await expect(
    request(useStore.getState().requestVersion, "/notifier/tick", "POST"),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps global proxy settings usable after deleting the last account", async () => {
  accounts = [account(1)];
  const store = await ready();
  vi.mocked(fetch).mockImplementationOnce(async () => {
    accounts = [];
    return Response.json({ reason: "账号已删除" });
  });
  expect(await store.getState().deleteAccount(1)).toBe(true);
  expect(store.getState()).toMatchObject({
    selectedAccountId: null,
    data: null,
    proxy,
  });
  vi.mocked(fetch).mockClear();
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ reason: "代理已关闭" }),
  );
  expect(
    await store.getState().action("/proxy-settings", "PUT", { enabled: false }),
  ).toBe(true);
  expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual([
    "/api/proxy-settings",
    "/api/proxy-settings",
  ]);
  expect(store.getState()).toMatchObject({
    message: "代理已关闭",
    error: "",
    busy: false,
  });
});

it("clears a removed selected account and loads a remaining account without showing the removed snapshot", async () => {
  const store = await ready();
  accounts = [account(2)];
  await store.getState().refresh();
  expect(store.getState()).toMatchObject({
    accounts,
    selectedAccountId: 2,
    data: snapshot(2),
    busy: false,
  });
});

it("does not show the previous account's data when loading another account fails", async () => {
  const store = await ready();
  vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
  await store.getState().selectAccount(2);
  expect(store.getState()).toMatchObject({
    selectedAccountId: 2,
    data: null,
    error: "offline",
    busy: false,
  });
  await store.getState().refresh();
  expect(store.getState().data).toEqual(snapshot(2));
});

it("creates an account only once and selects the server-verified result without persisting credentials", async () => {
  const store = await ready();
  const cookie = "A2=synthetic-new-cookie",
    pat = "synthetic-new-pat";
  accounts.push(account(3));
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ id: 3, reason: "账号已添加" }),
  );
  expect(await store.getState().addAccount(cookie, pat)).toBe(true);
  expect(store.getState()).toMatchObject({
    selectedAccountId: 3,
    data: snapshot(3),
    busy: false,
  });
  expect(
    vi
      .mocked(fetch)
      .mock.calls.filter(
        ([path, init]) => path === "/api/accounts" && init?.method === "POST",
      ),
  ).toHaveLength(1);
  expect(JSON.stringify(store.getState())).not.toContain(cookie);
  expect(localStorage.getItem("v2echo-cf-ui")).toBeNull();
});

it("does not remove the selected account when remote revocation fails", async () => {
  const store = await ready();
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ error: "撤销尚未完成" }, { status: 503 }),
  );
  expect(await store.getState().deleteAccount(1)).toBe(false);
  expect(store.getState()).toMatchObject({
    selectedAccountId: 1,
    data: snapshot(1),
    accounts,
    error: "撤销尚未完成",
    busy: false,
  });
});

it("deletes only the captured selected account and loads the remaining one", async () => {
  const store = await ready();
  vi.mocked(fetch).mockImplementationOnce(async (path, init) => {
    expect(path).toBe("/api/accounts/1");
    expect(init?.method).toBe("DELETE");
    accounts = [account(2)];
    return Response.json({ reason: "账号已删除" });
  });
  expect(await store.getState().deleteAccount(1)).toBe(true);
  expect(store.getState()).toMatchObject({
    selectedAccountId: 2,
    data: snapshot(2),
    accounts,
    busy: false,
  });
  expect(await store.getState().deleteAccount(1)).toBe(false);
});

it.each(["add", "delete"])(
  "keeps the account context until a pending %s commits and rejects duplicate mutations",
  async (operation) => {
    const store = await ready();
    const pending = deferred<Response>();
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    const mutation =
      operation === "add"
        ? store.getState().addAccount("A2=new-cookie", "new-pat")
        : store.getState().deleteAccount(1);
    await store.getState().selectAccount(2);
    await store.getState().logout();
    expect(
      await store.getState().addAccount("A2=duplicate", "duplicate-pat"),
    ).toBe(false);
    expect(await store.getState().deleteAccount(1)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      auth: "authenticated",
      selectedAccountId: 1,
      accountsPending: true,
    });
    accounts = operation === "add" ? [...accounts, account(3)] : [account(2)];
    pending.resolve(Response.json({ id: 3, reason: "已完成" }));
    expect(await mutation).toBe(true);
    expect(store.getState()).toMatchObject({
      selectedAccountId: operation === "add" ? 3 : 2,
      accountsPending: false,
      busy: false,
      message: "已完成",
    });
  },
);

it.each(["add", "delete"])(
  "reports a committed %s when the following account-list refresh fails without retrying it",
  async (operation) => {
    const store = await ready();
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ id: 3, reason: "已完成" }))
      .mockRejectedValueOnce(new Error("offline"));
    const committed =
      operation === "add"
        ? await store.getState().addAccount("A2=new-cookie", "new-pat")
        : await store.getState().deleteAccount(1);
    expect(committed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({
      accountsPending: false,
      busy: false,
      error:
        operation === "add"
          ? "账号已添加，但状态刷新失败，请手动刷新。"
          : "账号已删除，但状态刷新失败，请手动刷新。",
    });
    if (operation === "delete") {
      expect(store.getState()).toMatchObject({
        selectedAccountId: null,
        data: null,
      });
      expect(store.getState().accounts.map(({ id }) => id)).toEqual([2]);
    }
  },
);
