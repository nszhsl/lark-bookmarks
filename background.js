import { getConfig } from "./lib/store.js";
import { syncOnce } from "./lib/sync.js";
import { enqueueTitles, processTitleQueue, queueLength } from "./lib/title-queue.js";
import { findUntitled } from "./lib/bookmarks.js";
import { addLog } from "./lib/log.js";
import { scanBookmarks, applyTidy, startLinkCheck } from "./lib/tidy.js";
import { processJobs, jobCounts } from "./lib/jobs.js";

const SYNC_ALARM = "sync";

async function scheduleSync() {
  const { intervalMinutes } = await getConfig();
  await chrome.alarms.create(SYNC_ALARM, { delayInMinutes: 1, periodInMinutes: intervalMinutes });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await scheduleSync();
  if (reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(scheduleSync);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_ALARM) await syncOnce();
  else if (alarm.name === "titles") await processTitleQueue();
  else if (alarm.name === "jobs") await processJobs();
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

const handlers = {
  async syncNow() {
    return syncOnce();
  },
  async fixTitles() {
    const ids = await findUntitled();
    await enqueueTitles(ids);
    if (ids.length) await addLog("titles", `补全无标题书签：找到 ${ids.length} 个，开始在后台补标题`);
    return { queued: ids.length };
  },
  async configChanged() {
    await scheduleSync();
    return { ok: true };
  },
  async status() {
    return { queueLength: await queueLength(), jobs: await jobCounts() };
  },
  async tidyScan() {
    return scanBookmarks(await getConfig());
  },
  async tidyApply(msg) {
    return applyTidy(await getConfig(), msg.selection);
  },
  async tidyCheckLinks() {
    return startLinkCheck();
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: e.message }));
  return true; // keep the channel open for the async reply
});
