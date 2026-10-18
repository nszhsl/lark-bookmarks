// Typed helpers over chrome.storage.local. Everything stays on this device; nothing is synced.

export const DEFAULT_CONFIG = {
  brand: "feishu", // "feishu" | "lark"
  appId: "",
  appSecret: "",
  parentFolderId: "", // empty = "Other bookmarks"
  inboxName: "收件箱",
  intervalMinutes: 60,
  syncFrom: "", // YYYY-MM-DD; messages before this date are ignored
};

const DEFAULT_STATE = {
  selfChatId: "",
  cursorMs: 0, // create_time of the newest message already processed
  lastSyncAt: 0,
  lastError: "",
  addedTotal: 0,
};

export async function getConfig() {
  const { config } = await chrome.storage.local.get("config");
  return { ...DEFAULT_CONFIG, ...config };
}

export async function setConfig(patch) {
  const config = { ...(await getConfig()), ...patch };
  await chrome.storage.local.set({ config });
  return config;
}

export async function getAuth() {
  const { auth } = await chrome.storage.local.get("auth");
  return auth || null;
}

export async function setAuth(auth) {
  if (auth) await chrome.storage.local.set({ auth });
  else await chrome.storage.local.remove("auth");
}

export async function getState() {
  const { state } = await chrome.storage.local.get("state");
  return { ...DEFAULT_STATE, ...state };
}

export async function setState(patch) {
  const state = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ state });
  return state;
}

// Bookmark ids waiting for a title lookup, processed a few at a time.
export async function getTitleQueue() {
  const { titleQueue } = await chrome.storage.local.get("titleQueue");
  return titleQueue || [];
}

export async function setTitleQueue(titleQueue) {
  await chrome.storage.local.set({ titleQueue });
}
