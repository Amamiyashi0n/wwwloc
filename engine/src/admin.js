// 管理入口(默认只绑 127.0.0.1): 状态页、根证书下载、.mobileconfig 生成。
// 手机在"同一局域网 + 配置好 serverHost"后, 用 Safari 打开
//   http://<serverHost>:<adminPort>/
// 按页面指引安装描述文件。adminHost 改成 0.0.0.0 之前先读 README 的安全红线。
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getState } from "./settings.js";

function pemToDer(pem) {
  const body = pem
    .toString("utf8")
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s+/g, "");
  return Buffer.from(body, "base64");
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// .mobileconfig: 根 CA 证书 payload + 每个配置过的 SSID 一个 Wi-Fi payload(含手动代理)
export function buildMobileConfig(config) {
  const caPem = readFileSync(`${config.certsDir}/ca.crt`);
  const der = pemToDer(caPem);
  const identifier = config.profileIdentifier || "com.selfhost.wloc.test";
  const uuids = Array.from({ length: 1 + config.ssids.length }, () => randomUUID().toUpperCase());

  const content = [];
  content.push(`<dict>
    <key>PayloadType</key><string>com.apple.security.root</string>
    <key>PayloadVersion</key><integer>1</integer>
    <key>PayloadIdentifier</key><string>${identifier}.rootca</string>
    <key>PayloadUUID</key><string>${uuids[0]}</string>
    <key>PayloadDisplayName</key><string>WLOC Selfhost Root CA (Testing)</string>
    <key>PayloadDescription</key><string>Only install on your own authorized test device. Used to test Apple network location responses.</string>
    <key>PayloadContent</key><data>${der.toString("base64")}</data>
  </dict>`);

  config.ssids.forEach((entry, i) => {
    const ssid = typeof entry === "string" ? entry : entry.ssid;
    const password = typeof entry === "object" ? entry.password : undefined;
    content.push(`<dict>
    <key>PayloadType</key><string>com.apple.wifi.managed</string>
    <key>PayloadVersion</key><integer>1</integer>
    <key>PayloadIdentifier</key><string>${identifier}.wifi.${i}</string>
    <key>PayloadUUID</key><string>${uuids[i + 1]}</string>
    <key>PayloadDisplayName</key><string>WLOC Wi-Fi (${esc(ssid)})</string>
    <key>HIDDEN_NETWORK</key><false/>
    <key>AutoJoin</key><true/>
    <key>SSID_STR</key><string>${esc(ssid)}</string>${password ? `
    <key>Password</key><string>${esc(password)}</string>` : ""}
    <key>ProxyType</key><string>Manual</string>
    <key>ProxyServer</key><string>${esc(config.serverHost)}</string>
    <key>ProxyPort</key><integer>${config.proxyPort}</integer>
  </dict>`);
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
${content.join("\n")}
  </array>
  <key>PayloadDisplayName</key><string>WLOC Selfhost (Testing)</string>
  <key>PayloadDescription</key><string>Installs a testing root CA and points Wi-Fi HTTP proxy at your own WLOC proxy. Authorized devices only.</string>
  <key>PayloadIdentifier</key><string>${identifier}</string>
  <key>PayloadOrganization</key><string>selfhost-wloc</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadScope</key><string>System</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuids[0]}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
}

function statusPage(config) {
  const s = getState();
  const lanIps = Object.entries(globalThis.__lanIPs ?? {});
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>selfhost-wloc</title></head>
<body style="font-family:-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:16px">
<h2>selfhost-wloc 控制台</h2>
<p>代理端口 <b>${config.proxyPort}</b> · 管理端口 <b>${config.adminPort}</b> · 代理地址(填到手机) <b>${esc(config.serverHost)}:${config.proxyPort}</b></p>
<h3>当前锁定坐标</h3>
<p>${s ? `经度 ${s.longitude} · 纬度 ${s.latitude} · 精度 ${s.accuracy}m${s.randomRadius ? ` · 扰动 ${s.randomRadius}m` : ""}<br><small>更新于 ${s.updatedAt}</small>` : "<i>未锁定(定位透传)</i>"}</p>
<h3>安装步骤</h3>
<ol>
<li>在 <b>手机 Safari</b>(和电脑同一 Wi-Fi)打开本页, 下载 <a href="/wloc.mobileconfig">描述文件</a>, 按提示安装</li>
<li>设置 → 通用 → 关于本机 → <b>证书信任设置</b> → 对 "WLOC Selfhost Root CA" 开启<b>完全信任</b>(必做)</li>
<li>重新连接该 Wi-Fi(或在 WLAN 详情里确认 HTTP 代理 = ${esc(config.serverHost)}:${config.proxyPort})</li>
<li>设置 → 隐私与安全性 → 定位服务 → 关闭再打开, 打开地图看蓝点</li>
</ol>
<h3>选点</h3>
<p>用你部署的 cloudflare-wloc 网页选点「储存到设备」即可 —— 保存请求会经过本代理并落在这里; 也可以直接访问:<br>
<code>/wloc-settings/save?lon=&amp;lat=&amp;acc=25</code> · <code>?action=query</code> · <code>?action=clear</code></p>
<p style="color:#c00"><b>仅供自有授权设备测试。</b>不要把描述文件或 CA 分发给他人, 不要把代理端口暴露到公网。</p>
</body></html>`;
}

export function createAdmin(config, log = console.log) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/ca.cer" || u.pathname === "/wloc.mobileconfig") {
      try {
        if (u.pathname === "/ca.cer") {
          const der = pemToDer(readFileSync(`${config.certsDir}/ca.crt`));
          res.writeHead(200, {
            "Content-Type": "application/x-x509-ca-cert",
            "Content-Disposition": 'attachment; filename="selfhost-wloc-ca.cer"',
          });
          return res.end(der);
        }
        const profile = buildMobileConfig(config);
        res.writeHead(200, {
          "Content-Type": "application/x-apple-aspen-config",
          "Content-Disposition": 'attachment; filename="wloc-selfhost.mobileconfig"',
        });
        return res.end(profile);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(`证书/描述文件生成失败: ${e.message}(先运行 tools/make-certs.sh)`);
      }
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(statusPage(config));
  });
  server.on("clientError", (_e, socket) => socket.destroy());
  return server;
}

export function assertCerts(config) {
  for (const f of ["ca.crt", "server.key", "server.crt"]) {
    if (!existsSync(`${config.certsDir}/${f}`)) {
      throw new Error(`缺少 ${config.certsDir}/${f}, 请先运行 tools/make-certs.sh`);
    }
  }
}
