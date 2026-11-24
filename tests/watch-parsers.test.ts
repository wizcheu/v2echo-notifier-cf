import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DomUtils, parseDocument } from 'htmlparser2';
import { absoluteTime, parseFollowedMembers, parseFollowing, parseMembersFeed, parseWatchedTopic } from '../worker/notifier/watch-parsers';
import { validateDeployment } from '../deployment-config';
import { followingHTML, membersFeedHTML, topicHTML } from './watch-fixtures';

describe('homepage members feed presentation', () => {
  const updatedAt = Date.UTC(2026, 10, 13, 1, 0, 14);
  const card = () => membersFeedHTML([{ id: 42, author: 'Writer', title: '标题 &amp; 内容', replyCount: 6, updatedAt }]);

  it('reads display fields in source order with activity time and the actual author', () => {
    const html = membersFeedHTML([
      { id: 42, author: 'Writer', title: '标题 &amp; 内容', replyCount: 6, updatedAt },
      { id: 4, avatar: null, nodeName: null }, { id: 30, replyCount: 2 },
    ]);
    expect(parseMembersFeed(html, 'TESTER')).toEqual([
      { id: 42, title: '标题 & 内容', author: 'Writer', avatar_url: 'https://cdn.v2ex.com/avatar/Writer.png',
        reply_count: 6, node_name: 'tech', node_title: '技术', updated_at: updatedAt },
      { id: 4, title: '主题 4', author: 'writer', reply_count: 0 },
      { id: 30, title: '主题 30', author: 'writer', avatar_url: 'https://cdn.v2ex.com/avatar/writer.png',
        reply_count: 2, node_name: 'tech', node_title: '技术' },
    ]);
    expect(parseMembersFeed(card().replace('title="2026-', 'data-original-title="2026-'), 'tester')[0]?.updated_at).toBe(updatedAt);
  });

  it('uses a matching orange badge ahead of the stale title count and proves zero through reply0', () => {
    const html = card().replace('class="count_livid"', 'class="count_orange"').replace('>6</a>', '>8</a>');
    expect(parseMembersFeed(html, 'tester')[0]?.reply_count).toBe(8);
    expect(parseMembersFeed(membersFeedHTML([{ id: 1 }]), 'tester')[0]?.reply_count).toBe(0);
    expect(() => parseMembersFeed(membersFeedHTML([{ id: 1 }]).replace('#reply0', ''), 'tester')).toThrow('回复数');
  });

  it('requires the selected members route and authenticated account rather than borrowing another feed', () => {
    for (const html of [
      card().replace('href="/?tab=members"', 'href="/?tab=all"'),
      card().replace('href="/?tab=members"', 'href="https://foreign.example/?tab=members"'),
      card().replace('href="/?tab=members"', 'href="/?tab=members&tab=all"'),
      card().replace('id="Tabs"', 'id="OtherTabs"'),
      card().replace('class="tab"', 'class="tab_current"'),
      followingHTML([{ id: 42 }]),
    ]) expect(() => parseMembersFeed(html, 'tester')).toThrow('帖子流');
    expect(() => parseMembersFeed(card(), 'other')).toThrow('账号');
    expect(() => parseMembersFeed('<form action="/signin"></form>', 'tester')).toThrow();
    expect(() => parseMembersFeed('<title>Just a moment</title>', 'tester')).toThrow('验证');
    expect(() => parseMembersFeed('<a class="top" href="/member/tester">tester</a>', 'tester')).toThrow('结构');
  });

  it('rejects duplicate or partly damaged rows rather than returning a partial snapshot', () => {
    expect(() => parseMembersFeed(membersFeedHTML([{ id: 42 }, { id: 42 }]), 'tester')).toThrow('重复');
    for (const html of [
      card().replace('href="/t/42#reply6"', 'href="https://foreign.example/t/42#reply6"'),
      card().replace('class="item_title"', 'class="missing-title"'),
      card().replace('class="topic_info"', 'class="missing-info"'),
      card().replace('<strong><a href="/member/Writer">Writer</a></strong>', ''),
      card().replace('<strong><a href="/member/Writer">Writer</a></strong>', '<strong><a href="/member/Other">Writer</a></strong>'),
      card().replace('>6</a>', '>-1</a>'),
      card().replace('>6</a>', '>9007199254740992</a>'),
      card().replace('class="count_livid" href="/t/42#reply6"', 'class="count_livid" href="/t/99#reply6"'),
      card().replace('href="/go/tech"', 'href="https://foreign.example/go/tech"'),
      card().replace('title="2026-11-13T01:00:14Z"', 'title="not a timestamp"'),
    ]) expect(() => parseMembersFeed(html, 'tester')).toThrow();
  });

  it('rejects ambiguous count, node and activity metadata', () => {
    for (const html of [
      card().replace('</tr>', '<td><a class="count_livid" href="/t/42#reply6">6</a></td></tr>'),
      card().replace('<strong>', '<a class="node" href="/go/other">Other</a><strong>'),
      card().replace('</strong>', '</strong><span title="2026-11-12T01:00:14Z">other activity</span>'),
    ]) expect(() => parseMembersFeed(html, 'tester')).toThrow();
  });

  it('ignores other Main boxes, sidebar topics, advertisements and timestamps inside title text', () => {
    const noise = '<div class="cell item"><span class="item_title"><a href="/t/999#reply1">unrelated</a></span></div>';
    const html = card()
      .replace('<div id="Main">', `<aside id="Rightbar">${noise}</aside><div id="Main"><div class="box">${noise}</div>`)
      .replace('<div class="inner"><a href="/recent">', `<div class="cell"><a href="/t/999#reply1">advertisement</a></div><div class="advert">${noise}</div><div class="inner"><a href="/recent">`)
      .replace('标题 &amp; 内容', '标题 <span title="not a timestamp">内容</span>');
    const topics = parseMembersFeed(html, 'tester');
    expect(topics.map(topic => topic.id)).toEqual([42]);
    expect(topics[0]?.updated_at).toBe(updatedAt);
  });

  it('accepts only an explicit empty state inside the selected feed box', () => {
    expect(parseMembersFeed(membersFeedHTML([]), 'tester')).toEqual([]);
    const unknown = membersFeedHTML([]).replace('还没有关注任何人', '');
    expect(() => parseMembersFeed(unknown, 'tester')).toThrow('无法确认');
    expect(() => parseMembersFeed(unknown.replace('<div id="Main">', '<div id="Main"><div class="box"><div class="cell">还没有关注任何人</div></div>'), 'tester')).toThrow('无法确认');
    expect(() => parseMembersFeed(membersFeedHTML([]).replace('tab=members', 'tab=all'), 'tester')).toThrow('帖子流');
  });

  it.each([
    'https://foreign.example/avatar/writer.png', 'data:image/png;base64,aGVsbG8=',
    'https://reader@cdn.v2ex.com/avatar/writer.png', 'https://cdn.v2ex.com:8443/avatar/writer.png',
    'https://cdn.v2ex.com/avatar/writer.png#fragment',
  ])('omits an unsafe portrait without dropping the topic: %s', avatar => {
    const topics = parseMembersFeed(membersFeedHTML([{ id: 1, avatar }]), 'tester');
    expect(topics.length).toBe(1); expect(topics[0]?.avatar_url).toBeUndefined();
  });

  it('accepts a trusted protocol-relative author avatar but never borrows title or replier images', () => {
    expect(parseMembersFeed(membersFeedHTML([{ id: 1, avatar: '//cdn.v2ex.com/avatar/writer.png' }]), 'tester')[0]?.avatar_url)
      .toBe('https://cdn.v2ex.com/avatar/writer.png');
    const fake = '<img class="avatar" src="https://cdn.v2ex.com/avatar/fake.png" alt="writer">';
    const html = membersFeedHTML([{ id: 1, avatar: null, title: `title${fake}` }])
      .replace('>lastreader</a>', `>${fake}lastreader</a>`);
    expect(parseMembersFeed(html, 'tester')[0]?.avatar_url).toBeUndefined();
    expect(parseMembersFeed(card().replace('alt="Writer"', 'alt="Other"'), 'tester')[0]?.avatar_url).toBeUndefined();
  });
});

describe('watch source validation', () => {
  it('reads an unsorted following stream and the complete membership snapshot', () => {
    const result = parseFollowing(followingHTML([{ id: 100 }, { id: 4 }, { id: 90 }], ['writer', 'second'], 4), 'tester');
    expect(result.topics.map(t => t.id)).toEqual([100, 4, 90]);
    expect(result.members).toEqual(['writer', 'second']); expect(result.pages).toBe(4);
  });
  it('reads each following topic activity time without requiring timestamp or ID order', () => {
    const time = Date.UTC(2026, 10, 8);
    const result = parseFollowing(followingHTML([
      { id: 100, updatedAt: time }, { id: 4, updatedAt: time + 60000 }, { id: 90, updatedAt: time - 60000 },
    ]), 'tester');
    expect(result.topics.map(t => [t.id, t.updatedAt])).toEqual([
      [100, time], [4, time + 60000], [90, time - 60000],
    ]);
    expect(parseFollowing(followingHTML([{ id: 1, updatedAt: time }]).replace('title="2026-', 'data-original-title="2026-'), 'tester').topics[0]?.updatedAt).toBe(time);
  });
  it('leaves missing activity timestamps absent for existing fixtures and stored progress', () => {
    expect(parseFollowing(followingHTML([{ id: 1 }]), 'tester').topics).toEqual([
      { id: 1, author: 'writer', title: '主题 1' },
    ]);
  });
  it.each(['a minute ago', '', '2026-11-08 08:00:00', '2026-13-08 08:00:00 +08:00'])(
    'rejects an explicitly invalid following activity timestamp: %s', value => {
      const html = followingHTML([{ id: 1 }]).replace('</strong>', `</strong><span title="${value}">time</span>`);
      expect(() => parseFollowing(html, 'tester')).toThrow('时间');
    },
  );
  it('ignores fake activity timestamps in topic text, nested content and unrelated row content', () => {
    const fake = '<span title="not a date">fake time</span>';
    const html = followingHTML([{ id: 1, title: `标题${fake}` }])
      .replace('</strong>', `</strong><span class="topic_content">${fake}</span>`)
      .replace('</span></div>', `</span><section class="topic_content"><span class="topic_info">${fake}</span></section></div>`);
    expect(parseFollowing(html, 'tester').topics[0]?.updatedAt).toBeUndefined();
  });
  it('rejects ambiguous activity timestamps instead of selecting an arbitrary value', () => {
    const html = followingHTML([{ id: 1, updatedAt: Date.UTC(2026, 10, 8) }])
      .replace('</strong>', '</strong><span title="2026-11-07 00:00:00 +00:00">other time</span>');
    expect(() => parseFollowing(html, 'tester')).toThrow('时间不明确');
  });
  it('distinguishes empty streams from authentication and incomplete layouts', () => {
    expect(parseFollowing(followingHTML([], []), 'tester').topics).toEqual([]);
    for (const html of ['<div id="Main"></div>', followingHTML([]).replace('no topics', ''), followingHTML([]).replace('<span>1</span>', '<span>2</span>'), '<title>Just a moment</title>']) {
      expect(() => parseFollowing(html, 'tester')).toThrow();
    }
    expect(() => parseFollowing(followingHTML([]), 'other')).toThrow();
  });
  it('rejects duplicate ids, foreign URLs, and mismatching topic identity', () => {
    expect(() => parseFollowing(followingHTML([{ id: 1 }, { id: 1 }]), 'tester')).toThrow();
    expect(() => parseFollowing(followingHTML([{ id: 1 }]).replace('href="/t/1"', 'href="https://evil.test/t/1"'), 'tester')).toThrow();
    expect(() => parseWatchedTopic(topicHTML(1, Date.now()), 'tester', 2)).toThrow();
  });
  it('rejects a redirected or inconsistent current page before using its records', () => {
    const topic = topicHTML(42, Date.now(), [{ id: 10 }], 3);
    expect(() => parseWatchedTopic(topic, 'tester', 42, 3)).toThrow('页码');
    expect(() => parseFollowing(followingHTML([{ id: 1 }], ['writer'], 4), 'tester', 2)).toThrow('页码');
    expect(() => parseWatchedTopic(topic.replace('class="page_current"', 'class="page_normal"'), 'tester', 42)).toThrow('页码');
    expect(parseWatchedTopic(topicHTML(42, Date.now(), [{ id: 10 }], 3, 'writer', 3), 'tester', 42, 3).replies[0]?.id).toBe(10);
  });
  it('keeps stable reply ids, creation timestamps and floors rather than interpreting count differences', () => {
    const time = Date.UTC(2026, 10, 8);
    const result = parseWatchedTopic(topicHTML(42, time, [{ id: 101, floor: 2 }, { id: 108, floor: 4, author: 'tester' }], 3), 'tester', 42);
    expect(result.replies).toEqual([
      { id: 101, floor: 2, author: 'reader', created: time, body: 'text', avatar: 'https://cdn.v2ex.com/avatar/reader.png' },
      { id: 108, floor: 4, author: 'tester', created: time, body: 'text', avatar: 'https://cdn.v2ex.com/avatar/tester.png' },
    ]);
    expect(result.pages).toBe(3);
    expect(absoluteTime('2026-11-08 08:00:00 +08:00')).toBe(time);
    expect(() => absoluteTime('a minute ago')).toThrow();
    expect(() => parseWatchedTopic(topicHTML(42, time, [{ id: 3 }, { id: 2 }]), 'tester', 42)).toThrow();
  });
  it('extracts comment text with image placeholders and never uses content images as a portrait', () => {
    const result = parseWatchedTopic(topicHTML(42, Date.now(), [
      { id: 1, body: '<p>看这里<img class="avatar" src="https://cdn.v2ex.com/avatar/fake.png"></p><p>第二段 &amp; 正文<script>secret()</script></p>' },
      { id: 2, avatar: 'https://evil.test/avatar.png', body: '<img src="https://example.test/image.png">' },
      { id: 3, avatar: '', body: '<img class="avatar" src="https://cdn.v2ex.com/avatar/fake.png">' },
    ]), 'tester', 42);
    expect(result.avatar).toBe('https://cdn.v2ex.com/avatar/writer.png');
    expect(result.replies[0]).toMatchObject({ body: '看这里 [图片] 第二段 & 正文', avatar: 'https://cdn.v2ex.com/avatar/reader.png' });
    expect(result.replies[1]).toMatchObject({ body: '[图片]', avatar: '' });
    expect(result.replies[2]).toMatchObject({ body: '[图片]', avatar: '' });
  });
});

describe('followed member presentation', () => {
  it('reads membership without parsing damaged topic rows or inconsistent pagination', () => {
    const html = followingHTML([{ id: 1, updatedAt: Date.UTC(2026, 10, 13) }], ['writer', 'second'], 4, 3)
      .replace('href="/t/1"', 'href="https://foreign.example/t/1"')
      .replace('title="2026-11-13T00:00:00Z"', 'title="invalid topic time"')
      .replace('>writer</a>', '>WriTer</a>')
      .replace('<img>', '<img class="avatar" src="//cdn.v2ex.com/avatar/writer.png" alt="writer">');
    expect(parseFollowedMembers(html, 'tester')).toEqual([
      { username: 'WriTer', avatar_url: 'https://cdn.v2ex.com/avatar/writer.png' }, { username: 'second' },
    ]);
    expect(() => parseFollowing(html, 'tester')).toThrow();
  });

  it('does not let missing or duplicate topic data alter an intact membership snapshot', () => {
    const base = followingHTML([], ['writer']);
    expect(parseFollowedMembers(base.replace('no topics', ''), 'tester')).toEqual([{ username: 'writer' }]);
    expect(parseFollowedMembers(followingHTML([{ id: 1 }, { id: 1 }], ['writer']), 'tester')).toEqual([{ username: 'writer' }]);
    expect(parseFollowedMembers(followingHTML([], []).replace('no topics', ''), 'tester')).toEqual([]);
  });

  it('still rejects wrong accounts, wrong routes and incomplete membership in the membership-only parser', () => {
    expect(() => parseFollowedMembers(followingHTML([], ['writer']), 'other')).toThrow('账号');
    expect(() => parseFollowedMembers(membersFeedHTML([]), 'tester')).toThrow('关注帖子列表');
    for (const html of [
      followingHTML([], ['writer']).replace('<span>1</span>', '<span>2</span>'),
      followingHTML([], ['writer']).replace('id="Rightbar"', 'id="Missing"'),
      followingHTML([], ['writer']).replace('<a href="/member/writer"><img></a>', '<a href="https://foreign.example/member/writer"><img></a>'),
      followingHTML([], ['writer']).replace('class="active"', 'class="inactive"'),
    ]) expect(() => parseFollowedMembers(html, 'tester')).toThrow();
  });

  it('omits unsafe membership portraits while preserving names independently of feed markup', () => {
    const html = followingHTML([], ['writer']).replace('<img>', '<img class="avatar" src="https://foreign.example/avatar/writer.png" alt="writer">');
    expect(parseFollowedMembers(html, 'tester')).toEqual([{ username: 'writer' }]);
  });

  it('preserves display-name casing and normalizes trusted sidebar avatars', () => {
    const html = followingHTML([{ id: 1 }], ['writer', 'second'])
      .replace('>writer</a>', '>WriTer</a>')
      .replace('>second</a>', '>Second</a>')
      .replace('<img>', '<img class="avatar" src="https://cdn.v2ex.com/avatar/writer.png?m=1" alt="WRITER">')
      .replace('<img>', '<img class="avatar" src="//cdn.v2ex.com/avatar/second.png">');
    const result = parseFollowing(html, 'tester');
    expect(result.members).toEqual(['writer', 'second']);
    expect(result.followed_members).toEqual([
      { username: 'WriTer', avatar_url: 'https://cdn.v2ex.com/avatar/writer.png?m=1' },
      { username: 'Second', avatar_url: 'https://cdn.v2ex.com/avatar/second.png' },
    ]);
  });

  it.each([
    ['foreign host', 'https://foreign.example/avatar/writer.png', 'writer'],
    ['data URL', 'data:image/png;base64,aGVsbG8=', 'writer'],
    ['userinfo', 'https://reader@cdn.v2ex.com/avatar/writer.png', 'writer'],
    ['custom port', 'https://cdn.v2ex.com:8443/avatar/writer.png', 'writer'],
    ['another member alt', 'https://cdn.v2ex.com/avatar/writer.png', 'second'],
  ])('omits an untrusted %s avatar without discarding the member', (_label, src, alt) => {
    const html = followingHTML([{ id: 1 }])
      .replace('<img>', `<img class="avatar" src="${src}" alt="${alt}">`);
    const result = parseFollowing(html, 'tester');
    expect(result.members).toEqual(['writer']);
    expect(result.followed_members).toEqual([{ username: 'writer' }]);
  });

  it.each([
    ['missing avatar class', '<img src="https://cdn.v2ex.com/avatar/writer.png" alt="writer">'],
    ['multiple images', '<img class="avatar" src="https://cdn.v2ex.com/avatar/writer.png" alt="writer"><img src="https://cdn.v2ex.com/avatar/second.png">'],
  ])('omits an ambiguous sidebar portrait with %s without discarding the member', (_label, portrait) => {
    const result = parseFollowing(followingHTML([{ id: 1 }]).replace('<img>', portrait), 'tester');
    expect(result.members).toEqual(['writer']);
    expect(result.followed_members).toEqual([{ username: 'writer' }]);
  });

  it('returns an explicit empty member presentation for an empty following list', () => {
    const result = parseFollowing(followingHTML([], []), 'tester');
    expect(result.members).toEqual([]);
    expect(result.followed_members).toEqual([]);
  });

  it('still rejects an incomplete sidebar membership count when avatars are available', () => {
    const html = followingHTML([], ['writer', 'second'])
      .replace('<span>2</span>', '<span>3</span>')
      .replace('<img>', '<img class="avatar" src="https://cdn.v2ex.com/avatar/writer.png" alt="writer">');
    expect(() => parseFollowing(html, 'tester')).toThrow('关注成员列表未读完整');
  });

  it('does not borrow a fake avatar from topic content when the sidebar avatar is absent', () => {
    const html = followingHTML([{
      id: 1,
      title: '主题 <img class="avatar" src="https://cdn.v2ex.com/avatar/fake.png" alt="writer">',
    }]);
    const result = parseFollowing(html, 'tester');
    expect(result.members).toEqual(['writer']);
    expect(result.followed_members).toEqual([{ username: 'writer' }]);
  });

  it('ignores unrelated sidebar boxes with paired non-member links and rejects duplicate member boxes', () => {
    const promo = '<div class="box"><div class="cell"><a href="/promo"><img src="/static/img/promo.png"></a><a href="/promo">Promo</a></div></div>';
    const withPromo = followingHTML([], ['tw93', 'ibireme']).replace('<div class="box">', `${promo}<div class="box">`);
    expect(parseFollowedMembers(withPromo, 'tester')).toEqual([{ username: 'tw93' }, { username: 'ibireme' }]);
    const duplicateBox = '<div class="box"><div>other</div><div><a href="/member/extra"><img></a><a href="/member/extra">extra</a></div></div>';
    const withDup = followingHTML([], ['tw93']).replace('</div></div></div>', `</div></div>${duplicateBox}</div>`);
    expect(() => parseFollowedMembers(withDup, 'tester')).toThrow('关注成员列表结构异常');
  });
});

const root = new URL('../../site-data/html_20260701/', import.meta.url);
const following = new URL('my_following/V2EX › 我的特别关注 (1).html', root);
const topic = new URL('topics/1227731/打个游戏还被骗了，很烦 - V2EX.html', root);
const memberFeed = new URL('../private/member-feed/members.html', import.meta.url);
it.skipIf(!existsSync(memberFeed))('parses the private captured members tab without publishing its content', () => {
  const html = readFileSync(memberFeed, 'utf8');
  const doc = parseDocument(html);
  const names = DomUtils.findAll(n => n.name === 'a' && (n.attribs.class ?? '').split(/\s+/).includes('top'), doc.children)
    .map(n => new URL(n.attribs.href ?? '', 'https://www.v2ex.com').pathname.match(/^\/member\/([^/]+)$/)?.[1]).filter(Boolean);
  expect(names.length).toBe(1);
  const topics = parseMembersFeed(html, names[0]!);
  expect(topics.length).toBe(49);
  expect(topics.filter(t => t.reply_count === 0).length).toBe(11);
  expect(topics.every(t => t.title && t.author && t.node_name && t.node_title && Number.isFinite(t.updated_at))).toBe(true);
  expect(topics.every(t => t.avatar_url?.startsWith('https://cdn.v2ex.com/avatar/'))).toBe(true);
  expect(new Set(topics.map(t => t.id)).size).toBe(topics.length);
});
it.skipIf(!existsSync(following))('parses the existing browser-saved following evidence', () => {
  const result = parseFollowing(readFileSync(following, 'utf8'), 'wizChen');
  expect(result.topics).toHaveLength(20);
  expect(result.topics.slice(0, 4).map(t => t.id)).toEqual([1223913, 1223638, 1221548, 1222103]);
  expect(result.topics.every(t => Number.isFinite(t.updatedAt))).toBe(true);
  expect(result.topics[0]?.updatedAt).toBe(Date.parse('2026-07-01T13:28:11+08:00'));
  expect(result.members).toContain('livid');
  expect(result.followed_members).toEqual([
    { username: 'ibireme' }, { username: 'vulgur' }, { username: 'Livid' },
  ]);
});
it.skipIf(!existsSync(topic))('parses real topic creation and all observed reply ids', () => {
  const result = parseWatchedTopic(readFileSync(topic, 'utf8'), 'wizChen', 1227731);
  expect(result.author).toBe('xiaoxiaodong'); expect(result.replies).toHaveLength(15);
  expect(result.replies[0]).toMatchObject({ id: 17872176, floor: 1, author: 'neuthself', body: 'op 单纯了一把，不过吃一堑长一智', avatar: '' });
  expect(result.created).toBe(Date.parse('2026-07-16T06:43:10Z'));
});

it('accepts user-owned deployment targets without a service binding and rejects placeholder or credential fields', () => {
  const value = { accountId: 'a'.repeat(32), databaseId: '11111111-1111-4111-8111-111111111111', workerName: 'my-notifier' };
  expect(validateDeployment(value)).toEqual(value);
  expect(() => validateDeployment({ ...value, databaseId: '00000000-0000-4000-8000-000000000001' })).toThrow();
  expect(() => validateDeployment({ ...value, token: 'secret' })).toThrow();
  expect(() => validateDeployment({ ...value, domain: 'https://example.com' })).toThrow();
});
