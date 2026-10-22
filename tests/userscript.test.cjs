'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'quark-filelist.user.js'), 'utf8');

// 只隔离业务逻辑进行测试，不需要真实夸克 Cookie 或浏览器 DOM。
// 页面 UI 需要在 Tampermonkey 中做手动集成验证。
function loadWith(fetch, storedToken) {
  const start = source.indexOf('(function () {');
  const end = source.indexOf('  // Shadow DOM 防止');
  assert.ok(start > 0 && end > start, 'userscript business logic found');
  const isolated = source.slice(start, end) +
    'return { parseShares, scanShare, csv, tree, isFolder }; })();';
  const load = new Function(
    'location', 'document', 'sessionStorage', 'fetch', 'URL', 'DOMException', 'setTimeout',
    'return ' + isolated
  );
  return load(
    { pathname: '/s/example' },
    { getElementById: () => null },
    { getItem: () => storedToken ? JSON.stringify({ value: { stoken: storedToken } }) : null },
    fetch, URL, DOMException, setTimeout
  );
}

function response(data, extra = {}) {
  return { status: 200, json: async () => ({ code: 0, data, ...extra }) };
}

test('accepts many share URLs, deduplicates them and parses access codes', () => {
  const api = loadWith(async () => response({}));
  const list = api.parseShares([
    'https://pan.quark.cn/s/example',
    'https://pan.quark.cn/s/example 提取码：AB12',
    'https://pan.quark.cn/s/second?pwd=1234'
  ].join('\n'));
  assert.equal(list.length, 2);
  assert.equal(list[0].passcode, 'AB12');
  assert.equal(list[1].passcode, '1234');
  assert.equal(list[0].url, 'https://pan.quark.cn/s/example');
  assert.throws(() => api.parseShares('https://attacker.example/s/hello'), /仅支持/);
});

test('reads original detail API URL without double-encoding its token', () => {
  const api = loadWith(async () => response({}));
  const [entry] = api.parseShares('https://drive-h.quark.cn/1/clouddrive/share/sharepage/detail?pwd_id=xyz&stoken=123%3D');
  assert.equal(entry.id, 'xyz');
  assert.equal(entry.token, '123=');
  assert.equal(entry.url, 'https://pan.quark.cn/s/xyz');
});

test('fetches all pages and child folders, exports CSV JSON fields and ordered tree', async () => {
  const calls = [];
  const rootPage1 = Array.from({ length: 49 }, (_, i) => ({
    fid: String(i), file_name: i === 0 ? '=HYPERLINK("x")' : 'video-' + i + '.mp4',
    file_type: 1, size: 2048, updated_at: 123456
  }));
  rootPage1.push({ fid: 'dir123', file_name: 'subfolder', file_type: 0, dir: true });
  const fetcher = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const endpoint = url.pathname.split('/').pop();
    calls.push({ endpoint, page: url.searchParams.get('_page'), dir: url.searchParams.get('pdir_fid') });
    if (endpoint === 'token') {
      assert.equal(init.method, 'POST');
      return response({ stoken: 'test-token' });
    }
    assert.equal(url.searchParams.get('stoken'), 'test-token');
    if (url.searchParams.get('pdir_fid') === 'dir123') {
      return response({ list: [{ fid: 'nested', file_name: 'inside.pdf', file_type: 1, size: 20 }], total: 1 });
    }
    if (url.searchParams.get('_page') === '1') {
      return response({ list: rootPage1, total: 51, title: '示例分享' });
    }
    return response({ list: [{ fid: 'last', file_name: 'last.txt', file_type: 1, size: 8 }], total: 51 });
  };
  const api = loadWith(fetcher);
  const [share] = api.parseShares('https://pan.quark.cn/s/example');
  const result = await api.scanShare(share, true, { aborted: false }, () => {});

  assert.equal(result.file_count, 51);
  assert.equal(result.folder_count, 1);
  assert.equal(result.rows.length, 52);
  assert.equal(result.rows.find(row => row.fid === 'nested').path, '/subfolder/inside.pdf');
  assert.ok(calls.some(call => call.page === '2'));
  assert.ok(calls.some(call => call.dir === 'dir123'));
  assert.ok(api.csv([result]).includes("'=HYPERLINK"));
  assert.ok(api.csv([result]).startsWith('\ufeff'));
  assert.equal(result.rows[0].raw.updated_at, 123456);
  const output = api.tree([result]);
  assert.ok(output.indexOf('subfolder/') < output.indexOf('inside.pdf'));
  assert.ok(output.indexOf('inside.pdf') < output.indexOf('last.txt'));
});

test('fails on API errors instead of exporting truncated results', async () => {
  const api = loadWith(async () => ({ status: 200, json: async () => ({
    code: 403, message: 'access denied'
  }) }));
  const [share] = api.parseShares('https://pan.quark.cn/s/example');
  await assert.rejects(
    api.scanShare(share, false, { aborted: false }, () => {}),
    /夸克 API 错误 403/
  );
});

test('detects repeated pages and stops instead of looping forever', async () => {
  const page = Array.from({ length: 50 }, (_, i) => ({
    fid: String(i), file_name: 'f' + i, file_type: 1
  }));
  const api = loadWith(async (rawUrl) => new URL(rawUrl).pathname.endsWith('/token')
    ? response({ stoken: 'token' })
    : response({ list: page }));
  const [share] = api.parseShares('https://pan.quark.cn/s/example');
  await assert.rejects(
    api.scanShare(share, false, { aborted: false }, () => {}),
    /连续返回相同页面/
  );
});

test('abort does not make a partial export appear successful', async () => {
  const api = loadWith(async () => { throw new Error('should not call'); });
  const [share] = api.parseShares('https://pan.quark.cn/s/example');
  await assert.rejects(
    api.scanShare(share, true, { aborted: true }, () => {}),
    /已停止/
  );
});
