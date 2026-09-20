import { Hono } from "hono/tiny";
import { getPageHtml } from "./page.js";
import { parseCoords, gcj02ToWgs84, toWgs84, round6, inRange } from "./parse.js";
import { SERVED_ASSETS } from "./assets.generated.js";

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
