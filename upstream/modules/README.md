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

## 注意：这些**不是**本仓库实际提供的订阅

它们的脚本地址指向 **GitHub Raw**：

```text
https://raw.githubusercontent.com/xepes0/wloc/refs/heads/main/dist/wloc.js
```

本仓库自己生成的订阅在仓库根部的 [`modules/`](../modules/) 目录，脚本与页面都由**你自己的 Cloudflare Worker** 提供（`script-path` 指向你的站点），不依赖 GitHub Raw。**要装到手机上请用那一份**，这里的文件只是上游原文备份。

两者的差别仅在于脚本地址与描述文案；拦截规则、参数、MITM 域名列表完全一致。

## 和 `templates/modules/` 的关系

- `templates/modules/`：带 `{{SITE}}` 占位符的模板，`npm run configure` 用它生成根部 `modules/`。
- 本目录：上游**已发布**的成品，不含占位符，也不参与生成，改它不会被任何流程覆盖、也不影响构建。
