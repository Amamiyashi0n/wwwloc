import { Hono } from "hono/tiny";
import { getPageHtml } from "./page.js";
import { parseCoords, gcj02ToWgs84, toWgs84, round6, inRange } from "./parse.js";
import { SERVED_ASSETS, CA_CERT_B64, ENGINE_HOST, ENGINE_PORT } from "./assets.generated.js";

const app = new Hono();

// 解析请求可能包含位置；明确禁止浏览器和共享缓存存储 API 响应。
// 静态脚本/模块同样 no-store: 重新 configure 后客户端下次拉取即拿到新内容。
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

app.get("/", (c) => {
  return c.html(getPageHtml(new URL(c.req.url).origin));
});

// 代理客户端拉取的两个 WLOC 脚本 + 五种模块订阅。
// 内容来自 src/assets.generated.js (由 scripts/configure.mjs 生成)。
// 模块里的 {{SITE}} 在响应时替换为当前请求的 origin —— 一键部署后零配置即可用。
app.get("/wloc.js", (c) => serveAsset(c, "/wloc.js"));
app.get("/wloc-settings.js", (c) => serveAsset(c, "/wloc-settings.js"));
app.get("/modules/:name", (c) => {
  const name = c.req.param("name");
  const route = `/modules/${name}`;
  // 只放行 configure 生成过的文件名, 其余一律 404。
  return SERVED_ASSETS[route] ? serveAsset(c, route, new URL(c.req.url).origin) : c.notFound();
});

function serveAsset(c, route, origin) {
  const asset = SERVED_ASSETS[route];
  const content = origin ? asset.content.replaceAll("{{SITE}}", origin) : asset.content;
  if (content.includes("{{SITE}}")) {
    // 模板占位符必须被替换干净; 出现残留说明模板新增了未覆盖的用法
    return c.body("module template contains unreplaced placeholder", 500, { "Content-Type": "text/plain; charset=utf-8" });
  }
  return c.body(content, 200, { "Content-Type": asset.type });
}

// 根证书分发: 站点即证书来源, 手机不必再从引擎管理页手动取文件。
// 只有公开证书(无任何私钥); 私钥始终留在引擎所在的机器上。
app.get("/ca.cer", (c) => {
  if (!CA_CERT_B64) {
    return c.body(
      "未配置根证书。请在电脑上运行 engine/tools/make-certs.sh 后执行 npm run configure 并提交 public/。",
      404,
      { "Content-Type": "text/plain; charset=utf-8" },
    );
  }
  const der = Uint8Array.from(atob(CA_CERT_B64), (ch) => ch.charCodeAt(0));
  return c.body(der, 200, {
    "Content-Type": "application/x-x509-ca-cert",
    "Content-Disposition": 'attachment; filename="wloc-root-ca.cer"',
  });
});

// 供页面自动载入: 直接给出 DER 的 base64(与描述文件 <data> 字段同格式), 省去前端再编码。
app.get("/ca.b64", (c) => {
  if (!CA_CERT_B64) return c.text("", 404);
  return c.text(CA_CERT_B64, 200, { "Content-Type": "text/plain; charset=utf-8" });
});

// ---- PAC: 只把三个定位域名导向你电脑的引擎, 其余一律直连 ----
//
// 为什么用 PAC 而不是"手动代理 + IP":
//   * 手动代理是全局的 —— 引擎没开时, 该 Wi-Fi 上所有流量都被送去一个不通的地址, 会断网;
//     PAC 只影响那三个域名且带回退: 引擎没开时定位请求自动直连, 其它网络毫无影响。
//   * 电脑地址活在 Worker 上(project.config.json 的 engineHost), 手机只记 PAC 网址;
//     电脑 IP 变了只改配置重新部署, 手机端零改动。
//
// ?h=<host>&p=<port> 可临时覆盖(在手机"自动代理"里就地改地址, 不必重装描述文件)。
// 该值会被拼进 PAC 脚本, 而 PAC 是一段会被设备执行的 JS —— 所以必须严格清洗。
const MITM_DOMAINS = ["gs-loc.apple.com", "gs-loc-cn.apple.com", "gsp-ssl.ls.apple.com"];

function sanitizeHost(value) {
  return typeof value === "string" && /^[A-Za-z0-9.-]{1,253}$/.test(value) ? value : "";
}

function sanitizePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 0;
}

export function buildPac(host, port) {
  const proxyLine = host ? `PROXY ${host}:${port}; DIRECT` : "DIRECT";
  return (
    "// WLOC: 只把三个 Apple 定位域名导向你自己的引擎, 其余直连。\n" +
    "// 引擎不可达时回退 DIRECT, 所以引擎没开也不会断网。\n" +
    "function FindProxyForURL(url, host) {\n" +
    `  var wloc = ${JSON.stringify(MITM_DOMAINS)};\n` +
    "  for (var i = 0; i < wloc.length; i++) {\n" +
    "    if (host === wloc[i] || dnsDomainIs(host, '.' + wloc[i])) {\n" +
    `      return ${JSON.stringify(proxyLine)};\n` +
    "    }\n" +
    "  }\n" +
    '  return "DIRECT";\n' +
    "}\n"
  );
}

app.get("/wloc.pac", (c) => {
  const host = sanitizeHost(c.req.query("h")) || ENGINE_HOST;
  const port = sanitizePort(c.req.query("p")) || ENGINE_PORT;
  return c.body(buildPac(host, port), 200, {
    "Content-Type": "application/x-ns-proxy-autoconfig",
    "Cache-Control": "no-store",
  });
});

// 地图链接解析: 供快捷指令调用。
// GET /api/parse?u=<链接>&format=json&cs=<gcj|none>
//   返回 {lat, lon, name}; 高德/苹果地图(中国大陆均为 GCJ-02)自动转 WGS84; 境外坐标自动跳过(out_of_china)。cs=none 可强制不转换。
//   不带 format=json 时返回纯文本 "lat=..&lon=.." 片段。
app.get("/api/parse", async (c) => {
  const raw = c.req.query("u") || "";
  const cs = (c.req.query("cs") || "").toLowerCase();
  const fmt = (c.req.query("format") || "").toLowerCase();
  try {
    let { lat, lon, name, src } = await parseCoords(raw);
    // 默认按来源自动换算; cs=none 强制不转换, cs=gcj/bd 强制按指定坐标系转换。
    if (cs === "gcj") ({ lat, lon } = gcj02ToWgs84(lat, lon));
    else if (cs === "bd") ({ lat, lon } = toWgs84(lat, lon, "baidu"));
    else if (cs !== "none") ({ lat, lon } = toWgs84(lat, lon, src));
    // 出口再校验一次: cs= 是调用方指定的, 强行按错误坐标系换算也可能把值推出值域。
    // 宁可报错也不要返回一个能被当成坐标写进设备的数字。
    if (!inRange(lat, lon)) throw new Error("解析出的坐标超出合法范围");
    lat = round6(lat);
    lon = round6(lon);
    name = name || "";
    c.header("Access-Control-Allow-Origin", "*");
    if (fmt === "json") return c.json({ lat, lon, name });
    return c.text(`lat=${lat}&lon=${lon}`);
  } catch (e) {
    c.header("Access-Control-Allow-Origin", "*");
    return c.json({ error: String(e && e.message ? e.message : e) }, 422);
  }
});

// 兜底 500 也要带 CORS —— 否则快捷指令那边看到的是跨域错误, 而不是真正的原因。
app.onError((e, c) => {
  c.header("Access-Control-Allow-Origin", "*");
  return c.text(`${e && e.message ? e.message : e}`, 500);
});

export default app;
