// 自建 WLOC 代理(零依赖, Node >= 18)。
//
// 安全边界(改这里之前先想清楚):
//   * 只对 MITM_HOSTS 三个 Apple 定位域名终止 TLS 并处理;
//   * 其余所有 CONNECT 一律盲隧道(不解密、不落盘、不缓存);
//   * /clls/wloc 命中且有锁定坐标时按请求合成响应(不回连 Apple);
//     未锁定或解析失败时原样转发;
//   * /wloc-settings/* 提供与 dist/wloc-settings.js 相同的 save/query/clear,
//     让 cloudflare-wloc 的选点网页原样可用。
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import { buildResponseBody } from "./mutator.js";
import { getState, saveSettings, clearSettings } from "./settings.js";

// 只有这三个域名会被解密。扩大这个列表属于高风险变更。
const MITM_HOSTS = new Set([
  "gs-loc.apple.com",
  "gs-loc-cn.apple.com",
  "gsp-ssl.ls.apple.com",
]);

export function createProxy({ certsDir, log = console.log }) {
  const serverKey = readFileSync(`${certsDir}/server.key`);
  const serverCert = readFileSync(`${certsDir}/server.crt`);
  const secureContext = tls.createSecureContext({ key: serverKey, cert: serverCert });

  const server = http.createServer((req, res) => {
    // 普通绝对 URI 的 HTTP 请求: 本代理不处理明文转发
    log(`[proxy] 拒绝普通 HTTP 请求 ${req.headers.host}${req.url}`);
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("selfhost-wloc: 仅支持 CONNECT 隧道。");
  });

  server.on("connect", (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(":");
    const port = Number(portStr) || 443;
    const hostLower = host.toLowerCase();

    if (!MITM_HOSTS.has(hostLower)) {
      return blindTunnel(host, port, clientSocket, head, log);
    }
    if (port !== 443) {
      return rejectSocket(clientSocket, `selfhost-wloc: ${host}:${port} 不在处理范围`);
    }

    log(`[proxy] MITM ${hostLower} (来自 ${clientSocket.remoteAddress})`);
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    const tlsSocket = new tls.TLSSocket(clientSocket, { isServer: true, secureContext });
    tlsSocket.on("error", (e) => log(`[proxy] ${hostLower} TLS 错误: ${e.message}`));
    tlsSocket.on("close", () => clientSocket.destroy());

    const parser = createRequestParser(tlsSocket, hostLower, log);
    if (head && head.length) parser.write(head);
    tlsSocket.on("data", (chunk) => parser.write(chunk));
  });

  server.on("clientError", (_err, socket) => socket.destroy());
  return server;
}

// ---------- 非 MITM 域名: 盲隧道 ----------

function blindTunnel(host, port, clientSocket, head, log) {
  const upstream = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const fail = (e) => {
    log(`[proxy] 隧道失败 ${host}:${port} ${e.message}`);
    clientSocket.destroy();
    upstream.destroy();
  };
  upstream.on("error", fail);
  clientSocket.on("error", () => {
    clientSocket.destroy();
    upstream.destroy();
  });
  clientSocket.on("close", () => upstream.destroy());
  upstream.on("close", () => clientSocket.destroy());
}

function rejectSocket(socket, message) {
  socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n${message}`);
  socket.destroy();
}

// ---------- MITM 之后的 HTTP 解析与路由 ----------

function createRequestParser(socket, host, log) {
  let buf = Buffer.alloc(0);

  return {
    write(chunk) {
      buf = Buffer.concat([buf, chunk]);
      // 循环处理同一条连接里的多个请求
      for (;;) {
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          if (buf.length > 256 * 1024) socket.destroy();
          return;
        }
        const headText = buf.subarray(0, headerEnd).toString("utf8");
        const lines = headText.split("\r\n");
        const [method, target] = lines[0].split(" ");
        let contentLength = 0;
        for (const line of lines.slice(1)) {
          const m = line.match(/^content-length:\s*(\d+)/i);
          if (m) contentLength = Number(m[1]);
        }
        const total = headerEnd + 4 + contentLength;
        if (buf.length < total) return;
        const body = Buffer.from(buf.subarray(headerEnd + 4, total));
        buf = Buffer.from(buf.subarray(total));
        route(method, target, body)
          .then((resp) => {
            log(`[proxy] ${host} ${method} ${pathOf(target)} -> ${resp.status}`);
            writeResponse(socket, resp);
          })
          .catch((e) => {
            log(`[proxy] ${host}${target} 处理失败: ${e.message}`);
            writeResponse(socket, {
              status: 502,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
              body: Buffer.from(`selfhost-wloc: ${e.message}`),
            });
          });
      }
    },
  };
}

function pathOf(target) {
  // CONNECT 之后通常是 origin-form("/clls/wloc"); 兼容 absolute-form
  const schemeIdx = target.indexOf("://");
  return schemeIdx >= 0 ? target.slice(target.indexOf("/", schemeIdx + 3)) : target;
}

async function route(method, target, body) {
  const path = pathOf(target);
  const u = new URL(path, "https://gs-loc.apple.com");

  if (u.pathname === "/wloc-settings/save") return handleSettings(u);
  if (u.pathname === "/clls/wloc") return handleWloc(method, body);

  // 其余路径原样转发上游(仍由本代理终止 TLS, 但内容不改)
  return forwardUpstream(method, u.hostname, u.pathname + u.search, body);
}

function handleSettings(u) {
  const json = (obj, status = 200) => ({
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "no-store",
    },
    body: Buffer.from(JSON.stringify(obj)),
  });
  const action = u.searchParams.get("action");
  if (action === "query") {
    const s = getState();
    return json(s ? { success: true, ...s } : { success: true, longitude: null, latitude: null });
  }
  if (action === "clear") {
    clearSettings();
    return json({ success: true });
  }
  const err = saveSettings({
    longitude: u.searchParams.get("lon"),
    latitude: u.searchParams.get("lat"),
    accuracy: u.searchParams.get("acc"),
    randomRadius: u.searchParams.get("randomRadius"),
  });
  return err ? json({ success: false, error: err }, 422) : json({ success: true });
}

function handleWloc(method, body) {
  const state = getState();
  if (!state) {
    // 未锁定坐标: 透传给真实 Apple 接口
    return forwardUpstream(method || "POST", "gs-loc.apple.com", "/clls/wloc", body);
  }
  try {
    const mutated = buildResponseBody(body, state);
    return {
      status: 200,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-store" },
      body: mutated,
    };
  } catch (e) {
    console.log(`[proxy] /clls/wloc 合成失败, 回退透传: ${e.message}`);
    return forwardUpstream(method || "POST", "gs-loc.apple.com", "/clls/wloc", body);
  }
}

function forwardUpstream(method, hostname, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: method || "POST", headers: { "Content-Length": body ? body.length : 0 } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("upstream timeout")));
    if (body && body.length) req.write(body);
    req.end();
  });
}

function writeResponse(socket, resp) {
  const headers = Object.entries(resp.headers)
    .filter(([k]) => !["content-length", "transfer-encoding", "connection", "content-encoding"].includes(k.toLowerCase()))
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  const head = Buffer.from(
    `HTTP/1.1 ${resp.status} ${http.STATUS_CODES[resp.status] ?? "OK"}\r\n${headers}\r\nContent-Length: ${resp.body.length}\r\nConnection: close\r\n\r\n`,
  );
  socket.end(Buffer.concat([head, resp.body]));
}
