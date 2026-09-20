// 描述文件生成器的结构与内容验证。
//
// 这段代码是页面内联脚本(模板字符串里), 转义写错会静默产出坏的 .mobileconfig ——
// 手机上装不上、却看不出哪里错。这里把它抽出来在假 DOM 里真跑一遍, 并逐项校验:
//   * 所有 <key> 成对且结构完整(标签配平)
//   * 根 CA payload 与 Wi-Fi payload 的必需键都存在
//   * <data> 里是可解码的 base64, 且解出来是 DER 证书(首字节 0x30)
//   * SSID / 代理地址 / 端口按输入写入
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPageHtml } from "../src/page.js";

// 从页面里抽出描述文件生成器代码块
function extractGenerator(html) {
  const start = html.indexOf("/* ---- 免客户端模式");
  const endMarker = "document.getElementById('pfCaFile').addEventListener('change', pfOnCaFile);";
  const end = html.indexOf(endMarker);
  assert.ok(start >= 0, "页面应含描述文件生成器代码块");
  assert.ok(end > start, "生成器代码块应有结束标记");
  return html.slice(start, end + endMarker.length);
}

// 用真证书做输入(openssl 生成的 PEM 根证书)
const certsDir = mkdtempSync(join(tmpdir(), "wloc-page-ca-"));
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", join(certsDir, "ca.key"),
  "-out", join(certsDir, "ca.crt"),
  "-days", "1",
  "-subj", "/CN=wloc-test-root",
]);
const CA_PEM = readFileSync(join(certsDir, "ca.crt"), "utf8");
const CA_DER = execFileSync("openssl", ["x509", "-in", join(certsDir, "ca.crt"), "-outform", "DER"]);

function runGenerator(values) {
  const code = extractGenerator(getPageHtml("https://example.test"));
  let downloaded = null;
  const els = {};
  const element = (id) => {
    if (!els[id]) els[id] = { value: values[id] ?? "", addEventListener() {} };
    return els[id];
  };
  const sandbox = {
    document: {
      getElementById: element,
      createElement: () => ({ href: "", download: "", click() {}, remove() {} }),
      body: { appendChild() {} },
    },
    crypto: globalThis.crypto,
    window: { location: { origin: "https://example.test" } },
    Blob: globalThis.Blob,
    URL: { createObjectURL: (blob) => { downloaded = blob; return "blob:test"; } },
    toast: (msg) => { sandbox.__toast = msg; },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    Uint8Array,
    String,
    Math,
    parseInt,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  sandbox.buildProfile();
  assert.ok(downloaded, "buildProfile 应产出可下载的 Blob");
  return { blob: downloaded, sandbox };
}

async function blobText(blob) {
  return await blob.text();
}

// 极简标签配平检查(无依赖): 所有非自闭合标签开闭必须严格配对
function checkTagBalance(xml) {
  const tags = [...xml.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g)];
  const stack = [];
  for (const [, closing, name, attrs, selfClosing] of tags) {
    if (closing) {
      assert.equal(stack.pop(), name, `标签 </${name}> 与最近的开始标签不匹配`);
    } else if (!selfClosing && !attrs.trim().endsWith("/")) {
      stack.push(name);
    }
  }
  assert.deepEqual(stack, [], "XML 标签应完全配平");
}

test("生成器: 描述文件结构完整、CA 为可解析的 DER 证书", async () => {
  const { blob } = runGenerator({
    pfSsidList: "MyWiFi | secret123",
    pfCa: CA_PEM,
  });
  assert.equal(blob.type, "application/x-apple-aspen-config");
  const xml = await blobText(blob);

  // 结构
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), "应有 XML 声明");
  assert.ok(xml.includes("<!DOCTYPE plist PUBLIC"), "应有 plist DOCTYPE");
  assert.ok(xml.includes("<plist version=\"1.0\">"), "应有 plist 根元素");
  checkTagBalance(xml);

  // 两个 payload 类型
  assert.ok(xml.includes("<string>com.apple.security.root</string>"), "应含根证书 payload");
  assert.ok(xml.includes("<string>com.apple.wifi.managed</string>"), "应含 Wi-Fi payload");
  assert.ok(xml.includes("<string>Configuration</string>"), "顶层应为 Configuration");

  // 输入值按预期写入
  assert.ok(xml.includes("<string>MyWiFi</string>"), "SSID 应写入");
  assert.ok(xml.includes("<string>secret123</string>"), "Wi-Fi 密码应写入");
  assert.ok(xml.includes("<string>Auto</string>"), "代理类型应为 Auto(PAC)");
  assert.ok(xml.includes("<key>ProxyPACURL</key>"), "应带 PAC 网址");
  assert.ok(xml.includes("https://example.test/wloc.pac"), "PAC 网址应取当前站点");
  assert.ok(!xml.includes("ProxyServer"), "不应写死代理地址");

  // UUID 应各不相同: 根证书 payload + Wi-Fi payload + 顶层配置 = 3 个
  const uuids = [...xml.matchAll(/<key>PayloadUUID<\/key><string>([^<]+)<\/string>/g)].map((m) => m[1]);
  assert.equal(uuids.length, 3, "应有 3 个 PayloadUUID(两个 payload + 顶层)");
  assert.equal(new Set(uuids).size, 3, "各 PayloadUUID 应互不相同");

  // CA: <data> 里是 base64, 解码后应为 DER 证书(首字节 0x30)
  const dataMatch = xml.match(/<key>PayloadContent<\/key><data>([^<]*)<\/data>/);
  assert.ok(dataMatch, "应含 <data> 证书内容");
  const der = Buffer.from(dataMatch[1], "base64");
  assert.equal(der[0], 0x30, "解码结果应为 DER 序列(0x30)");
  assert.ok(der.equals(CA_DER), "嵌入的 DER 应与 openssl 导出的证书逐字节一致");
});

test("生成器: 不填 Wi-Fi 密码时不写 Password 键; 缺必填项则不出文件", async () => {
  const { blob } = runGenerator({
    pfSsidList: "NoPass",
    pfCa: CA_PEM.replace(/\s+/g, "\n"), // 带换行的 PEM 也应正确处理
  });
  const xml = await blobText(blob);
  assert.ok(!xml.includes("<key>Password</key>"), "空密码不应写入 Password 键");
  assert.ok(xml.includes("<string>NoPass</string>"));
  checkTagBalance(xml);
});

test("生成器: 缺少 Wi-Fi 名称时不产出可下载文件", () => {
  const code = extractGenerator(getPageHtml("https://example.test"));
  let downloaded = null;
  let toastMsg = "";
  const els = {
    pfSsidList: { value: "", addEventListener() {} },
    pfCa: { value: CA_PEM, addEventListener() {} },
    toast: { value: "", addEventListener() {} },
  };
  const sandbox = {
    document: {
      getElementById: (id) => els[id] ?? { value: "", addEventListener() {} },
      createElement: () => ({ href: "", download: "", click() {}, remove() {} }),
      body: { appendChild() {} },
    },
    crypto: globalThis.crypto,
    window: { location: { origin: "https://example.test" } },
    Blob: globalThis.Blob,
    URL: { createObjectURL: (b) => { downloaded = b; return "blob:x"; } },
    toast: (m) => { toastMsg = m; },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    Uint8Array,
    String,
    Math,
    parseInt,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  sandbox.buildProfile();
  assert.equal(downloaded, null, "缺 SSID 时不应产出文件");
  assert.match(toastMsg, /填写/, "应给出填写提示");
});
