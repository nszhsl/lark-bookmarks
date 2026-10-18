import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLinks, normalizeUrl } from "../lib/links.js";

const text = (t) => JSON.stringify({ text: t });

test("bare link in a text message", () => {
  assert.deepEqual(extractLinks("text", text("https://github.com/owner/repo")), [
    { url: "https://github.com/owner/repo", title: "", note: "" },
  ]);
});

test("words next to a link become the note", () => {
  const [link] = extractLinks("text", text("https://mp.weixin.qq.com/s/abc 插件"));
  assert.equal(link.note, "插件");
});

test("long text around a link is cut short", () => {
  const [link] = extractLinks("text", text(`看这个 https://example.com/a ${"很长的说明".repeat(20)}`));
  assert.ok(link.note.length <= 41);
  assert.ok(link.note.endsWith("…"));
});

test("Zhihu share text supplies the title and no note", () => {
  const [link] = extractLinks("text", text("【有哪些高效的复盘方法？ - 知乎】 https://www.zhihu.com/question/123?utm_psn=9"));
  assert.deepEqual(link, { url: "https://www.zhihu.com/question/123", title: "有哪些高效的复盘方法？", note: "" });
});

test("markdown links in text keep the label as a note", () => {
  const [link] = extractLinks("text", text("[Docs](https://open.feishu.cn/document)"));
  assert.equal(link.url, "https://open.feishu.cn/document");
  assert.equal(link.note, "Docs");
});

test("post messages: a-tag hrefs and links inside text", () => {
  const post = JSON.stringify({
    title: "",
    content: [
      [{ tag: "a", text: "仓库", href: "https://github.com/a/b" }],
      [{ tag: "text", text: "还有 https://example.com/x" }],
    ],
  });
  assert.deepEqual(
    extractLinks("post", post).map((l) => l.url),
    ["https://github.com/a/b", "https://example.com/x"]
  );
});

test("post content wrapped in a locale key", () => {
  const post = JSON.stringify({ zh_cn: { title: "", content: [[{ tag: "a", text: "x", href: "https://example.com/y" }]] } });
  assert.equal(extractLinks("post", post)[0].url, "https://example.com/y");
});

test("non-link message types are ignored", () => {
  assert.deepEqual(extractLinks("image", JSON.stringify({ image_key: "img_x" })), []);
  assert.deepEqual(extractLinks("text", "not json"), []);
});

test("the same link twice in one message is added once", () => {
  assert.equal(extractLinks("text", text("https://a.com/x https://a.com/x?utm_source=feishu")).length, 1);
});

test("normalizeUrl strips tracking and share parameters", () => {
  assert.equal(normalizeUrl("https://zhuanlan.zhihu.com/p/1?utm_psn=2"), "https://zhuanlan.zhihu.com/p/1");
  assert.equal(normalizeUrl("https://mp.weixin.qq.com/s/abc?scene=1&chksm=x"), "https://mp.weixin.qq.com/s/abc");
  assert.equal(
    normalizeUrl("https://mp.weixin.qq.com/s?__biz=B&mid=1&idx=1&sn=S&chksm=x&scene=21"),
    "https://mp.weixin.qq.com/s?__biz=B&mid=1&idx=1&sn=S"
  );
  assert.equal(normalizeUrl("https://example.com/a?id=7&utm_medium=x#top"), "https://example.com/a?id=7");
  assert.equal(normalizeUrl("https://link.zhihu.com/?target=https%3A%2F%2Fgithub.com%2Fa%2Fb"), "https://github.com/a/b");
  assert.equal(normalizeUrl("https://example.com/x)."), "https://example.com/x");
  assert.equal(normalizeUrl("ftp://example.com"), null);
});
