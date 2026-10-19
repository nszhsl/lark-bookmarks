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
const server = createServer((req, res) => {
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
  await options.evaluate(
    (me) =>
      chrome.storage.local.set({
        config: { brand: "feishu", appId: "cli_test", appSecret: "secret", inboxName: "收件箱", intervalMinutes: 60, syncFrom: "", startMode: "all" },
        auth: { accessToken: "stale", expiresAt: Date.now() - 1000, refreshToken: "rt_initial", openId: me, name: "测试用户" },
      }),
    ME
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
      return out.filter((b) => b.path.at(-1) === "收件箱");
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

  // 3. a second sync adds nothing; a new message is picked up
  const again = await options.evaluate(() => chrome.runtime.sendMessage({ type: "syncNow" }));
  assert.equal(again.added, 0, "nothing re-added");
  messages.push(msg("text", { text: `${base}/a2 新的` }));
  const third = await options.evaluate(() => chrome.runtime.sendMessage({ type: "syncNow" }));
  assert.equal(third.added, 1, "new message synced");
  assert.equal((await bookmarksIn()).length, 6);

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
