// Feishu / Lark OAuth (user's own self-built app) and the few IM APIs this extension needs.

import { getAuth, setAuth } from "./store.js";

// Scopes the user enables under 权限管理 → 用户身份.
export const REQUIRED_SCOPES = [
  { scope: "offline_access", label: "保持登录，不用每两小时重新授权" },
  { scope: "im:message.p2p_msg:get_as_user", label: "读取单聊消息（用户身份）" },
  { scope: "im:message:readonly", label: "获取单聊、群组消息" },
  { scope: "im:chat:read", label: "查找你和自己的那个会话" },
];

const HOSTS = {
  feishu: {
    authorize: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    token: "https://accounts.feishu.cn/oauth/v3/token",
    api: "https://open.feishu.cn",
    console: "https://open.feishu.cn/app",
  },
  lark: {
    authorize: "https://accounts.larksuite.com/open-apis/authen/v1/authorize",
    token: "https://open.larksuite.com/open-apis/authen/v2/oauth/token",
    api: "https://open.larksuite.com",
    console: "https://open.larksuite.com/app",
  },
};

export const hosts = (brand) => HOSTS[brand] || HOSTS.feishu;

// Error codes that mean "the access token is no longer good; refresh and retry".
const TOKEN_EXPIRED = new Set([99991677, 99991668, 99991663, 20005, 20006]);
// Refresh token is gone; the user has to connect again.
const RELOGIN = new Set([20026, 20037, 20064, 20073]);

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

async function requestToken(config, fields) {
  const h = hosts(config.brand);
  const body = { client_id: config.appId, client_secret: config.appSecret, ...fields };
  const isV3 = h.token.includes("/oauth/v3/");
  const res = await fetch(h.token, {
    method: "POST",
    headers: { "content-type": isV3 ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8" },
    body: isV3 ? new URLSearchParams(body) : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) {
    const err = new Error(data.error_description || data.msg || `获取令牌失败（HTTP ${res.status}）`);
    err.code = data.code;
    throw err;
  }
  const now = Date.now();
  return {
    accessToken: data.access_token,
    expiresAt: now + (data.expires_in || 7200) * 1000,
    refreshToken: data.refresh_token || "",
    refreshExpiresAt: data.refresh_token ? now + (data.refresh_token_expires_in || 0) * 1000 : 0,
    scope: data.scope || "",
  };
}

async function api(config, token, method, path, { params, body } = {}) {
  const url = new URL(path, hosts(config.brand).api);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ code: -1, msg: `HTTP ${res.status}` }));
  if (data.code !== 0) {
    const err = new Error(`${data.msg || "请求失败"}（${data.code}）`);
    err.code = data.code;
    err.retryAfter = Number(res.headers.get("x-ogw-ratelimit-reset")) || 0;
    throw err;
  }
  return data.data;
}

// Interactive sign-in. Opens Feishu's consent page and returns the auth record to store.
export async function connect(config) {
  const h = hosts(config.brand);
  const redirectUri = chrome.identity.getRedirectURL();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const { verifier, challenge } = await pkcePair();
  const url = new URL(h.authorize);
  url.search = new URLSearchParams({
    client_id: config.appId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: REQUIRED_SCOPES.map((s) => s.scope).join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const finalUrl = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  const back = new URL(finalUrl);
  if (back.searchParams.get("error")) throw new Error("你在飞书授权页取消了授权");
  if (back.searchParams.get("state") !== state) throw new Error("授权回调校验失败，请重试");
  const code = back.searchParams.get("code");
  if (!code) throw new Error("没有拿到授权码");

  const tokens = await requestToken(config, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
  const me = await api(config, tokens.accessToken, "GET", "/open-apis/authen/v1/user_info");
  return { ...tokens, openId: me.open_id, name: me.name };
}

// API client that refreshes the access token as needed and persists the rotated tokens.
export class FeishuClient {
  constructor(config, auth) {
    this.config = config;
    this.auth = auth;
  }

  async refresh() {
    if (!this.auth.refreshToken) throw Object.assign(new Error("登录已过期，请重新连接飞书"), { relogin: true });
    try {
      const tokens = await requestToken(this.config, { grant_type: "refresh_token", refresh_token: this.auth.refreshToken });
      this.auth = { ...this.auth, ...tokens };
      await setAuth(this.auth);
    } catch (e) {
      if (RELOGIN.has(e.code)) {
        await setAuth(null);
        throw Object.assign(new Error("登录已过期，请重新连接飞书"), { relogin: true });
      }
      throw e;
    }
  }

  async call(method, path, opts) {
    if (Date.now() > this.auth.expiresAt - 60_000) await this.refresh();
    try {
      return await api(this.config, this.auth.accessToken, method, path, opts);
    } catch (e) {
      if (TOKEN_EXPIRED.has(e.code)) {
        await this.refresh();
        return api(this.config, this.auth.accessToken, method, path, opts);
      }
      throw e;
    }
  }

  // The chat a user has with themselves is an ordinary p2p chat whose two members are the same person.
  async selfChatId() {
    const data = await this.call("POST", "/open-apis/im/v1/chat_p2p/batch_query", {
      params: { user_id_type: "open_id" },
      body: { chatter_ids: [this.auth.openId] },
    });
    const chat = (data.p2p_chats || []).find((c) => c.chatter_id1 === this.auth.openId && c.chatter_id2 === this.auth.openId);
    if (!chat) throw new Error("没找到你发给自己的会话，请先在飞书里给自己发一条消息");
    return chat.chat_id;
  }

  // Yields pages of messages in the chat, oldest first, starting at startMs.
  async *messages(chatId, startMs) {
    let pageToken = "";
    do {
      const data = await this.call("GET", "/open-apis/im/v1/messages", {
        params: {
          container_id_type: "chat",
          container_id: chatId,
          start_time: startMs ? String(Math.floor(startMs / 1000)) : "",
          sort_type: "ByCreateTimeAsc",
          page_size: "50",
          page_token: pageToken,
        },
      });
      yield data.items || [];
      pageToken = data.has_more ? data.page_token : "";
    } while (pageToken);
  }
}

export async function currentClient(config) {
  const auth = await getAuth();
  return auth ? new FeishuClient(config, auth) : null;
}
