import app from "../worker/index";
import { Database } from "../worker/db";
import { parseHome } from "../worker/parsers";
import { cookieHeader } from "../worker/notifier/http";
import { cleanup } from "../worker/maintenance";
import type { Env } from "../worker/types";

export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) return app.fetch(request, env);
    const data = (await request.json()) as any;
    try {
      if (path === "/parse")
        return Response.json({
          count: (await parseHome(data.html, data.username)).unread,
        });
      if (path === "/cookie")
        return Response.json({ value: cookieHeader(data.value) });
      if (path === "/cleanup") await cleanup(new Database(env.DB), data.now);
      else if (path === "/scheduled")
        await app.scheduled({} as ScheduledController, env);
      else return new Response("missing", { status: 404 });
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ error: (e as Error).message });
    }
  },
};
