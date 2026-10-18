// Bookmark folder lookup, dedupe and creation.

// Permanent folder ids aren't fixed once account (synced) bookmark storage is in use,
// so find "Other bookmarks" by type, preferring the copy that syncs to the Google account.
async function otherBookmarksId() {
  const [root] = await chrome.bookmarks.getTree();
  const others = root.children.filter((c) => c.folderType === "other");
  return (others.find((c) => c.syncing) || others[0] || root.children[1] || root.children[0]).id;
}

export async function ensureInbox(parentFolderId, inboxName) {
  let parentId = parentFolderId;
  try {
    if (parentId) await chrome.bookmarks.get(parentId);
  } catch {
    parentId = ""; // the chosen folder was deleted
  }
  parentId ||= await otherBookmarksId();
  const children = await chrome.bookmarks.getChildren(parentId);
  const existing = children.find((c) => !c.url && c.title === inboxName);
  if (existing) return existing.id;
  return (await chrome.bookmarks.create({ parentId, title: inboxName })).id;
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

// Folders as a flat list with their full path, for the folder picker.
export async function listFolders() {
  const [root] = await chrome.bookmarks.getTree();
  const out = [];
  const walk = (node, path) => {
    for (const child of node.children || []) {
      if (child.url) continue;
      const p = path ? `${path} / ${child.title}` : child.title;
      out.push({ id: child.id, path: p });
      walk(child, p);
    }
  };
  walk(root, "");
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
