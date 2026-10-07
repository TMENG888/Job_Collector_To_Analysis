import fs from 'node:fs/promises';
import path from 'node:path';

const SEARCH_URL = 'https://www.nowcoder.com/search/all?query=%E7%88%AC%E8%99%AB&type=all&searchType=%E5%8E%86%E5%8F%B2%E6%90%9C%E7%B4%A2&subType=818';
const API = 'https://gw-c.nowcoder.com';
const headers = {
  'content-type': 'application/json',
  origin: 'https://www.nowcoder.com',
  referer: SEARCH_URL,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestJson(url, options = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const json = await response.json();
      if (json?.code !== 0) throw new Error(`API ${json?.code}: ${json?.msg || 'unknown error'}`);
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(300 * (2 ** (attempt - 1)));
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
  return String(text || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => entities[name.toLowerCase()] ?? m);
}

function htmlToText(value) {
  return decodeEntities(String(value || '')
    .replace(/<img[^>]*data-card-(?:emoji|nowcoder)="([^"]+)"[^>]*>/gi, '$1')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

async function fetchSearchPage(page) {
  const body = {
    type: 'all',
    query: '爬虫',
    page,
    tag: [{ id: 818, name: '面经' }],
    order: 1,
    gioParams: {},
  };
  const json = await requestJson(`${API}/api/sparta/pc/search`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return json.data;
}

async function fetchDetail(meta) {
  const { contentType, item } = meta;
  const url = contentType === 250
    ? `${API}/api/sparta/detail/content-data/detail/${item.id}`
    : `${API}/api/sparta/detail/moment-data/detail/${item.uuid}`;
  try {
    const json = await requestJson(url, { method: 'GET' });
    return { ok: true, data: json.data || {}, error: '' };
  } catch (error) {
    return { ok: false, data: {}, error: String(error.message || error) };
  }
}

async function fetchCommentPage(entityId, entityType, pageNo) {
  const params = new URLSearchParams({
    entityId: String(entityId),
    entityType: String(entityType),
    order: '1',
    pageNo: String(pageNo),
    toCommentId: '0',
  });
  return (await requestJson(`${API}/api/sparta/comment/list-by-page?${params}`, { method: 'GET' })).data;
}

async function fetchAllComments(entityId, entityType) {
  const first = await fetchCommentPage(entityId, entityType, 1);
  const pages = [first];
  for (let page = 2; page <= Number(first.totalPage || 1); page += 1) {
    pages.push(await fetchCommentPage(entityId, entityType, page));
  }
  return pages.flatMap((page) => page.records || []);
}

function postUrl(contentType, item) {
  return contentType === 250
    ? `https://www.nowcoder.com/discuss/${item.id}`
    : `https://www.nowcoder.com/feed/main/detail/${item.uuid}`;
}

function normalizePost(meta, detailResult, rank, collectedAt) {
  const { base, contentType, item } = meta;
  const detail = detailResult.data || {};
  const merged = { ...item, ...detail };
  const user = merged.userBrief || base.userBrief || {};
  const freq = merged.frequencyData || base.frequencyData || {};
  const rawContent = merged.richText || merged.content || item.content || '';
  const topics = merged.subjectData || base.subjectData || [];
  const images = merged.imgMoment || merged.contentImageUrls || [];
  const normalizedImages = images.map((image) => typeof image === 'string' ? image : image?.src).filter(Boolean);
  const id = String(merged.id ?? item.id ?? '');
  return {
    search_rank: rank + 1,
    search_page: Math.floor(rank / 20) + 1,
    keyword: '爬虫',
    category: '面经',
    post_id: id,
    uuid: String(merged.uuid ?? item.uuid ?? ''),
    content_type_code: contentType,
    content_type: contentType === 250 ? '帖子' : '动态',
    title: htmlToText(merged.title || item.title || ''),
    content_text: htmlToText(rawContent),
    content_html: String(rawContent || ''),
    author_id: String(user.userId ?? merged.authorId ?? merged.userId ?? ''),
    author_nickname: user.nickname || '',
    author_gender: user.gender || '',
    author_identity: user.authDisplayInfo || '',
    author_education: user.educationInfo || '',
    author_major: user.secondMajorName || '',
    author_work_year: user.workTime || '',
    ip_location: merged.ip4Location || '',
    created_at: iso(merged.createTime ?? merged.createdAt),
    edited_at: iso(merged.editTime),
    shown_at: iso(merged.showTime),
    edited: Boolean(merged.edited || merged.hasEdit),
    like_count: Number(freq.likeCnt || 0),
    collect_count: Number(freq.followCnt || 0),
    top_level_comment_count: Number(freq.commentCnt || 0),
    total_comment_count: Number(freq.totalCommentCnt || 0),
    view_count: Number(freq.viewCnt || 0),
    share_count: Number(freq.shareCnt || 0),
    topics: topics.map((topic) => topic?.content).filter(Boolean).join(' | '),
    image_count: normalizedImages.length,
    image_urls: normalizedImages.join('\n'),
    post_url: postUrl(contentType, item),
    search_url: SEARCH_URL,
    detail_status: detailResult.ok ? '成功' : `失败：${detailResult.error}`,
    collected_at: collectedAt,
  };
}

function normalizeComment(comment, post, parentCommentId = '', level = 1) {
  const user = comment.userBrief || {};
  const toUser = comment.toUserBrief || {};
  const freq = comment.frequencyData || {};
  return {
    comment_id: String(comment.id ?? ''),
    post_id: post.post_id,
    post_title: post.title,
    post_url: post.post_url,
    parent_comment_id: parentCommentId ? String(parentCommentId) : '',
    reply_to_comment_id: comment.toCommentId ? String(comment.toCommentId) : '',
    comment_level: level,
    author_id: String(user.userId ?? comment.authorId ?? ''),
    author_nickname: user.nickname || '',
    author_identity: user.authDisplayInfo || '',
    reply_to_user_id: comment.toUserId ? String(comment.toUserId) : '',
    reply_to_nickname: comment.toUserId ? (toUser.nickname || '') : '',
    content_text: htmlToText(comment.pureText || comment.content || ''),
    content_html: String(comment.content || ''),
    created_at: iso(comment.createTime),
    updated_at: iso(comment.updateTime),
    like_count: Number(freq.likeCnt || 0),
    reply_count: Number(freq.totalCommentCnt || 0),
    ip_location: comment.ip4Location || '',
    client_system: comment.clientSystem || '',
    accepted: Boolean(comment.isAccepted),
    wonderful: Boolean(comment.isWonderful),
    top_comment: Boolean(comment.isTop),
    status: Number(comment.status || 0),
  };
}

const firstPage = await fetchSearchPage(1);
const totalPages = Number(firstPage.totalPage || 1);
const searchPages = [firstPage];
for (let page = 2; page <= totalPages; page += 1) {
  searchPages.push(await fetchSearchPage(page));
  if (page % 5 === 0 || page === totalPages) console.log(`search pages ${page}/${totalPages}`);
}

const rawRecords = searchPages.flatMap((page) => page.records || []);
const metas = rawRecords.map(unwrapRecord);
const collectedAt = new Date().toISOString();

const detailResults = await mapLimit(metas, 8, async (meta, index) => {
  const result = await fetchDetail(meta);
  if ((index + 1) % 50 === 0 || index + 1 === metas.length) console.log(`details ${index + 1}/${metas.length}`);
  return result;
});

const posts = metas.map((meta, index) => normalizePost(meta, detailResults[index], index, collectedAt));
const commentsByPost = await mapLimit(posts, 6, async (post, index) => {
  if (!post.total_comment_count) return [];
  try {
    const topLevel = await fetchAllComments(post.post_id, post.content_type_code);
    const rows = topLevel.map((comment) => normalizeComment(comment, post));
    const parentsWithReplies = topLevel.filter((comment) => Number(comment.frequencyData?.totalCommentCnt || 0) > 0);
    const replyGroups = await mapLimit(parentsWithReplies, 3, async (parent) => {
      const replies = await fetchAllComments(parent.id, 2);
      return replies.map((reply) => normalizeComment(reply, post, parent.id, 2));
    });
    rows.push(...replyGroups.flat());
    return rows;
  } catch (error) {
    console.warn(`comments failed for ${post.post_id}: ${error.message || error}`);
    return [];
  } finally {
    if ((index + 1) % 50 === 0 || index + 1 === posts.length) console.log(`comments ${index + 1}/${posts.length}`);
  }
});

const comments = commentsByPost.flat();
const output = {
  metadata: {
    keyword: '爬虫',
    category: '面经',
    search_url: SEARCH_URL,
    api_reported_total: Number(firstPage.total || rawRecords.length),
    api_total_pages: totalPages,
    collected_post_count: posts.length,
    collected_comment_count: comments.length,
    collected_at: collectedAt,
    note: '牛客搜索接口当前最多返回20页、400条结果；评论含一级评论与回复。',
  },
  posts,
  comments,
};

const outputPath = path.resolve('work/nowcoder_crawler_data.json');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
console.log(JSON.stringify(output.metadata));
