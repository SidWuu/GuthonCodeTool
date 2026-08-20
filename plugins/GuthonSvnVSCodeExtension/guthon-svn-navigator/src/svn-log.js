'use strict';

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function textOf(source, tag) {
  const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return decodeXml(match?.[1] || '');
}

function decodePossibleMojibake(value) {
  const text = String(value || '');
  if (!/[\u0080-\u00BF]|[ÃÂâæåäéèç]/.test(text)) return text;
  const repaired = Buffer.from(text, 'latin1').toString('utf8');
  return /[\u3400-\u9fff]/.test(repaired) ? repaired : text;
}

function parseSvnLogXml(xml) {
  const entries = [];
  const pattern = /<logentry\b([^>]*)>([\s\S]*?)<\/logentry>/g;
  let match;
  while ((match = pattern.exec(String(xml || '')))) {
    const revision = match[1].match(/\brevision="([^"]+)"/)?.[1] || '';
    if (!revision) continue;
    entries.push({
      revision,
      author: textOf(match[2], 'author') || '未知作者',
      date: textOf(match[2], 'date'),
      message: decodePossibleMojibake(textOf(match[2], 'msg')).trim()
    });
  }
  return entries;
}

module.exports = { parseSvnLogXml };
