import { parseDocument, DomUtils } from "htmlparser2";
import { excerpt } from "./crypto";
import { NotifierError, type Content, type NotificationKind } from "./model";
type Node = ReturnType<typeof parseDocument>["children"][number];
export interface Notification {
  id: number;
  for_member_id: number;
  created?: number;
  text: string;
  payload?: string | null;
  payload_rendered?: string;
  member?: {
    username?: string;
    avatar_large?: string;
    avatar_normal?: string;
    avatar_mini?: string;
  };
}
const compact = (s: string) => s.replace(/\s+/g, " ").trim();
const linkPath = (value: string) => {
  try {
    const u = new URL(value, "https://www.v2ex.com");
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.port &&
      (u.hostname === "v2ex.com" || u.hostname.endsWith(".v2ex.com"))
      ? u.pathname
      : "";
  } catch {
    return "";
  }
};
export function avatarURL(value = "") {
  if (value.length > 1024) return "";
  try {
    const u = new URL(value, "https://www.v2ex.com");
    if (u.protocol === "http:") u.protocol = "https:";
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      u.href.length <= 1024 &&
      (["v2ex.com", "www.v2ex.com", "cdn.v2ex.com"].includes(u.hostname) ||
        u.hostname.endsWith(".cdn.v2ex.com")) &&
      (u.pathname.startsWith("/avatar/") || u.pathname.startsWith("/gravatar/"))
      ? u.href
      : "";
  } catch {
    return "";
  }
}
function removeMention(text: string, self: string) {
  const escaped = self.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(
    new RegExp(
      `(?<![\\p{L}\\p{N}_.+@-])@${escaped}(?![\\p{L}\\p{N}_-])(?:\\s*#\\d+(?![\\p{L}\\p{N}_.-]))?`,
      "giu",
    ),
    "",
  );
}
export function plain(source: string, self = "") {
  // A mention link and its floor are separate HTML nodes; join text without crossing code.
  const parts: { text: string; code: boolean }[] = [];
  const append = (text: string, code: boolean) => {
    const previous = parts.at(-1);
    if (previous?.code === code) previous.text += text;
    else parts.push({ text, code });
  };
  const walk = (n: Node, code = false) => {
    if (n.type === "text") {
      append(n.data, code);
      return;
    }
    if (n.type === "script" || n.type === "style") return;
    if (n.type === "tag") {
      code ||= ["code", "pre"].includes(n.name);
      if (
        self &&
        !code &&
        n.name === "a" &&
        linkPath(n.attribs.href ?? "").toLowerCase() ===
          `/member/${self}`.toLowerCase() &&
        ((!parts.at(-1)?.code && parts.at(-1)?.text.endsWith("@")) ||
          DomUtils.textContent(n).toLowerCase() === `@${self}`.toLowerCase())
      ) {
        if (!parts.at(-1)?.code && parts.at(-1)?.text.endsWith("@"))
          parts.at(-1)!.text = parts.at(-1)!.text.slice(0, -1);
        append(`@${self}`, code);
        return;
      }
      if (n.name === "img") {
        append(" [图片] ", code);
        return;
      }
      if (["br", "p", "div", "li", "pre"].includes(n.name)) append(" ", code);
    }
    if ("children" in n) n.children.forEach((child) => walk(child, code));
    if (n.type === "tag" && ["p", "div", "li", "pre"].includes(n.name))
      append(" ", code);
  };
  parseDocument(source).children.forEach((n) => walk(n));
  return compact(
    parts
      .map((part) =>
        self && !part.code ? removeMention(part.text, self) : part.text,
      )
      .join(""),
  );
}

/** Only action text participates: usernames, topic titles and payloads are content. */
function classify(action: string, hasTopic: boolean): NotificationKind {
  const kinds: NotificationKind[] = [];
  const thanks = /感谢(?:了)?你|\bthank(?:ed|s)?\s+(?:you|your)\b/.test(action);
  if (thanks) {
    if (/回复|\b(?:repl(?:y|ies)|responses?|comments?)\b/.test(action))
      kinds.push("thanks_reply");
    else if (/主题|帖子|\b(?:topics?|posts?|threads?)\b/.test(action))
      kinds.push("thanks_topic");
    else return "other";
  }
  if (
    /收藏(?:了)?你(?:发布)?的(?:主题|帖子)|\b(?:favou?rit(?:e|ed|es)|bookmark(?:ed|s)?)\s+(?:your\s+)?(?:topic|post|thread)\b/.test(
      action,
    ) ||
    (hasTopic && /^(?:favou?rited|bookmarked)\s*$/.test(action))
  )
    kinds.push("favorite");
  if (/提(?:到|及)(?:了)?你|\bmention(?:ed|s)?\s+you\b/.test(action))
    kinds.push("mention");
  if (
    /回复(?:了)?你|\b(?:replied|responded)\s+to\s+(?:you|your)\b/.test(
      action,
    ) ||
    (hasTopic && /^(?:replied|responded)\s+to\s*$/.test(action))
  )
    kinds.push("reply");
  // Conflicting actions and incomplete thanks targets need review, not a guess.
  return kinds.length === 1 ? kinds[0] : "other";
}

export function presentation(
  n: Notification,
  self: string,
): Content & { kind: NotificationKind; avatar: string } {
  let actor = n.member?.username ?? "",
    topic = "",
    action = "",
    hasTopic = false;
  const walk = (node: Node) => {
    if (node.type === "script" || node.type === "style") return;
    if (node.type === "tag" && node.name === "a") {
      const path = linkPath(node.attribs.href ?? "");
      if (/^\/t\/\d+\/?$/.test(path)) {
        hasTopic = true;
        topic += DomUtils.textContent(node);
        return;
      }
      if (/^\/member\/[^/]+$/.test(path)) {
        actor ||= path.slice(8);
        return;
      }
      // Even an unrecognized link can contain a title with classification words.
      return;
    }
    if (node.type === "text") action += node.data;
    if ("children" in node) node.children.forEach(walk);
  };
  parseDocument(n.text).children.forEach(walk);
  action = compact(action).toLowerCase();
  const actorPrefix = `${compact(actor).toLowerCase()} `;
  if (actor && action.startsWith(actorPrefix))
    action = action.slice(actorPrefix.length);
  topic = compact(topic);
  const payload = n.payload_rendered?.trim()
    ? n.payload_rendered
    : (n.payload ?? "");
  let verb = "有新的动态",
    body = plain(payload);
  const kind = classify(action, hasTopic);
  if (kind === "thanks_reply") {
    verb = "感谢了你的回复";
  } else if (kind === "thanks_topic") {
    verb = "感谢了你的主题";
    body = topic ? `《${excerpt(topic, "", 177)}》` : "";
  } else if (kind === "favorite") {
    verb = "收藏了你的主题";
    body = topic ? `《${excerpt(topic, "", 177)}》` : "";
  } else if (kind === "mention") {
    verb = "提到了你";
    body = plain(payload, self);
  } else if (kind === "reply") {
    verb = "回复了你的主题";
    body = plain(payload, self);
  } else body ||= plain(n.text);
  let title = `${compact(actor) || "有人"} ${verb}`;
  if (kind === "reply" && topic) {
    const prefix = `${compact(actor) || "有人"} 回复了《`;
    title = `${prefix}${excerpt(topic, "", Math.max(1, 98 - [...prefix].length))}》`;
  }
  return {
    title: excerpt(title, "V2Echo 通知", 100),
    body: excerpt(body || topic, "打开应用查看详情", 180),
    kind,
    avatar:
      [n.member?.avatar_large, n.member?.avatar_normal, n.member?.avatar_mini]
        .map((x) => avatarURL(x))
        .find(Boolean) ?? "",
  };
}
export function notificationPage(value: unknown, account: number) {
  const data = value as { success?: boolean; result?: Notification[] };
  if (
    !data ||
    data.success !== true ||
    !Array.isArray(data.result) ||
    data.result.length > 100
  )
    throw new NotifierError("通知 API 列表结构无效");
  let prev = Number.MAX_SAFE_INTEGER;
  for (const n of data.result) {
    if (
      !n ||
      !Number.isSafeInteger(n.id) ||
      n.id <= 0 ||
      n.id >= prev ||
      typeof n.text !== "string" ||
      n.text.length > 65536 ||
      (n.payload != null &&
        (typeof n.payload !== "string" || n.payload.length > 262144)) ||
      (n.payload_rendered !== undefined &&
        (typeof n.payload_rendered !== "string" ||
          n.payload_rendered.length > 262144)) ||
      (n.member !== undefined &&
        (!n.member ||
          typeof n.member !== "object" ||
          (n.member.username !== undefined &&
            typeof n.member.username !== "string")))
    )
      throw new NotifierError("通知 API 编号顺序或内容格式无效");
    if (n.for_member_id !== account)
      throw new NotifierError("通知收件人与已确认账号不符", 0, "credentials");
    prev = n.id;
  }
  return data.result;
}
