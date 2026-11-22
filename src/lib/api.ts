import { create } from "zustand";
import type {
  NotifierState,
  ApiUsageState,
  CredentialStatus,
  NotifierAccount,
  AccountsState,
} from "../../shared/contracts";
import { clearLegacySession } from "./session";
import type { HttpProxyStatus } from "../../shared/proxy-types";

clearLegacySession();

export interface Daily {
  day: string;
  invocations: number;
  http: number;
  cron: number;
  outbound: number;
  rows_read: number;
  rows_written: number;
  queries: number;
  bytes: number;
  database_bytes: number;
}
export interface State {
  version?: string;
  proxy: HttpProxyStatus;
  api_usage: ApiUsageState;
  notifier: NotifierState;
  now: number;
  control: {
    next_dispatch: number;
    api_until: number;
    web_until: number;
    lease_until: number;
  };
  daily: Daily[];
  credentials: CredentialStatus;
  limits: {
    requests: number;
    rowsRead: number;
    rowsWritten: number;
    databaseBytes: number;
    cpuMs: number;
  };
}
interface Store {
  auth: "checking" | "authenticated" | "anonymous";
  requestVersion: number;
  authPending: boolean;
  accounts: NotifierAccount[];
  accountsLoaded: boolean;
  accountsPending: boolean;
  selectedAccountId: number | null;
  data: State | null;
  proxy: HttpProxyStatus | null;
  error: string;
  message: string;
  busy: boolean;
  login: (token: string) => Promise<void>;
  refresh: () => Promise<void>;
  selectAccount: (id: number) => Promise<void>;
  addAccount: (cookie: string, pat: string) => Promise<boolean>;
  deleteAccount: (id: number) => Promise<boolean>;
  action: (path: string, method: string, body?: unknown) => Promise<boolean>;
  logout: () => Promise<void>;
}
class APIError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
async function send<T>(
  path: string,
  method = "GET",
  body?: unknown,
  operationPath = path,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      "X-Notifier-Request": "1",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // A test can read up to 100 samples and then attempt delivery in a fresh
    // lease. Give those bounded stages time to return the persisted result.
    signal: AbortSignal.timeout(
      operationPath === "/notifier/test"
        ? 150_000
        : [
              "/notifier/history",
              "/notifier/unread/refresh",
              "/notifier/watch/refresh",
            ].includes(operationPath)
          ? 90_000
          : 35_000,
    ),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = data.error ?? `请求失败 (${response.status})`;
    throw new APIError(message, response.status);
  }
  return data as T;
}

export async function request<T>(
  requestVersion: number,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const current = useStore.getState();
  // A version includes both the admin session and account selection. Check before
  // sending as well as after receiving so a stale continuation cannot mutate B.
  if (current.requestVersion !== requestVersion)
    throw new Error("账号或登录状态已变更");
  const scoped = path === "/state" || path.startsWith("/notifier/");
  if (scoped && current.selectedAccountId === null)
    throw new Error("请先选择账号");
  const target = scoped
    ? `/accounts/${current.selectedAccountId}${path}`
    : path;
  try {
    const result = await send<T>(target, method, body, path);
    if (useStore.getState().requestVersion !== requestVersion)
      throw new Error("账号或登录状态已变更");
    return result;
  } catch (error) {
    const current = useStore.getState();
    if (
      error instanceof APIError &&
      error.status === 401 &&
      current.requestVersion === requestVersion
    ) {
      useStore.setState({
        auth: "anonymous",
        requestVersion: requestVersion + 1,
        accounts: [],
        accountsLoaded: false,
        accountsPending: false,
        selectedAccountId: null,
        data: null,
        proxy: null,
        busy: false,
        authPending: false,
        message: "",
        error: current.auth === "checking" ? "" : error.message,
      });
    }
    throw error;
  }
}

function applySnapshot(data: State) {
  const current = useStore.getState();
  useStore.setState({
    data,
    proxy: data.proxy,
    accounts: current.accounts.map((account) =>
      account.id === current.selectedAccountId
        ? {
            ...account,
            account_id: data.notifier.account_id,
            username: data.notifier.username,
            avatar_url: data.notifier.avatar_url,
            enabled: data.notifier.enabled,
            blocked: data.notifier.blocked,
            paired_at: data.notifier.paired_at,
            binding_id: data.notifier.binding_id,
            credentials: data.credentials,
          }
        : account,
    ),
  });
}

async function refreshSnapshot(requestVersion: number) {
  if (useStore.getState().selectedAccountId === null) {
    const proxy = await request<HttpProxyStatus>(
      requestVersion,
      "/proxy-settings",
    );
    if (useStore.getState().requestVersion === requestVersion)
      useStore.setState({ proxy });
  } else {
    const data = await request<State>(requestVersion, "/state");
    if (useStore.getState().requestVersion === requestVersion)
      applySnapshot(data);
  }
}

async function loadAccount(id: number | null, message = "") {
  const requestVersion = useStore.getState().requestVersion + 1;
  // Clear the old view synchronously, including its mounted QR/forms/pagination.
  useStore.setState({
    requestVersion,
    selectedAccountId: id,
    data: null,
    error: "",
    message,
    busy: true,
    accountsPending: false,
  });
  try {
    await refreshSnapshot(requestVersion);
  } catch (e) {
    if (useStore.getState().requestVersion === requestVersion)
      useStore.setState({
        error: e instanceof Error ? e.message : "读取账号失败",
      });
  } finally {
    if (useStore.getState().requestVersion === requestVersion)
      useStore.setState({ busy: false });
  }
}

async function loadDashboard(
  requestVersion: number,
  preferredID?: number,
  message = "",
) {
  const result = await request<AccountsState>(requestVersion, "/accounts");
  if (useStore.getState().requestVersion !== requestVersion) return;
  useStore.setState({
    accounts: result.accounts,
    accountsLoaded: true,
    auth: "authenticated",
    ...(message ? { message } : {}),
  });
  const wanted = preferredID ?? useStore.getState().selectedAccountId;
  const id =
    result.accounts.find((account) => account.id === wanted)?.id ??
    result.accounts[0]?.id ??
    null;
  if (id !== useStore.getState().selectedAccountId) {
    await loadAccount(id, message);
  } else {
    await refreshSnapshot(requestVersion);
  }
}

/** One authenticated mutation followed by a state refresh; never automatically retries. */
export async function performAction<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T | null> {
  const current = useStore.getState();
  const requestVersion = current.requestVersion;
  if (current.auth !== "authenticated" || current.busy) return null;
  useStore.setState({ busy: true, error: "", message: "" });
  try {
    let result: T & { reason?: string };
    try {
      result = await request<T & { reason?: string }>(
        requestVersion,
        path,
        method,
        body,
      );
    } catch (e) {
      // Failed mutations may persist cooldowns; refresh them without retrying the mutation.
      if (useStore.getState().requestVersion === requestVersion) {
        try {
          await refreshSnapshot(requestVersion);
        } catch {
          /* Preserve the original operation error. */
        }
      }
      if (useStore.getState().requestVersion === requestVersion)
        useStore.setState({
          error: e instanceof Error ? e.message : "操作失败",
        });
      return null;
    }
    try {
      await refreshSnapshot(requestVersion);
    } catch {
      if (useStore.getState().requestVersion === requestVersion)
        useStore.setState({
          error: "操作已完成，但状态刷新失败，请手动刷新。",
        });
    }
    if (useStore.getState().requestVersion !== requestVersion) return null;
    useStore.setState({ message: result.reason ?? "操作已完成" });
    return result;
  } finally {
    if (useStore.getState().requestVersion === requestVersion)
      useStore.setState({ busy: false });
  }
}

export const useStore = create<Store>()(
    (set, get) => ({
      auth: "checking",
      requestVersion: 0,
      authPending: false,
      accounts: [],
      accountsLoaded: false,
      accountsPending: false,
      selectedAccountId: null,
      data: null,
      proxy: null,
      error: "",
      message: "",
      busy: false,
      login: async (token) => {
        if (get().busy) return;
        const requestVersion = get().requestVersion + 1;
        set({
          requestVersion,
          data: null,
          proxy: null,
          accounts: [],
          accountsLoaded: false,
          accountsPending: false,
          selectedAccountId: null,
          error: "",
          message: "",
          busy: true,
          authPending: true,
        });
        try {
          await send("/login", "POST", { token });
          if (get().requestVersion !== requestVersion) return;
          set({ auth: "authenticated", authPending: false });
          await loadDashboard(requestVersion);
        } catch (e) {
          if (get().requestVersion === requestVersion)
            set({ error: e instanceof Error ? e.message : "登录失败" });
        } finally {
          if (get().requestVersion === requestVersion)
            set({ busy: false, authPending: false });
        }
      },
      logout: async () => {
        if (get().authPending || get().accountsPending) return;
        const requestVersion = get().requestVersion + 1;
        set({
          requestVersion,
          error: "",
          message: "",
          busy: true,
          authPending: true,
        });
        try {
          await send("/logout", "POST");
          if (get().requestVersion === requestVersion)
            set({
              auth: "anonymous",
              data: null,
              proxy: null,
              accounts: [],
              accountsLoaded: false,
              accountsPending: false,
              selectedAccountId: null,
            });
        } catch (e) {
          if (get().requestVersion === requestVersion)
            set({ error: e instanceof Error ? e.message : "退出失败，请重试" });
        } finally {
          if (get().requestVersion === requestVersion)
            set({ busy: false, authPending: false });
        }
      },
      refresh: async () => {
        const requestVersion = get().requestVersion;
        if (get().auth === "anonymous" || get().busy) return;
        set({ busy: true, error: "" });
        try {
          await loadDashboard(requestVersion);
        } catch (e) {
          if (get().requestVersion === requestVersion) {
            set({ error: e instanceof Error ? e.message : "读取失败" });
          }
        } finally {
          if (get().requestVersion === requestVersion) set({ busy: false });
        }
      },
      selectAccount: async (id) => {
        const current = get();
        if (
          current.auth !== "authenticated" ||
          current.authPending ||
          current.accountsPending ||
          !current.accounts.some((account) => account.id === id) ||
          (id === current.selectedAccountId && current.data)
        )
          return;
        await loadAccount(id);
      },
      addAccount: async (cookie, pat) => {
        const { requestVersion, auth, busy } = get();
        if (auth !== "authenticated" || busy) return false;
        set({ busy: true, accountsPending: true, error: "", message: "" });
        let created = false;
        try {
          const result = await request<{ id: number; reason: string }>(
            requestVersion,
            "/accounts",
            "POST",
            { cookie, pat },
          );
          if (get().requestVersion !== requestVersion) return false;
          created = true;
          await loadDashboard(requestVersion, result.id, result.reason);
          return true;
        } catch (e) {
          if (get().requestVersion === requestVersion)
            set({
              error: created
                ? "账号已添加，但状态刷新失败，请手动刷新。"
                : e instanceof Error
                  ? e.message
                  : "添加账号失败",
            });
          return created;
        } finally {
          if (get().requestVersion === requestVersion)
            set({ busy: false, accountsPending: false });
        }
      },
      deleteAccount: async (id) => {
        const { auth, busy, selectedAccountId } = get();
        let requestVersion = get().requestVersion;
        if (auth !== "authenticated" || busy || id !== selectedAccountId)
          return false;
        set({ busy: true, accountsPending: true, error: "", message: "" });
        let removed = false;
        try {
          const result = await request<{ reason: string }>(
            requestVersion,
            `/accounts/${id}`,
            "DELETE",
          );
          if (get().requestVersion !== requestVersion) return false;
          removed = true;
          // The server has already removed this account. Never retain its forms
          // or credentials metadata if the following list refresh fails.
          requestVersion += 1;
          set({
            requestVersion,
            selectedAccountId: null,
            data: null,
            accounts: get().accounts.filter((account) => account.id !== id),
          });
          await loadDashboard(requestVersion, undefined, result.reason);
          return true;
        } catch (e) {
          if (!removed && get().requestVersion === requestVersion) {
            // A failed remote revocation leaves the account paused on the server.
            // Read that state once; never retry a destructive action implicitly.
            try {
              const data = await request<State>(requestVersion, "/state");
              if (get().requestVersion === requestVersion) applySnapshot(data);
            } catch {
              /* Keep the deletion error and allow an explicit refresh. */
            }
          }
          if (get().requestVersion === requestVersion)
            set({
              error: removed
                ? "账号已删除，但状态刷新失败，请手动刷新。"
                : e instanceof Error
                  ? e.message
                  : "删除账号失败",
            });
          return removed;
        } finally {
          if (get().requestVersion === requestVersion)
            set({ busy: false, accountsPending: false });
        }
      },
      action: async (path, method, body) =>
        (await performAction(path, method, body)) !== null,
    }),
);

export const time = (timestamp: number | null) =>
  timestamp
    ? new Date(timestamp).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "—";
export const format = (value: number) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
