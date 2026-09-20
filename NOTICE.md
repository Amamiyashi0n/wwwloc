# NOTICE — 来源与完整性

## 来源

本仓库是 **xepes0/wloc**(WLOC 社区维护版)的 Cloudflare 单实例再打包:

| 内容 | 来源 | 处理方式 |
| --- | --- | --- |
| `vendor/wloc.js`、`vendor/wloc-settings.js` | xepes0/wloc `dist/`(恢复自 Yu9191/wloc,基线 `529fcd8`,2026-09-04) | **字节级副本**,未做任何修改 |
| `src/parse.js`、`src/gcj-browser.js`、`src/page.js` | xepes0/wloc `worker/src/` | 原样复用;`page.js` 仅改页脚署名一行 |
| 五种模块 | xepes0/wloc `templates/modules/` | 仅把脚本下载地址从 GitHub Raw 改为 `{{SITE}}`(Worker 自托管),规则、参数与 MITM 域名未动 |
| `src/index.js`、`scripts/`、`templates/`、工程配置 | 本仓库新写 | 单 Worker 全托管组织方式 |

原作者 Yu9191 的仓库已不可访问;恢复过程、镜像来源与「dist 缺少完整源工程、无法复现重建」的限制,见上游 `docs/PROVENANCE.md` 的记录,此处不再重复。

## 上游完整性

`docs/upstream-integrity.json` 记录两份 vendor 脚本与 LICENSE 的 SHA-256(LF 规范化),与上游恢复基线的记录一致。`npm run check` 会逐字节校验:

- 任何对 `vendor/` 的改动都会导致检查失败。这两份脚本是压缩产物,**没有可审阅的源码**;如果你需要修改 WLOC 改写逻辑,正确路径是先重建源工程,而不是手改 minified 代码。
- LICENSE 的哈希同样被记录,以保证许可证文本未被替换。

## 已知限制

- `vendor/wloc-settings.js` 对经纬度 `0` 使用真值判断,缺失保存参数有被当成 `0` 的风险(上游已知问题,继承于此,待上游修复后同步)。
- 保存接口沿用上游的宽松 CORS 与 GET 写入设计;这是与旧快捷指令保持兼容的有意选择,不是疏忽。
- WLOC 依赖的 MITM 链路在 iOS 27 正式版上已被苹果封堵,本仓库无法也不试图绕过。

## 隐私边界

Worker 本身:无数据库、无 KV、无持久化日志(observability 关闭),API 全部 `no-store`。
链路整体:地图瓦片(CDN)、地名搜索(Nominatim)、地图链接解析(目标地图站)都会产生第三方可见的网络请求。自托管只消除「第三方 Worker 实例」这一层,不消除网络层记录。
