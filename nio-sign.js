/*
 * 蔚来 NIO App Loon 签到调试版
 *
 * 用法：
 * - 先安装 nio-sign.plugin，并给 *.nio.com / *.nio.cn 开启 MITM。
 * - 打开蔚来 App，访问签到/积分/任务页，手动签到一次。
 * - 捕获成功后，定时任务会复用已保存的签到请求和最新认证头。
 *
 * 只用于自动化你自己的账号请求。接口如变更，请看 Loon 日志里的 NIO_SIGN_DEBUG。
 */

const STORE = {
  auth: 'nio.sign.auth.v1',
  signReq: 'nio.sign.request.v1',
  lastDebug: 'nio.sign.lastDebug.v1',
};

const CONFIG = {
  notify: true,
  debug: true,
  // 路径或 query 命中这些词时，会优先认为是“签到请求”。
  signKeywords: [
    'checkin',
    'check-in',
    'signin',
    'sign-in',
    'daily_sign',
    'daily-sign',
    'sign',
    'calendar',
    'task',
    'points',
    'point',
    'credit',
    'member',
    'growth',
  ],
  // 这些头会从 App 请求中保存下来，定时任务重放时自动覆盖旧值。
  authHeaderNames: [
    'authorization',
    'access-token',
    'x-access-token',
    'x-token',
    'token',
    'app_id',
    'app-id',
    'x-app-id',
    'device_id',
    'device-id',
    'x-device-id',
    'user-agent',
    'content-type',
    'accept',
    'accept-language',
    'nio-app-id',
    'nio-device-id',
    'nio-token',
  ],
};

function isRequestMode() {
  return typeof $request !== 'undefined' && $request && $request.url;
}

function readJson(key, fallback) {
  const raw = $persistentStore.read(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    log(`读取 ${key} 失败: ${err.message}`);
    return fallback;
  }
}

function writeJson(key, value) {
  return $persistentStore.write(JSON.stringify(value), key);
}

function now() {
  return new Date().toISOString();
}

function log(message, data) {
  const line = `[NIO_SIGN_DEBUG] ${message}${data ? ` ${safeJson(data)}` : ''}`;
  console.log(line);
  $persistentStore.write(`${now()} ${line}`, STORE.lastDebug);
}

function safeJson(value) {
  return JSON.stringify(value, (key, val) => {
    if (typeof val !== 'string') return val;
    if (/authorization|token|cookie|secret|session|access/i.test(key)) return mask(val);
    return val.length > 800 ? `${val.slice(0, 800)}...<trimmed>` : val;
  });
}

function mask(value) {
  if (!value) return value;
  if (value.length <= 12) return '***';
  return `${value.slice(0, 6)}***${value.slice(-6)}`;
}

function normalizeHeaders(headers) {
  const out = {};
  Object.keys(headers || {}).forEach((name) => {
    out[name.toLowerCase()] = String(headers[name]);
  });
  return out;
}

function pickAuthHeaders(headers) {
  const lower = normalizeHeaders(headers);
  const picked = {};
  CONFIG.authHeaderNames.forEach((name) => {
    const key = name.toLowerCase();
    if (lower[key]) picked[key] = lower[key];
  });
  // Cookie 可能含登录态，默认保存但日志会脱敏。
  if (lower.cookie) picked.cookie = lower.cookie;
  return picked;
}

function mergeHeaders(saved, latest) {
  const merged = Object.assign({}, normalizeHeaders(saved || {}), normalizeHeaders(latest || {}));
  delete merged.host;
  delete merged['content-length'];
  delete merged['accept-encoding'];
  delete merged.connection;
  return merged;
}

function looksLikeSignRequest(url) {
  const text = decodeURIComponent(url).toLowerCase();
  return CONFIG.signKeywords.some((word) => text.includes(word));
}

function isStaticAsset(url) {
  const path = url.split('?')[0].toLowerCase();
  return /\.(ttf|otf|woff|woff2|eot|css|js|map|png|jpe?g|gif|webp|svg|ico|mp4|mov|m4v|webm|mp3|m4a|aac|wav|json)$/.test(path);
}

function capture() {
  const url = $request.url;
  const method = ($request.method || 'GET').toUpperCase();
  const headers = normalizeHeaders($request.headers || {});
  const body = $request.body || '';

  if (isStaticAsset(url)) {
    if (CONFIG.debug) log('跳过静态资源请求', { method, url });
    return $done({});
  }

  const authHeaders = pickAuthHeaders(headers);

  if (Object.keys(authHeaders).length > 0) {
    const oldAuth = readJson(STORE.auth, {});
    const nextAuth = {
      updatedAt: now(),
      url,
      headers: mergeHeaders(oldAuth.headers, authHeaders),
    };
    writeJson(STORE.auth, nextAuth);
    if (CONFIG.debug) log('已更新 NIO 认证头', { url, headers: nextAuth.headers });
  }

  if (looksLikeSignRequest(url)) {
    const signReq = {
      updatedAt: now(),
      url,
      method,
      headers: mergeHeaders(headers, authHeaders),
      body,
    };
    writeJson(STORE.signReq, signReq);
    notify('NIO 捕获成功', '已保存疑似签到请求', `${method} ${url}`);
    log('已保存疑似签到请求', signReq);
  } else if (CONFIG.debug) {
    log('捕获到 NIO 请求，但不像签到接口', { method, url, authHeaderCount: Object.keys(authHeaders).length });
  }

  $done({});
}

function requestOptions(signReq, auth) {
  const method = (signReq.method || 'GET').toUpperCase();
  const headers = mergeHeaders(signReq.headers, auth.headers);
  const options = {
    url: signReq.url,
    method,
    headers,
  };
  if (method !== 'GET' && signReq.body) options.body = signReq.body;
  return options;
}

function runSign() {
  const signReq = readJson(STORE.signReq, null);
  const auth = readJson(STORE.auth, null);

  if (!signReq) {
    notify('NIO 签到未配置', '还没有捕获到签到请求', '请开启 MITM 后在蔚来 App 手动签到一次。');
    log('缺少签到请求配置');
    return $done();
  }

  if (!auth || !auth.headers || Object.keys(auth.headers).length === 0) {
    notify('NIO 签到未配置', '还没有捕获到认证头', '请打开蔚来 App 刷新一次，再手动运行脚本。');
    log('缺少认证头配置', { signReq });
    return $done();
  }

  const options = requestOptions(signReq, auth);
  log('开始签到请求', options);

  $httpClient.request(options, (error, response, body) => {
    const status = response && response.status;
    const text = body || '';
    const parsed = tryParseJson(text);
    const resultText = summarizeResponse(status, parsed, text);

    log('签到响应', { error: error && String(error), status, body: parsed || text });

    if (error) {
      notify('NIO 签到请求失败', String(error), '请查看 Loon 日志 NIO_SIGN_DEBUG。');
      return $done();
    }

    notify('NIO 签到完成', `HTTP ${status || 'unknown'}`, resultText);
    $done();
  });
}

function tryParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function summarizeResponse(status, parsed, text) {
  if (parsed) {
    const candidates = [
      parsed.message,
      parsed.msg,
      parsed.error,
      parsed.errmsg,
      parsed.desc,
      parsed.data && parsed.data.message,
      parsed.data && parsed.data.msg,
    ].filter(Boolean);
    if (candidates.length) return String(candidates[0]).slice(0, 180);
    return safeJson(parsed).slice(0, 180);
  }
  if (!text) return '无响应正文';
  return String(text).replace(/\s+/g, ' ').slice(0, 180);
}

function notify(title, subtitle, message) {
  if (!CONFIG.notify) return;
  $notification.post(title, subtitle || '', message || '');
}

if (isRequestMode()) {
  capture();
} else {
  runSign();
}
