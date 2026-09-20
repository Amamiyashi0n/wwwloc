import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import app from '../src/index.js';
import { SOURCE_URL } from '../src/project.js';
import { SERVED_ASSETS, CA_CERT_B64 } from '../src/assets.generated.js';

test('首页包含源码入口、免客户端模式卡片,且内联脚本可解析', async () => {
  const response = await app.request('/');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes(`href="${SOURCE_URL}"`));
  // 免客户端模式: 描述文件生成器必须在页面上
  assert.ok(html.includes('免客户端模式'), '应有免客户端模式卡片');
  assert.ok(html.includes('buildProfile'), '应包含描述文件生成函数');
  assert.ok(html.includes('wloc.mobileconfig'), '应生成 .mobileconfig 下载');
  assert.ok(!html.includes('模块订阅地址'), '模块订阅卡片应已从页面移除');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x => x[1]).filter(x => x.trim());
  assert.ok(scripts.length > 0);
  for (const script of scripts) new vm.Script(script);
});

test('静态路由提供两个 WLOC 脚本且可执行解析', async () => {
  for (const route of ['/wloc.js', '/wloc-settings.js']) {
    const response = await app.request(route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    // 内容必须与 vendor 字节一致 (LF 规范化后)
    assert.equal(await response.text(), SERVED_ASSETS[route].content);
    // 能被 JS 引擎解析 (minified 上游脚本, 不执行)
    new vm.Script(SERVED_ASSETS[route].content);
  }
});

test('模块订阅路由提供五种格式, 且按请求 origin 注入站点地址', async () => {
  const names = ['wloc.sgmodule', 'wloc.conf', 'wloc.lpx', 'wloc.stoverride', 'wloc.module'];
  for (const name of names) {
    const response = await app.request(`/modules/${name}`);
    assert.equal(response.status, 200, name);
    const body = (await response.text()).replaceAll('\\', '');
    assert.ok(body.includes('/clls/wloc'), `${name} 应包含响应改写规则`);
    assert.ok(body.includes('/wloc-settings/save'), `${name} 应包含保存拦截规则`);
    // {{SITE}} 占位符必须被请求 origin 替换干净 —— 一键部署零配置的关键
    assert.ok(!body.includes('{{SITE}}'), `${name} 不应残留模板占位符`);
    assert.ok(body.includes('http://localhost/wloc.js'), `${name} 脚本地址应指向请求 origin`);
    assert.ok(body.includes('http://localhost/wloc-settings.js'), `${name} 设置脚本地址应指向请求 origin`);
  }
  assert.equal((await app.request('/modules/not-exist.sgmodule')).status, 404);
});

test('API JSON 坐标结果带 CORS 和 no-store', async () => {
  const response = await app.request('/api/parse?u=31.230400,121.473700&format=json');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { lat: 31.2304, lon: 121.4737, name: '' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('API 保留快捷指令使用的纯文本模式', async () => {
  const response = await app.request('/api/parse?u=31.230400,121.473700');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'lat=31.2304&lon=121.4737');
});

test('API 空输入错误不能被缓存', async () => {
  const response = await app.request('/api/parse?format=json');
  assert.equal(response.status, 422);
  assert.ok((await response.json()).error);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('未知路由返回 404', async () => {
  assert.equal((await app.request('/does-not-exist')).status, 404);
});

test('站点分发根证书: /ca.cer 为 DER, /ca.b64 为同一份内容的 base64', async () => {
  const cer = await app.request('/ca.cer');
  assert.equal(cer.status, 200);
  assert.equal(cer.headers.get('content-type'), 'application/x-x509-ca-cert');
  assert.match(cer.headers.get('content-disposition') ?? '', /attachment/);
  const der = Buffer.from(await cer.arrayBuffer());
  assert.equal(der[0], 0x30, '应为 DER 序列');

  const b64 = await app.request('/ca.b64');
  assert.equal(b64.status, 200);
  const text = (await b64.text()).trim();
  // 两个路由必须指向同一张证书, 否则页面载入的与下载的不是一张
  assert.ok(Buffer.from(text, 'base64').equals(der), '/ca.b64 与 /ca.cer 应为同一张证书');
  assert.equal(text, CA_CERT_B64, '应等于 configure 内嵌的证书');
});

test('页面自动载入本站证书并提供指纹与手动兜底', async () => {
  const html = await (await app.request('/')).text();
  assert.ok(html.includes('pfAutoLoadCa'), '应含自动载入逻辑');
  assert.ok(html.includes("fetch('/ca.b64'"), '应从本站取证书');
  assert.ok(html.includes('SHA-256 指纹'), '应显示指纹便于核对');
  assert.ok(html.includes('手动指定根证书'), '应保留手动兜底入口');
  assert.ok(html.includes('public/ca.cer'), '应说明证书来源');
});

test('主操作只有一个「安装根证书」按钮, 代理配置降级为进阶/手动', async () => {
  const html = await (await app.request('/')).text();
  // 证书卡片内只有 installCertOnly 一个主按钮; buildProfile 降级为次要按钮
  const card = html.slice(html.indexOf('cert-mode-title'));
  assert.ok(card.includes('installCertOnly()'), '主按钮应调用只装证书的函数');
  const primaryInCard = [...card.matchAll(/<button[^>]*class="[^"]*btn-primary[^"]*"[^>]*>/g)];
  assert.equal(primaryInCard.length, 1, '证书卡片内只应有一个主按钮');
  assert.ok(primaryInCard[0][0].includes('installCertOnly'), '主按钮应就是安装证书');
  assert.ok(/<button[^>]*class="[^"]*btn-secondary[^"]*"[^>]*onclick="buildProfile\(\)"/.test(card),
    '含代理的描述文件应降级为次要按钮');
  // 代理配置不再是主路径: Wi-Fi 名等输入项放在 details 里
  assert.ok(card.includes('进阶：让描述文件自动配置代理'), '应把自动配置代理标为进阶');
  assert.ok(card.includes('配置代理 → 手动'), '应给出手机端手动设置代理的指引');
  assert.ok(card.includes('pfHostEcho'), '代理地址应回显到操作指引里');
  // 证书卡片的 details 默认收起, 主界面只剩一个按钮
  assert.ok(!/<details style="margin-top:10px" open>/.test(card), '进阶区应默认收起');
});

test('「安装根证书」产出的描述文件只含根证书, 不含代理配置', async () => {
  const html = await (await app.request('/')).text();
  const marker = 'function installCertOnly()';
  const start = html.indexOf(marker);
  assert.ok(start > 0);
  const end = html.indexOf('function buildProfile()', start);
  const code = html.slice(html.lastIndexOf('/* ---- 免客户端模式', start), end);

  let downloaded = null;
  const els = { pfCa: { value: CA_CERT_B64, addEventListener() {} } };
  const sandbox = {
    document: {
      getElementById: (id) => els[id] ?? { value: '', addEventListener() {} },
      createElement: () => ({ href: '', download: '', click() {}, remove() {} }),
      body: { appendChild() {} },
    },
    crypto: globalThis.crypto,
    Blob: globalThis.Blob,
    URL: { createObjectURL: (b) => { downloaded = b; return 'blob:x'; } },
    toast: () => {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    Uint8Array, String, Math, parseInt,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  sandbox.installCertOnly();
  assert.ok(downloaded, '应产出可下载的描述文件');
  const xml = await downloaded.text();
  assert.ok(xml.includes('com.apple.security.root'), '应含根证书 payload');
  assert.ok(!xml.includes('com.apple.wifi.managed'), '不应含 Wi-Fi/代理 payload');
  assert.ok(!xml.includes('ProxyServer'), '不应含代理服务器配置');
  assert.ok(xml.includes('<data>' + CA_CERT_B64 + '</data>'), '应嵌入本站证书');
});
