// End-to-end test: loads the extension in Chrome for Testing, answers its Feishu API calls with a
// mock, serves a few local pages for title lookups, and checks the bookmarks it creates.
// Run with `npm run e2e`. Uses a throwaway browser profile; never touches your own Chrome.
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import puppeteer from "puppeteer";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ME = "ou_test_self";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- local pages whose titles the extension should pick up ---
const gbkTitle = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xd2, 0xb3]); // "测试页" in GBK
const pages = {
  "/a": { type: "text/html; charset=utf-8", body: "<html><head><title>页面 A</title></head></html>" },
  "/b": { type: "text/html; charset=utf-8", body: '<meta property="og:title" content="页面 B &amp; 更多"><title>ignored</title>' },
  "/gbk": { type: "text/html; charset=gbk", body: Buffer.concat([Buffer.from("<title>"), gbkTitle, Buffer.from("</title>")]) },
  "/challenge": { type: "text/html", body: "<title>Just a moment...</title>" },
};
// Mock OpenAI-compatible model: anything titled "页面 A" belongs in 编程开发, the rest stays put.
const llmCalls = [];
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      const request = JSON.parse(body);
      llmCalls.push({ auth: req.headers.authorization, request });
      const user = request.messages.at(-1).content;
      const answer = user.includes("标题：页面 A") ? "编程开发" : "收件箱";
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
    });
    return;
  }
  const page = pages[req.url];
  if (!page) return res.writeHead(404).end("<title>404 Not Found</title>");
  res.writeHead(200, { "content-type": page.type }).end(page.body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// --- mock Feishu messages ---
let nextTime = Date.parse("2026-10-17T10:00:00+08:00");
const msg = (type, content, extra = {}) => ({
  message_id: `om_${nextTime}`,
  msg_type: type,
  create_time: String((nextTime += 60_000)),
  deleted: false,
  body: { content: JSON.stringify(content) },
  ...extra,
});
const messages = [
  msg("text", { text: `${base}/a` }),
  msg("text", { text: `${base}/b?utm_source=feishu 插件` }),
  msg("text", { text: `【分享的标题 - 知乎】 ${base}/share` }),
  msg("image", { image_key: "img_x" }),
  msg("text", { text: `${base}/deleted` }, { deleted: true }),
  msg("post", { title: "", content: [[{ tag: "a", text: "gbk", href: `${base}/gbk` }], [{ tag: "text", text: `${base}/challenge` }]] }),
  msg("text", { text: `${base}/a` }), // same link again
];

const calls = [];
function feishu(request) {
  const url = new URL(request.url);
  calls.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: request.postData || "" });
  if (url.pathname === "/oauth/v3/token") {
    return { access_token: `at_${calls.length}`, expires_in: 7200, refresh_token: `rt_${calls.length}`, refresh_token_expires_in: 604800 };
  }
  if (request.headers.Authorization?.startsWith("Bearer at_") !== true && request.headers.authorization?.startsWith("Bearer at_") !== true) {
    return { code: 99991677, msg: "token expired" };
  }
  if (url.pathname === "/open-apis/im/v1/chat_p2p/batch_query") {
    return { code: 0, data: { p2p_chats: [{ chat_id: "oc_self", chatter_id1: ME, chatter_id2: ME }] } };
  }
  if (url.pathname === "/open-apis/im/v1/messages") {
    const start = Number(url.searchParams.get("start_time") || 0) * 1000;
    // Like Feishu: a start time at or after "now" is rejected.
    if (start >= Date.now()) return { code: 230001, msg: "Your request contains an invalid request parameter, ext=The end_time is earlier than the start_time." };
    const items = messages.filter((m) => Number(m.create_time) >= start);
    const offset = Number(url.searchParams.get("page_token") || 0);
    const page = items.slice(offset, offset + 3); // small pages to exercise pagination
    const more = offset + 3 < items.length;
    return { code: 0, data: { items: page, has_more: more, page_token: more ? String(offset + 3) : undefined } };
  }
  return { code: 404, msg: `unmocked ${url.pathname}` };
}

// --- extension copy with page access pre-granted (a real install asks the user) ---
const extDir = mkdtempSync(join(tmpdir(), "lark-bookmarks-ext-"));
for (const p of ["manifest.json", "background.js", "options.html", "options.js", "options.css", "lib", "icons"]) cpSync(join(root, p), join(extDir, p), { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
manifest.host_permissions.push("<all_urls>");
writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest));

const profile = mkdtempSync(join(tmpdir(), "lark-bookmarks-profile-"));
// CHROME_PATH lets you use an installed Chrome instead of downloading Chrome for Testing.
const browser = await puppeteer.launch({
  headless: true,
  userDataDir: profile,
  executablePath: process.env.CHROME_PATH || undefined,
  pipe: true,
  enableExtensions: [extDir],
});

let failed = false;
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"));
  const extId = new URL(swTarget.url()).host;
  const cdp = await swTarget.createCDPSession();
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://open.feishu.cn/*" }, { urlPattern: "https://accounts.feishu.cn/*" }] });
  cdp.on("Fetch.requestPaused", async ({ requestId, request }) => {
    const body = Buffer.from(JSON.stringify(feishu(request))).toString("base64");
    await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body });
  });

  const errors = [];
  const options = await browser.newPage();
  options.on("pageerror", (e) => errors.push(e.message));
  // The extension opens its own options tab on install; use a fresh one we control.
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.waitForSelector("#status li");

  // Signed in, but with an expired access token so the first call has to refresh.
  // Settings arrive through sync; the login is this computer's own.
  await options.evaluate(
    async (me, base) => {
      await chrome.storage.sync.set({
        config: {
          brand: "feishu", appId: "cli_test", appSecret: "secret", inboxName: "收件箱", intervalMinutes: 60, syncFrom: "", startMode: "all",
          classify: true, llmBaseUrl: `${base}/v1`, llmApiKey: "sk-test", llmModel: "test-model", classifyExclude: ["待分类（等补完标题）"],
        },
      });
      await chrome.storage.local.set({
        auth: { accessToken: "stale", expiresAt: Date.now() - 1000, refreshToken: "rt_initial", openId: me, name: "测试用户" },
      });
      // Folders next to the inbox: one sorting target, one excluded holding folder.
      const [tree] = await chrome.bookmarks.getTree();
      const other = tree.children.find((n) => n.folderType === "other");
      await chrome.bookmarks.create({ parentId: other.id, title: "编程开发" });
      await chrome.bookmarks.create({ parentId: other.id, title: "待分类（等补完标题）" });
    },
    ME,
    base
  );

  const bookmarksIn = () =>
    options.evaluate(async () => {
      const [tree] = await chrome.bookmarks.getTree();
      const out = [];
      const walk = (n, path) => {
        if (n.url) out.push({ path, title: n.title, url: n.url });
        for (const c of n.children || []) walk(c, n.url ? path : [...path, n.title]);
      };
      walk(tree, []);
      return out.filter((b) => ["收件箱", "编程开发"].includes(b.path.at(-1)));
    });

  // 1. first sync
  const first = await options.evaluate(() => chrome.runtime.sendMessage({ type: "syncNow" }));
  assert.equal(first.error, undefined, `sync failed: ${first.error}`);
  assert.equal(first.added, 5, "five distinct links (deleted, image and the repeat are skipped)");

  const refresh = calls.find((c) => c.path === "/oauth/v3/token");
  assert.ok(refresh, "expired token was refreshed");
  const form = new URLSearchParams(refresh.body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "rt_initial");
  assert.equal(form.get("client_secret"), "secret");
  const auth = await options.evaluate(() => chrome.storage.local.get("auth").then((r) => r.auth));
  assert.match(auth.accessToken, /^at_/, "new access token stored");
  assert.match(auth.refreshToken, /^rt_/, "rotated refresh token stored");

  const p2p = calls.find((c) => c.path === "/open-apis/im/v1/chat_p2p/batch_query");
  assert.deepEqual(JSON.parse(p2p.body), { chatter_ids: [ME] });
  assert.equal(p2p.query.user_id_type, "open_id");
  const listCalls = calls.filter((c) => c.path === "/open-apis/im/v1/messages");
  assert.ok(listCalls.length >= 3, "paginated through all pages");
  assert.equal(listCalls[0].query.container_id, "oc_self");
  assert.equal(listCalls[0].query.sort_type, "ByCreateTimeAsc");

  let inbox = await bookmarksIn();
  assert.equal(inbox.length, 5);
  assert.ok(inbox.find((b) => b.url === `${base}/share` && b.title === "分享的标题"), "share text used as title");
  assert.ok(inbox.find((b) => b.url === `${base}/b` && b.title === `${base}/b | 插件`), "note kept, tracking param stripped");

  // 2. titles get filled in by the background queue (alarm fires every ~30-60 s)
  const want = { [`${base}/a`]: "页面 A", [`${base}/b`]: "页面 B & 更多 | 插件", [`${base}/gbk`]: "测试页" };
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    inbox = await bookmarksIn();
    if (Object.entries(want).every(([url, title]) => inbox.find((b) => b.url === url)?.title === title)) break;
    await sleep(3000);
  }
  for (const [url, title] of Object.entries(want)) assert.equal(inbox.find((b) => b.url === url)?.title, title, `title for ${url}`);
  assert.equal(inbox.find((b) => b.url === `${base}/challenge`)?.title, `${base}/challenge`, "bot-check page title is not used");

  // 2b. automatic sorting: 页面 A went to 编程开发, the rest stayed in the inbox
  const sortDeadline = Date.now() + 30_000;
  while (Date.now() < sortDeadline && (await bookmarksIn()).find((b) => b.url === `${base}/a`)?.path.at(-1) !== "编程开发") await sleep(1000);
  inbox = await bookmarksIn();
  assert.equal(inbox.find((b) => b.url === `${base}/a`)?.path.at(-1), "编程开发", "sorted by the model");
  assert.equal(inbox.find((b) => b.url === `${base}/b`)?.path.at(-1), "收件箱", "unsure ones stay in the inbox");
  assert.ok(llmCalls.length >= 4, "every new link was offered to the model");
  assert.equal(llmCalls[0].auth, "Bearer sk-test");
  assert.equal(llmCalls[0].request.model, "test-model");
  assert.match(llmCalls[0].request.messages[1].content, /文件夹：编程开发\n/, "excluded folders are not offered");

  // 3. a second sync adds nothing; a new message is picked up
  const again = await options.evaluate(() => chrome.runtime.sendMessage({ type: "syncNow" }));
  assert.equal(again.added, 0, "nothing re-added");
  messages.push(msg("text", { text: `${base}/a2 新的` }));
  const third = await options.evaluate(() => chrome.runtime.sendMessage({ type: "syncNow" }));
  assert.equal(third.added, 1, "new message synced");
  assert.equal((await bookmarksIn()).length, 6);

  // 3b. "only new links" starts the cursor at now; that must not trip Feishu's start/end check
  await options.evaluate(() => chrome.storage.sync.set({ cursorMs: Date.now() }));
  const fresh = await options.evaluate(() => chrome.runtime.sendMessage({ type: "syncNow" }));
  assert.equal(fresh.error, undefined, `sync right after "only new links" failed: ${fresh.error}`);
  assert.equal(fresh.added, 0);

  // 3c. another computer added the same new link: the later copy is removed on the next pass
  const inboxBefore = await bookmarksIn();
  const original = inboxBefore.find((b) => b.url === `${base}/a2`);
  await options.evaluate(async (url) => {
    const [first] = await chrome.bookmarks.search({ url });
    await chrome.bookmarks.create({ parentId: first.parentId, title: "copy from the other computer", url });
  }, original.url);
  assert.equal((await bookmarksIn()).filter((b) => b.url === original.url).length, 2);
  await options.evaluate(() => chrome.runtime.sendMessage({ type: "syncNow" }));
  const copies = (await bookmarksIn()).filter((b) => b.url === original.url);
  assert.equal(copies.length, 1, "duplicate removed");
  assert.equal(copies[0].title, original.title, "the older copy is the one kept");

  // 4. options page shows status and threw no errors
  await options.reload();
  await options.waitForSelector("#status li");
  const statusText = await options.$eval("#status", (el) => el.textContent);
  assert.match(statusText, /累计加入书签：6 个/);
  assert.match(await options.$eval("#step2 h2", (el) => el.textContent), /测试用户/);
  assert.deepEqual(errors, [], "no page errors");

  console.log("e2e: all checks passed");
} catch (e) {
  failed = true;
  console.error("e2e failed:", e.message);
  console.error("Feishu calls:", JSON.stringify(calls.map((c) => `${c.method} ${c.path}`)));
} finally {
  await browser.close();
  server.close();
  rmSync(extDir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
process.exit(failed ? 1 : 0);
