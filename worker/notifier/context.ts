import { Database } from "../db";
import type { Env, UpstreamFetch } from "../types";
import { NotifierError, type Notifier } from "./model";
import { loadCredentialEnv } from "./credentials";

export class Context {
  private entered = Date.now();
  private credentialEnv?: Promise<Env>;
  constructor(
    readonly db: Database,
    readonly env: Env,
    readonly lease: string,
    // Keep the native global fetch receiver intact when called as c.fetcher().
    readonly fetcher: UpstreamFetch = (input, init) =>
      env.outbound ? env.outbound.fetch(input, init) : fetch(input, init),
    private epoch = Date.now(),
    readonly id = 1,
  ) {}
  get now() {
    return this.epoch + Date.now() - this.entered;
  }
  credentials() {
    // All scope checks and upstream requests in one lease share one snapshot.
    return this.credentialEnv ??= loadCredentialEnv(this.db, this.env, this.id);
  }
  withCredentials(cookie: string, pat: string) {
    const candidate = new Context(
      this.db,
      { ...this.env, V2EX_COOKIE: cookie, V2EX_PAT: pat },
      this.lease,
      this.fetcher,
      this.now,
      this.id,
    );
    candidate.credentialEnv = Promise.resolve(candidate.env);
    return candidate;
  }
  forAccount(id: number) {
    return new Context(this.db, this.env, this.lease, this.fetcher, this.now, id);
  }
  state() {
    return this.db.one<Notifier>("SELECT * FROM notifier WHERE id=?", this.id);
  }
  sql(sql: string, ...args: (string | number | null)[]) {
    return this.db.statement(sql, ...args);
  }
  async save(statements: D1PreparedStatement[]) {
    // D1 batch is transactional. The CHECK aborts *all* writes from a stale holder.
    return this.db.batch([
      this.sql(
        `INSERT INTO notifier_fence(id) VALUES(CASE WHEN EXISTS(SELECT 1 FROM control WHERE id=1 AND lease=? AND lease_until>?) THEN 1 ELSE 0 END) ON CONFLICT(id) DO NOTHING`,
        this.lease,
        this.now,
      ),
      ...statements,
    ]);
  }
  async update(sql: string, ...args: (string | number | null)[]) {
    await this.save([this.sql(sql, ...args)]);
  }
}
export async function locked<T>(
  db: Database,
  env: Env,
  job: (c: Context) => Promise<T>,
  fetcher?: UpstreamFetch,
  now = Date.now(),
  respectInterval = false,
  accountID = 1,
): Promise<T> {
  const lease = crypto.randomUUID();
  const result = await db.run(
    "UPDATE control SET lease=?,lease_until=? WHERE id=1 AND lease_until<=? AND (?=0 OR next_dispatch<=?)",
    lease,
    now + 90000,
    now,
    Number(respectInterval),
    now,
  );
  if (!result.meta.changes)
    throw new NotifierError("正在执行其他任务或处于请求间隔，请稍后刷新");
  const c = new Context(db, env, lease, fetcher, now, accountID);
  try {
    return await job(c);
  } finally {
    await db.run(
      "UPDATE control SET lease='',lease_until=0 WHERE id=1 AND lease=?",
      lease,
    );
  }
}
