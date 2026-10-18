// Persistent queue of bookmarks that still show a URL instead of a title.
// Worked through in short batches from an alarm, so a service worker restart loses nothing.

import { getTitleQueue, setTitleQueue, getState, setState } from "./store.js";
import { fetchTitle } from "./titles.js";
import { hasRealTitle } from "./bookmarks.js";

const ALARM = "titles";
const BATCH_MS = 45_000;
let running = false;

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
    let fixed = 0;
    let failed = 0;
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
          fixed++;
        } else {
          failed++;
        }
      }
      await setTitleQueue(queue);
    }
    if (fixed || failed) {
      const state = await getState();
      await setState({ titlesFixed: (state.titlesFixed || 0) + fixed, titlesFailed: (state.titlesFailed || 0) + failed });
    }
    if (!queue.length) await chrome.alarms.clear(ALARM);
  } finally {
    running = false;
  }
}

export async function queueLength() {
  return (await getTitleQueue()).length;
}
