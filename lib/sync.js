// One sync pass: read new self-chat messages and add their links to the inbox folder.

import { getConfig, getState, setState } from "./store.js";
import { currentClient } from "./feishu.js";
import { extractLinks } from "./links.js";
import { ensureInbox, isBookmarked, provisionalTitle, hasRealTitle } from "./bookmarks.js";
import { enqueueTitles } from "./title-queue.js";

let syncing = null;

async function canReadPages() {
  return chrome.permissions.contains({ origins: ["<all_urls>"] });
}

async function run() {
  const config = await getConfig();
  const client = await currentClient(config);
  if (!client) return { error: "还没有连接飞书" };

  let state = await getState();
  try {
    const chatId = state.selfChatId || (await client.selfChatId());
    if (chatId !== state.selfChatId) state = await setState({ selfChatId: chatId });

    const fromDate = config.syncFrom ? new Date(`${config.syncFrom}T00:00:00`).getTime() : 0;
    // Messages at or before the cursor were handled by an earlier pass.
    const floor = Math.max(state.cursorMs, fromDate ? fromDate - 1 : 0);
    const inboxId = await ensureInbox(config.parentFolderId, config.inboxName);
    const needTitles = [];
    const baseTotal = state.addedTotal;
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
          if (!hasRealTitle(node)) needTitles.push(node.id);
        }
      }
      // Save progress after every page so an interrupted pass resumes where it stopped.
      await setState({ cursorMs: cursor, addedTotal: baseTotal + added });
    }

    if (needTitles.length && (await canReadPages())) await enqueueTitles(needTitles);
    await setState({ lastSyncAt: Date.now(), lastError: "" });
    return { added };
  } catch (e) {
    await setState({ lastSyncAt: Date.now(), lastError: e.message });
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
