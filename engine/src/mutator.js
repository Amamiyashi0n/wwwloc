// WLOC 改写器 —— wloc8 (AppWLocMutator + AppWLocARPC) 的零依赖 Node 移植。
//
// 协议(逆向自 Apple 网络定位接口,与 wloc8/BSSIDApp.pb.swift 对齐):
//   请求体  = ARPC 封包: u16BE version, pascal(locale), pascal(appId),
//             pascal(osVersion), u32BE funcId, u32BE payloadLen, payload
//   payload = protobuf 顶层消息: field 2 (repeated, wire 2) = WifiDevice
//             WifiDevice: field 1 = bssid(string), field 2 = location(message)
//             Location:   1 lat(int64, ×1e8), 2 lon, 3 hAccuracy, 4 unknown4,
//                         5 altitude, 6 vAccuracy, 11 motionType, 12 motionConf
//   响应体  = `00 01 00 00 00 01 00 00` + u16BE payloadLen + protobuf
//
// 改写策略与 wloc8 一致: 从请求里取出 WiFi 设备列表, 把每台设备的 location
// 整体替换成锁定坐标, 保留所有未知字段, 不回连上游。

const RESPONSE_PREFIX = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);

// 顶层消息里 WiFi 设备列表的 field 编号 (BSSIDApp.proto WifiDevice)
const FIELD_WIFI_DEVICES = 2;

export class WlocError extends Error {}

// ---------- varint / protobuf 基础 ----------

export function readVarint(buf, off) {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (off + i >= buf.length) throw new WlocError("truncated varint");
    const b = buf[off + i];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      if (i === 9) {
        // 10 字节 varint = 64 位补码 (负 int64), 按 SwiftProtobuf decodeSingularInt64 语义解释
        result = BigInt.asIntN(64, result);
      }
      // 数值域最大 ~1.8e10, Number 精度足够
      return [Number(result), off + i + 1];
    }
    shift += 7n;
  }
  throw new WlocError("varint too long");
}

export function encodeVarint(value) {
  let v = BigInt(Math.trunc(value));
  if (v < 0n) {
    // 64 位二补码
    v &= 0xffffffffffffffffn;
  }
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return Buffer.from(out);
}

export function parseProtobuf(buf) {
  const fields = [];
  let off = 0;
  while (off < buf.length) {
    const start = off;
    const [tag, next] = readVarint(buf, off);
    off = next;
    const fieldNo = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (fieldNo === 0) throw new WlocError(`invalid protobuf field 0 at offset ${start}`);
    let value;
    if (wireType === 0) {
      [value, off] = readVarint(buf, off);
    } else if (wireType === 1) {
      value = buf.subarray(off, off + 8);
      off += 8;
    } else if (wireType === 2) {
      const [len, after] = readVarint(buf, off);
      off = after;
      value = buf.subarray(off, off + len);
      off += len;
    } else if (wireType === 5) {
      value = buf.subarray(off, off + 4);
      off += 4;
    } else {
      throw new WlocError(`unsupported wire type ${wireType}`);
    }
    if (off > buf.length) throw new WlocError("truncated protobuf field");
    fields.push({ fieldNo, wireType, value, raw: buf.subarray(start, off) });
  }
  return fields;
}

function varintLen(v) {
  return encodeVarint(v).length;
}

function encodeTag(fieldNo, wireType) {
  return encodeVarint(fieldNo * 8 + wireType);
}

export function encodeField(fieldNo, wireType, value) {
  if (wireType === 0) return Buffer.concat([encodeTag(fieldNo, 0), encodeVarint(value)]);
  if (wireType === 2) return Buffer.concat([encodeTag(fieldNo, 2), encodeVarint(value.length), value]);
  if (wireType === 1 || wireType === 5) return Buffer.concat([encodeTag(fieldNo, wireType), value]);
  throw new WlocError(`cannot encode wire type ${wireType}`);
}

// ---------- ARPC 请求封包 ----------

export function parseARPC(buf) {
  let off = 0;
  const readU16 = () => { const v = buf.readUInt16BE(off); off += 2; return v; };
  const readU32 = () => { const v = buf.readUInt32BE(off); off += 4; return v; };
  const readPascal = () => { const len = readU16(); const s = buf.subarray(off, off + len).toString("utf8"); off += len; return s; };
  if (buf.length < 8) throw new WlocError("ARPC data incomplete");
  const version = readU16();
  const locale = readPascal();
  const appIdentifier = readPascal();
  const osVersion = readPascal();
  const functionID = readU32();
  const payloadLength = readU32();
  if (off + payloadLength > buf.length) throw new WlocError("ARPC payload length invalid");
  return { version, locale, appIdentifier, osVersion, functionID, payload: buf.subarray(off, off + payloadLength) };
}

// ---------- 锁定坐标 -> Location 子消息 ----------

export function buildLocation(state) {
  const parts = [
    encodeField(1, 0, Math.round(state.latitude * 1e8)),
    encodeField(2, 0, Math.round(state.longitude * 1e8)),
    encodeField(3, 0, state.accuracy ?? 39),
    encodeField(4, 0, 3),                 // unknownValue4, wloc8 固定 3
    encodeField(5, 0, state.altitude ?? 480),
    encodeField(6, 0, state.verticalAccuracy ?? 1000),
    encodeField(11, 0, 63),               // motionActivityType
    encodeField(12, 0, 467),              // motionActivityConfidence
  ];
  return Buffer.concat(parts);
}

function patchWifiDevice(deviceBuf, locationBuf) {
  const fields = parseProtobuf(deviceBuf);
  const out = [];
  let hasLocation = false;
  for (const f of fields) {
    if (f.fieldNo === 2 && f.wireType === 2) {
      out.push(encodeField(2, 2, locationBuf));
      hasLocation = true;
    } else {
      out.push(f.raw);
    }
  }
  if (!hasLocation) out.push(encodeField(2, 2, locationBuf));
  return Buffer.concat(out);
}

// 请求体 -> 合成的 WLoc 响应体。任何一步解析失败都抛错, 由调用方回退透传。
// state.randomRadius > 0 时, 每次响应在目标点周围随机偏移(与上游 dist/wloc.js 语义一致)。
export function buildResponseBody(requestBody, state) {
  if (!requestBody || requestBody.length === 0) throw new WlocError("empty request body");
  if (!state) throw new WlocError("no locked coordinate");
  const arpc = parseARPC(requestBody);
  const topFields = parseProtobuf(arpc.payload);
  const out = [];
  let devices = 0;
  for (const f of topFields) {
    if (f.fieldNo === FIELD_WIFI_DEVICES && f.wireType === 2) {
      out.push(encodeField(FIELD_WIFI_DEVICES, 2, patchWifiDevice(f.value, buildLocation(jitter(state)))));
      devices++;
    } else {
      out.push(f.raw);
    }
  }
  if (devices === 0) throw new WlocError("no wifi devices in request");
  const payload = Buffer.concat(out);
  if (payload.length > 0xffff) throw new WlocError("patched payload too large");
  // 与 wloc8/Apple 一致: 固定 2 字节大端长度, 不是 varint
  const lenBytes = Buffer.from([(payload.length >> 8) & 0xff, payload.length & 0xff]);
  return Buffer.concat([RESPONSE_PREFIX, lenBytes, payload]);
}

function jitter(state) {
  const radius = Number(state.randomRadius) || 0;
  if (!(radius > 0)) return state;
  const r = Math.random() * radius;
  const theta = Math.random() * Math.PI * 2;
  const dLat = (r * Math.sin(theta)) / 111320;
  const dLon = (r * Math.cos(theta)) / (111320 * Math.cos((state.latitude * Math.PI) / 180) || 1);
  return { ...state, latitude: state.latitude + dLat, longitude: state.longitude + dLon };
}

// 供测试/调试: 解开响应封包
export function parseResponseEnvelope(body) {
  if (body.length < 10 || !body.subarray(0, 8).equals(RESPONSE_PREFIX)) {
    throw new WlocError("unrecognized response envelope");
  }
  const len = body.readUInt16BE(8);
  const payload = body.subarray(10, 10 + len);
  if (payload.length !== len) throw new WlocError("declared length exceeds body");
  return payload;
}
