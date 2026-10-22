// ==UserScript==
// @name         夸克网盘分享文件清单批量导出
// @namespace    https://github.com/shandianchengzi/getfilelist
// @version      1.0.0
// @description  批量扫描夸克分享链接的全部分页与子文件夹，导出 CSV / JSON（含原始文件元数据）/ TXT 目录树。
// @author       shandianchengzi
// @match        https://pan.quark.cn/s/*
// @match        https://drive.quark.cn/s/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/shandianchengzi/getfilelist/main/quark-filelist.user.js
// @downloadURL  https://raw.githubusercontent.com/shandianchengzi/getfilelist/main/quark-filelist.user.js
// ==/UserScript==

(function () {
  'use strict';

  const API_BASE = 'https://drive-h.quark.cn/1/clouddrive/share/sharepage';
  const PAGE_SIZE = 50;
  const RETRY_COUNT = 3;
  const REQUEST_GAP_MS = 120;
  const MAX_PAGES_PER_FOLDER = 10000;
  const MAX_ROWS_PER_SHARE = 500000;
  const PREFIX = 'qfl-exporter-';

  // 只在分享页面运行；页面内不收集 Cookies，也不上传列表到第三方。
  if (!/\/s\/[^/]+/.test(location.pathname)) return;
  if (document.getElementById(PREFIX + 'host')) return;

  function currentShareId() {
    const match = location.pathname.match(/\/s\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function parseShareLine(line) {
    const match = String(line).match(/https?:\/\/[^\s<>"'，。；）]+/i);
    if (!match) throw new Error('请输入夸克分享链接或分享详情 API 地址');
    let url;
    try {
      url = new URL(match[0].replace(/&amp;/g, '&'));
    } catch (_) {
      throw new Error('无效的网址：' + line.slice(0, 90));
    }
    if (!/(^|\.)quark\.cn$/i.test(url.hostname) || url.protocol !== 'https:') {
      throw new Error('仅支持 HTTPS 夸克网盘链接：' + url.hostname);
    }
    const shareMatch = url.pathname.match(/\/s\/([^/?#]+)/);
    const apiDetail = url.pathname.endsWith('/share/sharepage/detail');
    const id = shareMatch ? decodeURIComponent(shareMatch[1]) :
      (apiDetail ? url.searchParams.get('pwd_id') : '');
    if (!id) throw new Error('链接中缺少分享 ID（pwd_id）');
    // 支持一行一个链接，或“链接 提取码: abcd”；不会储存提取码。
    const trailing = line.slice(match.index + match[0].length);
    const passMatch = trailing.match(/(?:提取码|访问码|密码|passcode|pwd)\s*[:：=]?\s*([a-zA-Z0-9]{1,16})/i);
    const passcode = url.searchParams.get('pwd') ||
      url.searchParams.get('passcode') ||
      url.searchParams.get('password') ||
      (passMatch ? passMatch[1] : '');
    return {
      id: id,
      passcode: passcode,
      token: apiDetail ? (url.searchParams.get('stoken') || '') : '',
      url: 'https://pan.quark.cn/s/' + encodeURIComponent(id)
    };
  }

  function parseShares(input) {
    const lines = input.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
    if (!lines.length) lines.push(location.href);
    const unique = new Map();
    for (const line of lines) {
      const parsed = parseShareLine(line);
      const old = unique.get(parsed.id);
      if (!old) unique.set(parsed.id, parsed);
      else unique.set(parsed.id, {
        id: parsed.id,
        url: parsed.url,
        passcode: parsed.passcode || old.passcode,
        token: parsed.token || old.token
      });
    }
    return Array.from(unique.values());
  }

  function cachedTokenForCurrentShare(id) {
    if (id !== currentShareId()) return '';
    try {
      const args = JSON.parse(sessionStorage.getItem('_share_args') || 'null');
      const value = args && (args.value || args);
      // 这个页面的 sessionStorage 可能包含当前分享的已授权 token。
      return value && typeof value.stoken === 'string' ? value.stoken : '';
    } catch (_) {
      return '';
    }
  }

  function apiError(payload, httpStatus) {
    if (!payload || typeof payload !== 'object') return new Error('返回数据不是 JSON 对象');
    if (payload.code !== undefined && String(payload.code) !== '0') {
      return new Error('夸克 API 错误 ' + payload.code + ': ' +
        (payload.message || payload.msg || '分享失效、提取码错误或权限不足'));
    }
    if (payload.status !== undefined && Number(payload.status) >= 400) {
      return new Error('夸克 API 状态 ' + payload.status + ': ' + (payload.message || '请求失败'));
    }
    if (httpStatus < 200 || httpStatus >= 300) {
      return new Error('HTTP ' + httpStatus + ': ' + (payload.message || '请求失败'));
    }
    return null;
  }

  async function pause(ms, signal) {
    if (signal.aborted) throw new DOMException('已停止', 'AbortError');
    await new Promise(function (resolve) { setTimeout(resolve, ms); });
    if (signal.aborted) throw new DOMException('已停止', 'AbortError');
  }

  async function request(url, options, signal) {
    let lastError;
    for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
      if (attempt) await pause(Math.min(600 * Math.pow(2, attempt - 1), 3500), signal);
      try {
        const response = await fetch(url, Object.assign({
          credentials: 'include',
          mode: 'cors',
          cache: 'no-store',
          signal: signal,
          headers: { 'accept': 'application/json, text/plain, */*' }
        }, options || {}));
        let json;
        try { json = await response.json(); }
        catch (_) { throw new Error('接口没有返回有效 JSON（HTTP ' + response.status + '）'); }
        const error = apiError(json, response.status);
        if (error) {
          // 令牌失效/提取码错误不应盲目反复请求。
          if (response.status !== 429 && response.status < 500) throw error;
          lastError = error;
        } else {
          return json;
        }
      } catch (err) {
        if (signal.aborted || (err && err.name === 'AbortError')) throw err;
        // 业务错误不会自动恢复。
        if (err && /夸克 API 错误|夸克 API 状态 4\d\d/.test(err.message)) throw err;
        lastError = err;
      }
    }
    throw new Error('接口请求失败（已重试 ' + RETRY_COUNT + ' 次）：' +
      (lastError ? lastError.message : '未知错误'));
  }

  async function getShareToken(share, signal, forceRefresh) {
    if (!forceRefresh && share.token) return share.token;
    const stored = !forceRefresh ? cachedTokenForCurrentShare(share.id) : '';
    if (stored && !share.passcode) return stored;
    const endpoint = new URL(API_BASE + '/token');
    endpoint.searchParams.set('pr', 'ucpro');
    endpoint.searchParams.set('fr', 'pc');
    endpoint.searchParams.set('uc_param_str', '');
    const body = {
      pwd_id: share.id,
      passcode: share.passcode || '',
      support_visit_limit_private_share: true
    };
    const json = await request(endpoint.toString(), {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8'
      },
      body: JSON.stringify(body)
    }, signal);
    if (!json.data || !json.data.stoken) {
      throw new Error('无法获取分享访问令牌，请确认链接和提取码，或先在夸克页面打开该分享');
    }
    return json.data.stoken;
  }

  function makeDetailUrl(share, token, parentId, page) {
    const url = new URL(API_BASE + '/detail');
    const p = url.searchParams;
    p.set('pr', 'ucpro');
    p.set('fr', 'pc');
    p.set('uc_param_str', '');
    p.set('ver', '2');
    p.set('pwd_id', share.id);
    p.set('stoken', token);
    p.set('pdir_fid', String(parentId));
    p.set('force', '0');
    p.set('_page', String(page));
    p.set('_size', String(PAGE_SIZE));
    p.set('_fetch_banner', parentId === '0' && page === 1 ? '1' : '0');
    p.set('_fetch_share', parentId === '0' && page === 1 ? '1' : '0');
    p.set('fetch_relate_conversation', '0');
    p.set('_fetch_total', '1');
    p.set('_sort', 'file_type:asc,file_name:asc');
    return url.toString();
  }

  function isFolder(item) {
    return item.dir === true || item.dir === 1 || item.dir === '1' ||
      item.file_type === 0 || item.file_type === '0';
  }

  function countFrom(data) {
    for (const item of [data.total, data.total_num, data.total_count,
      data.pagination && data.pagination.total]) {
      if (item !== null && item !== undefined && item !== '' && Number.isFinite(Number(item))) {
        return Number(item);
      }
    }
    return null;
  }

  function readTitle(data, shareId) {
    return (data.title || (data.share && (data.share.title || data.share.share_title)) ||
      (data.share_info && data.share_info.title) || shareId);
  }

  async function scanShare(share, recursive, signal, progress) {
    let token = await getShareToken(share, signal, false);
    let result = null;
    // sessionStorage 可能有旧 token。仅在第一次目录请求失败时重新申请。
    const rows = [];
    const queue = [{ id: '0', path: '', depth: -1 }];
    const visited = new Set();
    let folderCount = 0;
    let requestCount = 0;
    let title = share.id;

    while (queue.length) {
      if (signal.aborted) throw new DOMException('已停止', 'AbortError');
      const folder = queue.shift();
      if (visited.has(folder.id)) continue;
      visited.add(folder.id);
      folderCount++;
      let received = 0;
      let previousFingerprint = null;
      for (let page = 1; page <= MAX_PAGES_PER_FOLDER; page++) {
        if (requestCount) await pause(REQUEST_GAP_MS, signal);
        let json;
        try {
          json = await request(makeDetailUrl(share, token, folder.id, page), {}, signal);
        } catch (err) {
          if (folder.id === '0' && page === 1 && cachedTokenForCurrentShare(share.id) === token && !share.token) {
            token = await getShareToken(share, signal, true);
            json = await request(makeDetailUrl(share, token, folder.id, page), {}, signal);
          } else {
            throw err;
          }
        }
        requestCount++;
        const data = json.data;
        if (!data || !Array.isArray(data.list)) {
          throw new Error('返回结果缺少 data.list，无法确认文件列表完整性');
        }
        if (folder.id === '0' && page === 1) {
          title = String(readTitle(data, share.id));
        }
        const list = data.list;
        const total = countFrom(data);
        if (list.length === 0) {
          if (total !== null && total > received) {
            throw new Error('目录 ' + (folder.path || '/') + ' 提前返回空页：已获取 ' + received + '/' + total);
          }
          break;
        }
        const fingerprint = list.map(function (item) { return String(item.fid); }).join('|');
        if (previousFingerprint === fingerprint) {
          throw new Error('目录 ' + (folder.path || '/') + ' 连续返回相同页面，已中止以免生成重复/不完整清单');
        }
        previousFingerprint = fingerprint;
        for (const item of list) {
          const name = String(item.file_name || '(未命名)');
          const path = folder.path + '/' + name;
          const dir = isFolder(item);
          rows.push({
            share_id: share.id,
            share_url: share.url,
            share_title: title,
            path: path,
            parent_path: folder.path || '/',
            depth: folder.depth + 1,
            name: name,
            is_folder: dir,
            fid: item.fid === undefined ? '' : String(item.fid),
            parent_fid: String(folder.id),
            size_bytes: dir ? null : (item.size === undefined ? null : item.size),
            file_type: item.file_type === undefined ? null : item.file_type,
            created_at: item.created_at === undefined ? null : item.created_at,
            updated_at: item.updated_at === undefined ? null : item.updated_at,
            // 原始条目保留 API 提供的文件属性，不包含 HTTP Cookie/stoken。
            raw: item
          });
          if (dir && recursive && item.fid !== undefined && item.fid !== null) {
            queue.push({ id: String(item.fid), path: path, depth: folder.depth + 1 });
          }
        }
        received += list.length;
        if (rows.length > MAX_ROWS_PER_SHARE) {
          throw new Error('单个分享超过安全上限 ' + MAX_ROWS_PER_SHARE + ' 条，请缩小导出范围');
        }
        progress({ id: share.id, files: rows.length, folders: folderCount, pending: queue.length, pages: requestCount });
        // 部分接口不返回 total，继续用“少于 PAGE_SIZE”判断最后一页。
        if (list.length < PAGE_SIZE || (total !== null && total > 0 && received >= total)) break;
        if (page === MAX_PAGES_PER_FOLDER) {
          throw new Error('目录分页超过安全上限，未导出不完整结果');
        }
      }
    }
    result = {
      share_id: share.id,
      share_url: share.url,
      title: title,
      file_count: rows.filter(function (r) { return !r.is_folder; }).length,
      folder_count: rows.filter(function (r) { return r.is_folder; }).length,
      rows: rows
    };
    return result;
  }

  function safeCsvValue(input) {
    let value = input === null || input === undefined ? '' : String(input);
    // 防止 Excel / 表格软件将网盘文件名解释为公式。
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(value)) value = "'" + value;
    return '"' + value.replace(/"/g, '""') + '"';
  }

  function csv(results) {
    const columns = [
      'share_title', 'share_id', 'share_url', 'path', 'parent_path', 'depth',
      'name', 'is_folder', 'fid', 'parent_fid', 'size_bytes', 'file_type',
      'created_at', 'updated_at'
    ];
    const lines = [columns.map(safeCsvValue).join(',')];
    for (const result of results) {
      for (const row of result.rows) {
        lines.push(columns.map(function (key) { return safeCsvValue(row[key]); }).join(','));
      }
    }
    return '\ufeff' + lines.join('\r\n');
  }

  function tree(results) {
    const lines = [];
    for (const result of results) {
      lines.push(result.title + ' (' + result.share_url + ')');
      if (!result.rows.length) lines.push('(空目录)');
      for (const row of result.rows) {
        lines.push('  '.repeat(Math.max(0, row.depth)) + (row.is_folder ? '[目录] ' : '[文件] ') +
          row.name + (row.is_folder ? '/' : (row.size_bytes === null ? '' : ' (' + row.size_bytes + ' bytes)')));
      }
      lines.push('');
    }
    return '\ufeff' + lines.join('\r\n');
  }

  function filenameDate(date) {
    const pad = function (value) { return String(value).padStart(2, '0'); };
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) +
      '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  }

  function download(results, type, recursive) {
    const date = new Date();
    let text;
    let mime;
    if (type === 'json') {
      text = JSON.stringify({
        exported_at: date.toISOString(),
        recursive: recursive,
        total_shares: results.length,
        total_items: results.reduce(function (s, r) { return s + r.rows.length; }, 0),
        shares: results
      }, null, 2);
      mime = 'application/json;charset=utf-8';
    } else if (type === 'txt') {
      text = tree(results);
      mime = 'text/plain;charset=utf-8';
    } else {
      text = csv(results);
      mime = 'text/csv;charset=utf-8';
    }
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'quark-filelist-' + filenameDate(date) + '.' + type;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  // Shadow DOM 防止夸克站点样式影响面板；所有动态内容使用 textContent。
  const host = document.createElement('div');
  host.id = PREFIX + 'host';
  host.style.cssText = 'position:fixed;right:18px;bottom:20px;z-index:2147483647;font-family:system-ui,sans-serif;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = [
    ':host{color-scheme:light;}*{box-sizing:border-box;}',
    'button,select,textarea{font:inherit;}',
    '#toggle{background:#1867e8;border:0;border-radius:20px;color:#fff;padding:11px 17px;cursor:pointer;box-shadow:0 4px 16px #0004;font-weight:650;}',
    '#panel{width:min(390px,calc(100vw - 36px));background:#fff;border:1px solid #d9dfeb;border-radius:13px;box-shadow:0 10px 35px #0003;padding:16px;color:#202939;margin-bottom:10px;}',
    '[hidden]{display:none!important;}h2{font-size:16px;line-height:1.4;margin:0 0 10px;}',
    'p{font-size:12px;line-height:1.65;color:#586174;margin:6px 0 10px;}',
    'label{display:block;font-size:13px;margin:8px 0 4px;}',
    'textarea{width:100%;min-height:112px;resize:vertical;border:1px solid #b9c3d3;border-radius:7px;padding:8px;font-size:12px;line-height:1.5;color:#202939;background:#fff;}',
    'select{border:1px solid #b9c3d3;border-radius:7px;padding:7px;background:#fff;color:#202939;}',
    '.row{display:flex;gap:12px;align-items:center;margin:10px 0;flex-wrap:wrap;}',
    '.check{display:flex;gap:6px;align-items:center;margin:0;}',
    '.check input{margin:0;}.action{border:0;border-radius:7px;padding:9px 14px;cursor:pointer;font-weight:600;}',
    '#start{background:#1867e8;color:white;}#stop{background:#e9edf4;color:#293345;}',
    'button:disabled{opacity:.55;cursor:not-allowed;}',
    '#status{font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;max-height:130px;overflow-y:auto;color:#344154;border-top:1px solid #eef0f5;padding-top:9px;}',
    '#status.error{color:#ad2020;}'
  ].join('');
  shadow.appendChild(style);
  const panel = document.createElement('section');
  panel.id = 'panel';
  panel.hidden = true;
  panel.innerHTML = [
    '<h2>夸克文件清单批量导出</h2>',
    '<p>每行一个分享链接，可附“提取码: xxxx”。也可粘贴分享详情 API URL。留空导出当前分享。仅读取文件元数据。</p>',
    '<label for="links">分享链接（支持多个）</label>',
    '<textarea id="links" spellcheck="false" placeholder="https://pan.quark.cn/s/xxxx 提取码: 1234"></textarea>',
    '<div class="row"><label for="format" style="margin:0">导出格式</label>',
    '<select id="format"><option value="csv">CSV（Excel 可打开）</option>',
    '<option value="json">JSON（含原始元数据）</option>',
    '<option value="txt">TXT（目录树）</option></select>',
    '<label class="check"><input type="checkbox" id="recursive" checked>遍历子文件夹</label></div>',
    '<div class="row"><button class="action" id="start" type="button">开始导出</button>',
    '<button class="action" id="stop" type="button" disabled>停止</button></div>',
    '<div id="status" role="status" aria-live="polite">准备就绪</div>',
    '<p>CSV 保留常用属性；JSON 保留每个文件的完整原始条目。不会下载网盘文件或上传清单。</p>'
  ].join('');
  const toggle = document.createElement('button');
  toggle.id = 'toggle';
  toggle.type = 'button';
  toggle.textContent = '导出文件列表';
  shadow.appendChild(panel);
  shadow.appendChild(toggle);
  document.body.appendChild(host);

  const $ = function (selector) { return shadow.getElementById(selector); };
  const linksEl = $('links');
  linksEl.value = 'https://pan.quark.cn/s/' + encodeURIComponent(currentShareId());
  let controller = null;
  let running = false;
  toggle.addEventListener('click', function () { panel.hidden = !panel.hidden; });
  $('stop').addEventListener('click', function () {
    if (controller) controller.abort();
  });
  function status(message, error) {
    const element = $('status');
    element.textContent = message;
    element.classList.toggle('error', !!error);
  }
  function setRunning(value) {
    running = value;
    $('start').disabled = value;
    $('stop').disabled = !value;
    $('links').disabled = value;
    $('format').disabled = value;
    $('recursive').disabled = value;
  }

  $('start').addEventListener('click', async function () {
    if (running) return;
    let shares;
    try { shares = parseShares(linksEl.value); }
    catch (err) { status(err.message, true); return; }
    const recursive = $('recursive').checked;
    const format = $('format').value;
    const results = [];
    controller = new AbortController();
    setRunning(true);
    try {
      for (let i = 0; i < shares.length; i++) {
        const share = shares[i];
        status('正在处理分享 ' + (i + 1) + '/' + shares.length + '\n' + share.url +
          '\n正在获取访问令牌…');
        const result = await scanShare(share, recursive, controller.signal, function (p) {
          status('分享 ' + (i + 1) + '/' + shares.length + ' · ' + share.url +
            '\n已扫描 ' + p.files + ' 项，' + p.folders + ' 个已访问目录，' +
            p.pending + ' 个待访问目录，' + p.pages + ' 次请求');
        });
        results.push(result);
      }
      if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError');
      download(results, format, recursive);
      const items = results.reduce(function (sum, result) { return sum + result.rows.length; }, 0);
      status('完成：' + results.length + ' 个分享，' + items + ' 条记录。\n已生成 ' +
        format.toUpperCase() + ' 文件。若未出现下载，请检查浏览器下载权限。');
    } catch (err) {
      const reason = controller.signal.aborted || err.name === 'AbortError' ?
        '扫描已停止，未导出不完整数据。' :
        '导出失败，未导出不完整数据。\n' + err.message;
      status(reason + (results.length ? '\n此前已成功扫描 ' + results.length + ' 个分享。' : ''), true);
      console.error('[Quark File List Exporter]', err);
    } finally {
      controller = null;
      setRunning(false);
    }
  });
})();
