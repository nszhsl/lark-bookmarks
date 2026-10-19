// Persistent queue of bookmarks that still show a URL instead of a title.
// Worked through in short batches from an alarm, so a service worker restart loses nothing.

import { getTitleQueue, setTitleQueue, getState, setState } from "./store.js";
import { fetchTitle } from "./titles.js";
import { hasRealTitle } from "./bookmarks.js";
import { classifyBookmark, describeSorting } from "./classify.js";
import { addLog } from "./log.js";

const ALARM = "titles";
const BATCH_MS = 45_000;
let running = false;

const FAIL_REASON = { "not-html": "不是网页", "no-title": "网页没有标题", error: "打不开" };

export async function enqueueTitles(ids) {
  if (!ids.length) return;
  const queue = new Set(await getTitleQueue());
  ids.forEach((id) => queue.add(id));
  await setTitleQueue([...queue]);
  await chrome.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes: 1 });
}

// A provisional title looks like "<url>" or "<url> | <note>"; keep the note after the real title.
function noteFrom(node) {
  return node.title.startsWith(node.url) ? node.title.slice(node.url.length).replace(/^\s*\|\s*/, "").trim() : "";
}

export async function processTitleQueue() {
  if (running) return;
  running = true;
  try {
    const started = Date.now();
    let queue = await getTitleQueue();
    const fixed = [];
    const failed = [];
    const sorted = [];
    while (queue.length && Date.now() - started < BATCH_MS) {
      const [id] = queue;
      queue = queue.slice(1);
      let node = null;
      try {
        [node] = await chrome.bookmarks.get(id);
      } catch {
        // deleted since it was queued
      }
      if (node?.url && !hasRealTitle(node)) {
        const result = await fetchTitle(node.url);
        if (result.status === "ok") {
          const note = noteFrom(node);
          await chrome.bookmarks.update(id, { title: note ? `${result.title} | ${note}` : result.title });
          fixed.push({ title: result.title, url: node.url });
        } else {
          failed.push({ title: node.url, url: node.url, detail: FAIL_REASON[result.status] || result.status });
        }
        // Sort it now that it has the best title we can get (or just its URL).
        sorted.push(await classifyBookmark(id));
      }
      await setTitleQueue(queue);
    }
    if (fixed.length || failed.length) {
      const state = await getState();
      await setState({ titlesFixed: (state.titlesFixed || 0) + fixed.length, titlesFailed: (state.titlesFailed || 0) + failed.length });
      const left = queue.length ? `，还剩 ${queue.length} 个` : "，全部处理完了";
      await addLog("titles", `补标题：成功 ${fixed.length} 个${failed.length ? `，没抓到 ${failed.length} 个` : ""}${left}`, [...fixed, ...failed]);
    }
    const sorting = describeSorting(sorted);
    if (sorting) await addLog("classify", sorting.text, sorting.items);
    if (!queue.length) await chrome.alarms.clear(ALARM);
  } finally {
    running = false;
  }
}

export async function queueLength() {
  return (await getTitleQueue()).length;
}
