const at = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const membersFeedHTML = (topics: { id: number; author?: string; title?: string; avatar?: string | null;
  replyCount?: number; nodeName?: string | null; nodeTitle?: string; updatedAt?: number }[], username = 'tester') =>
  `<a class="top" href="/member/${username}">${username}</a><div id="Main"><div class="box">
  <div class="inner" id="Tabs"><a href="/?tab=all" class="tab">全部</a><a href="/?tab=members" class="tab_current">关注</a></div>
  ${topics.map(t => `<div class="cell item"><table><tbody><tr>
    <td>${t.avatar === null ? '' : `<a href="/member/${t.author ?? 'writer'}"><img class="avatar" src="${t.avatar ?? 'https://cdn.v2ex.com/avatar/' + (t.author ?? 'writer') + '.png'}" alt="${t.author ?? 'writer'}"></a>`}</td><td></td>
    <td><span class="item_title"><a class="topic-link" href="/t/${t.id}#reply${t.replyCount ?? 0}">${t.title ?? '主题 ' + t.id}</a></span>
    <span class="topic_info">${t.nodeName === null ? '' : `<a class="node" href="/go/${t.nodeName ?? 'tech'}">${t.nodeTitle ?? '技术'}</a>`}
    <strong><a href="/member/${t.author ?? 'writer'}">${t.author ?? 'writer'}</a></strong>
    ${t.updatedAt === undefined ? '' : `<span title="${at(t.updatedAt)}">last activity</span>`}
    最后回复来自 <strong><a href="/member/lastreader">lastreader</a></strong></span></td>
    <td>${t.replyCount ? `<a class="count_livid" href="/t/${t.id}#reply${t.replyCount}">${t.replyCount}</a>` : ''}</td>
  </tr></tbody></table></div>`).join('')}${topics.length ? '' : '<div class="cell">还没有关注任何人</div>'}
  <div class="inner"><a href="/recent">更多新主题</a></div></div></div>`;

export const followingHTML = (topics: { id: number; author?: string; title?: string; updatedAt?: number }[], members = ['writer'], pages = 1, page = 1) =>
  `<a class="top" href="/member/tester">tester</a><div id="Rightbar"><a href="/my/following"><span>${members.length}</span></a><div class="box"><div>people</div>${members.map(n => `<div><a href="/member/${n}"><img></a><a href="/member/${n}">${n}</a></div>`).join('')}</div></div>
  <div id="Main"><a class="active" href="/my/following">following</a>${topics.map(t => `<div class="cell item"><span class="item_title"><a href="/t/${t.id}">${t.title ?? '主题 ' + t.id}</a></span><span class="topic_info"><strong><a href="/member/${t.author ?? 'writer'}">${t.author ?? 'writer'}</a></strong>${t.updatedAt === undefined ? '' : `<span title="${at(t.updatedAt)}">last activity</span>`}</span></div>`).join('')}${topics.length ? '' : 'no topics'}<a class="page_current" href="/my/following?p=${page}">${page}</a><a class="page_normal" href="/my/following?p=${pages}">${pages}</a></div>`;

export const topicHTML = (id: number, created: number, replies: { id: number; floor?: number; author?: string; created?: number; body?: string; avatar?: string }[] = [], pages = 1, author = 'writer', page = 1) =>
  `<a class="top" href="/member/tester">tester</a><div id="Main"><div class="header"><a href="/member/${author}"><img class="avatar" src="https://cdn.v2ex.com/avatar/${author}.png"></a><h1>主题 ${id}</h1><div id="topic_${id}_votes"></div><small><a href="/member/${author}">${author}</a><span title="${at(created)}">time</span></small></div>
  ${replies.map((r, i) => `<div class="cell" id="r_${r.id}"><img class="avatar" alt="${r.author ?? 'reader'}" src="${r.avatar ?? 'https://cdn.v2ex.com/avatar/' + (r.author ?? 'reader') + '.png'}"><strong><a href="/member/${r.author ?? 'reader'}">${r.author ?? 'reader'}</a></strong><span class="no">${r.floor ?? i + 1}</span><span class="ago" title="${at(r.created ?? created)}">time</span><div class="reply_content">${r.body ?? 'text'}</div></div>`).join('')}${replies.length ? '' : '目前尚无回复'}<a class="page_current" href="/t/${id}?p=${page}">${page}</a><a class="page_normal" href="/t/${id}?p=${pages}">${pages}</a></div>`;
