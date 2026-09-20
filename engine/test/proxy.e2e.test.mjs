// 端到端: 在本进程内起 代理 + 本地 TLS 目标, 验证
//   1. 非 MITM 域名走盲隧道(内容原样, 代理不参与 TLS)
//   2. MITM 域名 /wloc-settings/save|query|clear (含 CORS、422)
//   3. MITM 域名 /clls/wloc 锁定时按请求合成响应
// 全部走 127.0.0.1, 不依赖外网。代理每响应一次即关闭连接, 每个请求单独建连。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";
import { createProxy } from "../src/proxy.js";
import { saveSettings, clearSettings } from "../src/settings.js";
import { parseResponseEnvelope, parseProtobuf } from "../src/mutator.js";

const certsDir = mkdtempSync(join(tmpdir(), "wloc-certs-"));
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", join(certsDir, "server.key"),
  "-out", join(certsDir, "server.crt"),
  "-days", "1",
  "-subj", "/CN=gs-loc.apple.com",
  "-addext", "subjectAltName=DNS:gs-loc.apple.com,DNS:gs-loc-cn.apple.com,DNS:gsp-ssl.ls.apple.com",
]);
const CA_PEM = readFileSync(join(certsDir, "server.crt"), "utf8");
const KEY_PEM = readFileSync(join(certsDir, "server.key"), "utf8");

const log = () => {};
const proxy = createProxy({ certsDir, log });
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const proxyPort = proxy.address().port;

// 盲隧道目标: 普通 HTTPS 服务器(自签证书, 客户端不校验 —— 证明代理没有碰这条 TLS)
const tunnelTarget = tls.createServer({ key: KEY_PEM, cert: CA_PEM }, (socket) => {
  socket.on("data", () => {
    const body = Buffer.from("BLIND-TUNNELED-CONTENT");
    socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
  });
});
await new Promise((r) => tunnelTarget.listen(0, "127.0.0.1", r));
const tunnelPort = tunnelTarget.address().port;

// 常驻服务器会让事件循环不空; 不关闭则测试进程永不退出
after(() => {
  proxy.closeAllConnections?.();
  tunnelTarget.closeAllConnections?.();
  return Promise.all([
    new Promise((r) => proxy.close(r)),
    new Promise((r) => tunnelTarget.close(r)),
  ]);
});

// 通过代理发起一次完整 HTTPS 请求: CONNECT -> TLS -> request -> 读完整响应
function mitmFetch(host, port, servername, requestText, { ca = CA_PEM, rejectUnauthorized = true } = {}) {
  return new Promise((resolve, reject) => {
    const c = net.connect(proxyPort, "127.0.0.1", () => {
      c.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
    });
    let head = Buffer.alloc(0);
    c.on("data", function onData(chunk) {
      head = Buffer.concat([head, chunk]);
      if (!head.toString("latin1").includes("\r\n\r\n")) return;
      c.removeListener("data", onData);
      const statusLine = head.toString("latin1").split("\r\n")[0];
      if (!statusLine.includes("200")) return reject(new Error(`CONNECT 失败: ${statusLine}`));

      const tlsSock = tls.connect({ socket: c, servername, rejectUnauthorized, ca }, () =>
        tlsSock.write(requestText),
      );
      let all = Buffer.alloc(0);
      tlsSock.on("data", (d) => (all = Buffer.concat([all, d])));
      tlsSock.on("close", () => resolve(all.toString("latin1")));
      tlsSock.on("error", reject);
    });
    c.on("error", reject);
  });
}

const httpReq = (host, method, path, body = "") =>
  `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;

test("非 MITM 域名走盲隧道, 内容原样到达", async () => {
  const resp = await mitmFetch("127.0.0.1", tunnelPort, "localhost", httpReq("localhost", "GET", "/"), {
    rejectUnauthorized: false,
  });
  assert.match(resp, /HTTP\/1\.1 200/);
  assert.ok(resp.includes("BLIND-TUNNELED-CONTENT"), "内容应原样到达(代理未参与该 TLS)");
});

test("MITM: save -> query -> 422 -> clear", async () => {
  clearSettings();
  const host = "gs-loc.apple.com";
  const save = await mitmFetch(host, 443, host, httpReq(host, "GET", "/wloc-settings/save?lon=116.3975&lat=39.9087&acc=25"));
  assert.match(save, /HTTP\/1\.1 200/);
  assert.ok(save.includes('{"success":true}'), "保存应成功");
  assert.ok(/access-control-allow-origin: \*/i.test(save), "应带 CORS");

  const query = await mitmFetch(host, 443, host, httpReq(host, "GET", "/wloc-settings/save?action=query"));
  const q = JSON.parse(query.split("\r\n\r\n")[1]);
  assert.equal(q.success, true);
  assert.equal(q.longitude, 116.3975);
  assert.equal(q.latitude, 39.9087);

  const invalid = await mitmFetch(host, 443, host, httpReq(host, "GET", "/wloc-settings/save?lon=999&lat=39"));
  assert.match(invalid, /HTTP\/1\.1 422/, "越界坐标应 422");

  const clear = await mitmFetch(host, 443, host, httpReq(host, "GET", "/wloc-settings/save?action=clear"));
  assert.ok(clear.includes('{"success":true}'));

  const query2 = await mitmFetch(host, 443, host, httpReq(host, "GET", "/wloc-settings/save?action=query"));
  const q2 = JSON.parse(query2.split("\r\n\r\n")[1]);
  assert.equal(q2.longitude, null, "清除后查询应为空");
});

test("MITM: 锁定后 /clls/wloc 按请求合成响应(不回连上游)", async () => {
  saveSettings({ longitude: 116.3975, latitude: 39.9087, accuracy: 25 });
  const host = "gs-loc-cn.apple.com";
  const request = makeARPCRequest(["aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02"]);
  const resp = await mitmFetch(host, 443, host, httpReq(host, "POST", "/clls/wloc", request));
  assert.match(resp, /HTTP\/1\.1 200/);

  const body = Buffer.from(resp.split("\r\n\r\n").slice(1).join("\r\n\r\n"), "latin1");
  const payload = parseResponseEnvelope(body); // 前缀/长度不对会抛错
  const devices = parseProtobuf(payload).filter((f) => f.fieldNo === 2 && f.wireType === 2);
  assert.equal(devices.length, 2, "应含两台 WiFi 设备");
  for (const d of devices) {
    const loc = Object.fromEntries(
      parseProtobuf(parseProtobuf(d.value).find((f) => f.fieldNo === 2).value).map((f) => [f.fieldNo, f.value]),
    );
    assert.equal(loc[1], 3990870000);
    assert.equal(loc[2], 11639750000);
    assert.equal(loc[4], 3);
  }
  clearSettings();
});

// ---------- 工具 ----------

function makeARPCRequest(bssids) {
  const encodeVarint = (v) => {
    let n = BigInt(v);
    const out = [];
    do {
      let b = Number(n & 0x7fn);
      n >>= 7n;
      if (n !== 0n) b |= 0x80;
      out.push(b);
    } while (n !== 0n);
    return Buffer.from(out);
  };
  const field = (no, wire, value) =>
    wire === 0
      ? Buffer.concat([encodeVarint(no * 8), encodeVarint(value)])
      : Buffer.concat([encodeVarint(no * 8 + 2), encodeVarint(value.length), value]);
  const parts = [];
  for (const b of bssids) {
    parts.push(field(2, 2, Buffer.concat([field(1, 2, Buffer.from(b)), field(2, 2, Buffer.from([0x08, 0x01]))])));
  }
  const payload = Buffer.concat(parts);
  const ver = Buffer.alloc(2);
  const fn = Buffer.alloc(4);
  const plen = Buffer.alloc(4);
  plen.writeUInt32BE(payload.length);
  const pascal = (s) => {
    const b = Buffer.from(s);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length);
    return Buffer.concat([len, b]);
  };
  return Buffer.concat([ver, pascal("zh"), pascal("app"), pascal("os"), fn, plen, payload]);
}
