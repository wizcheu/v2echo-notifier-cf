import { avatarURL } from "./notifier/presentation";

export class ParseError extends Error {
  constructor(readonly reason: "auth" | "parse" | "challenge") {
    super(reason);
  }
}
export const isChallenge = (html: string) =>
  /<title[^>]*>\s*(Just a moment|Attention Required)|id=["'](?:challenge-form|cf-challenge-running)["']|window\._cf_chl_opt\s*=/i.test(
    html,
  );
const path = (value: string | null) => {
  try {
    const u = new URL(value ?? "", "https://www.v2ex.com");
    return u.origin === "https://www.v2ex.com" ? u.pathname : "";
  } catch {
    return "";
  }
};
export async function digest(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}

/** Validate the signed-in homepage before using its unread count or account avatar. */
export async function parseHome(
  html: string,
  username: string,
  accountID?: number,
): Promise<{ unread: number; avatar_url: string }> {
  if (isChallenge(html)) throw new ParseError("challenge");
  const users: string[] = [];
  const expectedUsername = username.toLowerCase();
  let avatar = "",
    avatarLink = false,
    unread = "",
    unreadLinks = 0,
    main = false,
    hasTopic = false;
  const rewrite = new HTMLRewriter()
    .on("#Main", {
      element() {
        main = true;
      },
    })
    .on("a.top", {
      element(e) {
        const p = path(e.getAttribute("href"));
        if (/^\/member\//.test(p)) {
          try {
            users.push(decodeURIComponent(p.slice(8)));
          } catch {
            /* malformed member URL */
          }
        }
      },
    })
    .on("#Rightbar a", {
      element(e) {
        const p = path(e.getAttribute("href"));
        if (p === "/notifications") unreadLinks++;
        avatarLink = false;
        if (p.startsWith("/member/")) {
          try {
            avatarLink = decodeURIComponent(p.slice(8)).toLowerCase() === expectedUsername;
          } catch {
            /* malformed member URL */
          }
        }
        e.onEndTag(() => { avatarLink = false; });
      },
    })
    .on("#Rightbar a > img.avatar", {
      element(e) {
        if (avatar || !avatarLink) return;
        const alt = e.getAttribute("alt"), uid = e.getAttribute("data-uid");
        if (alt && alt.toLowerCase() !== expectedUsername) return;
        if (uid && accountID !== undefined && Number(uid) !== accountID) return;
        avatar = avatarURL(e.getAttribute("src") ?? "");
      },
    })
    .on("#Main .item_title a", {
      element(e) {
        const match = path(e.getAttribute("href")).match(/^\/t\/(\d+)$/);
        if (
          match &&
          Number.isSafeInteger(Number(match[1])) &&
          Number(match[1]) > 0
        )
          hasTopic = true;
      },
    });
  // Both relative server HTML and absolute browser-saved links are supported.
  rewrite.on(
    '#Rightbar a[href="/notifications"], #Rightbar a[href="https://www.v2ex.com/notifications"]',
    {
      text(t) {
        unread += t.text;
      },
    },
  );
  await rewrite.transform(new Response(html)).arrayBuffer();
  if (
    !username ||
    !users.some((u) => u.toLowerCase() === username.toLowerCase())
  )
    throw new ParseError("auth");
  if (!main || !hasTopic) throw new ParseError("parse");
  const match = unread
    .replace(/,/g, "")
    .match(/(\d+)\s*(?:未读提醒|unread notifications?)/i);
  if (!unreadLinks || !match) throw new ParseError("parse");
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count)) throw new ParseError("parse");
  return { unread: count, avatar_url: avatar };
}

export function parseMember(data: unknown) {
  const x = data as {
    success?: boolean;
    result?: { id?: number; username?: string };
  };
  if (
    !x ||
    x.success !== true ||
    !x.result ||
    !Number.isSafeInteger(x.result.id) ||
    x.result.id! <= 0 ||
    typeof x.result.username !== "string" ||
    !x.result.username.trim()
  )
    throw new ParseError("auth");
  return { id: x.result.id!, username: x.result.username.trim() };
}
