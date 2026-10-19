// Background queues for slow, per-bookmark work started from "整理收藏夹":
// - "sort":  ask the model which folder a bookmark belongs in
// - "check": open a bookmark's page to see whether it still exists
// Worked through in short batches from an alarm, like the title queue.

import { classifyBookmark, describeSorting } from "./classify.js";
import { waitForHost } from "./titles.js";
import { addLog } from "./log.js";

const ALARM = "jobs";
const BATCH_MS = 45_000;
let running = false;

async function getQueue(kind) {
  const key = `jobs_${kind}`;
  return (await chrome.storage.local.get(key))[key] || [];
}

async function setQueue(kind, ids) {
  await chrome.storage.local.set({ [`jobs_${kind}`]: ids });
}

export async function getLinkCheck() {
  return (await chrome.storage.local.get("linkCheck")).linkCheck || {};
}

async function setLinkCheck(patch) {
  await chrome.storage.local.set({ linkCheck: { ...(await getLinkCheck()), ...patch } });
}

export async function enqueueJobs(kind, ids, { fresh = false } = {}) {
  if (!ids.length) return;
  if (kind === "check" && fresh) {
    await setLinkCheck({ startedAt: Date.now(), finishedAt: 0, total: ids.length, done: 0, dead: {} });
    await setQueue(kind, ids);
  } else {
    await setQueue(kind, [...new Set([...(await getQueue(kind)), ...ids])]);
  }
  await chrome.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes: 1 });
}

export async function jobCounts() {
  return { sort: (await getQueue("sort")).length, check: (await getQueue("check")).length };
}

const DEAD_TITLE = /^(404|not found|page not found|页面不存在|您访问的页面不存在|百度网盘-链接不存在|链接不存在|该内容已被删除)/i;
const WECHAT_GONE = /已被发布者删除|涉嫌违反|无法查看|已自主注销|该公众号已迁移/;

// Returns why the page is gone, or null if it's there (or we can't tell — e.g. a login wall).
async function whyDead(url) {
  await waitForHost(new URL(url).hostname);
  try {
    const res = await fetch(url, { credentials: "include", redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (res.status === 404 || res.status === 410) return `网页不存在（HTTP ${res.status}）`;
    if (!res.ok || !/html/i.test(res.headers.get("content-type") || "html")) return null;
    const html = (await res.text()).slice(0, 300_000);
    if (/mp\.weixin\.qq\.com/.test(url) && !/og:title/.test(html) && WECHAT_GONE.test(html)) return "公众号文章已被删除";
    const title = (html.match(/<title[^>]*>([^<]*)/i)?.[1] || "").trim();
    if (DEAD_TITLE.test(title)) return `网页不存在（${title.slice(0, 20)}）`;
    return null;
  } catch {
    return null; // offline, timeout, blocked: not proof that the page is gone
  }
}

async function runSort(deadline) {
  let queue = await getQueue("sort");
  const results = [];
  while (queue.length && Date.now() < deadline) {
    const [id] = queue;
    queue = queue.slice(1);
    results.push(await classifyBookmark(id));
    await setQueue("sort", queue);
  }
  const sorting = describeSorting(results);
  if (sorting) await addLog("classify", sorting.text + (queue.length ? `，还剩 ${queue.length} 个` : "，全部处理完了"), sorting.items);
}

async function runCheck(deadline) {
  let queue = await getQueue("check");
  if (!queue.length) return;
  const check = await getLinkCheck();
  const dead = { ...(check.dead || {}) };
  const found = [];
  let done = check.done || 0;
  while (queue.length && Date.now() < deadline) {
    const [id] = queue;
    queue = queue.slice(1);
    let node = null;
    try {
      [node] = await chrome.bookmarks.get(id);
    } catch {
      // deleted meanwhile
    }
    if (node?.url) {
      const reason = await whyDead(node.url);
      if (reason) {
        dead[id] = { title: node.title, url: node.url, reason };
        found.push({ title: node.title, url: node.url, detail: reason });
      }
    }
    done++;
    await setQueue("check", queue);
  }
  await setLinkCheck({ dead, done, finishedAt: queue.length ? 0 : Date.now() });
  if (!queue.length) {
    await addLog("tidy", `检查完打不开的链接：共 ${check.total || done} 个，发现 ${Object.keys(dead).length} 个打不开，可以在"整理收藏夹"里删除`, found);
  }
}

export async function processJobs() {
  if (running) return;
  running = true;
  try {
    const deadline = Date.now() + BATCH_MS;
    // Share each batch: sorting is quick per item, link checks are paced per site.
    await runSort(Date.now() + BATCH_MS / 3);
    await runCheck(deadline);
    const counts = await jobCounts();
    if (!counts.sort && !counts.check) await chrome.alarms.clear(ALARM);
  } finally {
    running = false;
  }
}
