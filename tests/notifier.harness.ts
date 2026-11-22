import app from "../worker/index";
import { Database } from "../worker/db";
import { Context, locked } from "../worker/notifier/context";
import { encryptContent, open, randomToken, seal } from "../worker/notifier/crypto";
import { savePairing } from "../worker/notifier/pairing";
import { pairNotifierApp } from "../worker/notifier/watch-local";
import { watchStep } from "../worker/notifier/watch-scanner";
import { syncWatches, watchState } from "../worker/notifier/watch-config";
import { notifierAction, notifierState, notifierTick, eventContent } from "../worker/notifier";
import { scanStep } from "../worker/notifier/scan";
import { relayStep } from "../worker/notifier/relay";
import { presentation } from "../worker/notifier/presentation";
import { queueTestNotification } from "../worker/notifier/test-notifications";
import { NotifierError } from "../worker/notifier/model";
import type { Env } from "../worker/types";
export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
      if (request.headers.has("X-Test-Deny-App-Pair")) {
        return app.fetch(request, { ...env, DB: {} as D1Database,
          APP_PAIR_RATE_LIMIT: { limit: async () => ({ success: false }) } });
      }
      return app.fetch(request, env);
    }
    // Injected relay responses belong to individual tests, not the native binding fixture.
    const data = (await request.json()) as any;
    env = { ...env, ...data.env, PUSH_SERVICE: undefined };
    const db = new Database(env.DB),
      calls: any[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: Object.fromEntries(new Headers(init.headers)),
        body: init.body ? JSON.parse(String(init.body)) : null,
        redirect: init.redirect,
      });
      const response = data.responses?.shift();
      if (!response || response.error)
        throw response?.error === "timeout"
          ? new DOMException("synthetic timeout", "TimeoutError")
          : new Error("synthetic network failure");
      if (response.delay)
        await new Promise((resolve) => setTimeout(resolve, response.delay));
      if (response.replaceLease)
        await db.run("UPDATE control SET lease='new-owner' WHERE id=1");
      if (response.replaceCredentials)
        await db.run(
          "UPDATE notifier_credentials SET payload=? WHERE id=1",
          response.replaceCredentials,
        );
      if (response.receiptStatus) {
        const sent = calls.at(-1).body;
        response.body = {
          retry_after_seconds: 30,
          receipts: [
            ...sent.events.map((e: any) => e.event_id),
            ...sent.receipts,
          ].map((event_id: string) => ({
            event_id,
            status: response.receiptStatus,
          })),
        };
      }
      return new Response(
        response.streamError
          ? new ReadableStream({
              start(controller) {
                controller.error(new Error("synthetic body failure"));
              },
            })
          : typeof response.body === "string"
            ? response.body
            : JSON.stringify(response.body),
        { status: response.status ?? 200, headers: response.headers },
      );
    }) as typeof fetch;
    try {
      let result: unknown;
      if (path === "/action")
        result = await notifierAction(
          db,
          { ...env, ...data.env },
          data.action,
          data.input ?? {},
          fetcher,
          data.now,
          data.accountID,
        );
      if (path === "/queue-test")
        result = await locked(
          db,
          { ...env, ...data.env },
          (c) => queueTestNotification(c, data.input?.kind),
          fetcher,
          data.now, false, data.accountID,
        );
      if (path === "/round")
        result = await notifierTick(
          db,
          { ...env, ...data.env },
          fetcher,
          data.now, data.accountID,
        );
      if (path === "/scan")
        result = await locked(db, env, scanStep, fetcher, data.now, false, data.accountID);
      if (path === "/notifier-state")
        result = await notifierState(db, env, data.now, data.accountID);
      if (path === "/pair-notifier") result = await locked(db, env, c => pairNotifierApp(c, data.input), fetcher, data.now, false, data.accountID);
      if (path === "/save-pairing") result = await locked(db, env, async c => {
        const { account_id, username } = await c.state();
        await savePairing(c, { sender: randomToken(), account: account_id, username },
          { paired: true, binding_id: data.binding, username });
      }, fetcher, data.now, false, data.accountID);
      if (path === "/watch") result = await locked(db, env, watchStep, fetcher, data.now, false, data.accountID);
      if (path === "/watch-sync") result = await locked(db, env, c => syncWatches(c, true), fetcher, data.now, false, data.accountID);
      if (path === "/watch-state") result = await watchState(db, env, data.accountID);
      if (path === "/open") result = await open(env, data.purpose, data.value);
      if (path === "/relay")
        result = await locked(db, env, relayStep, fetcher, data.now, false, data.accountID);
      if (path === "/seal") result = await seal(env, data.purpose, data.value);
      if (path === "/encrypt")
        result = await encryptContent(
          data.id,
          data.account,
          data.content,
          data.recipient,
        );
      if (path === "/presentation")
        result = presentation(data.notification, data.username);
      if (path === "/content") result = await eventContent(db, env, data.id, data.accountID);
      if (path === "/fence") {
        await db.run(
          "UPDATE control SET lease='old',lease_until=? WHERE id=1",
          Date.now() + 90000,
        );
        const c = new Context(db, env, "old");
        await db.run("UPDATE control SET lease='new' WHERE id=1");
        await c.save([
          c.sql("UPDATE notifier SET enabled=1 WHERE id=1"),
          c.sql("INSERT INTO notification_dedup VALUES(7,999,'bad')"),
        ]);
      }
      return Response.json({ result, calls });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : "unknown",
        status: error instanceof NotifierError ? error.status : 500,
        block: error instanceof NotifierError ? error.block : "",
        retryAt: error instanceof NotifierError ? error.retryAt : 0,
        calls,
      });
    }
  },
};
