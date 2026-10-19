import { getConfig, setConfig, getAuth, setAuth, getState, setState } from "./lib/store.js";
import { connect, REQUIRED_SCOPES, hosts } from "./lib/feishu.js";
import { listFolders, classifyTargets } from "./lib/bookmarks.js";
import { testClassify } from "./lib/classify.js";
import { getLog } from "./lib/log.js";

const $ = (id) => document.getElementById(id);
const ALL_SITES = { origins: ["<all_urls>"] };
const STEP_TITLES = { step1: "填写飞书应用信息", step2: "连接飞书", step3: "开始同步" };

function feedback(id, text, kind = "ok") {
  $(id).textContent = text;
  $(id).className = kind === "ok" ? "feedback" : `feedback ${kind}`;
}

// Brief "已保存" next to whatever was just changed.
const savedTimers = {};
function flashSaved(id) {
  feedback(id, "已保存 ✓");
  clearTimeout(savedTimers[id]);
  savedTimers[id] = setTimeout(() => feedback(id, ""), 2000);
}

// ---- step layout: done / current / locked ----

async function renderSteps() {
  const config = await getConfig();
  const auth = await getAuth();
  const done = {
    step1: Boolean(config.appId && config.appSecret),
    step2: Boolean(auth),
    step3: Boolean(config.startMode),
  };
  const subtitle = {
    step1: done.step1 ? ` · ${config.appId}` : "",
    step2: auth ? ` · 已连接：${auth.name || auth.openId}` : "",
    step3: done.step3 ? " · 运行中" : "",
  };
  let reachedCurrent = false;
  ["step1", "step2", "step3"].forEach((id, i) => {
    const el = $(id);
    const isCurrent = !done[id] && !reachedCurrent;
    const locked = !done[id] && !isCurrent;
    if (isCurrent) reachedCurrent = true;
    el.classList.toggle("done", done[id]);
    el.classList.toggle("current", isCurrent);
    el.classList.toggle("locked", locked);
    el.querySelector(".badge").textContent = done[id] ? "✓" : String(i + 1);
    el.querySelector("h2").lastChild.textContent = STEP_TITLES[id] + subtitle[id];
  });
  // A finished step folds away once the next one is done too; its header reopens it.
  if (!$("step1").dataset.userOpened) $("step1").classList.toggle("collapsed", done.step1 && done.step2);
  if (!$("step2").dataset.userOpened) $("step2").classList.toggle("collapsed", done.step2 && done.step3);
  $("startChoice").style.display = done.step3 ? "none" : "";
  $("running").style.display = done.step3 ? "" : "none";
  $("activitySection").style.display = done.step3 ? "" : "none";
  $("settingsSection").style.display = done.step3 ? "" : "none";
  $("tidySection").style.display = done.step3 ? "" : "none";
  $("disconnect").style.display = auth ? "" : "none";
  $("connect").textContent = auth ? "重新连接" : "连接飞书";
  $("guide").open = !done.step1;
}

for (const id of ["step1", "step2"]) {
  $(id).querySelector("h2").addEventListener("click", () => {
    if (!$(id).classList.contains("done")) return;
    $(id).dataset.userOpened = "1";
    $(id).classList.toggle("collapsed");
  });
}

// ---- step 1: app credentials, saved as you type ----

async function renderGuide(brand) {
  $("consoleLink").href = hosts(brand).console;
  $("redirectUrl").textContent = chrome.identity.getRedirectURL();
  $("scopeList").replaceChildren(
    ...REQUIRED_SCOPES.map(({ scope, label }) => {
      const li = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = scope;
      li.append(code, ` ${label}`);
      return li;
    })
  );
}

$("copyRedirect").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("redirectUrl").textContent);
  $("copyRedirect").textContent = "已复制 ✓";
  setTimeout(() => ($("copyRedirect").textContent = "复制"), 2000);
});

let credTimer;
function saveCredentialsSoon() {
  clearTimeout(credTimer);
  credTimer = setTimeout(async () => {
    await setConfig({ brand: $("brand").value, appId: $("appId").value.trim(), appSecret: $("appSecret").value.trim() });
    flashSaved("feedback1");
    renderSteps();
  }, 400);
}
$("appId").addEventListener("input", saveCredentialsSoon);
$("appSecret").addEventListener("input", saveCredentialsSoon);
$("brand").addEventListener("change", (e) => {
  renderGuide(e.target.value);
  saveCredentialsSoon();
});

// ---- step 2: connect ----

$("connect").addEventListener("click", async () => {
  const config = await getConfig();
  $("connect").disabled = true;
  feedback("feedback2", '正在打开飞书授权窗口，请在窗口里点"授权"……', "busy");
  try {
    await setAuth(await connect(config));
    feedback("feedback2", "连接成功 ✓");
  } catch (e) {
    console.error("connect failed", e);
    feedback("feedback2", `连接失败：${e.message}`, "error");
  } finally {
    $("connect").disabled = false;
    renderSteps();
  }
});

$("disconnect").addEventListener("click", async () => {
  await setAuth(null);
  feedback("feedback2", "已断开连接");
  renderSteps();
});

// ---- step 3: choose a starting point, then start ----

$("startDate").addEventListener("focus", () => (document.querySelector('input[value="date"]').checked = true));

$("start").addEventListener("click", async () => {
  const mode = document.querySelector('input[name="startMode"]:checked').value;
  const date = $("startDate").value;
  if (mode === "date" && !date) return feedback("feedback3", "请选一个日期", "error");

  // Ask for page access while we still have the click (Chrome requires a user gesture).
  const granted = await chrome.permissions.request(ALL_SITES);
  if (mode === "new") await setState({ cursorMs: Date.now() });
  else await setState({ cursorMs: 0 });
  await setConfig({ startMode: mode, syncFrom: mode === "date" ? date : "" });

  $("start").disabled = true;
  feedback("feedback3", "正在同步……", "busy");
  const result = await chrome.runtime.sendMessage({ type: "syncNow" });
  $("start").disabled = false;
  await renderSteps();
  await renderRunning();
  if (result?.error) feedback("feedback4", `同步失败：${result.error}`, "error");
  else {
    const note = mode === "new" ? "以后你发给自己的链接会自动出现在书签的收件箱里。" : `这次加入了 ${result.added} 个书签。`;
    feedback("feedback4", `已开始同步 ✓ ${note}${granted ? "" : "（没有允许读取网页标题，书签会先显示网址）"}`);
  }
});

$("restart").addEventListener("click", async () => {
  await setConfig({ startMode: "" });
  renderSteps();
});

// ---- running: status, actions, more settings ----

function relative(ms) {
  if (!ms) return "还没有";
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  if (min < 24 * 60) return `${Math.round(min / 60)} 小时前`;
  return new Date(ms).toLocaleString();
}

function clock(ms) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

async function renderRunning() {
  const state = await getState();
  const { queueLength } = await chrome.runtime.sendMessage({ type: "status" });
  const alarm = await chrome.alarms.get("sync");
  const parts = [`上次同步：${relative(state.lastSyncAt)}`];
  if (alarm) parts.push(`下次同步：${clock(alarm.scheduledTime)}`);
  parts.push(`累计加入 ${state.addedTotal} 个`);
  if (queueLength) parts.push(`后台正在补标题，还剩 ${queueLength} 个`);
  $("summary").replaceChildren(
    ...parts.flatMap((p, i) => (i ? [Object.assign(document.createElement("span"), { className: "sep", textContent: "·" }), p] : [p]))
  );
  $("permWarning").style.display = (await chrome.permissions.contains(ALL_SITES)) ? "none" : "";
  await renderActivity();
}

// ---- activity log ----

const KIND_LABEL = { sync: "同步", titles: "补标题", classify: "分类", tidy: "整理", error: "出错" };
let activityLimit = 20;

async function renderActivity() {
  const entries = (await getLog()).slice().reverse();
  const list = $("activity");
  if (!entries.length) {
    list.replaceChildren(Object.assign(document.createElement("li"), { className: "empty", textContent: "还没有记录。" }));
    $("moreActivity").style.display = "none";
    return;
  }
  list.replaceChildren(
    ...entries.slice(0, activityLimit).map((e) => {
      const li = document.createElement("li");
      const time = Object.assign(document.createElement("time"), { textContent: clock(e.at), title: new Date(e.at).toLocaleString() });
      const body = document.createElement("div");
      const text = Object.assign(document.createElement("div"), { textContent: e.text + (e.repeat ? `（这段时间同步了 ${e.repeat} 次，都没有新链接）` : "") });
      if (e.kind === "error") text.className = "error";
      body.append(text);
      if (e.items?.length) {
        const details = document.createElement("details");
        details.append(Object.assign(document.createElement("summary"), { textContent: `查看 ${e.items.length + (e.more || 0)} 个` }));
        const ul = document.createElement("ul");
        for (const item of e.items) {
          const row = document.createElement("li");
          row.append(Object.assign(document.createElement("a"), { href: item.url, target: "_blank", rel: "noreferrer", textContent: item.title || item.url }));
          if (item.detail) row.append(Object.assign(document.createElement("span"), { className: "detail", textContent: item.detail }));
          ul.append(row);
        }
        if (e.more) ul.append(Object.assign(document.createElement("li"), { textContent: `……还有 ${e.more} 个` }));
        details.append(ul);
        body.append(details);
      }
      li.append(time, body);
      return li;
    })
  );
  $("moreActivity").style.display = entries.length > activityLimit ? "" : "none";
}

$("moreActivity").addEventListener("click", () => {
  activityLimit += 50;
  renderActivity();
});

$("grantPerm").addEventListener("click", async () => {
  const granted = await chrome.permissions.request(ALL_SITES);
  feedback("feedback4", granted ? "已允许读取网页标题 ✓" : "没有获得权限", granted ? "ok" : "error");
  renderRunning();
});

$("syncNow").addEventListener("click", async () => {
  $("syncNow").disabled = true;
  feedback("feedback4", "正在同步……", "busy");
  const result = await chrome.runtime.sendMessage({ type: "syncNow" });
  $("syncNow").disabled = false;
  if (result?.error) feedback("feedback4", `同步失败：${result.error}`, "error");
  else feedback("feedback4", result.added ? `同步完成 ✓ 新加入 ${result.added} 个书签` : "同步完成 ✓ 没有新链接");
  renderRunning();
});

$("fixTitles").addEventListener("click", async () => {
  const { queued } = await chrome.runtime.sendMessage({ type: "fixTitles" });
  feedback("feedback4", queued ? `已开始补标题 ✓ 共 ${queued} 个，在后台慢慢处理，可以关掉这个页面` : "没有找到无标题的书签");
  renderRunning();
});

async function saveMore() {
  await setConfig({
    parentFolderPath: $("parentFolder").value,
    inboxName: $("inboxName").value.trim() || "收件箱",
    intervalMinutes: Number($("interval").value),
  });
  await chrome.runtime.sendMessage({ type: "configChanged" });
  flashSaved("feedback5");
}
$("parentFolder").addEventListener("change", saveMore);
$("interval").addEventListener("change", saveMore);
$("inboxName").addEventListener("change", saveMore);

// ---- tidy up ----

function itemList(items, describe) {
  const details = document.createElement("details");
  details.append(Object.assign(document.createElement("summary"), { textContent: "查看" }));
  const ul = document.createElement("ul");
  for (const item of items.slice(0, 300)) {
    const li = document.createElement("li");
    const { title, url, detail } = describe(item);
    li.append(url ? Object.assign(document.createElement("a"), { href: url, target: "_blank", rel: "noreferrer", textContent: title || url }) : title);
    if (detail) li.append(Object.assign(document.createElement("span"), { className: "detail", textContent: detail }));
    ul.append(li);
  }
  if (items.length > 300) ul.append(Object.assign(document.createElement("li"), { textContent: `……还有 ${items.length - 300} 个` }));
  details.append(ul);
  return details;
}

// One line in the report: a checkbox (or why it can't be ticked), a hint, and the items.
function tidyRow({ key, label, count, checked, disabledReason, hint, items, describe }) {
  const row = document.createElement("div");
  row.className = "tidy-row";
  const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: checked && !disabledReason && count > 0, disabled: Boolean(disabledReason) || !count });
  box.dataset.key = key;
  const lab = document.createElement("label");
  lab.className = "radio";
  lab.append(box, ` ${label}：${count} 个`);
  row.append(lab);
  const note = disabledReason || hint;
  if (note) row.append(Object.assign(document.createElement("p"), { className: "hint", textContent: note }));
  if (count && items) row.append(itemList(items, describe));
  return row;
}

async function startLinkCheckClick() {
  const { queued } = await chrome.runtime.sendMessage({ type: "tidyCheckLinks" });
  feedback("feedback7", `已开始在后台检查 ${queued} 个链接，可以关掉这个页面`);
  renderTidy(await chrome.runtime.sendMessage({ type: "tidyScan" }));
}

function renderTidy(report) {
  const asBookmark = (b) => ({ title: b.title, url: b.url, detail: b.path });
  const rows = [
    tidyRow({
      key: "duplicates",
      label: "删除重复的书签",
      count: report.duplicates.reduce((n, d) => n + d.remove.length, 0),
      checked: true,
      hint: "同一个网页存了多份，只保留一份（优先保留已经分好类的那份）。",
      items: report.duplicates.flatMap((d) => d.remove.map((r) => ({ ...r, keepPath: d.keep.path }))),
      describe: (r) => ({ title: r.title, url: r.url, detail: `在"${r.path}"，保留"${r.keepPath}"里的` }),
    }),
    tidyRow({
      key: "untitled",
      label: "给没有标题的书签补标题",
      count: report.untitled.length,
      checked: true,
      hint: "在后台慢慢抓，知乎每个约 3 秒。",
      items: report.untitled,
      describe: asBookmark,
    }),
    tidyRow({
      key: "unsorted",
      label: "把收件箱和待分类里的书签自动分类",
      count: report.unsorted.length,
      checked: true,
      disabledReason: report.canSort ? "" : "要先在下面的设置里开启自动分类并填好大模型。",
      hint: "用你设置的大模型在后台分；没标题的会在补完标题后再分。",
      items: report.unsorted,
      describe: asBookmark,
    }),
    tidyRow({
      key: "emptyFolders",
      label: "删除空文件夹",
      count: report.emptyFolders.length,
      checked: true,
      items: report.emptyFolders,
      describe: (f) => ({ title: f.path }),
    }),
  ];

  // Dead links need a slow background check first.
  const lc = report.linkCheck;
  if (lc.running) {
    rows.push(Object.assign(document.createElement("div"), { className: "tidy-row", textContent: `正在后台检查打不开的链接：${lc.done} / ${lc.total}。检查完后再点"检查收藏夹"就能看到结果。` }));
  } else if (lc.checkedAt) {
    const row = tidyRow({
      key: "dead",
      label: "删除打不开的链接",
      count: report.dead.length,
      checked: false,
      hint: `${clock(lc.checkedAt)} 检查的结果。默认不勾选，请先看一眼。`,
      items: report.dead,
      describe: (d) => ({ title: d.title, url: d.url, detail: d.reason }),
    });
    row.append(Object.assign(document.createElement("button"), { type: "button", className: "link", textContent: "重新检查", onclick: startLinkCheckClick }));
    rows.push(row);
  } else {
    const row = document.createElement("div");
    row.className = "tidy-row";
    row.append(`打不开的链接：还没检查过。共 ${report.total} 个书签，在后台检查，大约 ${Math.max(1, Math.round((report.total * 1.5) / 60))} 分钟。`);
    row.append(Object.assign(document.createElement("button"), { type: "button", className: "small", textContent: "开始检查", onclick: startLinkCheckClick }));
    rows.push(row);
  }

  const apply = Object.assign(document.createElement("button"), { type: "button", id: "tidyApply", textContent: "执行选中的整理" });
  apply.addEventListener("click", applyTidyClick);
  $("tidyReport").replaceChildren(...rows, apply);
}

async function applyTidyClick() {
  const selection = {};
  for (const box of $("tidyReport").querySelectorAll("input[type=checkbox]")) selection[box.dataset.key] = box.checked;
  if (!Object.values(selection).some(Boolean)) return feedback("feedback7", "没有勾选任何一项", "error");
  $("tidyApply").disabled = true;
  feedback("feedback7", "正在整理……", "busy");
  const result = await chrome.runtime.sendMessage({ type: "tidyApply", selection });
  if (result.error) return feedback("feedback7", `整理失败：${result.error}`, "error");
  feedback("feedback7", result.done.length ? `整理完成 ✓ ${result.done.join("；")}` : "没有需要改动的");
  renderTidy(await chrome.runtime.sendMessage({ type: "tidyScan" }));
}

$("tidyScan").addEventListener("click", async () => {
  $("tidyScan").disabled = true;
  feedback("feedback7", "正在检查……", "busy");
  const report = await chrome.runtime.sendMessage({ type: "tidyScan" });
  $("tidyScan").disabled = false;
  if (report.error) return feedback("feedback7", `检查失败：${report.error}`, "error");
  feedback("feedback7", `共 ${report.total} 个书签`);
  renderTidy(report);
});

// ---- automatic sorting ----

async function renderTargets() {
  const config = await getConfig();
  // Show every folder next to the inbox; unchecked ones are never used as targets.
  const all = await classifyTargets({ ...config, classifyExclude: [] });
  $("targetList").replaceChildren(
    ...all.map((f) => {
      const label = document.createElement("label");
      const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: !config.classifyExclude.includes(f.title) });
      box.dataset.name = f.title;
      box.addEventListener("change", saveClassify);
      label.append(box, ` ${f.title}`);
      return label;
    })
  );
  if (!all.length) $("targetList").textContent = "收件箱旁边还没有其他文件夹。开启下面的新建选项后，大模型会边分类边建文件夹。";
}

let classifyTimer;
function saveClassify() {
  clearTimeout(classifyTimer);
  classifyTimer = setTimeout(async () => {
    const config = await getConfig();
    const shown = [...$("targetList").querySelectorAll("input")];
    const hiddenExcluded = config.classifyExclude.filter((n) => !shown.some((b) => b.dataset.name === n));
    await setConfig({
      classify: $("classify").checked,
      llmBaseUrl: $("llmBaseUrl").value.trim(),
      llmApiKey: $("llmApiKey").value.trim(),
      llmModel: $("llmModel").value.trim(),
      allowNewFolders: $("allowNewFolders").checked,
      classifyExclude: [...hiddenExcluded, ...shown.filter((b) => !b.checked).map((b) => b.dataset.name)],
    });
    flashSaved("feedback6");
  }, 400);
}
function renderClassifyFields() {
  $("classifyFields").style.display = $("classify").checked ? "" : "none";
  $("testClassify").disabled = !($("llmBaseUrl").value.trim() && $("llmModel").value.trim());
}
for (const id of ["classify", "llmBaseUrl", "llmApiKey", "llmModel", "allowNewFolders"]) {
  $(id).addEventListener("input", () => {
    renderClassifyFields();
    saveClassify();
  });
}

$("testClassify").addEventListener("click", async () => {
  const config = await getConfig();
  if (!config.llmBaseUrl || !config.llmModel) return feedback("feedback6", "请先填写 Base URL 和模型", "error");
  if (!(await chrome.permissions.contains(ALL_SITES)) && !(await chrome.permissions.request(ALL_SITES))) {
    return feedback("feedback6", "需要允许插件访问网络才能调用大模型", "error");
  }
  feedback("feedback6", "正在问大模型……", "busy");
  try {
    const name = await testClassify(config);
    feedback("feedback6", `连接正常 ✓ 示例标题"Claude Code 实用技巧：用好 Skills 和 MCP"被分到：${name}`);
  } catch (e) {
    feedback("feedback6", `调用失败：${e.message}`, "error");
  }
});

// ---- initial render ----

async function init() {
  const config = await getConfig();
  $("brand").value = config.brand;
  $("appId").value = config.appId;
  $("appSecret").value = config.appSecret;
  $("inboxName").value = config.inboxName;
  $("interval").value = String(config.intervalMinutes);
  const folders = await listFolders();
  $("parentFolder").replaceChildren(new Option("其他书签（默认）", ""), ...folders.map((f) => new Option(f.label, f.key)));
  $("parentFolder").value = config.parentFolderPath;
  $("classify").checked = config.classify;
  $("llmBaseUrl").value = config.llmBaseUrl;
  $("llmApiKey").value = config.llmApiKey;
  $("llmModel").value = config.llmModel;
  $("allowNewFolders").checked = config.allowNewFolders;
  renderClassifyFields();
  await renderTargets();
  await renderGuide(config.brand);
  await renderSteps();
  await renderRunning();
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.state || changes.titleQueue || changes.activity) renderRunning();
  if (changes.auth || changes.config) renderSteps();
});

await init();
// Folders the model creates show up in the checklist right away.
chrome.bookmarks.onCreated.addListener((_id, node) => node.url || renderTargets());
setInterval(renderRunning, 60_000); // keep "x 分钟前" and the next sync time current
