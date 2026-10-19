// Bookmark folder lookup, dedupe and creation.
//
// Folders are referred to by a "key" like "other/收藏/文章" — the permanent folder's type followed by
// folder names — because bookmark ids differ between computers and permanent folder titles depend
// on the browser language. That way the setting means the same folder on every synced computer.

// Permanent folder ids aren't fixed once account (synced) bookmark storage is in use, so find them
// by type, preferring the copy that syncs to the Google account.
async function permanentFolders() {
  const [root] = await chrome.bookmarks.getTree();
  const byType = {};
  root.children.forEach((c, i) => {
    const type = c.folderType || ["bookmarks-bar", "other", "mobile"][i] || `root${i}`;
    if (!byType[type] || (c.syncing && !byType[type].syncing)) byType[type] = c;
  });
  return byType;
}

export async function resolveFolder(key) {
  const [type, ...names] = (key || "other").split("/");
  let node = (await permanentFolders())[type];
  for (const name of names) {
    if (!node) return null;
    node = (await chrome.bookmarks.getChildren(node.id)).find((c) => !c.url && c.title === name);
  }
  return node || null;
}

async function ensureChildFolder(parentId, title) {
  const existing = (await chrome.bookmarks.getChildren(parentId)).find((c) => !c.url && c.title === title);
  return existing || chrome.bookmarks.create({ parentId, title });
}

// The inbox folder under the chosen parent; falls back to "Other bookmarks" if that folder is gone.
export async function ensureInbox(parentKey, inboxName) {
  const parent = (await resolveFolder(parentKey)) || (await resolveFolder("other"));
  return (await ensureChildFolder(parent.id, inboxName)).id;
}

// Folders next to the inbox that new links can be sorted into.
export async function classifyTargets(config) {
  const parent = (await resolveFolder(config.parentFolderPath)) || (await resolveFolder("other"));
  const children = await chrome.bookmarks.getChildren(parent.id);
  return children.filter((c) => !c.url && c.title !== config.inboxName && !config.classifyExclude.includes(c.title));
}

export async function isBookmarked(url) {
  const found = await chrome.bookmarks.search({ url });
  return found.length > 0;
}

// Title shown before the real one is fetched. A title starting with the URL marks it as
// "needs a title"; the user's note rides along after " | " and is kept once the title arrives.
export function provisionalTitle(link) {
  const head = link.title || link.url;
  return link.note ? `${head} | ${link.note}` : head;
}

export function hasRealTitle(node) {
  return node.title && node.title !== node.url && !/^https?:\/\//i.test(node.title);
}

// Every folder as {key, label}, for the folder picker.
export async function listFolders() {
  const roots = await permanentFolders();
  const out = [];
  const walk = async (node, key, label) => {
    out.push({ key, label });
    for (const child of await chrome.bookmarks.getChildren(node.id)) {
      if (!child.url) await walk(child, `${key}/${child.title}`, `${label} / ${child.title}`);
    }
  };
  for (const type of ["bookmarks-bar", "other"]) if (roots[type]) await walk(roots[type], type, roots[type].title);
  return out;
}

// Every bookmark under a folder (or the whole tree) that still has a URL instead of a title.
export async function findUntitled(folderId) {
  const roots = folderId ? await chrome.bookmarks.getSubTree(folderId) : await chrome.bookmarks.getTree();
  const out = [];
  const walk = (node) => {
    if (node.url && !hasRealTitle(node)) out.push(node.id);
    for (const c of node.children || []) walk(c);
  };
  roots.forEach(walk);
  return out;
}
