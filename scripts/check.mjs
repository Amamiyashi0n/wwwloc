// 发布前一致性检查:
//   1. modules/、src/project.js、src/assets.generated.js、README 订阅区与配置一致
//   2. --release 时禁止占位站点地址
//   3. vendor 脚本与上游完整性记录 (docs/upstream-integrity.json) 一致
//   4. 模块内容含两个脚本端点, 且不含旧上游地址
//   5. README 相对链接指向存在的文件
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generatedFiles } from './configure.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const errors = [];

// 1. 生成结果与磁盘一致 (@template/* 是仅供 assets 生成的内存条目, 不落盘)
const { config, files } = await generatedFiles();
for (const [name, expected] of files) {
  if (name.startsWith('@template/')) continue;
  const actual = await readFile(path.join(root, name), 'utf8').catch(() => '');
  if (actual.replaceAll('\r\n', '\n') !== expected) {
    errors.push(`${name} 与配置不一致，请运行 npm run configure`);
  }
}

// 2. 发布检查: 站点必须已配置
if (!config.site || /REPLACE-ME/.test(config.site)) {
  if (process.argv.includes('--release')) errors.push('尚未在 project.config.json 填写部署后的真实站点地址');
  else console.warn('提示: site 仍是占位地址（仅 --release 会拦截）。');
}

// 3. vendor 脚本未被改动 (SHA-256, 规范化 LF)
const manifest = JSON.parse(await readFile(path.join(root, 'docs/upstream-integrity.json'), 'utf8'));
for (const [rel, expected] of Object.entries(manifest.files)) {
  const disk = rel.replace(/^dist\//, 'vendor/');
  const content = (await readFile(path.join(root, disk), 'utf8')).replaceAll('\r\n', '\n');
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual !== expected) errors.push(`${disk} 与上游完整性记录不同: ${actual}`);
}

// 4. 模块内容自检
for (const name of await readdir(path.join(root, 'modules'))) {
  const content = await readFile(path.join(root, 'modules', name), 'utf8');
  // {{SITE}} 是模板残留, 必须报错; REPLACE-ME 是占位站点, 由上面的 release 检查负责
  if (content.includes('{{SITE}}')) errors.push(`modules/${name} 仍含未替换的模板占位符`);
  // 规则里的正则写作 \/clls\/wloc , 先去掉转义反斜杠再匹配
  const flat = content.replaceAll('\\', '');
  for (const target of ['/clls/wloc', '/wloc-settings/save', '/wloc.js', '/wloc-settings.js']) {
    if (!flat.includes(target)) errors.push(`modules/${name} 缺少 ${target}`);
  }
  // 运行时必须自托管: 脚本与图标都不能再从上游取。
  // 允许 github.com/... 的署名链接(desc/homepage) —— 那不是运行时依赖。
  if (/raw\.githubusercontent\.com|\.pages\.dev/.test(content)) {
    errors.push(`modules/${name} 仍在运行时引用上游托管(GitHub Raw / Pages)`);
  }
}

// 5. README / NOTICE / 使用指南的相对链接存在性
//    占位符检查只针对生成文件 —— NOTICE.md 正文里会提到 {{SITE}} 这个模板记号本身。
const generated = ['docs/USAGE.md'];
for (const name of ['README.md', 'NOTICE.md', 'docs/USAGE.md']) {
  const content = await readFile(path.join(root, name), 'utf8');
  if (generated.includes(name) && content.includes('{{SITE}}')) {
    errors.push(`${name} 仍含未替换的模板占位符`);
  }
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:/i.test(target) || target.startsWith('/')) continue;
    try {
      await readFile(path.resolve(root, path.dirname(name), target));
    } catch {
      errors.push(`${name} 的本地链接不存在: ${target}`);
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('配置一致性、上游完整性、模块内容与文档链接检查全部通过。');
}
