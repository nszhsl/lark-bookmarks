// Storage layout:
// - chrome.storage.sync: settings (incl. App Secret and LLM key) and the sync cursor, so every
//   computer signed in to the same Chrome account shares them.
// - chrome.storage.local: things that must stay per computer — the Feishu login (refresh tokens
//   rotate, so two computers can't share one), status, and the title queue.

export const DEFAULT_CONFIG = {
  brand: "feishu", // "feishu" | "lark"
  appId: "",
  appSecret: "",
  parentFolderPath: "", // "" = "Other bookmarks"; otherwise a folder path like "其他书签 / 收藏"
  inboxName: "收件箱",
  intervalMinutes: 60,
  syncFrom: "", // YYYY-MM-DD; messages before this date are ignored
  startMode: "", // "new" | "date" | "all"; empty until the user picks where syncing starts
  // Optional automatic sorting with an OpenAI-compatible model.
  classify: false,
  llmBaseUrl: "",
  llmApiKey: "",
  llmModel: "",
  classifyExclude: ["待分类（等补完标题）", "旧书签里没归类的"], // sibling folders never used as targets
  allowNewFolders: true, // let the model create a folder when none fits
};

const DEFAULT_STATE = {
  selfChatId: "",
  lastSyncAt: 0,
  lastError: "",
  addedTotal: 0,
};

export async function getConfig() {
  let { config } = await chrome.storage.sync.get("config");
  if (!config) {
    // Settings used to live in local storage; carry them over once.
    const local = await chrome.storage.local.get("config");
    if (local.config) {
      config = local.config;
      await chrome.storage.sync.set({ config });
      await chrome.storage.local.remove("config");
    }
  }
  if (!config?.appSecret) {
    // An optional preset.json next to the manifest (git-ignored) pre-fills a fresh install.
    try {
      const res = await fetch(chrome.runtime.getURL("preset.json"));
      if (res.ok) {
        config = { ...(await res.json()), ...config };
        await chrome.storage.sync.set({ config });
      }
    } catch {
      // no preset
    }
  }
  return { ...DEFAULT_CONFIG, ...config };
}

export async function setConfig(patch) {
  const config = { ...(await getConfig()), ...patch };
  await chrome.storage.sync.set({ config });
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

// cursorMs (newest message already handled) is shared through sync so moving the job to another
// computer continues where the last one stopped.
export async function getState() {
  const [{ state }, synced] = await Promise.all([chrome.storage.local.get("state"), chrome.storage.sync.get("cursorMs")]);
  let cursorMs = synced.cursorMs;
  if (cursorMs === undefined && state?.cursorMs) {
    // The cursor used to be local; move it so it isn't mistaken for "start from the beginning".
    cursorMs = state.cursorMs;
    await chrome.storage.sync.set({ cursorMs });
  }
  return { ...DEFAULT_STATE, ...state, cursorMs: cursorMs || 0 };
}

export async function setState(patch) {
  const { cursorMs, ...rest } = patch;
  if (cursorMs !== undefined) await chrome.storage.sync.set({ cursorMs });
  const { state } = await chrome.storage.local.get("state");
  const next = { ...DEFAULT_STATE, ...state, ...rest };
  await chrome.storage.local.set({ state: next });
  return { ...next, cursorMs: cursorMs ?? (await chrome.storage.sync.get("cursorMs")).cursorMs ?? 0 };
}

// Links this computer added recently, re-checked for duplicates added by another computer.
export async function getRecentAdds() {
  const { recentAdds } = await chrome.storage.local.get("recentAdds");
  return recentAdds || [];
}

export async function setRecentAdds(recentAdds) {
  await chrome.storage.local.set({ recentAdds });
}

// Bookmark ids waiting for a title lookup, processed a few at a time.
export async function getTitleQueue() {
  const { titleQueue } = await chrome.storage.local.get("titleQueue");
  return titleQueue || [];
}

export async function setTitleQueue(titleQueue) {
  await chrome.storage.local.set({ titleQueue });
}
