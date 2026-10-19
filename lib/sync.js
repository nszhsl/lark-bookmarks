// One sync pass: read new self-chat messages and add their links to the inbox folder.

import { getConfig, getState, setState, getRecentAdds, setRecentAdds } from "./store.js";
import { currentClient } from "./feishu.js";
import { extractLinks } from "./links.js";
import { ensureInbox, isBookmarked, provisionalTitle, hasRealTitle } from "./bookmarks.js";
import { enqueueTitles } from "./title-queue.js";
import { classifyBookmark, describeSorting } from "./classify.js";
import { addLog } from "./log.js";

let syncing = null;
const RECENT_DAYS = 7;

// With the extension on two computers, both can add the same new link before bookmark sync
// shows each the other's copy. Recently added links are re-checked on every pass and only the
// oldest copy is kept; every computer picks the same one, so they never delete each other's last copy.
// Returns the removed copies, for the activity log.
async function removeDuplicates(justAdded) {
  const removed = [];
  const cutoff = Date.now() - RECENT_DAYS * 86400_000;
  const recent = (await getRecentAdds()).filter((r) => r.at > cutoff);
  for (const url of justAdded) recent.push({ url, at: Date.now() });
  for (const url of new Set(recent.map((r) => r.url))) {
    const copies = (await chrome.bookmarks.search({ url })).filter((b) => b.url === url);
    if (copies.length < 2) continue;
    copies.sort((a, b) => a.dateAdded - b.dateAdded || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    for (const extra of copies.slice(1)) {
      await chrome.bookmarks.remove(extra.id).then(() => removed.push({ title: extra.title, url })).catch(() => {});
    }
  }
  await setRecentAdds(recent);
  return removed;
}

async function canReadPages() {
  return chrome.permissions.contains({ origins: ["<all_urls>"] });
}

async function run() {
  const config = await getConfig();
  const client = await currentClient(config);
  if (!client) return { error: "还没有连接飞书" };
  // Nothing is imported until the user has chosen where syncing starts.
  if (!config.startMode) return { error: "还没有选择从哪天开始同步" };

  let state = await getState();
  try {
    const chatId = state.selfChatId || (await client.selfChatId());
    if (chatId !== state.selfChatId) state = await setState({ selfChatId: chatId });

    const fromDate = config.syncFrom ? new Date(`${config.syncFrom}T00:00:00`).getTime() : 0;
    // Messages at or before the cursor were handled by an earlier pass.
    const floor = Math.max(state.cursorMs, fromDate ? fromDate - 1 : 0);
    const inboxId = await ensureInbox(config.parentFolderPath, config.inboxName);
    const needTitles = [];
    const readyToSort = [];
    const titlesPossible = await canReadPages();
    const baseTotal = state.addedTotal;
    const addedItems = [];
    let added = 0;
    let cursor = floor;

    for await (const page of client.messages(chatId, floor + 1)) {
      for (const msg of page) {
        const createdAt = Number(msg.create_time);
        if (createdAt <= floor) continue;
        cursor = Math.max(cursor, createdAt);
        if (msg.deleted) continue;
        for (const link of extractLinks(msg.msg_type, msg.body?.content || "")) {
          if (await isBookmarked(link.url)) continue;
          const node = await chrome.bookmarks.create({ parentId: inboxId, title: provisionalTitle(link), url: link.url });
          added++;
          addedItems.push({ title: node.title, url: link.url });
          if (!hasRealTitle(node) && titlesPossible) needTitles.push(node.id);
          else readyToSort.push(node.id);
        }
      }
      // Save progress after every page so an interrupted pass resumes where it stopped.
      await setState({ cursorMs: cursor, addedTotal: baseTotal + added });
    }

    const removed = await removeDuplicates(addedItems.map((i) => i.url));
    await enqueueTitles(needTitles); // these get sorted once their title arrives
    const sortResults = [];
    for (const id of readyToSort) sortResults.push(await classifyBookmark(id));
    const sorting = describeSorting(sortResults);
    await setState({ lastSyncAt: Date.now(), lastError: "" });

    const titleNote = needTitles.length ? `，${needTitles.length} 个正在后台补标题` : "";
    await addLog("sync", added ? `同步：新增 ${added} 个链接到"${config.inboxName}"${titleNote}` : "同步：没有新链接", addedItems);
    if (removed.length) await addLog("sync", `去重：删掉了 ${removed.length} 个其他电脑也加过的重复书签`, removed);
    if (sorting) await addLog("classify", sorting.text, sorting.items);
    return { added };
  } catch (e) {
    await setState({ lastSyncAt: Date.now(), lastError: e.message });
    await addLog("error", `同步失败：${e.message}`);
    return { error: e.message };
  }
}

// Concurrent callers (alarm + "sync now" button) share one in-flight pass.
export function syncOnce() {
  syncing ||= run().finally(() => {
    syncing = null;
  });
  return syncing;
}
