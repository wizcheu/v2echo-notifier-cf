export class Database {
  rowsRead = 0;
  rowsWritten = 0;
  queries = 0;
  size = 0;
  outbound = 0;
  apiRequests = 0;
  bytes = 0;
  constructor(readonly binding: D1Database) {}
  statement(sql: string, ...args: (string | number | null)[]) {
    return this.binding.prepare(sql).bind(...args);
  }
  record<T>(result: D1Result<T>) {
    this.queries++;
    this.rowsRead += result.meta.rows_read ?? 0;
    this.rowsWritten += result.meta.rows_written ?? 0;
    this.size = Math.max(this.size, result.meta.size_after ?? 0);
    return result;
  }
  async all<T>(sql: string, ...args: (string | number | null)[]) {
    return this.record(await this.statement(sql, ...args).all<T>()).results;
  }
  async one<T>(sql: string, ...args: (string | number | null)[]) {
    return (await this.all<T>(sql, ...args))[0];
  }
  async run(sql: string, ...args: (string | number | null)[]) {
    return this.record(await this.statement(sql, ...args).run());
  }
  async batch(statements: D1PreparedStatement[]) {
    return (await this.binding.batch(statements)).map((r) => this.record(r));
  }
  async flush(source: "http" | "cron", now = Date.now()) {
    // This accounting write cannot recursively account for itself. It and failed invocations
    // are deliberately excluded: dashboard values are a measured lower bound, not billing.
    await this.statement(
      `INSERT INTO daily(day,invocations,http,cron,outbound,rows_read,rows_written,queries,bytes,database_bytes)
      VALUES(?,1,?,?,?,?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET
      invocations=invocations+1,http=http+excluded.http,cron=cron+excluded.cron,outbound=outbound+excluded.outbound,
      rows_read=rows_read+excluded.rows_read,rows_written=rows_written+excluded.rows_written,
      queries=queries+excluded.queries,bytes=bytes+excluded.bytes,database_bytes=MAX(database_bytes,excluded.database_bytes)`,
      new Date(now).toISOString().slice(0, 10),
      source === "http" ? 1 : 0,
      source === "cron" ? 1 : 0,
      this.outbound,
      this.rowsRead,
      this.rowsWritten,
      this.queries,
      this.bytes,
      this.size,
    ).run();
  }
}
