// Activity log shown on the settings page: what the extension did, when, and with which links.
// Kept per computer in local storage, newest last, capped in size.

const MAX_ENTRIES = 300;
const MAX_ITEMS = 200; // links listed under one entry

// kind: "sync" | "titles" | "classify" | "error"; items: [{title, url, detail?}]
export async function addLog(kind, text, items = []) {
  const { activity = [] } = await chrome.storage.local.get("activity");
  const last = activity.at(-1);
  // Quiet hourly syncs would bury everything else; fold repeats of "nothing new" into one line.
  if (kind === "sync" && !items.length && last?.kind === "sync" && !last.items?.length && last.text === text) {
    last.at = Date.now();
    last.repeat = (last.repeat || 1) + 1;
  } else {
    activity.push({ at: Date.now(), kind, text, items: items.slice(0, MAX_ITEMS), more: Math.max(0, items.length - MAX_ITEMS) });
  }
  await chrome.storage.local.set({ activity: activity.slice(-MAX_ENTRIES) });
}

export async function getLog() {
  const { activity = [] } = await chrome.storage.local.get("activity");
  return activity;
}

export async function clearLog() {
  await chrome.storage.local.remove("activity");
}
