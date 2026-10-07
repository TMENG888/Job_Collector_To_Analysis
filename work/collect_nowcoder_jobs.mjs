import fs from 'node:fs/promises';
import path from 'node:path';

const KEYWORDS = [
  '前端工程师', '智能体开发工程师', '后端工程师', '网络安全工程师', '嵌入式开发工程师',
  '测试工程师', '运维工程师', '数据运营工程师', '数据安全工程师',
  'ai大模型算法工程师', '大模型研发工程师',
];
const API = 'https://gw-c.nowcoder.com';
const BASE_SEARCH_URL = 'https://www.nowcoder.com/search/all?type=all&subType=818&query=';
const headers = {
  'content-type': 'application/json', origin: 'https://www.nowcoder.com', referer: 'https://www.nowcoder.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextRequestAt = 0;
let requestGate = Promise.resolve();

async function rateLimit() {
  let release;
  const previous = requestGate;
  requestGate = new Promise((resolve) => { release = resolve; });
  await previous;
  const waitMs = Math.max(0, nextRequestAt - Date.now()) + Math.floor(Math.random() * 120);
  if (waitMs) await sleep(waitMs);
  nextRequestAt = Date.now() + 280;
  release();
}

async function requestJson(url, options = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rateLimit();
      const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      if (!response.ok) {
        const retryAfter = Number(response.headers.get('retry-after') || 0);
        if (retryAfter) await sleep(retryAfter * 1000);
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const json = await response.json();
      if (json?.code !== 0) throw new Error(`API ${json?.code}: ${json?.msg || 'unknown error'}`);
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(500 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 300));
    }
  }
  throw lastError;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function decodeEntities(text) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text || '').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => entities[name.toLowerCase()] ?? m);
}

function htmlToText(value) {
  return decodeEntities(String(value || '').replace(/<img[^>]*data-card-(?:emoji|nowcoder)="([^"]+)"[^>]*>/gi, '$1')
    .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p\s*>/gi, '\n').replace(/<\/div\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function iso(ms) {
  if (!ms || !Number.isFinite(Number(ms))) return '';
  return new Date(Number(ms)).toISOString();
}

function unwrapRecord(record) {
  const base = record?.data || record || {};
  const contentType = Number(base.contentType ?? record?.contentType ?? 0);
  const item = contentType === 250 ? base.contentData : base.momentData;
  return { record, base, contentType, item: item || {} };
}

function recordKey(meta) {
  return meta.contentType === 250 ? `250:${String(meta.item.id ?? '')}` : `${meta.contentType}:${String(meta.item.uuid ?? meta.item.id ?? '')}`;
}

async function fetchSearchPage(keyword, page) {
  const body = { type: 'all', query: keyword, page, tag: [{ id: 818, name: '面经' }], order: 1, gioParams: {} };
  const json = await requestJson(`${API}/api/sparta/pc/search`, {
    method: 'POST', body: JSON.stringify(body), headers: { referer: `${BASE_SEARCH_URL}${encodeURIComponent(keyword)}` },
  });
  return json.data;
}

async function fetchDetail(meta) {
  const { contentType, item } = meta;
  const url = contentType === 250 ? `${API}/api/sparta/detail/content-data/detail/${item.id}` : `${API}/api/sparta/detail/moment-data/detail/${item.uuid}`;
  try {
    const json = await requestJson(url, { method: 'GET' });
    return { ok: true, data: json.data || {}, error: '' };
  } catch (error) {
    return { ok: false, data: {}, error: String(error.message || error) };
  }
}

async function fetchCommentPage(entityId, entityType, pageNo) {
  const params = new URLSearchParams({ entityId: String(entityId), entityType: String(entityType), order: '1', pageNo: String(pageNo), toCommentId: '0' });
  return (await requestJson(`${API}/api/sparta/comment/list-by-page?${params}`, { method: 'GET' })).data;
}

async function fetchAllComments(entityId, entityType) {
  const first = await fetchCommentPage(entityId, entityType, 1);
  const pages = [first];
  for (let page = 2; page <= Number(first.totalPage || 1); page += 1) pages.push(await fetchCommentPage(entityId, entityType, page));
  return pages.flatMap((page) => page.records || []);
}

function postUrl(contentType, item) {
  return contentType === 250 ? `https://www.nowcoder.com/discuss/${item.id}` : `https://www.nowcoder.com/feed/main/detail/${item.uuid}`;
}

function normalizePost(entry, detailResult, collectedAt) {
  const { meta, hits } = entry;
  const { base, contentType, item } = meta;
  const merged = { ...item, ...(detailResult.data || {}) };
  const user = merged.userBrief || base.userBrief || {};
  const freq = merged.frequencyData || base.frequencyData || {};
  const topics = merged.subjectData || base.subjectData || [];
  const images = merged.imgMoment || merged.contentImageUrls || [];
  const normalizedImages = images.map((image) => typeof image === 'string' ? image : image?.src).filter(Boolean);
  const sortedHits = [...hits].sort((a, b) => KEYWORDS.indexOf(a.keyword) - KEYWORDS.indexOf(b.keyword));
  return {
    matched_keywords: sortedHits.map((hit) => hit.keyword).join(' | '), matched_keyword_count: sortedHits.length,
    search_positions: sortedHits.map((hit) => `${hit.keyword}:第${hit.page}页第${hit.rank}条`).join(' | '), category: '面经',
    post_id: String(merged.id ?? item.id ?? ''), uuid: String(merged.uuid ?? item.uuid ?? ''), content_type_code: contentType,
    content_type: contentType === 250 ? '帖子' : '动态', title: htmlToText(merged.title || item.title || ''),
    content_text: htmlToText(merged.richText || merged.content || item.content || ''), author_id: String(user.userId ?? merged.authorId ?? merged.userId ?? ''),
    author_nickname: user.nickname || '', author_gender: user.gender || '', author_identity: user.authDisplayInfo || '',
    author_education: user.educationInfo || '', author_major: user.secondMajorName || '', author_work_year: user.workTime || '',
    ip_location: merged.ip4Location || '', created_at: iso(merged.createTime ?? merged.createdAt), edited_at: iso(merged.editTime),
    shown_at: iso(merged.showTime), edited: Boolean(merged.edited || merged.hasEdit), like_count: Number(freq.likeCnt || 0),
    collect_count: Number(freq.followCnt || 0), top_level_comment_count: Number(freq.commentCnt || 0),
    total_comment_count: Number(freq.totalCommentCnt || 0), view_count: Number(freq.viewCnt || 0), share_count: Number(freq.shareCnt || 0),
    topics: topics.map((topic) => topic?.content).filter(Boolean).join(' | '), image_count: normalizedImages.length,
    image_urls: normalizedImages.join('\n'), post_url: postUrl(contentType, item),
    detail_status: detailResult.ok ? '成功' : `失败：${detailResult.error}`, comments_status: '未采集', collected_at: collectedAt,
  };
}

function normalizeComment(comment, post, parentCommentId = '', level = 1) {
  const user = comment.userBrief || {};
  const toUser = comment.toUserBrief || {};
  const freq = comment.frequencyData || {};
  return {
    matched_keywords: post.matched_keywords, comment_id: String(comment.id ?? ''), post_id: post.post_id, post_title: post.title,
    post_url: post.post_url, parent_comment_id: parentCommentId ? String(parentCommentId) : '',
    reply_to_comment_id: comment.toCommentId ? String(comment.toCommentId) : '', comment_level: level,
    author_id: String(user.userId ?? comment.authorId ?? ''), author_nickname: user.nickname || '', author_identity: user.authDisplayInfo || '',
    reply_to_user_id: comment.toUserId ? String(comment.toUserId) : '', reply_to_nickname: comment.toUserId ? (toUser.nickname || '') : '',
    content_text: htmlToText(comment.pureText || comment.content || ''), created_at: iso(comment.createTime), updated_at: iso(comment.updateTime),
    like_count: Number(freq.likeCnt || 0), reply_count: Number(freq.totalCommentCnt || 0), ip_location: comment.ip4Location || '',
    client_system: comment.clientSystem || '', accepted: Boolean(comment.isAccepted), wonderful: Boolean(comment.isWonderful),
    top_comment: Boolean(comment.isTop), status: Number(comment.status || 0),
  };
}

const deduped = new Map();
const searchStats = [];
for (const keyword of KEYWORDS) {
  const firstPage = await fetchSearchPage(keyword, 1);
  const totalPages = Number(firstPage.totalPage || 1);
  const pages = [firstPage];
  for (let page = 2; page <= totalPages; page += 1) pages.push(await fetchSearchPage(keyword, page));
  const records = pages.flatMap((page) => page.records || []);
  records.forEach((record, index) => {
    const meta = unwrapRecord(record);
    const key = recordKey(meta);
    const hit = { keyword, page: Math.floor(index / 20) + 1, rank: index + 1 };
    if (!deduped.has(key)) deduped.set(key, { meta, hits: [hit] }); else deduped.get(key).hits.push(hit);
  });
  searchStats.push({ keyword, api_reported_total: Number(firstPage.total || records.length), api_total_pages: totalPages, returned_records: records.length });
  console.log(`search ${keyword}: ${records.length} records, ${totalPages} pages`);
}

const entries = [...deduped.values()];
const collectedAt = new Date().toISOString();
console.log(`unique posts after deduplication: ${entries.length}`);
const detailResults = await mapLimit(entries, 4, async (entry, index) => {
  const result = await fetchDetail(entry.meta);
  if ((index + 1) % 50 === 0 || index + 1 === entries.length) console.log(`details ${index + 1}/${entries.length}`);
  return result;
});

const posts = entries.map((entry, index) => normalizePost(entry, detailResults[index], collectedAt));
const commentsByPost = await mapLimit(posts, 3, async (post, index) => {
  if (!post.total_comment_count) { post.comments_status = '成功（无评论）'; return []; }
  try {
    const topLevel = await fetchAllComments(post.post_id, post.content_type_code);
    const rows = topLevel.map((comment) => normalizeComment(comment, post));
    const parentsWithReplies = topLevel.filter((comment) => Number(comment.frequencyData?.totalCommentCnt || 0) > 0);
    const replyGroups = await mapLimit(parentsWithReplies, 2, async (parent) => {
      const replies = await fetchAllComments(parent.id, 2);
      return replies.map((reply) => normalizeComment(reply, post, parent.id, 2));
    });
    rows.push(...replyGroups.flat());
    post.comments_status = `成功（${rows.length}条）`;
    return rows;
  } catch (error) {
    post.comments_status = `失败：${String(error.message || error)}`;
    return [];
  } finally {
    if ((index + 1) % 50 === 0 || index + 1 === posts.length) console.log(`comments ${index + 1}/${posts.length}`);
  }
});

const commentMap = new Map();
for (const comment of commentsByPost.flat()) {
  const key = comment.comment_id || `${comment.post_id}:${comment.parent_comment_id}:${comment.created_at}:${comment.author_id}`;
  if (!commentMap.has(key)) commentMap.set(key, comment);
}
const comments = [...commentMap.values()];
const output = {
  metadata: {
    keywords: KEYWORDS, category: '面经', search_url_template: `${BASE_SEARCH_URL}{关键词}`, search_stats: searchStats,
    unique_post_count: posts.length, collected_comment_count: comments.length,
    failed_detail_count: posts.filter((post) => !post.detail_status.startsWith('成功')).length,
    failed_comment_post_count: posts.filter((post) => post.comments_status.startsWith('失败')).length,
    collected_at: collectedAt,
    note: '每个关键词均采集牛客搜索接口当前公开返回的全部面经结果；该接口可能限制最多20页、400条。重复帖子已合并去重，评论包含一级评论与回复。未采集原始HTML字段，未使用Cookie或登录态。',
  },
  posts, comments,
};

const outputPath = path.resolve('work/nowcoder_jobs_data.json');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
console.log(JSON.stringify(output.metadata));
