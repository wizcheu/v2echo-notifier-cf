import { DomUtils, parseDocument } from "htmlparser2";
import type { FollowedMember, MemberFeedTopic } from "../../shared/watch-contracts";
import { isChallenge } from "../parsers";
import { excerpt } from "./crypto";
import { avatarURL, plain } from "./presentation";
import { NotifierError } from "./model";

type Element = ReturnType<typeof DomUtils.getElementsByTagName>[number];
type Branch = Element | ReturnType<typeof parseDocument>;
const all = (root: Branch, test: (node: Element) => boolean) => DomUtils.findAll(test, root.children);
const cls = (node: Element, value: string) => (node.attribs.class ?? "").split(/\s+/).includes(value);
const text = (node: Branch) => DomUtils.textContent(node).replace(/\s+/g, " ").trim();
const fail = (message: string): never => { throw new NotifierError(message); };
const integer = (value: string | undefined) => value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : 0;

function siteURL(value: string | undefined): URL | null {
  try {
    const url = new URL(value ?? "", "https://www.v2ex.com");
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.port &&
      (url.hostname === "v2ex.com" || url.hostname.endsWith(".v2ex.com")) ? url : null;
  } catch { return null; }
}
const member = (node: Element) => {
  const match = siteURL(node.attribs.href)?.pathname.match(/^\/member\/([A-Za-z0-9_-]+)$/);
  return match?.[1] ?? "";
};
function document(html: string, username: string) {
  if (isChallenge(html)) fail("V2EX 页面需要验证，关注检查已暂停");
  const doc = parseDocument(html);
  if (!all(doc, n => n.name === "a" && cls(n, "top")).some(n => member(n).toLowerCase() === username.toLowerCase())) {
    throw new NotifierError("关注页面账号与助手不符，请更新 Cookie", 0, "credentials");
  }
  const main = all(doc, n => n.attribs.id === "Main")[0] ?? fail("关注页面结构不完整");
  return { doc, main };
}
export class WatchPageMismatchError extends NotifierError {}

function pages(root: Branch, path: string, expectedPage: number) {
  let result = 1;
  const current = new Set<number>();
  for (const link of all(root, n => n.name === "a" && (cls(n, "page_normal") || cls(n, "page_current")))) {
    const u = siteURL(link.attribs.href), page = integer(u?.searchParams.get("p") ?? undefined);
    if (u?.pathname === path && page) {
      result = Math.max(result, page);
      if (cls(link, "page_current")) current.add(page);
    }
  }
  for (const input of all(root, n => n.name === "input" && cls(n, "page_input"))) {
    result = Math.max(result, integer(input.attribs.max));
    current.add(integer(input.attribs.value));
  }
  if (result > 9999) fail("关注页面分页超出检查范围");
  if (!current.size && result === 1) current.add(1);
  if (current.size !== 1 || !current.has(expectedPage)) throw new WatchPageMismatchError("返回的页码与请求不符，保留检查进度");
  return result;
}
export function absoluteTime(value: string | undefined): number {
  const m = value?.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*)(Z|[+-]\d{2}:\d{2})$/);
  const result = m ? Date.parse(`${m[1]}T${m[2]}${m[3]}`) : NaN;
  return Number.isFinite(result) ? result : fail("页面缺少可验证的发布时间");
}

export interface FollowingTopic { id: number; author: string; title: string; updatedAt?: number; }
export interface FollowingPage { topics: FollowingTopic[]; members: string[]; followed_members: FollowedMember[]; pages: number; }

/** The selected homepage member feed supplies both display rows and new-topic scan candidates. */
export function parseMembersFeed(html: string, username: string): MemberFeedTopic[] {
  const { main } = document(html, username);
  const tabs = all(main, n => n.attribs.id === "Tabs");
  const selected = tabs.length === 1 ? all(tabs[0]!, n => n.name === "a" && cls(n, "tab_current")) : [];
  const route = selected.length === 1 ? siteURL(selected[0]!.attribs.href) : null;
  const box = tabs[0]?.parent ?? fail("返回的不是关注成员帖子流");
  if (!route || route.pathname !== "/" || route.searchParams.getAll("tab").length !== 1 ||
      route.searchParams.get("tab") !== "members" || box?.type !== "tag" ||
      !cls(box, "box") || box.parent !== main) fail("返回的不是关注成员帖子流");
  const rows = box.children.filter((n): n is Element => n.type === "tag" &&
    (cls(n, "item") || cls(n, "cell") && all(n, child => cls(child, "item_title")).length > 0));
  const topics = rows.map(row => {
    const titles = all(row, n => cls(n, "item_title"));
    const links = titles.length === 1 ? all(titles[0]!, n => n.name === "a") : [];
    const link = (links.length === 1 ? links[0] : undefined) ?? fail("关注成员帖子条目不完整");
    const url = siteURL(link?.attribs.href), id = integer(url?.pathname.match(/^\/t\/(\d+)$/)?.[1]);
    const infos = titles[0]?.parent?.children.filter((n): n is Element => n.type === "tag" && cls(n, "topic_info")) ?? [];
    if (!id || !link || !text(link) || infos.length !== 1) fail("关注成员帖子条目不完整");
    const info = infos[0]!;
    const authorSlot = info.children.find((n): n is Element => n.type === "tag" && n.name === "strong");
    const authors = authorSlot ? all(authorSlot, n => n.name === "a") : [];
    const author = authors.length === 1 ? member(authors[0]!) : "";
    if (!author || text(authors[0]!).toLowerCase() !== author.toLowerCase()) fail("关注成员帖子作者无效");
    const table = row.children.find((n): n is Element => n.type === "tag" && n.name === "table");
    const firstRow = table && all(table, n => n.name === "tr")[0];
    const portraitCell = firstRow?.children.find((n): n is Element => n.type === "tag" && n.name === "td");
    const portraits = portraitCell ? all(portraitCell, n => n.name === "img" && cls(n, "avatar")) : [];
    const portrait = portraits.length === 1 ? portraits[0] : undefined;
    const portraitOwner = portrait?.parent?.type === "tag" && portrait.parent.name === "a" ? member(portrait.parent) : "";
    if (portraitOwner && portraitOwner.toLowerCase() !== author.toLowerCase()) fail("关注成员帖子作者与头像不符");
    const avatar = portraitOwner && (!portrait?.attribs.alt || portrait.attribs.alt.toLowerCase() === author.toLowerCase())
      ? avatarURL(portrait?.attribs.src) : "";
    const counts = all(row, n => n.name === "a" && (cls(n, "count_livid") || cls(n, "count_orange")));
    if (counts.length > 1 || counts.some(n => integer(siteURL(n.attribs.href)?.pathname.match(/^\/t\/(\d+)$/)?.[1]) !== id))
      fail("关注成员帖子回复数与主题不符");
    // Zero-reply rows omit the badge, but the title still carries #reply0.
    const count = counts[0] ? text(counts[0]) : url?.hash.match(/^#reply(\d+)$/)?.[1];
    if (count === undefined || !/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) fail("关注成员帖子回复数无效");
    const nodes = info.children.filter((n): n is Element => n.type === "tag" && n.name === "a" && cls(n, "node"));
    const node = nodes[0], slug = node && siteURL(node.attribs.href)?.pathname.match(/^\/go\/([A-Za-z0-9_-]+)$/)?.[1];
    if (nodes.length > 1 || node && (!slug || !text(node))) fail("关注成员帖子节点无效");
    const times = info.children.filter((n): n is Element => n.type === "tag" && n.name === "span" &&
      (n.attribs.title !== undefined || n.attribs["data-original-title"] !== undefined));
    if (times.length > 1) fail("关注成员帖子活动时间不明确");
    // This is the row's last activity, never proof of the topic's creation time.
    const updated = times[0] ? absoluteTime(times[0].attribs.title ?? times[0].attribs["data-original-title"]) : undefined;
    return { id, title: text(link), author, reply_count: Number(count),
      ...(avatar ? { avatar_url: avatar } : {}), ...(node ? { node_name: slug!, node_title: text(node) } : {}),
      ...(updated === undefined ? {} : { updated_at: updated }) };
  });
  if (new Set(topics.map(topic => topic.id)).size !== topics.length) fail("关注成员帖子流出现重复主题");
  const empty = box.children.filter((n): n is Element => n.type === "tag" && n !== tabs[0] && (cls(n, "cell") || cls(n, "inner")))
    .some(n => /(?:还没有关注任何人|没有任何主题|暂无主题|尚无主题|no topics|not following)/i.test(text(n)));
  if (!topics.length && !empty) fail("无法确认关注成员帖子流为空");
  return topics;
}

/** Membership-only reads never depend on the topic rows or pagination below the navigation. */
export function parseFollowedMembers(html: string, username: string): FollowedMember[] {
  const { doc, main } = document(html, username);
  return followingMembers(doc, main);
}

function followingMembers(doc: Branch, main: Element): FollowedMember[] {
  if (!all(main, n => n.name === "a" && siteURL(n.attribs.href)?.pathname === "/my/following" &&
      (cls(n, "active") || n.attribs["aria-current"] === "page")).length) fail("返回的不是关注帖子列表");
  const right = all(doc, n => n.attribs.id === "Rightbar")[0] ?? fail("关注成员列表缺失");
  const countLink = all(right, n => n.name === "a" && siteURL(n.attribs.href)?.pathname === "/my/following");
  if (countLink.length !== 1) fail("关注人数无法核对");
  const countText = countLink[0]!.children.find((n): n is Element => n.type === "tag");
  const count = countText ? Number(text(countText).replaceAll(",", "")) : NaN;
  if (!Number.isSafeInteger(count) || count < 0) fail("关注人数无效");
  const tagChildren = (node: Element) => node.children.filter((n): n is Element => n.type === "tag");
  const directLinks = (node: Element) => tagChildren(node).filter(n => n.name === "a");
  // Scope to the sidebar "我关注的人" box (direct avatar+name member link rows) so unrelated boxes cannot poison parsing.
  const memberBoxes = tagChildren(right).filter(box => tagChildren(box).some(row => {
    const links = directLinks(row);
    return links.length >= 2 && links.some(a => all(a, n => n.name === "img").length > 0) &&
      links.some(a => Boolean(member(a)));
  }));
  if (memberBoxes.length > 1) fail("关注成员列表结构异常");
  const box = memberBoxes[0];
  if (!box) {
    if (count !== 0) fail("关注成员列表未读完整");
    return [];
  }
  const members: string[] = [];
  const followed_members: FollowedMember[] = [];
  for (const row of tagChildren(box)) {
    const links = directLinks(row);
    if (!links.length) continue;
    const avatarLinks = links.filter(a => all(a, n => n.name === "img").length > 0);
    if (links.length !== 2 || avatarLinks.length !== 1) fail("关注成员身份无效");
    const avatarLink = avatarLinks[0]!;
    const nameLink = links.find(a => a !== avatarLink)!;
    const name = member(avatarLink);
    if (!name || name.toLowerCase() !== member(nameLink).toLowerCase() || text(nameLink).toLowerCase() !== name.toLowerCase()) fail("关注成员身份无效");
    members.push(name.toLowerCase());
    const portraits = all(avatarLink, n => n.name === "img");
    const portrait = portraits.length === 1 && cls(portraits[0]!, "avatar") ? portraits[0] : undefined;
    const avatar = portrait && (!portrait.attribs.alt || portrait.attribs.alt.toLowerCase() === name.toLowerCase())
      ? avatarURL(portrait.attribs.src) : "";
    followed_members.push({ username: text(nameLink), ...(avatar ? { avatar_url: avatar } : {}) });
  }
  if (members.length !== count || new Set(members).size !== count) fail("关注成员列表未读完整");
  return followed_members;
}

export function parseFollowing(html: string, username: string, expectedPage = 1): FollowingPage {
  const { doc, main } = document(html, username);
  const followed_members = followingMembers(doc, main);
  const members = followed_members.map(person => person.username.toLowerCase());
  const titles = all(main, n => cls(n, "item_title"));
  const topics = titles.map(title => {
    const link = all(title, n => n.name === "a")[0];
    const id = integer(siteURL(link?.attribs.href)?.pathname.match(/^\/t\/(\d+)$/)?.[1]);
    let row: Element | undefined = title;
    while (row && !cls(row, "cell")) row = row.parent?.type === "tag" ? row.parent : undefined;
    const author = row ? all(row, n => n.name === "a" && Boolean(member(n)) &&
      (Boolean(all(n, img => img.name === "img").length) || n.parent?.type === "tag" && n.parent.name === "strong"))[0] : undefined;
    if (!id || !link || !text(link) || !author) return fail("关注主题条目不完整");
    // Only the list row's own metadata can provide its last activity time.
    // It does not establish creation order and must never be used to stop paging.
    const infos = title.parent?.children.filter((n): n is Element => n.type === "tag" && cls(n, "topic_info")) ?? [];
    if (infos.length > 1) fail("关注主题时间区域不明确");
    const times = infos[0]?.children.filter((n): n is Element => n.type === "tag" && n.name === "span" &&
      (n.attribs.title !== undefined || n.attribs["data-original-title"] !== undefined)) ?? [];
    if (times.length > 1) fail("关注主题时间不明确");
    const time = times[0];
    const updatedAt = time ? absoluteTime(time.attribs.title ?? time.attribs["data-original-title"]) : undefined;
    return { id, title: text(link), author: member(author), ...(updatedAt === undefined ? {} : { updatedAt }) };
  });
  if (new Set(topics.map(t => t.id)).size !== topics.length) fail("关注分页出现重复主题");
  if (!topics.length && !/(?:还没有关注任何人|没有任何主题|暂无主题|尚无主题|no topics|not following)/i.test(text(main))) fail("无法确认关注列表为空");
  return { topics, members, followed_members, pages: pages(main, "/my/following", expectedPage) };
}

export interface WatchReply { id: number; floor: number; author: string; created: number; body: string; avatar: string; }
export interface TopicSnapshot {
  id: number; title: string; author: string; avatar: string; created: number; pages: number; replies: WatchReply[];
}

export function parseWatchedTopic(html: string, username: string, topicID: number, expectedPage = 1): TopicSnapshot {
  const { main } = document(html, username);
  const header = all(main, n => cls(n, "header") && all(n, child => child.name === "h1").length > 0)[0] ?? fail("主题标题区域缺失");
  if (!all(header, n => n.attribs.id === `topic_${topicID}_votes`).length) fail("主题编号与请求不符");
  const title = all(header, n => n.name === "h1")[0]!;
  const metadata = all(header, n => n.name === "small")[0] ?? fail("主题发布时间缺失");
  const author = all(metadata, n => n.name === "a" && Boolean(member(n)))[0] ?? fail("主题作者缺失");
  const time = all(metadata, n => Boolean(n.attribs.title || n.attribs["data-original-title"]))[0];
  const created = absoluteTime(time?.attribs.title ?? time?.attribs["data-original-title"]);
  const replies = all(main, n => /^r_[1-9]\d*$/.test(n.attribs.id ?? "") && cls(n, "cell")).map(row => {
    const id = integer(row.attribs.id!.slice(2)), floor = all(row, n => cls(n, "no"))[0];
    const author = all(row, n => n.name === "a" && n.parent?.type === "tag" && n.parent.name === "strong" && Boolean(member(n)))[0];
    const time = all(row, n => cls(n, "ago"))[0];
    const content = all(row, n => cls(n, "reply_content"))[0];
    if (!id || !floor || !integer(text(floor)) || !author || !content) fail("回复结构不完整");
    const portrait = all(row, n => {
      if (n.name !== "img" || !cls(n, "avatar")) return false;
      // User-supplied images inside the reply can never become the author's avatar.
      for (let parent = n.parent; parent; parent = parent.parent) if (parent === content) return false;
      return !n.attribs.alt || n.attribs.alt.toLowerCase() === member(author!).toLowerCase();
    })[0];
    return { id, floor: integer(text(floor)), author: member(author!), created: absoluteTime(time?.attribs.title ?? time?.attribs["data-original-title"]),
      body: excerpt(plain(DomUtils.getInnerHTML(content!)), "打开主题查看这条评论", 180), avatar: avatarURL(portrait?.attribs.src ?? "") };

  });
  if (replies.some((r, i) => i > 0 && (r.id <= replies[i - 1]!.id || r.floor <= replies[i - 1]!.floor))) fail("回复顺序发生变化，等待重新读取");
  if (!replies.length && !/(?:目前尚无回复|暂无回复|没有回复|0\s*(?:条回复|replies)|no replies)/i.test(text(main))) fail("无法确认主题没有回复");
  const portrait = all(header, n => n.name === "a" && member(n).toLowerCase() === member(author).toLowerCase())
    .flatMap(n => all(n, child => child.name === "img" && cls(child, "avatar")))[0];
  return { id: topicID, title: text(title), author: member(author), avatar: avatarURL(portrait?.attribs.src ?? ""), created, pages: pages(main, `/t/${topicID}`, expectedPage), replies };
}
