# getfilelist — 夸克网盘分享目录导出

基于 Tampermonkey 的夸克网盘分享文件清单导出脚本，支持递归遍历、多页列表和 TXT、CSV、JSON 本地导出。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. [点击安装脚本](https://raw.githubusercontent.com/shandianchengzi/getfilelist/main/quark-share-file-list.user.js)，或在脚本管理器中新建脚本并粘贴代码。
3. 打开夸克分享链接，例如 https://pan.quark.cn/s/74efc047e198 ，在右下角点击「📂 导出文件列表」。
4. 按需填写提取码，扫描完成后下载 TXT、CSV 或 JSON。

## 功能

- 递归遍历子目录，逐页获取文件列表；支持取消扫描。
- TXT 导出目录树；CSV 包含路径、类型、大小、时间和文件 ID；JSON 包含结构化清单和汇总信息。
- 文件清单本地生成，不下载文件内容、不转存文件，也不上传数据到第三方；不把 Cookie、访问令牌和提取码写入导出文件。
- 支持夸克分享页 `https://pan.quark.cn/s/...`，不支持个人网盘的「我的文件」。
- 分享链接失效、需要提取码或额外访问验证时，需在网页上具备正常访问权限。
- 依赖夸克未公开的 Web 接口，网站改版后可能需要维护；尚未完成真实分享页的端到端验证。

## License

GPL-3.0-only
