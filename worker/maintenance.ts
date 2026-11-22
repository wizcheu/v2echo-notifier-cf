import { Database } from "./db";

export async function cleanup(db: Database, now: number) {
  const control = await db.one<{ cleanup_at: number }>(
    "SELECT cleanup_at FROM control WHERE id=1",
  );
  if (control.cleanup_at > now) return;
  const claim = await db.run(
    "UPDATE control SET cleanup_at=? WHERE id=1 AND cleanup_at<=?",
    now + 3600_000,
    now,
  );
  if (!claim.meta.changes) return;
  await db.batch([
    db.statement(
      "DELETE FROM api_usage WHERE id IN (SELECT id FROM api_usage WHERE attempted_at<? ORDER BY attempted_at LIMIT 500)",
      now - 7 * 86400000,
    ),
    db.statement(
      "DELETE FROM api_usage WHERE id IN (SELECT id FROM api_usage ORDER BY attempted_at DESC LIMIT 500 OFFSET 5000)",
    ),
    db.statement(
      "DELETE FROM api_daily WHERE day<?",
      new Date(now - 35 * 86400000).toISOString().slice(0, 10),
    ),
    db.statement(
      "DELETE FROM daily WHERE day<?",
      new Date(now - 35 * 86400_000).toISOString().slice(0, 10),
    ),
  ]);
}
