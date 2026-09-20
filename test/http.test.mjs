import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import app from '../src/index.js';
import { SOURCE_URL } from '../src/project.js';
import { SERVED_ASSETS } from '../src/assets.generated.js';

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
