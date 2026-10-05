const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Read the central directory before touching disk. VSIX and Chrome assets are
// bounded ZIP files; ZIP64, encryption and links are deliberately unsupported.
function readArchive(file, { maxBytes = 64 * 1024 * 1024, maxExpanded = 128 * 1024 * 1024 } = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('更新压缩包不是有效的有界文件');
  const bytes = fs.readFileSync(file);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('不支持的更新 ZIP 格式');
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16);
  const directorySize = bytes.readUInt32LE(end + 12);
  if (!count || count > 5000 || offset + directorySize !== end || bytes.readUInt16LE(end + 8) !== count) throw new Error('更新 ZIP 目录无效');
  const entries = new Map(), normalized = new Set();
  let cursor = offset, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('更新 ZIP 条目损坏');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const length = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42), mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    const name = bytes.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    cursor += 46 + length + extra + comment;
    if (cursor > end || !name || name.includes('\\') || name.includes('\ufffd') || /[\x00-\x1f\x7f:]/.test(name)
        || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.' || (part && /[. ]$/.test(part)))
        || name.split('/').some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))
        || flags & 1 || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000
        || expanded + size > maxExpanded || compressed === 0xffffffff || size === 0xffffffff) throw new Error('更新 ZIP 含不安全路径、链接或超大条目');
    const key = name.replace(/\/$/, '').toLowerCase();
    if (normalized.has(key)) throw new Error('更新 ZIP 含重复路径');
    normalized.add(key); expanded += size;
    if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('更新 ZIP 本地条目无效');
    const localLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
    if (bytes.subarray(local + 30, local + 30 + localLength).toString('utf8') !== name
        || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) & 1) throw new Error('更新 ZIP 路径记录不一致');
    const start = local + 30 + localLength + localExtra;
    if (start + compressed > offset) throw new Error('更新 ZIP 文件边界无效');
    entries.set(name, { directory: name.endsWith('/'), size, data() {
      const source = bytes.subarray(start, start + compressed);
      const output = method === 0 ? source : zlib.inflateRawSync(source, { maxOutputLength: Math.max(1, size) });
      if (output.length !== size) throw new Error('更新 ZIP 解压大小不一致');
      return output;
    } });
  }
  if (cursor !== end) throw new Error('更新 ZIP 中央目录边界无效');
  return entries;
}

function archiveJson(entries, name) {
  const entry = entries.get(name);
  if (!entry || entry.directory || entry.size > 65536) throw new Error('更新包缺少有效元数据：' + name);
  return JSON.parse(entry.data().toString('utf8'));
}

function extractArchive(entries, destination, prefix) {
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  const root = fs.realpathSync(destination);
  for (const [name, entry] of entries) {
    if (!name.startsWith(prefix)) throw new Error('更新包含目标目录之外的文件');
    const relative = name.slice(prefix.length);
    if (!relative) continue;
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) throw new Error('更新包路径越界');
    fs.mkdirSync(entry.directory ? target : path.dirname(target), { recursive: true, mode: 0o700 });
    if (!entry.directory) fs.writeFileSync(target, entry.data(), { flag: 'wx', mode: 0o600 });
  }
}
module.exports = { readArchive, archiveJson, extractArchive };
