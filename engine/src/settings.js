// 锁定坐标存储: 内存 + JSON 文件落盘, 与 dist/wloc-settings.js 的语义对齐,
// 这样 cloudflare-wloc 的选点页面可以原样使用 (save/query/clear + CORS)。
import { readFileSync, writeFileSync, existsSync } from "node:fs";

let state = null;
let stateFile = null;

export function initSettings(file, defaults = {}) {
  stateFile = file;
  state = null;
  if (file && existsSync(file)) {
    try {
      state = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      state = null;
    }
  }
  return state;
}

export function getState() {
  return state ? { ...state } : null;
}

// 参数校验失败返回 {error}, 成功返回 null
export function saveSettings({ longitude, latitude, accuracy, randomRadius }) {
  const lon = Number(longitude);
  const lat = Number(latitude);
  const acc = Number(accuracy ?? 25);
  const radius = Number(randomRadius ?? 0);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return "缺少 longitude / latitude";
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return "坐标超出合法范围";
  state = {
    longitude: lon,
    latitude: lat,
    accuracy: Number.isFinite(acc) && acc > 0 ? acc : 25,
    randomRadius: Number.isFinite(radius) && radius > 0 ? radius : 0,
    updatedAt: new Date().toISOString(),
  };
  persist();
  return null;
}

export function clearSettings() {
  state = null;
  persist();
}

function persist() {
  if (!stateFile) return;
  try {
    if (state) writeFileSync(stateFile, JSON.stringify(state, null, 2));
    else writeFileSync(stateFile, "{}");
  } catch (e) {
    console.error("[wloc] 状态写入失败:", e.message);
  }
}
