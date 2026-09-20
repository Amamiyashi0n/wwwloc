// 引擎的 .mobileconfig 生成: 结构与唯一性校验。
// 这里锁的是一个真实修过的 bug —— 顶层配置曾与根证书 payload 共用同一个 PayloadUUID。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMobileConfig } from "../src/admin.js";

const certsDir = mkdtempSync(join(tmpdir(), "wloc-admin-"));
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", join(certsDir, "ca.key"),
  "-out", join(certsDir, "ca.crt"),
  "-days", "1",
  "-subj", "/CN=wloc-engine-root",
]);
const CA_DER = execFileSync("openssl", ["x509", "-in", join(certsDir, "ca.crt"), "-outform", "DER"]);

function config(overrides = {}) {
  return {
    certsDir,
    serverHost: "192.168.1.50",
    proxyPort: 8888,
    profileIdentifier: "com.selfhost.wloc.test",
    ssids: ["HomeWiFi"],
    ...overrides,
  };
}

function uuidsOf(xml) {
  return [...xml.matchAll(/<key>PayloadUUID<\/key><string>([^<]+)<\/string>/g)].map((m) => m[1]);
}

test("描述文件: 单个 SSID -> 3 个互不重复的 PayloadUUID", () => {
  const xml = buildMobileConfig(config());
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes("<plist version=\"1.0\">"));
  const uuids = uuidsOf(xml);
  assert.equal(uuids.length, 3, "根证书 + Wi-Fi + 顶层 = 3 个 UUID");
  assert.equal(new Set(uuids).size, 3, "各 PayloadUUID 必须唯一(曾出现顶层与根证书重复)");
});

test("描述文件: 多个 SSID 时 UUID 仍全部唯一", () => {
  const xml = buildMobileConfig(config({ ssids: ["A", "B", "C"] }));
  const uuids = uuidsOf(xml);
  assert.equal(uuids.length, 5, "1 根证书 + 3 Wi-Fi + 1 顶层");
  assert.equal(new Set(uuids).size, 5, "多 SSID 时也必须唯一");
  // 每个 SSID 都有自己的 wifi payload
  for (const ssid of ["A", "B", "C"]) {
    assert.ok(xml.includes(`<string>${ssid}</string>`), `应含 SSID ${ssid}`);
  }
});

test("描述文件: CA 为可解析的 DER, 代理指向配置的地址与端口", () => {
  const xml = buildMobileConfig(config({ serverHost: "10.1.2.3", proxyPort: 9999 }));
  const dataMatch = xml.match(/<key>PayloadContent<\/key><data>([^<]*)<\/data>/);
  assert.ok(dataMatch, "应内嵌 CA 证书");
  const der = Buffer.from(dataMatch[1], "base64");
  assert.equal(der[0], 0x30, "应为 DER 序列");
  assert.ok(der.equals(CA_DER), "嵌入的 DER 应与 CA 文件一致");

  assert.ok(xml.includes("<string>10.1.2.3</string>"), "代理地址应写入");
  assert.ok(xml.includes("<integer>9999</integer>"), "代理端口应写入");
  assert.ok(xml.includes("<string>Manual</string>"), "代理类型应为 Manual");
});

test("描述文件: Wi-Fi 密码按需写入, 特殊字符被转义", () => {
  const withPass = buildMobileConfig(config({ ssids: [{ ssid: "Home", password: "p&<w>" }] }));
  assert.ok(withPass.includes("<key>Password</key><string>p&amp;&lt;w&gt;</string>"), "密码应转义写入");

  const withoutPass = buildMobileConfig(config({ ssids: [{ ssid: "Open" }] }));
  assert.ok(!withoutPass.includes("<key>Password</key>"), "无密码不应写入 Password 键");

  const plainString = buildMobileConfig(config({ ssids: ["PlainSSID"] }));
  assert.ok(plainString.includes("<string>PlainSSID</string>"), "字符串形式的 SSID 也应支持");
});
