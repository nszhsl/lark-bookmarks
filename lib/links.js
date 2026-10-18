// Pull links out of Feishu message content and normalize them so the same page dedupes to one bookmark.

const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g;
// Zhihu and WeChat share text wraps the page title in 【】.
const SHARE_TITLE_RE = /【([^】]{4,})】/;
const NOTE_MAX = 40;

export function normalizeUrl(raw) {
  let url;
  try {
    url = new URL(raw.replace(/[.,;:!?'")\]]+$/, ""));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "link.zhihu.com" && url.searchParams.get("target")) return normalizeUrl(url.searchParams.get("target"));
  url.hash = "";
  if (host.endsWith("zhihu.com")) {
    url.search = "";
  } else if (host === "mp.weixin.qq.com") {
    if (url.pathname.startsWith("/s/")) {
      url.search = "";
    } else {
      const keep = new URLSearchParams();
      for (const k of ["__biz", "mid", "idx", "sn"]) if (url.searchParams.has(k)) keep.set(k, url.searchParams.get(k));
      url.search = keep.toString();
    }
  } else {
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_.*|spm|share_.*|from|scene)$/i.test(k)) url.searchParams.delete(k);
    }
  }
  return url.toString();
}

// Markdown links "[text](url)" become "text url" so both the words and the URL are kept.
const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

function collectPostText(post, texts, hrefs) {
  // Post content is either {title, content, content_v2} or wrapped in a locale key such as {zh_cn: {...}}.
  const body = Array.isArray(post?.content) ? post : Object.values(post || {}).find((v) => Array.isArray(v?.content)) || {};
  if (body.title) texts.push(body.title);
  for (const line of [...(body.content || []), ...(body.content_v2 || [])]) {
    for (const el of line || []) {
      // A link's display text belongs to that one link, so it isn't treated as a note for the message.
      if (el.tag === "a" && el.href) hrefs.push(el.href);
      else if (el.text) texts.push(el.text);
    }
  }
}

// Returns [{url, title, note}]: title comes from share text when present, note is the user's own words.
export function extractLinks(msgType, rawContent) {
  let content;
  try {
    content = JSON.parse(rawContent);
  } catch {
    return [];
  }
  const texts = [];
  const hrefs = [];
  if (msgType === "text") texts.push(content.text || "");
  else if (msgType === "post") collectPostText(content, texts, hrefs);
  else return [];

  const text = texts.join("\n").replace(MD_LINK_RE, (_, label, url) => `${label} ${url}`);
  const found = [...hrefs, ...(text.match(URL_RE) || [])];
  if (!found.length) return [];

  const shareTitle = text.match(SHARE_TITLE_RE)?.[1]?.replace(/\s*-\s*知乎$/, "").trim() || "";
  // Keep the user's note short: long text around a link is usually a message, not a label.
  const words = shareTitle ? "" : text.replace(URL_RE, " ").replace(/\s+/g, " ").trim();
  const note = words.length > NOTE_MAX ? `${words.slice(0, NOTE_MAX)}…` : words;

  const links = [];
  const seen = new Set();
  for (const raw of found) {
    const url = normalizeUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ url, title: shareTitle, note });
  }
  return links;
}
