// Optional: sort a new bookmark into a folder next to the inbox, using any OpenAI-compatible chat
// model (DeepSeek, Qwen, Ollama, a relay...). The model picks an existing folder, or — when none
// fits and the user allows it — names a new one. Unsure answers leave the bookmark in place.

import { getConfig, setState } from "./store.js";
import { classifyTargets, classifyParent } from "./bookmarks.js";

const STAY = "收件箱";
export const MAX_FOLDERS = 20;
const NEW_PREFIX = /^新建\s*[:：]\s*/;

function endpoint(baseUrl) {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

export function classifyReady(config) {
  return config.classify && config.llmBaseUrl && config.llmModel;
}

function systemPrompt(canCreate) {
  const lines = [
    "你是书签分类助手。根据网页标题和网址，从已有文件夹里选一个最合适的，只输出文件夹名，不要解释。",
  ];
  if (canCreate) {
    lines.push(
      '如果没有合适的已有文件夹，可以新建一个：输出"新建：文件夹名"。文件夹名 2 到 8 个字，概括一类主题而不是这一篇的内容，' +
        '例如"前端开发"而不是"React 19 新特性"；和已有文件夹意思相近时，直接用已有的。'
    );
  }
  lines.push(`如果拿不准，输出"${STAY}"。`);
  return lines.join("\n");
}

const clean = (s) => s.trim().replace(/^["'“”「」《》【】\s]+|["'“”「」《》【】。.\s]+$/g, "");

// Ask the model where a link belongs. Returns {folder} for an existing folder, {create} for a new
// folder name, or null to leave it where it is.
export async function chooseFolder(config, { title, url }, folders, canCreate) {
  const res = await fetch(endpoint(config.llmBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.llmApiKey ? { authorization: `Bearer ${config.llmApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.llmModel,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt(canCreate) },
        { role: "user", content: `已有文件夹：${folders.length ? folders.join("、") : "（还没有）"}\n标题：${title}\n网址：${url}` },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `大模型接口返回 HTTP ${res.status}`);
  const answer = clean(String(data.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, ""));

  if (NEW_PREFIX.test(answer)) {
    const name = clean(answer.replace(NEW_PREFIX, "")).replace(/[\/\\]/g, "").slice(0, 12);
    if (folders.includes(name)) return { folder: name };
    if (!canCreate || !name || name === STAY) return null;
    return { create: name };
  }
  if (folders.includes(answer)) return { folder: answer };
  // Tolerate a little extra text around the name: take the longest folder name it mentions.
  const mentioned = folders.filter((f) => answer.includes(f)).sort((a, b) => b.length - a.length)[0];
  return mentioned ? { folder: mentioned } : null;
}

// Move a bookmark out of the inbox (or a "待分类…" holding folder) if the model is confident.
// Returns null when sorting doesn't apply, otherwise {title, url, folder, created} (folder null =
// stayed) or {title, url, error}, for the activity log.
export async function classifyBookmark(id) {
  const config = await getConfig();
  if (!classifyReady(config)) return null;
  let node;
  try {
    [node] = await chrome.bookmarks.get(id);
  } catch {
    return null; // deleted meanwhile
  }
  const [parent] = await chrome.bookmarks.get(node.parentId);
  if (parent.title !== config.inboxName && !parent.title.startsWith("待分类")) return null;

  const targets = await classifyTargets(config);
  const canCreate = config.allowNewFolders && targets.length < MAX_FOLDERS;
  if (!targets.length && !canCreate) return null;
  const item = { title: node.title, url: node.url };
  try {
    const choice = await chooseFolder(config, item, targets.map((t) => t.title), canCreate);
    let target = choice?.folder ? targets.find((t) => t.title === choice.folder) : null;
    if (choice?.create) {
      const home = await classifyParent(config);
      target = await chrome.bookmarks.create({ parentId: home.id, title: choice.create });
    }
    if (target) await chrome.bookmarks.move(id, { parentId: target.id });
    await setState({ classifyError: "" });
    return { ...item, folder: target ? target.title : null, created: Boolean(choice?.create) };
  } catch (e) {
    await setState({ classifyError: e.message });
    return { ...item, error: e.message };
  }
}

// One log entry for a batch of classifyBookmark results.
export function describeSorting(results) {
  const done = results.filter(Boolean);
  if (!done.length) return null;
  const moved = done.filter((r) => r.folder);
  const failed = done.filter((r) => r.error);
  const created = [...new Set(done.filter((r) => r.created).map((r) => r.folder))];
  const stayed = done.length - moved.length - failed.length;
  const parts = [`放进分类文件夹 ${moved.length} 个`];
  if (created.length) parts.push(`新建文件夹：${created.join("、")}`);
  if (stayed) parts.push(`拿不准留在原处 ${stayed} 个`);
  if (failed.length) parts.push(`出错 ${failed.length} 个（${failed[0].error}）`);
  return {
    text: `自动分类：${parts.join("，")}`,
    items: done.map((r) => ({
      title: r.title,
      url: r.url,
      detail: r.error ? "出错" : r.folder ? `→ ${r.folder}${r.created ? "（新建）" : ""}` : "留在原处",
    })),
  };
}

// For the settings page: one sample request against the user's own folders. Creates nothing.
export async function testClassify(config) {
  const targets = await classifyTargets(config);
  const choice = await chooseFolder(
    config,
    { title: "Claude Code 实用技巧：用好 Skills 和 MCP", url: "https://example.com/post" },
    targets.map((t) => t.title),
    config.allowNewFolders && targets.length < MAX_FOLDERS
  );
  if (choice?.create) return `新建文件夹"${choice.create}"（测试不会真的新建）`;
  return choice?.folder || STAY;
}
