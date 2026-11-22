import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseDocument, DomUtils } from "htmlparser2";
import { presentation } from "../worker/notifier/presentation";

const topic = '<a href="/t/123#reply2">主题里的感谢、回复、收藏与 mention</a>';
const actor = '<a href="/member/thanksgiving">thanksgiving</a>';
const show = (action: string, payload = "具体内容") =>
  presentation(
    {
      id: 1,
      for_member_id: 7,
      text: `${actor} ${action}`,
      payload_rendered: payload,
      member: { username: "thanksgiving" },
    },
    "tester",
  );

describe("notification action classification", () => {
  it.each([
    ["reply", `在 ${topic} 里回复了你`],
    ["reply", `在 ${topic} 回复了你`],
    ["reply", `回复了你的主题 ${topic}`],
    ["mention", `在回复 ${topic} 时提到了你`],
    ["mention", `在 ${topic} 中提及了你`],
    ["mention", `在 ${topic} 里提到了你`],
    ["thanks_topic", `感谢了你发布的主题 › ${topic}`],
    ["thanks_topic", `感谢了你的主题 › ${topic}`],
    ["thanks_reply", `感谢了你在主题 › ${topic} 里的回复`],
    ["thanks_reply", `感谢了你的回复 ${topic}`],
    ["favorite", `收藏了你发布的主题 › ${topic}`],
    ["favorite", `收藏了你的主题 › ${topic}`],
    ["reply", `replied to your topic ${topic}`],
    ["reply", `replied to ${topic}`],
    ["reply", `responded to you in ${topic}`],
    ["mention", `mentioned you in ${topic}`],
    ["thanks_topic", `thanked you for your topic ${topic}`],
    ["thanks_reply", `thanked you for your reply in ${topic}`],
    ["thanks_reply", `thanked you for your replies in topic ${topic}`],
    ["favorite", `favorited your topic ${topic}`],
    ["favorite", `favourited your post ${topic}`],
    ["favorite", `bookmarked your thread ${topic}`],
    ["favorite", `favorited ${topic}`],
  ])("identifies %s from the action: %s", (kind, action) => {
    expect(show(action).kind).toBe(kind);
  });

  it.each([
    `有一条新动态 ${topic}`,
    `感谢了你 ${topic}`,
    `thanked you ${topic}`,
    `reply ${topic}`,
    `thanksgiving ${topic}`,
    `提到了你并收藏了你的主题 ${topic}`,
    `回复了你并感谢了你的主题 ${topic}`,
  ])("leaves unknown or conflicting actions unclassified: %s", (action) => {
    expect(show(action, "感谢了你的回复，也提到了你").kind).toBe("other");
  });

  it("ignores titles, unrelated links and non-visible content during classification", () => {
    const item = show(
      `在 ${topic} 里回复了你 <script>感谢了你的主题</script><style>收藏了你的主题</style><a href="https://example.test">提到了你</a>`,
      "感谢、提及、收藏是回复的正文",
    );
    expect(item.kind).toBe("reply");
    expect(item.title).toBe(
      "thanksgiving 回复了《主题里的感谢、回复、收藏与 mention》",
    );
    expect(item.body).toBe("感谢、提及、收藏是回复的正文");
  });

  it.each([
    "/t/123#reply2",
    "https://www.v2ex.com/t/123#reply2",
    "https://v2ex.com/t/123?x=1#reply2",
    "https://edge.v2ex.com/t/123#reply2",
    "//hk.v2ex.com/t/123#reply2",
  ])("separates a real V2EX topic link at %s", (url) => {
    const item = show(
      `感谢了你发布的主题 › <a href="${url}">标题：回复了你</a>`,
      "不应使用的主题正文",
    );
    expect(item.kind).toBe("thanks_topic");
    expect(item.body).toBe("《标题：回复了你》");
  });

  it("does not infer an action from an external or malformed topic link", () => {
    for (const url of [
      "https://v2ex.com.example.test/t/123",
      "javascript:/t/123",
      "/t/not-a-topic",
    ])
      expect(show(`有新的动态 <a href="${url}">感谢了你的主题</a>`).kind).toBe(
        "other",
      );
  });

  it("removes a plain actor prefix and preserves mention cleanup across V2EX hosts", () => {
    const item = presentation(
      {
        id: 1,
        for_member_id: 7,
        text: `actor mentioned you in ${topic}`,
        payload_rendered:
          '@<a href="https://edge.v2ex.com/member/tester">tester</a> hello <code>@tester</code>',
        member: { username: "actor" },
      },
      "tester",
    );
    expect(item.kind).toBe("mention");
    expect(item.body).toBe("hello @tester");
  });

  it.each(["reply", "mention"])(
    "cleans self mentions and their adjacent floors for %s only outside code",
    (kind) => {
      const action =
        kind === "reply" ? `在 ${topic} 里回复了你` : `在 ${topic} 中提到了你`;
      for (const [payload, expected] of [
        ['@<a href="/member/tester">tester</a> #49 新内容 #72', "新内容 #72"],
        [
          '<a href="https://edge.v2ex.com/member/TESTER">@TESTER</a> <b>#12</b> 新内容',
          "新内容",
        ],
        [
          "@tester #12 hello @other #34 @tester2 #56 @tester_name #78 @tester-extra #90",
          "hello @other #34 @tester2 #56 @tester_name #78 @tester-extra #90",
        ],
        [
          "@tester issue #12 / @tester #12abc / @tester #12.5",
          "issue #12 / #12abc / #12.5",
        ],
        [
          "@tester #1 <code>@tester #2</code> <pre>@tester #3</pre> person@tester.com #4",
          "@tester #2 @tester #3 person@tester.com #4",
        ],
        ['<code>@</code><a href="/member/tester">tester</a> #5', "@tester #5"],
        ["@tester #1 first @TESTER #2 second", "first second"],
      ])
        expect(show(action, payload).body).toBe(expected);
    },
  );

  it("keeps reply mentions unchanged in thanked comments", () => {
    expect(
      show(`感谢了你在主题 › ${topic} 里的回复`, "@tester #49 原评论").body,
    ).toBe("@tester #49 原评论");
  });

  it("preserves book-title punctuation and actor identity when emoji topic names are long", () => {
    const longTopic = `<a href="/t/123">${"🙂".repeat(200)}</a>`;
    const reply = show(`在 ${longTopic} 里回复了你`);
    expect(reply.title).toMatch(/^thanksgiving 回复了《🙂+…》$/u);
    expect([...reply.title]).toHaveLength(100);
    for (const action of ["感谢了你的主题", "收藏了你的主题"]) {
      const body = show(`${action} ${longTopic}`).body;
      expect(body).toBe(`《${"🙂".repeat(177)}…》`);
      expect([...body]).toHaveLength(180);
    }
  });

  it("keeps a classified reply readable when the upstream action omits its topic", () => {
    const item = show("回复了你", "@tester #1 实际回复");
    expect(item.title).toBe("thanksgiving 回复了你的主题");
    expect(item.body).toBe("实际回复");
  });

  it.runIf(existsSync("../site-data/html_20261104/notifications.html"))(
    "formats current saved reply, mention and favorite payloads",
    async () => {
      const root = parseDocument(
        await readFile("../site-data/html_20261104/notifications.html", "utf8"),
      );
      const results = DomUtils.findAll(
        (node) => node.type === "tag" && /^n_\d+$/.test(node.attribs.id ?? ""),
        root.children,
      ).map((cell) => {
        const action = DomUtils.findOne(
          (node) => node.type === "tag" && node.attribs.class === "gray",
          cell.children,
        )!;
        const payload = DomUtils.findOne(
          (node) => node.type === "tag" && node.attribs.class === "payload",
          cell.children,
        );
        return presentation(
          {
            id: 1,
            for_member_id: 7,
            text: DomUtils.getInnerHTML(action),
            payload_rendered: payload ? DomUtils.getInnerHTML(payload) : "",
          },
          "wizChen",
        );
      });
      expect(results[0].title).toMatch(/^light000 回复了《.+》$/);
      expect(results[0].body).toMatch(/^再反馈一个问题/);
      expect(results[0].body).not.toContain("#49");
      expect(results[1].body).toMatch(/^@ghg198964 #42 /);
      expect(results[2].body).toBe(
        "@uxstone 确实是，想要进头部企业必须是名校 三楼就说了",
      );
      expect(results[3].body).toMatch(/^《.+》$/);
    },
  );

  for (const [file, expected] of [
    [
      "../site-data/html_20260701/notifications.html",
      { reply: 29, mention: 11, thanks_reply: 10 },
    ],
    [
      "../site-data/html_20260701/notifications/V2EX › 提醒系统.html",
      { reply: 46, favorite: 4 },
    ],
  ] as const) {
    it.runIf(existsSync(file))(
      `recognizes the actions in saved page ${file}`,
      async () => {
        const root = parseDocument(await readFile(file, "utf8"));
        const cells = DomUtils.findAll(
          (node) =>
            node.type === "tag" && /^n_\d+$/.test(node.attribs.id ?? ""),
          root.children,
        );
        const counts: Record<string, number> = {};
        for (const cell of cells) {
          const action = DomUtils.findOne(
            (node) =>
              node.type === "tag" &&
              node.name === "span" &&
              (node.attribs.class ?? "").split(/\s+/).includes("fade"),
            cell.children,
          );
          expect(action).not.toBeNull();
          const result = presentation(
            { id: 1, for_member_id: 7, text: DomUtils.getInnerHTML(action!) },
            "",
          );
          counts[result.kind] = (counts[result.kind] ?? 0) + 1;
        }
        expect(counts).toEqual(expected);
      },
    );
  }
});
