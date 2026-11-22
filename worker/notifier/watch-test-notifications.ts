import type { WatchMeta } from "../../shared/watch-contracts";
import type { Context } from "./context";
import { open } from "./crypto";
import { upstream } from "./http";
import { NotifierError, type Notifier, type WatchTestKind } from "./model";
import { cachedWatchConfig } from "./watch-config";
import { followingTopicContent, topicRepliesContent } from "./watch-content";
import { parseWatchedTopic } from "./watch-parsers";
import type { FollowingState } from "./watch-scanner";

/** Test sampling reads source content without advancing any monitoring cursor. */
export async function watchTestSample(c: Context, s: Notifier, kind: WatchTestKind) {
  const config = await cachedWatchConfig(c.db, c.id);
  if (!config || config.profile_id !== s.binding_id || config.source_account_id !== s.account_id)
    throw new NotifierError("请先同步当前账号的关注配置");
  if (!config.capable_recipient_count)
    throw new NotifierError("暂无支持关注提醒的设备，请先同步连接状态");
  const meta = (topic: number, epoch: number): WatchMeta => ({
    profile_id: config.profile_id, source_generation: config.source_generation,
    watch_kind: kind === "following_topic" ? "following_topic" : "topic_reply",
    watch_epoch: epoch, topic_id: topic,
  });
  if (kind === "following_topic") {
    if (!config.following.enabled) throw new NotifierError("请先开启关注成员的新帖提醒");
    const target = await c.db.one<{ target_key: string; state_enc: string }>(
      "SELECT target_key,state_enc FROM watch_targets WHERE notifier_id=? AND topic_id=0 AND epoch=?",
      c.id, config.following.epoch,
    );
    if (!target?.state_enc) throw new NotifierError("暂无成员帖子样本，请先在关注的人中获取最新数据");
    const state = await open<FollowingState>(c.env,
      `watch:${s.account_id}:${target.target_key}:${config.following.epoch}`, target.state_enc, 512 * 1024);
    const members = { ...state.scan?.members, ...state.members };
    const topic = state.member_feed?.topics.find(topic =>
      topic.author.toLowerCase() !== s.username.toLowerCase() && members[topic.author.toLowerCase()] !== undefined);
    if (!topic) throw new NotifierError("暂无关注成员的真实帖子样本，请先在关注的人中获取最新数据");
    return { content: followingTopicContent(topic.author, topic.title), avatar: topic.avatar_url ?? "",
      meta: meta(topic.id, config.following.epoch), origin: "cache" as const };
  }
  const rule = config.topics.find(topic => topic.enabled);
  if (!rule) throw new NotifierError("请先开启至少一个帖子的评论提醒");
  const first = parseWatchedTopic(String(await upstream(c, `/t/${rule.topic_id}?p=1`)), s.username, rule.topic_id);
  const tail = first.pages > 1
    ? parseWatchedTopic(String(await upstream(c, `/t/${rule.topic_id}?p=${first.pages}`)), s.username, rule.topic_id, first.pages)
    : first;
  const count = kind === "topic_replies" ? 3 : 1;
  let replies = tail.replies.filter(reply => reply.author.toLowerCase() !== s.username.toLowerCase());
  if (replies.length < count && first.pages > 1) {
    const previous = first.pages === 2 ? first : parseWatchedTopic(
      String(await upstream(c, `/t/${rule.topic_id}?p=${first.pages - 1}`)), s.username, rule.topic_id, first.pages - 1);
    replies = [...previous.replies.filter(reply => reply.author.toLowerCase() !== s.username.toLowerCase()), ...replies];
  }
  replies = [...new Map(replies.map(reply => [reply.id, reply])).values()].sort((a, b) => a.id - b.id).slice(-count);
  if (replies.length < (kind === "topic_replies" ? 2 : 1))
    throw new NotifierError(`关注的主题 #${rule.topic_id} 最近页面中没有足够的他人评论样本，请选择其他测试类型`);
  const reply = replies[0]!;
  return { content: topicRepliesContent(rule.topic_id, first.title, replies.length, reply),
    avatar: replies.length === 1 ? reply.avatar : first.avatar,
    meta: { ...meta(rule.topic_id, rule.epoch), reply_id: reply.id, reply_floor: reply.floor }, origin: "live" as const };
}
