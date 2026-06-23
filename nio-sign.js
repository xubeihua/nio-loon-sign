/*
 * 蔚来 APP 自动签到脚本 for Loon
 *
 * Adapted from:
 * https://github.com/atopsecret/weilai-auto-checkin
 *
 * Loon 使用：
 * 1. 导入 weilai-auto-checkin-loon.plugin。
 * 2. 开启 Loon、MitM，并信任证书。
 * 3. 打开蔚来 App，进入我的/积分/签到等页面，等待捕获 Authorization。
 * 4. 手动运行“蔚来自动签到”测试。
 */

const CONFIG = {
  baseURL: 'https://gateway-front-external.nio.com',
  appId: '10086',
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NIOAppCN/5.48.5 (com.do1.WeiLaiApp; build:2549; OS:iOS) webview/lg _dsbridge',
  maxRetries: 2,
  retryDelay: 2000,
  tokenStorageKey: 'weilai_auth_token',
  lastUpdateKey: 'weilai_token_last_update',
  tokenValidDays: 30,
  targetDomains: ['gateway-front-external.nio.com', 'app.nio.com', 'api.nio.com'],
  targetPaths: ['/checkin', '/award', '/user', '/profile', '/api', '/moat'],
};

function done(value) {
  if (typeof $done === 'function') $done(value || {});
}

function notify(title, subtitle, body) {
  $notification.post(title, subtitle || '', body || '');
}

function log(message, value) {
  if (value === undefined) {
    console.log(`[WEILAI_LOON] ${message}`);
  } else {
    console.log(`[WEILAI_LOON] ${message} ${safeJson(value)}`);
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value, (key, val) => {
      if (typeof val !== 'string') return val;
      if (/authorization|token|cookie/i.test(key)) return mask(val);
      return val.length > 1000 ? `${val.slice(0, 1000)}...<trimmed>` : val;
    });
  } catch (_) {
    return String(value);
  }
}

function mask(value) {
  if (!value) return value;
  if (value.length <= 18) return '***';
  return `${value.slice(0, 12)}***${value.slice(-6)}`;
}

function getHeader(headers, name) {
  const target = name.toLowerCase();
  const keys = Object.keys(headers || {});
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() === target) return headers[keys[i]];
  }
  return null;
}

function shouldInterceptRequest(url) {
  try {
    const urlObj = new URL(url);
    const domainMatch = CONFIG.targetDomains.some((domain) => urlObj.hostname === domain || urlObj.hostname.endsWith(`.${domain}`));
    if (!domainMatch) return false;

    return CONFIG.targetPaths.some((path) => urlObj.pathname.includes(path));
  } catch (error) {
    log('URL 解析失败', { url, error: String(error) });
    return false;
  }
}

function extractToken(headers) {
  const authHeader = getHeader(headers, 'authorization');
  if (!authHeader) return null;

  const token = String(authHeader).trim();
  if (/^Bearer\s+.+/i.test(token) && token.length > 20) return token;
  return null;
}

function saveToken(token) {
  const currentTime = Date.now();
  const ok1 = $persistentStore.write(token, CONFIG.tokenStorageKey);
  const ok2 = $persistentStore.write(String(currentTime), CONFIG.lastUpdateKey);

  if (!ok1 || !ok2) {
    log('Token 保存失败');
    return false;
  }

  log('Token 已保存', {
    token,
    savedAt: new Date(currentTime).toLocaleString('zh-CN'),
  });
  return true;
}

function getSavedToken() {
  const token = $persistentStore.read(CONFIG.tokenStorageKey);
  const lastUpdate = $persistentStore.read(CONFIG.lastUpdateKey);
  if (!token || !lastUpdate) return null;

  const lastUpdateTime = Number(lastUpdate);
  if (!Number.isFinite(lastUpdateTime)) return null;

  return {
    token,
    lastUpdate: lastUpdateTime,
    isExpired: isTokenExpired(lastUpdateTime),
  };
}

function isTokenExpired(lastUpdate) {
  const expireTime = lastUpdate + CONFIG.tokenValidDays * 24 * 60 * 60 * 1000;
  return Date.now() > expireTime;
}

function getValidToken() {
  const tokenInfo = getSavedToken();
  if (!tokenInfo) {
    log('未找到保存的 token');
    return null;
  }

  if (tokenInfo.isExpired) {
    notify('蔚来签到', 'Token 已过期', '请打开蔚来 App 进入我的/积分/签到页面刷新一次');
    log('Token 已过期');
    return null;
  }

  const remainingDays = Math.ceil((tokenInfo.lastUpdate + CONFIG.tokenValidDays * 24 * 60 * 60 * 1000 - Date.now()) / 86400000);
  log(`Token 有效，剩余约 ${remainingDays} 天`);
  return tokenInfo.token;
}

function handleTokenCapture(request) {
  const url = request.url;
  const headers = request.headers || {};
  log('Token 捕获模式', { url });

  if (!shouldInterceptRequest(url)) {
    log('跳过非目标请求', { url });
    return;
  }

  const token = extractToken(headers);
  if (!token) {
    log('未找到 Authorization Bearer token', { url, headerNames: Object.keys(headers) });
    return;
  }

  const savedTokenInfo = getSavedToken();
  if (savedTokenInfo && savedTokenInfo.token === token && !savedTokenInfo.isExpired) {
    log('Token 未变化，跳过保存');
    return;
  }

  if (saveToken(token)) {
    notify('蔚来 Token', savedTokenInfo ? 'Token 已更新' : 'Token 已获取', '可以手动运行“蔚来自动签到”测试');
  }
}

function buildParams() {
  return {
    app_id: CONFIG.appId,
    timestamp: Date.now(),
  };
}

function buildURL(params) {
  const queryString = Object.keys(params)
    .map((key) => `${key}=${encodeURIComponent(params[key])}`)
    .join('&');
  return `${CONFIG.baseURL}/moat/10086/c/award_cn/checkin?${queryString}`;
}

function buildHeaders(token) {
  return {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json, text/plain, */*',
    authorization: token,
    'accept-language': 'zh-CN,zh-Hans;q=0.9',
    origin: 'null',
    'user-agent': CONFIG.userAgent,
  };
}

function sendRequest(request, callback) {
  const method = String(request.method || 'GET').toUpperCase();
  if (method === 'POST') {
    $httpClient.post(request, callback);
    return;
  }
  if (method === 'PUT' && typeof $httpClient.put === 'function') {
    $httpClient.put(request, callback);
    return;
  }
  if (method === 'DELETE' && typeof $httpClient.delete === 'function') {
    $httpClient.delete(request, callback);
    return;
  }
  $httpClient.get(request, callback);
}

function formatDateTime(timestamp) {
  if (!timestamp) return '';
  const ms = Number(timestamp) > 1000000000000 ? Number(timestamp) : Number(timestamp) * 1000;
  return new Date(ms).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function extractCheckinStats(result) {
  const data = result && result.data ? result.data : {};
  const stats = data.stats || {};
  const awardInfo = data.award_info || {};

  const continuousDays =
    stats.continuous_checkin_days ||
    stats.continuousDays ||
    stats.consecutive_days ||
    data.continuous_checkin_days ||
    data.continuousDays ||
    data.consecutive_days ||
    awardInfo.continuous_days ||
    awardInfo.continuous_checkin_days ||
    0;

  const accumulateDays =
    stats.accumulate_days ||
    stats.accumulateDays ||
    stats.total_days ||
    data.accumulate_days ||
    data.accumulateDays ||
    data.total_days ||
    awardInfo.total_days ||
    awardInfo.accumulate_days ||
    0;

  const checkedIn = data.checked_in === true || data.is_checkin === true || data.has_checkin === true;
  const checkinTime = stats.checkin_time || data.checkin_time || data.checked_in_time || '';
  const tip = data.tip || result.message || result.msg || '签到完成';

  return { continuousDays, accumulateDays, checkedIn, checkinTime, tip };
}

function parseResponse(data) {
  try {
    return JSON.parse(data || '{}');
  } catch (error) {
    log('响应 JSON 解析失败', { error: String(error), data });
    return null;
  }
}

function buildStatsMessage(tip, stats) {
  const lines = [tip || '签到完成'];
  if (stats.continuousDays || stats.accumulateDays) {
    lines.push(`连续签到：${stats.continuousDays || 0} 天`);
    lines.push(`累计签到：${stats.accumulateDays || 0} 天`);
  }
  if (stats.checkinTime) lines.push(`签到时间：${formatDateTime(stats.checkinTime)}`);
  return lines.join('\n');
}

function handleResponse(response, data, token, callback) {
  const result = parseResponse(data);
  if (!result) {
    notify('蔚来签到', '响应解析失败', '请查看 Loon 日志 WEILAI_LOON');
    callback(false);
    return;
  }

  log('签到响应', result);
  const stats = extractCheckinStats(result);
  const success = response && response.status === 200 && result.result_code === 'success';

  if (success) {
    if (!stats.accumulateDays && !stats.continuousDays) {
      fetchCheckinStats(token, stats.tip || '签到成功', callback);
      return;
    }

    notify('蔚来签到', '签到成功', buildStatsMessage(stats.tip, stats));
    callback(true);
    return;
  }

  if (stats.checkedIn || /已签到|已经签到|重复签到/.test(`${stats.tip}${result.message || ''}${result.msg || ''}`)) {
    notify('蔚来签到', '今日已签到', buildStatsMessage(stats.tip || '今日已签到', stats));
    callback(true);
    return;
  }

  const errorMsg = result.message || result.msg || result.error || '签到失败';
  notify('蔚来签到', '签到失败', String(errorMsg));
  callback(false);
}

function fetchCheckinStats(token, tip, callback) {
  const request = {
    url: buildURL(buildParams()),
    method: 'POST',
    headers: buildHeaders(token),
    body: 'event=checkin',
  };

  log('尝试再次获取签到统计', request);
  sendRequest(request, (error, response, data) => {
    if (error) {
      log('获取统计失败', String(error));
      notify('蔚来签到', '签到成功', tip || '签到成功，但统计信息获取失败');
      callback(true);
      return;
    }

    const result = parseResponse(data);
    if (!result) {
      notify('蔚来签到', '签到成功', tip || '签到成功，但统计信息解析失败');
      callback(true);
      return;
    }

    const stats = extractCheckinStats(result);
    notify('蔚来签到', '签到成功', buildStatsMessage(tip || stats.tip, stats));
    callback(true);
  });
}

function performCheckin(token, retryCount) {
  const request = {
    url: buildURL(buildParams()),
    method: 'POST',
    headers: buildHeaders(token),
    body: 'event=checkin',
  };

  log(`开始签到，尝试 ${retryCount + 1}/${CONFIG.maxRetries + 1}`, request);
  sendRequest(request, (error, response, data) => {
    if (error) {
      log('网络请求失败', { error: String(error), retryCount });
      if (retryCount < CONFIG.maxRetries) {
        setTimeout(() => performCheckin(token, retryCount + 1), CONFIG.retryDelay);
        return;
      }
      notify('蔚来签到', '网络错误', String(error));
      done();
      return;
    }

    log('HTTP 状态', response && response.status);
    handleResponse(response, data, token, (ok) => {
      if (!ok && retryCount < CONFIG.maxRetries) {
        setTimeout(() => performCheckin(token, retryCount + 1), CONFIG.retryDelay);
        return;
      }
      done();
    });
  });
}

function main() {
  if (typeof $request !== 'undefined' && $request && $request.url) {
    handleTokenCapture($request);
    done();
    return;
  }

  log('蔚来自动签到 Loon 版启动');
  const token = getValidToken();
  if (!token) {
    notify('蔚来签到', 'Token 获取失败', '请打开蔚来 App 进入我的/积分/签到页面刷新一次');
    done();
    return;
  }

  performCheckin(token, 0);
}

main();
