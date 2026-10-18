import { getConfig, setConfig, getAuth, setAuth, getState } from "./lib/store.js";
import { connect, REQUIRED_SCOPES, hosts } from "./lib/feishu.js";
import { listFolders } from "./lib/bookmarks.js";

const $ = (id) => document.getElementById(id);
const ALL_SITES = { origins: ["<all_urls>"] };

function say(text, isError = false) {
  $("message").textContent = text;
  $("message").className = isError ? "message error" : "message";
}

function formatTime(ms) {
  return ms ? new Date(ms).toLocaleString() : "从未";
}

async function renderGuide(brand) {
  $("consoleLink").href = hosts(brand).console;
  $("redirectUrl").textContent = chrome.identity.getRedirectURL();
  $("scopeList").replaceChildren(
    ...REQUIRED_SCOPES.map(({ scope, label }) => {
      const li = document.createElement("li");
      li.innerHTML = `<code></code> <span></span>`;
      li.querySelector("code").textContent = scope;
      li.querySelector("span").textContent = label;
      return li;
    })
  );
}

async function renderAuth() {
  const auth = await getAuth();
  $("authStatus").textContent = auth ? `已连接：${auth.name || auth.openId}` : "未连接";
  $("disconnect").disabled = !auth;
}

async function renderPermission() {
  const granted = await chrome.permissions.contains(ALL_SITES);
  $("permStatus").textContent = granted ? "已允许" : "尚未允许，书签会先以网址作为标题";
  $("grantPerm").disabled = granted;
}

async function renderStatus() {
  const state = await getState();
  const { queueLength } = await chrome.runtime.sendMessage({ type: "status" });
  const rows = [
    `上次同步：${formatTime(state.lastSyncAt)}`,
    `累计加入书签：${state.addedTotal} 个`,
    `等待补标题：${queueLength} 个`,
    `已补标题：${state.titlesFixed || 0} 个，没抓到：${state.titlesFailed || 0} 个`,
  ];
  if (state.lastError) rows.push(`上次出错：${state.lastError}`);
  $("status").replaceChildren(
    ...rows.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    })
  );
}

async function renderConfig() {
  const config = await getConfig();
  $("brand").value = config.brand;
  $("appId").value = config.appId;
  $("appSecret").value = config.appSecret;
  $("inboxName").value = config.inboxName;
  $("interval").value = String(config.intervalMinutes);
  $("syncFrom").value = config.syncFrom;

  const folders = await listFolders();
  const select = $("parentFolder");
  select.replaceChildren(new Option("其他书签（默认）", ""), ...folders.map((f) => new Option(f.path, f.id)));
  select.value = config.parentFolderId;
  await renderGuide(config.brand);
}

$("brand").addEventListener("change", (e) => renderGuide(e.target.value));

$("copyRedirect").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("redirectUrl").textContent);
  say("已复制重定向地址");
});

$("saveApp").addEventListener("click", async () => {
  const appId = $("appId").value.trim();
  const appSecret = $("appSecret").value.trim();
  if (!appId || !appSecret) return say("请填写 App ID 和 App Secret", true);
  await setConfig({ brand: $("brand").value, appId, appSecret });
  say("已保存，下一步点击\"连接飞书\"");
});

$("connect").addEventListener("click", async () => {
  const config = await getConfig();
  if (!config.appId || !config.appSecret) return say("请先在第 2 步填写并保存应用信息", true);
  $("connect").disabled = true;
  say("正在打开飞书授权页……");
  try {
    await setAuth(await connect(config));
    await renderAuth();
    say("连接成功");
    chrome.runtime.sendMessage({ type: "syncNow" });
  } catch (e) {
    say(`连接失败：${e.message}`, true);
  } finally {
    $("connect").disabled = false;
  }
});

$("disconnect").addEventListener("click", async () => {
  await setAuth(null);
  await renderAuth();
  say("已断开连接");
});

$("saveSync").addEventListener("click", async () => {
  await setConfig({
    parentFolderId: $("parentFolder").value,
    inboxName: $("inboxName").value.trim() || "收件箱",
    intervalMinutes: Number($("interval").value),
    syncFrom: $("syncFrom").value,
  });
  await chrome.runtime.sendMessage({ type: "configChanged" });
  say("已保存");
});

$("grantPerm").addEventListener("click", async () => {
  const granted = await chrome.permissions.request(ALL_SITES);
  await renderPermission();
  say(granted ? "已允许读取网页标题" : "没有获得权限，书签会先以网址作为标题", !granted);
});

$("syncNow").addEventListener("click", async () => {
  $("syncNow").disabled = true;
  say("正在同步……");
  const result = await chrome.runtime.sendMessage({ type: "syncNow" });
  $("syncNow").disabled = false;
  if (result?.error) say(`同步失败：${result.error}`, true);
  else say(`同步完成，新加入 ${result?.added ?? 0} 个书签`);
  await renderStatus();
});

$("fixTitles").addEventListener("click", async () => {
  const { queued } = await chrome.runtime.sendMessage({ type: "fixTitles" });
  say(queued ? `已把 ${queued} 个无标题书签加入补标题队列，会在后台慢慢处理` : "没有找到无标题的书签");
  await renderStatus();
});

chrome.storage.onChanged.addListener(() => {
  renderStatus();
  renderAuth();
});

await renderConfig();
await renderAuth();
await renderPermission();
await renderStatus();
