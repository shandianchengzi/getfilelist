// ==UserScript==
// @name         夸克网盘分享文件列表导出
// @namespace    https://github.com/shandianchengzi/getfilelist
// @version      1.1.0
// @description  递归读取夸克网盘分享文件列表，支持 TXT/CSV/JSON 导出
// @author       shandianchengzi
// @match        https://pan.quark.cn/s/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      drive-pc.quark.cn
// @license      GPL-3.0-only
// ==/UserScript==

(function () {
  'use strict';
  const sid = location.pathname.match(/^\/s\/([a-zA-Z0-9_-]+)/)?.[1];
  if (!sid) return;
  const PAGE_SIZE = 50;
  const BASE_PATH = '/1/clouddrive/share/sharepage/';
  const MAX_PAGES = 2000;
  const MAX_FOLDERS = 20000;
  let running = null, result = null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const aborted = signal => { if (signal.aborted) throw new DOMException('已取消', 'AbortError'); };

  async function nativeRequest(url, method, body, signal) {
    const timeout = new AbortController();
    const onAbort = () => timeout.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => timeout.abort(), 20000);
    try {
      aborted(signal);
      const response = await fetch(url, {
        method, credentials: 'include', cache: 'no-store', signal: timeout.signal,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json;charset=UTF-8' }) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (!response.ok) throw Error('HTTP ' + response.status);
      return await response.json();
    } catch (error) {
      aborted(signal);
      if (timeout.signal.aborted) throw Error('请求超时');
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  function crossOriginRequest(url, method, body, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('已取消', 'AbortError'));
      let xhr, settled = false;
      const finish = (error, data) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(data);
      };
      const cancel = () => {
        xhr?.abort();
        finish(new DOMException('已取消', 'AbortError'));
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        xhr = GM_xmlhttpRequest({
          url, method, timeout: 20000,
          headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json;charset=UTF-8' }) },
          data: body === undefined ? undefined : JSON.stringify(body),
          onload: response => {
            if (response.status < 200 || response.status >= 300) return finish(Error('HTTP ' + response.status));
            try { finish(null, JSON.parse(response.responseText)); }
            catch { finish(Error('响应不是 JSON')); }
          },
          onerror: () => finish(Error('网络连接失败')),
          ontimeout: () => finish(Error('请求超时')),
          onabort: () => finish(new DOMException('已取消', 'AbortError'))
        });
        if (signal.aborted) cancel();
      } catch (error) { finish(error); }
    });
  }

  async function api(endpoint, method, query, body, signal) {
    const errors = [];
    for (const host of [location.origin, 'https://drive-pc.quark.cn']) {
      aborted(signal);
      const url = new URL(host + BASE_PATH + endpoint);
      Object.entries({ pr: 'ucpro', fr: 'pc', uc_param_str: '', ...query, __t: Date.now() })
        .forEach(([key, value]) => url.searchParams.set(key, String(value)));
      try {
        let json;
        if (host === location.origin) json = await nativeRequest(url.href, method, body, signal);
        else {
          try { json = await nativeRequest(url.href, method, body, signal); }
          catch (error) {
            aborted(signal);
            json = await crossOriginRequest(url.href, method, body, signal);
          }
        }
        if (!json || typeof json !== 'object') throw Error('服务器未返回 JSON 对象');
        if (json.code !== undefined && ![0, '0', 'OK'].includes(json.code)) {
          const error = Error('夸克接口错误 ' + json.code + '：' + (json.message || json.msg || '请检查提取码和分享有效性'));
          error.apiError = true;
          throw error;
        }
        if (typeof json.status === 'number' && json.status >= 400) {
          const error = Error('夸克接口状态 ' + json.status + '：' + (json.message || '请求失败'));
          error.apiError = true;
          throw error;
        }
        return json;
      } catch (error) {
        aborted(signal);
        if (error.apiError) throw error;
        errors.push(host + ': ' + error.message);
      }
    }
    throw Error('请求夸克接口失败：' + errors.join('；'));
  }

  function cachedToken() {
    try {
      const saved = JSON.parse(sessionStorage.getItem('_share_args') || 'null');
      const entry = saved?.value || saved;
      const id = entry?.pwd_id || entry?.pwdId || entry?.share_id;
      if (id && String(id) !== sid) return '';
      return typeof entry?.stoken === 'string' ? entry.stoken : '';
    } catch { return ''; }
  }

  async function token(passcode, signal, useCache) {
    if (useCache && !passcode && cachedToken()) return cachedToken();
    const response = await api('token', 'POST', {}, {
      pwd_id: sid, passcode, support_visit_limit_private_share: true
    }, signal);
    if (!response.data?.stoken) throw Error('未获得访问令牌，请检查分享是否有效及提取码');
    return response.data.stoken;
  }

  async function directory(fid, stoken, signal, progress) {
    const all = [];
    let previousPage = '';
    for (let page = 1; page <= MAX_PAGES; page++) {
      aborted(signal);
      const response = await api('detail', 'GET', {
        pwd_id: sid, stoken, pdir_fid: fid, force: 0,
        _page: page, _size: PAGE_SIZE, _fetch_total: 1,
        _fetch_share: 0, _fetch_banner: 0, _sort: 'file_type:asc,file_name:asc', ver: 2
      }, undefined, signal);
      const list = response.data?.list;
      if (!Array.isArray(list)) throw Error('目录 ' + fid + ' 返回的列表格式不正确');
      if (!list.length) return all;
      const signature = list.map(item => String(item.fid) + ':' + String(item.file_name)).join('|');
      if (signature === previousPage) throw Error('检测到重复分页，已终止以免产生错误清单');
      previousPage = signature;
      all.push(...list);
      progress(page, all.length);
      const rawTotal = response.data?.total;
      const total = rawTotal === null || rawTotal === undefined ? NaN : Number(rawTotal);
      if (Number.isFinite(total) && all.length >= total) return all;
      if (list.length < PAGE_SIZE && !Number.isFinite(total)) return all;
      await sleep(120);
    }
    throw Error('目录分页超过安全上限：' + fid);
  }

  function isFolder(file) {
    return file.dir === true || file.dir === 1 || file.dir === '1' ||
      (file.file_type != null && Number(file.file_type) === 0) || file.type === 'folder';
  }

  function timestamp(value) {
    if (value == null || value === '') return '';
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1000000000) return String(value);
    const date = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }

  function normalize(file, parent, path, depth) {
    const name = String(file.file_name ?? file.name ?? '(未命名)');
    const folder = isFolder(file);
    return {
      fid: String(file.fid ?? ''),
      parent_fid: String(parent),
      name, path: path ? path + '/' + name : name,
      type: folder ? 'folder' : 'file',
      size: folder || file.size == null || !Number.isFinite(Number(file.size)) ? null : Number(file.size),
      created_at: timestamp(file.created_at),
      updated_at: timestamp(file.updated_at),
      mime_type: String(file.mime_type ?? ''),
      obj_category: String(file.obj_category ?? ''),
      depth
    };
  }

  async function scan(passcode, signal, status) {
    let stoken = await token(passcode, signal, true);
    let refreshed = false;
    const stack = [{ fid: '0', path: '', depth: 0 }];
    const visited = new Set();
    const items = [];
    let files = 0, folders = 0, bytes = 0;
    while (stack.length) {
      aborted(signal);
      const parent = stack.pop();
      if (visited.has(parent.fid)) continue;
      visited.add(parent.fid);
      if (visited.size > MAX_FOLDERS) throw Error('文件夹数量超过安全上限');
      status('正在扫描 ' + (parent.path || '/') + '\n已获取文件 ' + files + '、文件夹 ' + folders);
      let children;
      try {
        children = await directory(parent.fid, stoken, signal, (page, count) =>
          status('正在扫描 ' + (parent.path || '/') + '\n第 ' + page + ' 页，本目录 ' + count + ' 项'));
      } catch (error) {
        if (parent.fid !== '0' || passcode || refreshed || !cachedToken() || !error.apiError) throw error;
        refreshed = true;
        stoken = await token('', signal, false);
        children = await directory(parent.fid, stoken, signal, () => {});
      }
      const subdirs = [];
      for (const child of children) {
        const item = normalize(child, parent.fid, parent.path, parent.depth);
        items.push(item);
        if (item.type === 'folder') {
          folders++;
          if (!item.fid) throw Error('文件夹缺少 fid：' + item.path);
          subdirs.push({ fid: item.fid, path: item.path, depth: parent.depth + 1 });
        } else {
          files++;
          bytes += item.size || 0;
        }
      }
      stack.push(...subdirs.reverse());
      await sleep(120);
    }
    return {
      source_url: location.origin + '/s/' + sid,
      share_id: sid,
      exported_at: new Date().toISOString(),
      summary: { files, folders, items: items.length, total_file_bytes: bytes },
      items
    };
  }

  function tree(data) {
    const groups = new Map();
    for (const item of data.items) {
      if (!groups.has(item.parent_fid)) groups.set(item.parent_fid, []);
      groups.get(item.parent_fid).push(item);
    }
    const lines = [
      '分享链接：' + data.source_url,
      '导出时间：' + data.exported_at,
      '文件：' + data.summary.files + '，文件夹：' + data.summary.folders +
        '，文件大小合计：' + data.summary.total_file_bytes + ' bytes', ''
    ];
    const stack = (groups.get('0') || []).slice().reverse();
    while (stack.length) {
      const item = stack.pop();
      lines.push('  '.repeat(item.depth) + (item.type === 'folder' ? '📁 ' : '📄 ') +
        item.name.replace(/[\r\n\t]/g, ' ') +
        (item.type === 'file' && item.size !== null ? ' (' + item.size + ' bytes)' : ''));
      if (item.type === 'folder') stack.push(...(groups.get(item.fid) || []).slice().reverse());
    }
    return lines.join('\n') + '\n';
  }

  function filenameList(data, includeFolders) {
    return data.items.filter(item => includeFolders || item.type === 'file')
      .map(item => item.name.replace(/[\r\n]+/g, ' ')).join('\n');
  }

  function csvCell(value) {
    let str = value == null ? '' : String(value);
    if (/^[\s\x00-\x1f]*[=+@-]/.test(str)) str = "'" + str;
    return '"' + str.replace(/"/g, '""') + '"';
  }

  function csv(data) {
    const keys = ['path', 'name', 'type', 'size', 'created_at', 'updated_at',
      'fid', 'parent_fid', 'mime_type', 'obj_category', 'depth'];
    return '\ufeff' + [keys.join(','), ...data.items.map(item =>
      keys.map(key => csvCell(item[key])).join(','))].join('\r\n') + '\r\n';
  }

  function save(data, extension) {
    const content = extension === 'json' ? JSON.stringify(data, null, 2) + '\n' :
      extension === 'csv' ? csv(data) : tree(data);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'quark_' + sid + '.' + extension;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function ui(tag, text, parent) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    parent?.appendChild(element);
    return element;
  }

  function init() {
    const style = ui('style', [
      '#qfl-entry{position:fixed;right:20px;bottom:90px;z-index:2147483646;background:#356cf3;color:white;border:0;border-radius:25px;padding:10px 16px;font-size:14px;cursor:pointer;box-shadow:0 4px 15px #0003}',
      '#qfl-panel{position:fixed;right:20px;bottom:145px;z-index:2147483647;background:white;color:#222;box-shadow:0 6px 35px #0004;border-radius:12px;width:min(465px,calc(100vw - 40px));max-height:calc(100vh - 170px);overflow:auto;padding:14px;font:13px/1.5 system-ui,sans-serif;display:none;box-sizing:border-box}',
      '#qfl-panel *{box-sizing:border-box}#qfl-panel button{border:0;border-radius:6px;background:#356cf3;color:white;cursor:pointer;padding:7px 10px;margin:3px;font:inherit}',
      '#qfl-panel button:disabled{background:#bdc3ce;cursor:not-allowed}#qfl-panel input{width:150px;padding:7px;border:1px solid #bcc4d0;border-radius:6px;margin-right:4px}',
      '#qfl-panel pre{max-height:260px;overflow:auto;background:#f6f7f9;padding:8px;white-space:pre;font:12px/1.45 Consolas,monospace}#qfl-panel .qfl-status{white-space:pre-wrap;background:#f2f5ff;padding:8px;border-radius:6px;margin:8px 0}'
    ].join(''), document.head);
    style.id = 'qfl-css';

    const entry = ui('button', '📂 导出文件列表', document.body);
    entry.id = 'qfl-entry';
    const panel = ui('div', undefined, document.body);
    panel.id = 'qfl-panel';
    const title = ui('div', '夸克分享文件清单', panel);
    title.style.fontWeight = 'bold';
    title.style.fontSize = '16px';
    ui('p', '递归获取全部子目录和分页；仅读取元数据，不下载文件。', panel);
    const code = ui('input', undefined, panel);
    code.placeholder = '提取码（无则留空）';
    code.autocomplete = 'off';
    const params = new URL(location.href).searchParams;
    code.value = params.get('pwd') || params.get('passcode') || '';
    const begin = ui('button', '扫描完整目录', panel);
    const stop = ui('button', '取消', panel);
    ui('hr', undefined, panel);
    const buttons = ['txt', 'csv', 'json'].map(ext => {
      const button = ui('button', '导出 ' + ext.toUpperCase(), panel);
      button.onclick = () => { if (result) save(result, ext); };
      return button;
    });
    const copy = ui('button', '复制目录树', panel);
    buttons.push(copy);
    const copyNames = ui('button', '仅复制名称', panel);
    buttons.push(copyNames);
    const namesIncludeLabel = ui('label', '包含文件夹', panel);
    const namesInclude = ui('input', undefined, namesIncludeLabel);
    namesInclude.type = 'checkbox';
    namesInclude.style.width = 'auto';
    namesInclude.style.marginLeft = '6px';
    const status = ui('div', '点击「扫描完整目录」开始。', panel);
    status.className = 'qfl-status';
    const preview = ui('pre', '', panel);
    const nameFallback = ui('textarea', undefined, panel);
    nameFallback.readOnly = true;
    nameFallback.style.cssText = 'display:none;width:100%;height:110px;resize:vertical;font:12px/1.5 monospace;white-space:pre;';
    function setBusy(busy) {
      begin.disabled = busy;
      stop.disabled = !busy;
      code.disabled = busy;
      namesInclude.disabled = busy;
      for (const button of buttons) button.disabled = busy || !result;
    }
    const say = value => { status.textContent = value; };
    begin.onclick = async () => {
      if (running) return;
      result = null;
      preview.textContent = '';
      nameFallback.style.display = 'none';
      nameFallback.value = '';
      running = new AbortController();
      setBusy(true);
      try {
        result = await scan(code.value.trim(), running.signal, say);
        say('✅ 完成：' + result.summary.files + ' 个文件、' +
          result.summary.folders + ' 个文件夹。全部数据仅保存在当前网页内。');
        const text = tree(result);
        preview.textContent = text.length > 25000 ?
          text.slice(0, 25000) + '\n…预览截断，下载内容不受影响' : text;
      } catch (error) {
        say(error.name === 'AbortError' ? '已取消；不会导出不完整的清单。' :
          '❌ ' + error.message + '\n若分享设有提取码，请输入后重试。');
        console.error('[getfilelist]', error);
      } finally {
        running = null;
        setBusy(false);
      }
    };
    stop.onclick = () => running?.abort();
    copy.onclick = async () => {
      if (!result) return;
      try {
        await navigator.clipboard.writeText(tree(result));
        say('目录树已复制到剪贴板。');
      } catch (error) {
        say('复制失败：' + error.message + '；请导出 TXT。');
      }
    };
    copyNames.onclick = async () => {
      if (!result) return;
      const names = filenameList(result, namesInclude.checked);
      if (!names) {
        say('没有可复制的' + (namesInclude.checked ? '条目' : '文件') + '名称。');
        return;
      }
      nameFallback.style.display = 'none';
      const count = result.items.filter(item => namesInclude.checked || item.type === 'file').length;
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
          throw Error('此浏览器不支持剪贴板 API');
        }
        await navigator.clipboard.writeText(names);
        say('已复制 ' + count + ' 个名称，每行一个，不包含路径和其他信息。');
      } catch (error) {
        nameFallback.value = names;
        nameFallback.style.display = 'block';
        nameFallback.focus();
        nameFallback.select();
        say('浏览器禁止自动复制，名称已填入下方文本框并选中，请按 Ctrl+C 手动复制。');
      }
    };
    function toggle() {
      panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    }
    entry.onclick = toggle;
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('显示/隐藏文件清单面板', toggle);
    }
    setBusy(false);
  }
  if (document.body && document.head) init();
  else window.addEventListener('DOMContentLoaded', init, { once: true });
})();
