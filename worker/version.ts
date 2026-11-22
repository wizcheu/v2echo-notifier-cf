import type { VersionCheckResult } from "../shared/contracts";
import {
  APP_VERSION,
  compareVersions,
  LATEST_RELEASE_API_URL,
  normalizeVersion,
  RELEASE_REPO,
  RELEASES_PAGE_URL,
} from "../shared/version";
import type { UpstreamFetch } from "./types";

const MAX_RELEASE_BYTES = 65536;
const RELEASE_URL_PREFIX = `https://github.com/${RELEASE_REPO}/releases/`;

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let total = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("release payload too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

/**
 * Manually query GitHub Releases for the latest published notifier version.
 * Never called automatically in background Cron or page loads.
 */
export async function checkLatestRelease(
  fetcher: UpstreamFetch = fetch,
  currentVersion = APP_VERSION,
  now = Date.now(),
): Promise<VersionCheckResult> {
  let response: Response;
  try {
    response = await fetcher(LATEST_RELEASE_API_URL, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `v2echo-notifier-cf/${currentVersion}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return {
      current_version: currentVersion,
      latest_version: null,
      has_update: false,
      release_url: RELEASES_PAGE_URL,
      published_at: null,
      checked_at: now,
      note: "无法连接 GitHub 检查更新，请稍后重试或前往 Releases 页面查看。",
    };
  }

  if (response.status === 404) {
    return {
      current_version: currentVersion,
      latest_version: null,
      has_update: false,
      release_url: RELEASES_PAGE_URL,
      published_at: null,
      checked_at: now,
      note: "GitHub 仓库尚未发布正式 Release。",
    };
  }
  if (response.status === 403 || response.status === 429) {
    return {
      current_version: currentVersion,
      latest_version: null,
      has_update: false,
      release_url: RELEASES_PAGE_URL,
      published_at: null,
      checked_at: now,
      note: "GitHub API 触发临时限流，请稍后再试。",
    };
  }
  if (!response.ok) {
    return {
      current_version: currentVersion,
      latest_version: null,
      has_update: false,
      release_url: RELEASES_PAGE_URL,
      published_at: null,
      checked_at: now,
      note: `GitHub 返回异常状态（HTTP ${response.status}），请稍后重试。`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedText(response, MAX_RELEASE_BYTES));
  } catch {
    return {
      current_version: currentVersion,
      latest_version: null,
      has_update: false,
      release_url: RELEASES_PAGE_URL,
      published_at: null,
      checked_at: now,
      note: "版本信息响应格式无效，请前往 GitHub Releases 查看。",
    };
  }

  const data = payload as {
    tag_name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
  } | null;
  const latest =
    typeof data?.tag_name === "string" ? normalizeVersion(data.tag_name) : null;
  if (!latest) {
    return {
      current_version: currentVersion,
      latest_version: null,
      has_update: false,
      release_url: RELEASES_PAGE_URL,
      published_at: null,
      checked_at: now,
      note: "未识别到有效的发布版本号。",
    };
  }

  const releaseUrl =
    typeof data?.html_url === "string" && data.html_url.startsWith(RELEASE_URL_PREFIX)
      ? data.html_url
      : `${RELEASE_URL_PREFIX}tag/v${latest}`;
  const publishedAt =
    typeof data?.published_at === "string" && !Number.isNaN(Date.parse(data.published_at))
      ? data.published_at
      : null;
  const cmp = compareVersions(currentVersion, latest);

  return {
    current_version: currentVersion,
    latest_version: latest,
    has_update: cmp === -1,
    release_url: releaseUrl,
    published_at: publishedAt,
    checked_at: now,
  };
}
