// "整理收藏夹": look over every bookmark, report what could be cleaned up, and apply what the
// user ticks. Quick fixes (duplicates, empty folders) happen right away; slow ones (titles,
// sorting, checking for dead links) go to background queues.

import { normalizeUrl } from "./links.js";
import { hasRealTitle } from "./bookmarks.js";
import { classifyReady } from "./classify.js";
import { enqueueTitles } from "./title-queue.js";
import { enqueueJobs, getLinkCheck } from "./jobs.js";
import { addLog } from "./log.js";

const isHolding = (config, title) => title === config.inboxName || title.startsWith("待分类");

async function walkAll() {
  const [tree] = await chrome.bookmarks.getTree();
  const urls = [];
  const folders = [];
  const walk = (node, path, depth) => {
    for (const child of node.children || []) {
      const p = path ? `${path} / ${child.title}` : child.title;
      if (child.url) urls.push({ id: child.id, title: child.title, url: child.url, path, folder: node.title, dateAdded: child.dateAdded || 0 });
      else {
        folders.push({ id: child.id, title: child.title, path: p, permanent: depth === 0, node: child });
        walk(child, p, depth + 1);
      }
    }
  };
  walk(tree, "", 0);
  return { urls, folders };
}

const hasUrls = (node) => (node.children || []).some((c) => c.url || hasUrls(c));

export async function scanBookmarks(config) {
  const { urls, folders } = await walkAll();

  // Same page saved more than once: keep the copy that's already sorted, else the oldest.
  const groups = new Map();
  for (const b of urls) {
    const key = normalizeUrl(b.url) || b.url;
    groups.set(key, [...(groups.get(key) || []), b]);
  }
  const duplicates = [];
  for (const copies of groups.values()) {
    if (copies.length < 2) continue;
    copies.sort((a, b) => isHolding(config, a.folder) - isHolding(config, b.folder) || a.dateAdded - b.dateAdded);
    duplicates.push({ keep: copies[0], remove: copies.slice(1) });
  }
  const removing = new Set(duplicates.flatMap((d) => d.remove.map((r) => r.id)));
  const live = urls.filter((b) => !removing.has(b.id));

  const untitled = live.filter((b) => !hasRealTitle(b));
  const unsorted = live.filter((b) => isHolding(config, b.folder) && hasRealTitle(b));
  const emptyFolders = folders.filter((f) => !f.permanent && f.title !== config.inboxName && !hasUrls(f.node)).map(({ node, ...f }) => f);

  const check = await getLinkCheck();
  const existing = new Set(live.map((b) => b.id));
  const dead = Object.entries(check.dead || {})
    .filter(([id]) => existing.has(id))
    .map(([id, d]) => ({ id, ...d }));

  return {
    duplicates,
    untitled,
    unsorted,
    canSort: Boolean(classifyReady(config)),
    emptyFolders,
    dead,
    linkCheck: { checkedAt: check.finishedAt || 0, running: Boolean(check.startedAt && !check.finishedAt), done: check.done || 0, total: check.total || 0 },
    total: urls.length,
  };
}

// selection: {duplicates, untitled, unsorted, emptyFolders, dead} booleans
export async function applyTidy(config, selection) {
  const report = await scanBookmarks(config);
  const done = [];
  const items = [];

  if (selection.duplicates && report.duplicates.length) {
    let n = 0;
    for (const d of report.duplicates) {
      for (const r of d.remove) {
        await chrome.bookmarks.remove(r.id).catch(() => {});
        items.push({ title: r.title, url: r.url, detail: `删除重复，保留"${d.keep.path}"里的那个` });
        n++;
      }
    }
    done.push(`删除重复书签 ${n} 个`);
  }
  if (selection.dead && report.dead.length) {
    for (const d of report.dead) {
      await chrome.bookmarks.remove(d.id).catch(() => {});
      items.push({ title: d.title, url: d.url, detail: `删除：${d.reason}` });
    }
    done.push(`删除打不开的链接 ${report.dead.length} 个`);
  }
  if (selection.untitled && report.untitled.length) {
    await enqueueTitles(report.untitled.map((b) => b.id));
    done.push(`${report.untitled.length} 个书签开始在后台补标题`);
  }
  if (selection.unsorted && report.canSort && report.unsorted.length) {
    await enqueueJobs("sort", report.unsorted.map((b) => b.id));
    done.push(`${report.unsorted.length} 个书签开始在后台自动分类`);
  }
  if (selection.emptyFolders) {
    // Re-check after the removals above; deleting a folder can empty its parent, so loop.
    let removed = 0;
    for (;;) {
      const { emptyFolders } = await scanBookmarks(config);
      if (!emptyFolders.length) break;
      for (const f of emptyFolders) {
        await chrome.bookmarks.removeTree(f.id).catch(() => {});
        items.push({ title: f.path, url: "", detail: "删除空文件夹" });
        removed++;
      }
    }
    if (removed) done.push(`删除空文件夹 ${removed} 个`);
  }

  if (done.length) await addLog("tidy", `整理收藏夹：${done.join("，")}`, items);
  return { done };
}

export async function startLinkCheck() {
  const { urls } = await walkAll();
  const ids = urls.filter((b) => !/^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(b.url)).map((b) => b.id);
  await enqueueJobs("check", ids, { fresh: true });
  await addLog("tidy", `开始检查打不开的链接：共 ${ids.length} 个，在后台进行`);
  return { queued: ids.length };
}
