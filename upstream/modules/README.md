# upstream/modules — 上游模块原文

这里存放的是 **xepes0/wloc 仓库 `modules/` 目录的原文副本**（未做任何修改），用于留档与对照：

| 文件 | 上游路径 |
| --- | --- |
| `wloc.sgmodule` | `modules/wloc.sgmodule`（Surge / Egern） |
| `wloc.conf` | `modules/wloc.conf`（Quantumult X） |
| `wloc.lpx` | `modules/wloc.lpx`（Loon） |
| `wloc.stoverride` | `modules/wloc.stoverride`（Stash） |
| `wloc.module` | `modules/wloc.module`（Shadowrocket） |

来源：`https://raw.githubusercontent.com/xepes0/wloc/refs/heads/main/modules/`（2026-09-20 抓取）

## 和 `templates/modules/`、`modules/` 的关系

三者是**同一份内容的不同形态**，`npm test` 里有一条不变量测试逐字节校验它们的关系：

| 目录 | 内容 | 谁改它 |
| --- | --- | --- |
| `upstream/modules/`（本目录） | 上游**已发布**的原文，运行时地址指向 GitHub Raw | 只在重新抓取上游时更新（手动） |
| `templates/modules/` | 以上游原文为基准，把**运行时地址**换成 `{{SITE}}` 占位符 | 手动 |
| `modules/`（仓库根部） | 生成结果，占位符替换为你的站点，由 Worker 提供 | `npm run configure` |

**我们与上游的差异只有三类地址**（脚本两个 + 图标），其余逐字节相同：

- `<RAW>/dist/wloc.js` → `<你的站点>/wloc.js`
- `<RAW>/dist/wloc-settings.js` → `<你的站点>/wloc-settings.js`
- `<RAW>/wloc.jpg` → `<你的站点>/wloc.jpg`（图标也自托管，见下）

署名与说明（`#!desc` 里的上游链接、`#!homepage`）保留原文——那是署名，不是运行时依赖。所以**模块在运行时对 GitHub Raw 是零依赖**。

## 图标

`public/wloc.jpg`（4.6 KB）是从上游抓取的同名图标，由 Worker 在 `/wloc.jpg` 提供，模块的 `icon` 字段指向它，不再指向 GitHub Raw。

## 安装请用根部 `modules/`

`upstream/` 里的文件是留档对照用的；装到手机上请订阅仓库根部 [`modules/`](../modules/) 生成的那份（页面上显示的订阅地址就是它）。
