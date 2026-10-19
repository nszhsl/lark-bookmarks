// Fetch page titles from inside the browser, so sites that need a login (e.g. Zhihu) work with the
// user's own session. Requests to the same host are spaced out to stay clear of anti-bot limits.

const SLOW_HOSTS = [/(^|\.)zhihu\.com$/i, /(^|\.)weixin\.qq\.com$/i];
const lastHit = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForHost(host) {
  const gap = SLOW_HOSTS.some((re) => re.test(host)) ? 3000 : 500;
  const wait = (lastHit.get(host) || 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (/(property|name)\s*=\s*["']og:title["']/i.test(tag)) {
      const m = tag.match(/content\s*=\s*(["'])([\s\S]*?)\1/i);
      if (m && m[2].trim()) return decodeEntities(m[2]);
    }
  }
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? decodeEntities(t[1]) : "";
}

// Bot checks and error pages have titles too; never store those as a bookmark title.
const USELESS_TITLE = /^(just a moment|attention required|rate limit|安全验证|访问验证|404|not found|page not found|502 bad gateway)/i;

export async function fetchTitle(url) {
  const host = new URL(url).hostname;
  await waitForHost(host);
  try {
    const res = await fetch(url, { credentials: "include", redirect: "follow", signal: AbortSignal.timeout(20000) });
    const type = res.headers.get("content-type") || "";
    if (type && !/html|xml/i.test(type)) return { status: "not-html" };
    const buf = await res.arrayBuffer();
    const head = new TextDecoder("latin1").decode(buf.slice(0, 4096));
    const charset = type.match(/charset=([\w-]+)/i)?.[1] || head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || "utf-8";
    let html;
    try {
      html = new TextDecoder(charset.toLowerCase()).decode(buf);
    } catch {
      html = new TextDecoder().decode(buf);
    }
    const title = extractTitle(html).replace(/\s*-\s*知乎$/, "");
    if (!res.ok) return { status: `http-${res.status}` };
    if (!title || USELESS_TITLE.test(title)) return { status: "no-title" };
    return { status: "ok", title };
  } catch (e) {
    return { status: "error", error: String(e?.name || e) };
  }
}
