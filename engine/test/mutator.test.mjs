// mutator 纯函数回归测试
import test from "node:test";
import assert from "node:assert/strict";
import {
  readVarint,
  encodeVarint,
  parseProtobuf,
  encodeField,
  parseARPC,
  buildLocation,
  buildResponseBody,
  parseResponseEnvelope,
} from "../src/mutator.js";

test("varint 编解码往返", () => {
  for (const v of [0, 1, 127, 128, 300, 1e8, 11639751234567, 2 ** 40]) {
    const buf = encodeVarint(v);
    const [got, off] = readVarint(buf, 0);
    assert.equal(got, v);
    assert.equal(off, buf.length);
  }
});

test("varint 负数走 64 位补码(10 字节)", () => {
  const buf = encodeVarint(-12345);
  assert.equal(buf.length, 10);
  // 与 SwiftProtobuf decodeSingularInt64 的预期一致: 解回同一个位模式
  const [got] = readVarint(buf, 0);
  assert.equal(BigInt.asIntN(64, BigInt(got)), -12345n);
});

test("parseProtobuf 保留未知字段与乱序字段", () => {
  const msg = Buffer.concat([
    encodeField(1, 0, 42),
    encodeField(15, 2, Buffer.from("unknown15")),
    encodeField(2, 2, Buffer.from([0xaa])),
    encodeField(1, 0, 7),
  ]);
  const fields = parseProtobuf(msg);
  assert.deepEqual(
    fields.map((f) => [f.fieldNo, f.wireType]),
    [[1, 0], [15, 2], [2, 2], [1, 0]],
  );
  // 原样回写应逐字节一致
  assert.equal(Buffer.concat(fields.map((f) => f.raw)).equals(msg), true);
});

test("ARPC 解析", () => {
  const payload = encodeField(2, 2, Buffer.from([1]));
  const ver = Buffer.alloc(2);
  ver.writeUInt16BE(1);
  const pascal = (s) => {
    const b = Buffer.from(s, "utf8");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length);
    return Buffer.concat([len, b]);
  };
  const fn = Buffer.alloc(4);
  fn.writeUInt32BE(33);
  const plen = Buffer.alloc(4);
  plen.writeUInt32BE(payload.length);
  const body = Buffer.concat([ver, pascal("zh_CN"), pascal("com.apple.locationd"), pascal("18.0"), fn, plen, payload]);
  const arpc = parseARPC(body);
  assert.equal(arpc.version, 1);
  assert.equal(arpc.locale, "zh_CN");
  assert.equal(arpc.appIdentifier, "com.apple.locationd");
  assert.equal(arpc.osVersion, "18.0");
  assert.equal(arpc.functionID, 33);
  assert.equal(arpc.payload.equals(payload), true);
});

test("buildLocation: 字段编号与 wloc8 语义一致", () => {
  const loc = buildLocation({ latitude: 22.5, longitude: 113.9, accuracy: 39, altitude: 480, verticalAccuracy: 1000 });
  const fields = parseProtobuf(loc);
  const byId = Object.fromEntries(fields.map((f) => [f.fieldNo, f.value]));
  assert.equal(byId[1], 2250000000); // 22.5 * 1e8
  assert.equal(byId[2], 11390000000);
  assert.equal(byId[3], 39);
  assert.equal(byId[4], 3); // unknownValue4 固定 3
  assert.equal(byId[5], 480);
  assert.equal(byId[6], 1000);
  assert.equal(byId[11], 63);
  assert.equal(byId[12], 467);
});

function buildARPC(payload) {
  const ver = Buffer.alloc(2);
  ver.writeUInt16BE(1);
  const pascal = (s) => {
    const b = Buffer.from(s, "utf8");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length);
    return Buffer.concat([len, b]);
  };
  const fn = Buffer.alloc(4);
  fn.writeUInt32BE(33);
  const plen = Buffer.alloc(4);
  plen.writeUInt32BE(payload.length);
  return Buffer.concat([ver, pascal("zh_CN"), pascal("com.apple.locationd"), pascal("18.0"), fn, plen, payload]);
}

function makeARPCRequest(wifiDevices) {
  // 顶层消息: 若干 field 2 (WifiDevice), 外加一个未知 field 99 (应保留)
  const parts = [];
  for (const d of wifiDevices) {
    const device = Buffer.concat([
      encodeField(1, 2, Buffer.from(d.bssid, "utf8")),
      encodeField(2, 2, d.location ?? Buffer.from([0x08, 0x01])), // 旧 location(有 lat=1) 或占位
      encodeField(9, 0, 1234), // 未知字段, 应保留
    ]);
    parts.push(encodeField(2, 2, device));
  }
  parts.push(encodeField(99, 0, 555));
  return buildARPC(Buffer.concat(parts));
}

test("buildResponseBody: 每台设备 location 被替换, 未知字段保留", () => {
  const request = makeARPCRequest([
    { bssid: "aa:bb:cc:dd:ee:01" },
    { bssid: "aa:bb:cc:dd:ee:02" },
  ]);
  const state = { latitude: 39.9087, longitude: 116.3975, accuracy: 39, altitude: 480, verticalAccuracy: 1000 };
  const response = buildResponseBody(request, state);

  // 封包前缀
  assert.equal(response.subarray(0, 8).equals(Buffer.from([0, 1, 0, 0, 0, 1, 0, 0])), true);
  const payload = parseResponseEnvelope(response);

  const top = parseProtobuf(payload);
  const devices = top.filter((f) => f.fieldNo === 2 && f.wireType === 2);
  assert.equal(devices.length, 2);

  for (const d of devices) {
    const df = parseProtobuf(d.value);
    const bssid = df.find((f) => f.fieldNo === 1).value.toString("utf8");
    assert.match(bssid, /^aa:bb:cc:dd:ee:0[12]$/);
    const loc = parseProtobuf(df.find((f) => f.fieldNo === 2 && f.wireType === 2).value);
    const byId = Object.fromEntries(loc.map((f) => [f.fieldNo, f.value]));
    assert.equal(byId[1], 3990870000);
    assert.equal(byId[2], 11639750000);
    assert.equal(byId[4], 3);
    // 设备级未知字段(field 9)保留
    assert.equal(df.find((f) => f.fieldNo === 9).value, 1234);
  }
  // 顶层未知字段(field 99)保留
  assert.equal(top.find((f) => f.fieldNo === 99).value, 555);
});

test("buildResponseBody: 无 WiFi 设备的请求报错(调用方应回退透传)", () => {
  const payload = encodeField(5, 2, Buffer.from("bundle.id"));
  assert.throws(() => buildResponseBody(buildARPC(payload), { latitude: 1, longitude: 1 }), /no wifi devices/);
});

test("randomRadius: 每次响应产生不同偏移但落在半径内", () => {
  const state = { latitude: 22, longitude: 113, accuracy: 25, randomRadius: 500 };
  const responses = new Set();
  for (let i = 0; i < 20; i++) {
    const request = makeARPCRequest([{ bssid: "aa:bb:cc:dd:ee:01" }]);
    const payload = parseResponseEnvelope(buildResponseBody(request, state));
    const device = parseProtobuf(payload).find((f) => f.fieldNo === 2).value;
    const loc = Object.fromEntries(parseProtobuf(parseProtobuf(device).find((f) => f.fieldNo === 2).value).map((f) => [f.fieldNo, f.value]));
    const dLatM = (loc[1] - 22e8) / 1e8 * 111320;
    // 经度偏移的地面距离要乘 cos(纬度); jitter 生成的是地面米制圆盘
    const dLonM = (loc[2] - 113e8) / 1e8 * 111320 * Math.cos((22 * Math.PI) / 180);
    const meters = Math.sqrt(dLatM ** 2 + dLonM ** 2);
    assert.ok(meters <= 500 + 1, `偏移 ${meters.toFixed(1)}m 超出半径`);
    responses.add(`${loc[1]},${loc[2]}`);
  }
  assert.ok(responses.size > 1, "20 次响应坐标应不完全相同");
});
