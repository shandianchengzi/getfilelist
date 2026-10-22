# getfilelist — 夸克网盘分享文件清单导出

基于 Tampermonkey 的夸克网盘分享文件清单导出项目。支持批量导出文件名称、目录路径、大小、时间戳、文件 ID、原始文件元数据等信息，数据只在本地生成。

## 推荐：多分享批量导出版

**安装：** [quark-filelist.user.js（点击安装）](https://raw.githubusercontent.com/shandianchengzi/getfilelist/main/quark-filelist.user.js)

适合从一个或多个夸克分享链接中完整整理文件目录，支持：

- 一次粘贴**多个**分享链接、提取码或分享详情 API 请求 URL；同一分享自动去重。
- 遍历分享根目录及任意深度子目录，并逐页获取全部文件（每页 50 项）。
- 三种格式本地下载：**CSV（Excel/WPS 可读取）、JSON（含原始文件条目 raw）、TXT（真实目录树）**。
- 输出分享名称、分享 ID、链接、文件名、完整路径、层级、目录标记、大小、时间、FID 等常用属性。
- 停止扫描、有限重试、避免无限翻页；请求失败不静默导出不完整清单。
- 不收集 Cookie、不上传文件清单、不下载网盘文件；使用已登录浏览器的会话请求夸克 API。

### 如何使用

1. 安装浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/)。
2. 点击上面的脚本安装链接，在油猴扩展中确认安装。
3. 打开任意夸克分享页（\`https://pan.quark.cn/s/...\`）。
4. 点击右下角 **导出文件列表**，选择 CSV、JSON 或 TXT，然后按 **开始导出**。

默认输入框会填入当前分享链接。**批量模式**是在输入框中每行粘贴一个链接，例如：

\`\`\`text
https://pan.quark.cn/s/xxxxxxxx
https://pan.quark.cn/s/yyyyyyyy 提取码: 1234
https://pan.quark.cn/s/zzzzzzzz?pwd=ABCD
\`\`\`

如果已从开发者工具复制了夸克的 \`/share/sharepage/detail\` 请求 URL，也可将它粘贴到输入框（需要含 \`pwd_id\` 和 \`stoken\`）。脚本仅提取所需访问参数，仍会自动分页并递归遍历。**请勿公开该 URL 中的令牌。**

默认勾选 **遍历子文件夹**；取消勾选仅导出每个分享根目录的项目（依然会翻页）。多个分享合并为一个导出文件，CSV 和 JSON 会标记每个条目的来源。

### 数据格式

| 格式 | 导出字段/结构 | 用途 |
| --- | --- | --- |
| CSV | 分享名称/ID/URL、路径、父路径、层级、名称、目录标记、FID、父目录 FID、字节数、文件类型、创建时间、修改时间 | 表格筛选、批量统计 |
| JSON | \`exported_at\`、\`recursive\`、\`total_shares\`、\`total_items\`、\`shares\`；每个文件条目包含公共字段和原始 \`raw\` | 再加工、数据分析、获取接口全部元数据 |
| TXT | 按文件夹父子关系展开的文本目录树，带文件大小 | 目录阅读、归档 |

CSV 使用 UTF-8 BOM 支持中文 Excel，同时对公式式文件名做安全转义。JSON 的原始条目可能包含分享范围内的文件访问标识，请妥善保管导出结果；脚本不会额外写入浏览器 Cookie 或分享访问 \`stoken\`。

### 网络与安全说明

脚本只通过夸克域名的以下 Web API 获取数据：

- \`POST https://drive-h.quark.cn/1/clouddrive/share/sharepage/token\`
- \`GET https://drive-h.quark.cn/1/clouddrive/share/sharepage/detail\`

请求携带浏览器当前已有的站点会话凭据（\`credentials: include\`），不会上传数据到第三方；使用 \`@grant none\`，无需扩展授予额外网络权限。

分享失效、提取码不正确、浏览器阻止第三方 Cookie 或夸克调整跨域访问规则时，可能无法扫描。可先在夸克网页中正常打开/解锁分享，再运行脚本。这里使用的是夸克未公开的 Web 接口；现网行为可能变化。

**当前验证状态：** 已做 JavaScript 语法检查和模拟接口回归测试；尚未在真实登录夸克账号的浏览器里完成端到端运行测试。

## 备用：单分享扫描版

仓库另有 [quark-share-file-list.user.js](https://raw.githubusercontent.com/shandianchengzi/getfilelist/main/quark-share-file-list.user.js)，供**单个分享页**扫描和预览，支持导出 TXT/CSV/JSON、复制目录树。它使用 \`GM_xmlhttpRequest\`，在某些跨域环境下可能有不同的兼容性。该版本不支持上面多分享批量版的“多链接合并导出”。

**两个版本不要同时启用**，否则分享页可能同时显示两个导出面板。

## 开发与测试

多分享版不依赖 npm 软件包。使用 Node.js 20+：

\`\`\`bash
node --check quark-filelist.user.js
node --test tests/*.test.cjs
\`\`\`

回归测试覆盖多链接解析、访问码、分享详情 URL、分页、递归、CSV 安全处理、目录树顺序、API 错误、重复分页和取消。

建议再人工验证：空目录、根目录超过 50 项、子目录超过 50 项、多层目录、需要提取码的分享、混合多分享、手动停止，以及链接失效时的错误提示。

## 许可证

- 多分享版 \`quark-filelist.user.js\`：**MIT**，见 [LICENSE](LICENSE)。
- 单分享版 \`quark-share-file-list.user.js\`：脚本标注为 **GPL-3.0-only**。请分别遵守文件内的许可证标注。
