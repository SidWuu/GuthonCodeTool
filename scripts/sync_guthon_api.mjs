#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const apiDir = path.join(repoRoot, 'var', 'docs', '谷神方言API');
const extensionDir = path.join(
  repoRoot,
  'plugins',
  'GuthonVSCodeExtension',
  'gushen-vscode-completion'
);
const dataDir = path.join(extensionDir, 'data');
const buildDataScript = path.join(extensionDir, 'scripts', 'build-data.mjs');
const syncConfigPath = path.join(repoRoot, 'config', 'sync.yaml');
const languages = ['java', 'javascript', 'sql'];

function unquote(value) {
  const text = String(value || '').trim();
  return text.startsWith('"') && text.endsWith('"')
    || text.startsWith("'") && text.endsWith("'")
    ? text.slice(1, -1)
    : text;
}

function loadApiConfig(filePath = syncConfigPath) {
  // ponytail: only this small sync.yaml section is needed; use a YAML package if it grows.
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  let inApi = false;
  let inBundles = false;
  let activeVersion = '';
  const bundleFiles = {};

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (indent === 0) {
      inApi = text === 'guthon_api:';
      inBundles = false;
      continue;
    }
    if (!inApi) continue;
    if (indent === 2 && text.startsWith('active_version:')) {
      activeVersion = unquote(text.slice(text.indexOf(':') + 1));
    } else if (indent === 2 && text === 'bundle_files:') {
      inBundles = true;
    } else if (indent === 4 && inBundles) {
      const match = /^("[^"]+"|'[^']+'|[^:]+):\s*(.+)$/.exec(text);
      if (match) bundleFiles[unquote(match[1])] = unquote(match[2]);
    }
  }

  if (!/^[A-Za-z0-9._-]+$/.test(activeVersion)) {
    throw new Error('config/sync.yaml 缺少有效的 guthon_api.active_version');
  }
  const configuredFile = bundleFiles[`v${activeVersion.replace(/\./g, '_')}`];
  if (!configuredFile) throw new Error(`未配置谷神 ${activeVersion} 的 bundle_file`);
  return {
    activeVersion,
    bundleFile: path.resolve(repoRoot, configuredFile),
  };
}

function takeBalanced(source, start) {
  const open = source[start];
  const close = { '[': ']', '{': '}', '(': ')' }[open];
  if (!close) throw new Error(`无法从位置 ${start} 读取 JS 结构`);

  let depth = 0;
  let quote = '';
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }

    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === open) depth += 1;
    else if (char === close && --depth === 0) return source.slice(start, index + 1);
  }

  throw new Error('app.js 中存在未闭合的 API 数据结构');
}

function getFunRemark(fundis, args = [], returnValue = '无') {
  const params = args.length
    ? args.map((item) => `+ **${item.name}:** ${item.remark}。`).join(' \n ')
    : '无';
  return {
    isTrusted: true,
    fundis,
    value: `**函数说明：**\n ${fundis} \n\n**参数说明：**\n ${params}\n\n**返&nbsp;&nbsp;回&nbsp;&nbsp;值：**\n ${returnValue || '无'}`,
  };
}

function extractBundleModel(source) {
  const startMatch = /;var ([\w$]+)=[\w$]+,([\w$]+)=\{\};\2\.gUtil=\[/.exec(source);
  if (!startMatch) throw new Error('未找到谷神前端 API 数据起点');

  const apiMatch = /([\w$]+)\.apiBeans=\[/.exec(source.slice(startMatch.index));
  if (!apiMatch) throw new Error('未找到 API 中心 apiBeans');

  const apiOwner = apiMatch[1];
  const apiAssignment = startMatch.index + apiMatch.index;
  const apiArrayStart = source.indexOf('[', apiAssignment);
  const apiBeans = vm.runInNewContext(`(${takeBalanced(source, apiArrayStart)})`, {}, { timeout: 1000 });

  const dataStart = source.indexOf(`${startMatch[2]}={};`, startMatch.index);
  const dataEnd = source.lastIndexOf(`,${apiOwner}={}`, apiAssignment);
  if (dataStart < 0 || dataEnd <= dataStart) throw new Error('无法确定 API 数据代码边界');

  const kinds = new Proxy({}, { get: () => 1 });
  const rules = new Proxy({}, { get: () => 4 });
  const context = {
    monaco: {
      languages: {
        CompletionItemKind: kinds,
        CompletionItemInsertTextRule: rules,
      },
    },
    [startMatch[1]]: { getFunRemark },
  };

  vm.runInNewContext(
    `var ${source.slice(dataStart, dataEnd)};`,
    context,
    { timeout: 5000 }
  );

  const js = context[startMatch[2]];
  const objects = Object.values(context).filter((value) => value && typeof value === 'object');
  const gs = objects.find((value) => !Array.isArray(value) && value.vsBeans && value.keywords);
  const sql = objects.find(
    (value) => Array.isArray(value)
      && value.some((item) => item?.label === 'UUID()')
      && value.some((item) => item?.label?.startsWith('isNull('))
  );

  if (!js?.gUtil || !gs?.vsBeans || !sql) throw new Error('API 数据已提取，但结构与预期不一致');
  return { apiBeans, js, gs, sql };
}

function splitParams(value) {
  const params = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index <= value.length; index += 1) {
    const char = value[index];
    if ('<[{('.includes(char)) depth += 1;
    else if ('>]}）)'.includes(char)) depth -= 1;
    else if ((char === ',' || index === value.length) && depth === 0) {
      params.push(value.slice(start, index));
      start = index + 1;
    }
  }
  return params.map((item) => item.trim()).filter(Boolean);
}

function signature(label) {
  const text = String(label || '').trim();
  const open = text.indexOf('(');
  if (open < 0) {
    const name = text.split(/\s+-\s+/, 1)[0].trim();
    return { name, call: name };
  }

  const close = text.lastIndexOf(')');
  if (close < open) throw new Error(`API 签名括号不完整：${text}`);
  const name = text.slice(0, open).trim().split('.').at(-1);
  const params = splitParams(text.slice(open + 1, close)).map((param) => {
    const noDefault = param.split('=', 1)[0].trim();
    const value = noDefault
      .split(':', 1)[0]
      .replace(/^\[|\]$/g, '')
      .replace(/^\\?\$/, '')
      .replace(/<[^>]*>/g, '')
      .replace(/[\\|]/g, '')
      .trim();
    return value === '...' ? 'args' : value;
  });
  return { name, call: `${name}(${params.join(',')})` };
}

function itemPath(body) {
  const text = String(body || '');
  const open = text.indexOf('(');
  return open < 0 ? text : text.slice(0, open);
}

function methodsFor(model, item) {
  let own;
  if (item.itemType === 'JS') own = model.js[item.alia];
  else if (item.itemType === 'GS') own = model.gs[item.alia] || model.gs.vsBeans[item.key];
  else own = model.sql;

  if (!Array.isArray(own)) throw new Error(`未找到 ${item.key} 的 API 数据`);
  const inherited = String(item.parent || '')
    .split(',')
    .filter(Boolean)
    .flatMap((name) => model.js[name] || []);
  return [...inherited, ...own].sort((left, right) => left.label.localeCompare(right.label));
}

function resolveGroup(existingItems, item, methods) {
  const paths = new Set(methods.map((method) => `${item.key}.${signature(method.label).name}`));
  const scores = new Map();
  for (const existing of existingItems) {
    if (!paths.has(itemPath(existing.body))) continue;
    scores.set(existing.group, (scores.get(existing.group) || 0) + 1);
  }
  const ranked = [...scores].sort((left, right) => right[1] - left[1]);
  if (!ranked.length || (ranked[1] && ranked[1][1] === ranked[0][1])) {
    throw new Error(`无法从现有补全数据确定 ${item.key} 的命名空间`);
  }
  return ranked[0][0];
}

function oneLine(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tableCell(value) {
  return oneLine(value).replace(/\|/g, '\\|');
}

function buildApiData(model, existingIndex) {
  const result = { java: [], javascript: [], sql: [] };
  const seenBodies = Object.fromEntries(
    languages.map((language) => [language, new Map(
      (existingIndex[language] || []).map((item) => [item.body, item])
    )])
  );
  const matched = { java: 0, javascript: 0, sql: 0 };

  for (const apiGroup of model.apiBeans) {
    const language = { JS: 'javascript', GS: 'java', SQL: 'sql' }[apiGroup.key];
    if (!language) throw new Error(`未知 API 类型：${apiGroup.key}`);

    for (const item of apiGroup.items) {
      const methods = methodsFor(model, item);
      const group = resolveGroup(existingIndex[language] || [], item, methods);

      for (const method of methods) {
        const parsed = signature(method.label);
        const body = `${item.key}.${parsed.call}`;
        const existing = seenBodies[language].get(body);
        if (existing) matched[language] += 1;
        const documentation = method.documentation;
        result[language].push({
          language,
          group,
          prefix: existing?.prefix || `${group}.${parsed.name}`,
          body,
          description: oneLine(
            typeof documentation === 'string' ? documentation : documentation?.fundis
          ),
        });
      }
    }
  }

  for (const language of languages) {
    const oldCount = existingIndex[language]?.length || 0;
    if (!result[language].length) throw new Error(`${language} API 为空`);
    if (oldCount && matched[language] / oldCount < 0.9) {
      throw new Error(`${language} 仅匹配 ${matched[language]}/${oldCount} 个现有补全，拒绝覆盖`);
    }
  }

  return { result, matched };
}

function markdownFor(language, items, version, templateDir = apiDir) {
  const filePath = path.join(templateDir, `${language}.md`);
  const current = fs.readFileSync(filePath, 'utf8');
  const marker = '## 命名空间索引';
  const markerIndex = current.indexOf(marker);
  if (markerIndex < 0) throw new Error(`${filePath} 缺少“命名空间索引”`);

  let preamble = current
    .slice(0, markerIndex)
    .replace(/- API 数量：\d+/, `- API 数量：${items.length}`);
  const versionLine = `- 谷神版本：${version}`;
  preamble = /- 谷神版本：[^\r\n]+/.test(preamble)
    ? preamble.replace(/- 谷神版本：[^\r\n]+/, versionLine)
    : preamble.replace(/(- API 数量：\d+)/, `$1\n${versionLine}`);
  preamble = preamble.trimEnd();
  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.group)) grouped.set(item.group, []);
    grouped.get(item.group).push(item);
  }

  const index = [...grouped].map(([group, groupItems]) => `- [${group}](#${group})：${groupItems.length}`);
  const sections = [...grouped].map(([group, groupItems]) => [
    `## ${group}`,
    '',
    '| Snippet | API 调用模板 | 说明 |',
    '|---|---|---|',
    ...groupItems.map((item) =>
      `| \`${tableCell(item.prefix)}\` | \`${tableCell(item.body)}\` | ${tableCell(item.description)} |`
    ),
  ].join('\n'));

  return `${preamble}\n\n${marker}\n\n${index.join('\n')}\n\n${sections.join('\n\n')}\n`;
}

function run(command, args, cwd = repoRoot) {
  const child = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (child.status !== 0) {
    throw new Error([child.stdout, child.stderr].filter(Boolean).join('\n').trim());
  }
  return child.stdout.trim();
}

function validateGenerated(tempDataDir, expected, oldCounts, allowShrink) {
  const generatedIndex = JSON.parse(fs.readFileSync(path.join(tempDataDir, 'index.json'), 'utf8'));
  for (const language of languages) {
    const generated = generatedIndex[language];
    assert.equal(generated.length, expected[language].length);
    for (const item of generated) {
      assert.equal(typeof item.prefix, 'string');
      assert.equal(typeof item.body, 'string');
      assert.equal(typeof item.description, 'string');
      assert.ok(item.prefix && item.body && item.group);
    }
    const oldCount = oldCounts[language] || 0;
    if (!allowShrink && generated.length < oldCount) {
      throw new Error(`${language} API 从 ${oldCount} 减少到 ${generated.length}；如确认删除请加 --allow-shrink`);
    }
  }
}

function apiCounts(directory) {
  const counts = {};
  for (const language of languages) {
    const filePath = path.join(directory, `${language}.md`);
    if (!fs.existsSync(filePath)) continue;
    const match = /- API 数量：(\d+)/.exec(fs.readFileSync(filePath, 'utf8'));
    if (match) counts[language] = Number(match[1]);
  }
  return counts;
}

function changedContents(contents) {
  return new Map([...contents].filter(([target, content]) =>
    !fs.existsSync(target) || !fs.readFileSync(target).equals(content)
  ));
}

function atomicReplace(contents) {
  const staged = [];
  for (const [target, content] of contents) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.sync-${process.pid}.tmp`;
    fs.writeFileSync(temp, content);
    staged.push([target, temp]);
  }
  for (const [target, temp] of staged) fs.renameSync(temp, target);
}

function selfTest() {
  assert.deepEqual(signature('alert(msg:string,fun:Function=null):void'), {
    name: 'alert',
    call: 'alert(msg,fun)',
  });
  assert.deepEqual(signature('MEMBER_CODE - 当前会员代码'), {
    name: 'MEMBER_CODE',
    call: 'MEMBER_CODE',
  });
  assert.equal(signature('hideAllButtonsExcept(array\\|function):void').call, 'hideAllButtonsExcept(arrayfunction)');
  assert.equal(signature('listJoin($list<string>,$ch:string)').call, 'listJoin(list,ch)');
  assert.equal(signature('concat(str1,str2,...)').call, 'concat(str1,str2,args)');
  assert.equal(takeBalanced('x[{a:"[x]"}]y', 1), '[{a:"[x]"}]');
  const configFile = path.join(os.tmpdir(), `guthon-api-config-${process.pid}.yaml`);
  fs.writeFileSync(configFile, 'guthon_api:\n  active_version: "2.0"\n  bundle_files:\n    v2_0: "app.js"\n');
  try {
    assert.equal(loadApiConfig(configFile).activeVersion, '2.0');
  } finally {
    fs.rmSync(configFile, { force: true });
  }
  console.log('sync_guthon_api self-test: ok');
}

function usage() {
  console.error('用法: node scripts/sync_guthon_api.mjs [--check] [--allow-shrink]');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  if (args.some((arg) => !arg.startsWith('--'))) {
    usage();
    process.exitCode = 2;
    return;
  }

  const { activeVersion, bundleFile } = loadApiConfig();
  const inputPath = bundleFile;
  if (!fs.existsSync(inputPath)) throw new Error(`bundle 文件不存在：${path.relative(repoRoot, inputPath)}`);
  const checkOnly = args.includes('--check');
  const allowShrink = args.includes('--allow-shrink');
  const source = fs.readFileSync(inputPath, 'utf8');
  const versionApiDir = path.join(apiDir, 'versions', activeVersion);
  const activeIndex = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
  const baselineCounts = apiCounts(versionApiDir);
  const model = extractBundleModel(source);
  const { result, matched } = buildApiData(model, activeIndex);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-api-'));
  const tempDocs = path.join(tempRoot, 'docs');
  const tempData = path.join(tempRoot, 'data');
  fs.mkdirSync(tempDocs);

  try {
    for (const language of languages) {
      const templateDir = fs.existsSync(path.join(versionApiDir, `${language}.md`))
        ? versionApiDir
        : apiDir;
      fs.writeFileSync(
        path.join(tempDocs, `${language}.md`),
        markdownFor(language, result[language], activeVersion, templateDir)
      );
    }
    const buildOutput = run(process.execPath, [buildDataScript, tempDocs, tempData]);
    validateGenerated(tempData, result, baselineCounts, allowShrink);

    console.log(`谷神版本：${activeVersion}`);
    console.log(buildOutput);
    console.log(languages.map((language) =>
      `${language}: ${baselineCounts[language] || 0} -> ${result[language].length}, matched ${matched[language]}`
    ).join('\n'));

    const targets = new Map();
    for (const language of languages) {
      const markdown = fs.readFileSync(path.join(tempDocs, `${language}.md`));
      targets.set(path.join(versionApiDir, `${language}.md`), markdown);
      targets.set(path.join(apiDir, `${language}.md`), markdown);
    }
    const index = fs.readFileSync(path.join(tempData, 'index.json'));
    // 根 index.json 最后替换；插件运行时只读取它，前序中断不会破坏现有补全。
    targets.set(path.join(dataDir, 'index.json'), index);
    const changed = changedContents(targets);
    if (!changed.size) {
      console.log('无差异，未覆盖任何 MD 或 JSON。');
      return;
    }
    if (checkOnly) {
      console.log(`检查通过，将更新 ${changed.size} 个文件；当前未写入。`);
      return;
    }

    const originals = new Map([...changed].map(([target]) => [
      target,
      fs.existsSync(target) ? fs.readFileSync(target) : undefined,
    ]));

    try {
      atomicReplace(changed);
      console.log(run('npm', ['test'], extensionDir));
    } catch (error) {
      atomicReplace(new Map([...originals].filter(([, content]) => content)));
      for (const [target, content] of originals) {
        if (content === undefined && fs.existsSync(target)) fs.rmSync(target, { force: true });
      }
      throw error;
    }
    console.log(`同步完成，更新 ${changed.size} 个文件。`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export { extractBundleModel, loadApiConfig, signature, takeBalanced };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`同步失败：${error.message}`);
    process.exitCode = 1;
  }
}
