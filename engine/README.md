# engine — 免客户端模式的定位改写引擎

本目录是「证书 + 描述文件」路线的引擎:跑在你自己的电脑/局域网机器上,对 Apple 定位域名做 MITM 并改写坐标。手机**不安装任何代理 App(IPA)**,只装一份网页生成的描述文件。

选点页(仓库根部的 Worker)负责选点与生成描述文件;本引擎负责拦截与改写。协议与 `wloc8`(Swift)同源。

## 运行

```sh
cd engine
bash tools/make-certs.sh          # 生成证书(首次;需 openssl)
cp config.example.json config.json
# 编辑 config.json:
#   serverHost -> 电脑局域网 IP(手机代理要连的地址)
#   ssids      -> 你的 Wi-Fi 名称(可带密码)
npm start                         # Node >= 18,零依赖
```

引擎起两个端口:

| 端口 | 用途 |
| --- | --- |
| 8888(proxyPort) | MITM 代理:仅解密 `gs-loc.apple.com` / `gs-loc-cn.apple.com` / `gsp-ssl.ls.apple.com`,其余流量盲隧道 |
| 18080(adminPort) | 管理页:状态、`/ca.cer` 下载、`/wloc.mobileconfig` 描述文件(备用;主入口是选点页的生成器) |

## 手机侧

1. 与电脑同一 Wi-Fi,Safari 打开选点页(Worker)→「免客户端模式」卡片 → 填电脑 IP/Wi-Fi 信息 + 载入 CA(引擎管理页 `/ca.cer`)→ 生成并安装描述文件
2. 设置 → 通用 → 关于本机 → **证书信任设置** → 完全信任该 CA(必做)
3. 选点 → 储存到设备(请求经引擎代理落库)→ 刷新定位(关定位→飞行模式→等10秒→恢复→重开定位)

## 测试

```sh
npm test    # 11 个:改写器回归 + 代理端到端(全本地,不依赖外网)
```

## 红线与限制

- `certs/` 私钥只留在本机;描述文件只给自己用;8888 端口不要暴露公网(无鉴权)。
- 仅 Wi-Fi 生效(蜂窝不走该代理);iOS 27 正式版不可用。
- **核心假设待真机验证**:iOS locationd 是否遵循 Wi-Fi 手动代理。装好后看引擎日志是否出现 `MITM gs-loc...`;若无请求,此路不通,只能回客户端模块/wloc8 路线。
- 仅供授权测试;详见仓库根 README 的免责声明。
