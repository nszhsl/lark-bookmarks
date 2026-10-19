import { getConfig, setConfig, getAuth, setAuth, getState, setState, isMover, setMover } from "./lib/store.js";
import { connect, REQUIRED_SCOPES, hosts } from "./lib/feishu.js";
import { listFolders, classifyTargets } from "./lib/bookmarks.js";
import { testClassify } from "./lib/classify.js";

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

function formatTime(ms) {
  return ms ? new Date(ms).toLocaleString() : "还没有";
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
  await setMover(true);

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

async function renderRunning() {
  const state = await getState();
  const { queueLength } = await chrome.runtime.sendMessage({ type: "status" });
  const rows = [
    `上次同步：${formatTime(state.lastSyncAt)}`,
    `累计加入书签：${state.addedTotal} 个`,
    `等待补标题：${queueLength} 个；已补好 ${state.titlesFixed || 0} 个，没抓到 ${state.titlesFailed || 0} 个`,
  ];
  if (state.lastError) rows.push(`上次出错：${state.lastError}`);
  if (state.classifyError) rows.push(`自动分类出错：${state.classifyError}`);
  $("status").replaceChildren(
    ...rows.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    })
  );
  $("permWarning").style.display = (await chrome.permissions.contains(ALL_SITES)) ? "none" : "";
  const mover = await isMover();
  $("mover").checked = mover;
  $("syncNow").disabled = !mover;
  $("moverHint").textContent = mover
    ? "只用一台电脑的话保持勾选即可。如果你在多台电脑上装了这个插件，只在其中一台勾选，否则同一个链接可能被加两次；书签会通过 Chrome 同步到其他电脑。"
    : "这台电脑不会去飞书取新链接，书签由另一台电脑添加后通过 Chrome 同步过来。如果那台电脑不用了，就勾上这里。";
}

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

$("mover").addEventListener("change", async (e) => {
  await setMover(e.target.checked);
  if (e.target.checked) await chrome.runtime.sendMessage({ type: "configChanged" });
  feedback("feedback4", e.target.checked ? "这台电脑会自动同步 ✓" : "这台电脑不再自动同步 ✓");
  renderRunning();
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
  if (!all.length) $("targetList").textContent = "收件箱旁边还没有其他文件夹。";
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
      classifyExclude: [...hiddenExcluded, ...shown.filter((b) => !b.checked).map((b) => b.dataset.name)],
    });
    flashSaved("feedback6");
  }, 400);
}
for (const id of ["classify", "llmBaseUrl", "llmApiKey", "llmModel"]) $(id).addEventListener("input", saveClassify);

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
  $("classifySection").open = config.classify;
  await renderTargets();
  await renderGuide(config.brand);
  await renderSteps();
  await renderRunning();
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.state || changes.titleQueue || changes.mover) renderRunning();
  if (changes.auth || changes.config) renderSteps();
});

await init();
