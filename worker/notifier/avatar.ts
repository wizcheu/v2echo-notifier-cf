import type { Context } from "./context";
import { upstream } from "./http";
import { NotifierError } from "./model";
import { avatarURL } from "./presentation";

export function senderUsername(title: string): string {
  // Only our classified, decrypted presentation can identify the sender. Never
  // derive a request path from arbitrary notification text or a topic title.
  return (
    /^([A-Za-z0-9_]{1,100}) (?:回复了《.+》|回复了你的主题|提到了你|提及了你|感谢了你的主题|感谢了你的回复|收藏了你的主题)$/.exec(
      title,
    )?.[1] ?? ""
  );
}

/** API v2 notifications may include only a username, with no avatar fields. */
export async function senderAvatar(c: Context, title: string): Promise<string> {
  const username = senderUsername(title);
  if (!username) return "";
  try {
    const member = (await upstream(
      c,
      `/api/members/show.json?username=${username}`,
    )) as Record<string, unknown> | null;
    if (
      !member ||
      member.status !== "found" ||
      !Number.isSafeInteger(member.id) ||
      Number(member.id) <= 0 ||
      typeof member.username !== "string" ||
      member.username.toLowerCase() !== username.toLowerCase()
    )
      return "";
    return (
      [member.avatar_large, member.avatar_normal, member.avatar_mini]
        .map((value) => (typeof value === "string" ? avatarURL(value) : ""))
        .find(Boolean) ?? ""
    );
  } catch (error) {
    // Avatar enrichment is optional. Preserve real text on an upstream failure
    // or cooldown; database/lease failures must still abort the preparation.
    if (error instanceof NotifierError) return "";
    throw error;
  }
}
