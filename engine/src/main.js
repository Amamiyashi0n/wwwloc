// 入口: node src/main.js [config.json]
import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { createProxy } from "./proxy.js";
import { createAdmin, assertCerts } from "./admin.js";
import { initSettings } from "./settings.js";
import os from "node:os";

const configPath = process.argv[2] ?? "config.json";
if (!existsSync(configPath)) {
  if (existsSync("config.example.json")) {
    copyFileSync("config.example.json", configPath);
    console.log(`[wloc] 已从 config.example.json 生成 ${configPath}, 请修改 serverHost / ssids 后重启。`);
  } else {
    console.error(`[wloc] 找不到配置文件 ${configPath}`);
    process.exit(1);
  }
}
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.certsDir ??= "./certs";
config.proxyPort ??= 8888;
config.adminPort ??= 8080;
config.adminHost ??= "127.0.0.1";
config.ssids ??= [];
config.stateFile ??= "./state.json";

try {
  assertCerts(config);
} catch (e) {
  console.error(`[wloc] ${e.message}`);
  process.exit(1);
}

initSettings(config.stateFile);

// 提示用户该填哪个地址
const lanIPs = [];
for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
  for (const a of addrs ?? []) {
    if (a.family === "IPv4" && !a.internal) lanIPs.push(`  ${name}: ${a.address}`);
  }
}
globalThis.__lanIPs = lanIPs;

const proxy = createProxy(config);
proxy.listen(config.proxyPort, "0.0.0.0", () => {
  console.log(`[wloc] MITM 代理已监听 0.0.0.0:${config.proxyPort} (仅解密 gs-loc 三域名, 其余盲隧道)`);
  console.log(`[wloc] 手机端代理地址建议填: ${lanIPs.find((s) => /192\.168\.|10\./.test(s)) ?? lanIPs[0] ?? "<本机IP>"} -> 端口 ${config.proxyPort}`);
});

const admin = createAdmin(config);
admin.listen(config.adminPort, config.adminHost, () => {
  console.log(`[wloc] 管理页面: http://127.0.0.1:${config.adminPort}/ (手机从 http://<本机LAN IP>:${config.adminPort}/ 访问需把 adminHost 改为 0.0.0.0)`);
});
