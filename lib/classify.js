// Optional: sort a new bookmark into one of the folders next to the inbox, using any
// OpenAI-compatible chat model (DeepSeek, Qwen, Ollama, a relay...). Unsure answers leave it in place.

import { getConfig, setState } from "./store.js";
import { classifyTargets } from "./bookmarks.js";

const STAY = "收件箱";

function endpoint(baseUrl) {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

export function classifyReady(config) {
  return config.classify && config.llmBaseUrl && config.llmModel;
}

// Ask the model for one folder name; returns a name from `folders` or null.
export async function chooseFolder(config, { title, url }, folders) {
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
        {
          role: "system",
          content: `你是书签分类助手。根据网页标题和网址，从给定的文件夹里选一个最合适的，只输出文件夹名，不要解释。如果都不合适或拿不准，输出"${STAY}"。`,
        },
        { role: "user", content: `文件夹：${folders.join("、")}\n标题：${title}\n网址：${url}` },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `大模型接口返回 HTTP ${res.status}`);
  const answer = String(data.choices?.[0]?.message?.content || "")
    .replace(/<think>[\s\S]*?<\/think>/g, "") // reasoning models
    .trim()
    .replace(/^["'“”「」《》\s]+|["'“”「」《》。.\s]+$/g, "");
  if (folders.includes(answer)) return answer;
  // Tolerate a little extra text around the name: take the longest folder name it mentions.
  return folders.filter((f) => answer.includes(f)).sort((a, b) => b.length - a.length)[0] || null;
}

// Move a bookmark out of the inbox (or a "待分类…" holding folder) if the model is confident.
// Returns null when sorting doesn't apply, otherwise {title, url, folder} (folder null = stayed)
// or {title, url, error}, for the activity log.
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
  if (!targets.length) return null;
  const item = { title: node.title, url: node.url };
  try {
    const name = await chooseFolder(config, item, targets.map((t) => t.title));
    const target = targets.find((t) => t.title === name);
    if (target) await chrome.bookmarks.move(id, { parentId: target.id });
    await setState({ classifyError: "" });
    return { ...item, folder: target ? target.title : null };
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
  const parts = [`放进分类文件夹 ${moved.length} 个`];
  if (done.length - moved.length - failed.length) parts.push(`拿不准留在原处 ${done.length - moved.length - failed.length} 个`);
  if (failed.length) parts.push(`出错 ${failed.length} 个（${failed[0].error}）`);
  return {
    text: `自动分类：${parts.join("，")}`,
    items: done.map((r) => ({ title: r.title, url: r.url, detail: r.error ? "出错" : r.folder ? `→ ${r.folder}` : "留在原处" })),
  };
}

// For the settings page: one sample request against the user's own folders.
export async function testClassify(config) {
  const targets = await classifyTargets(config);
  const folders = targets.length ? targets.map((t) => t.title) : ["编程开发", "个人成长与生活"];
  const name = await chooseFolder(config, { title: "Claude Code 实用技巧：用好 Skills 和 MCP", url: "https://example.com/post" }, folders);
  return name || STAY;
}
