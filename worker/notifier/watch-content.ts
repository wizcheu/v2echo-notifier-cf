import { excerpt } from "./crypto";
import type { Content } from "./model";
import type { WatchReply } from "./watch-parsers";

export function followingTopicContent(author: string, title: string): Content {
  return { title: `${author} 发布了新主题`, body: `《${excerpt(title, "关注成员有新帖", 160)}》` };
}

export function topicRepliesContent(topicID: number, title: string, count: number, first: WatchReply): Content {
  const prefix = `${first.author} 回复了《`;
  return {
    title: count === 1
      ? `${prefix}${excerpt(title, `主题 #${topicID}`, Math.max(1, 98 - [...prefix].length))}》`
      : `新增了 ${count} 条评论`,
    body: count === 1 ? first.body : `《${excerpt(title, `主题 #${topicID}`, 177)}》`,
  };
}
