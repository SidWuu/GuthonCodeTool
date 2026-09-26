function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function table(headers, rows) {
  if (!rows.length) return '无索引证据。\n';
  return [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
    '',
  ].join('\n');
}

function renderPageImpact(identity, context, relations) {
  const lines = [
    `# PAGE 影响预览：${identity.sourceId}`,
    '',
    `- 工作区：${identity.workspaceKey}`,
    `- 索引文件：${context.sourcePath}`,
    `- 索引代次：${context.indexGeneration}`,
    `- 索引源码 SHA-256：${context.indexedSourceHash}`,
    '- 快照：预览时已核对工作副本源码与索引哈希；后续编辑或重新索引后须重新预览。',
    '- 范围：当前 PAGE 的索引事实。字段关系仅覆盖显式 selectBox 证据，不构成删除安全判定。',
    '- 跳转：在源码树右键同一 PAGE，选择“浏览影响证据”打开索引记录的源码片段与行。',
    '',
    '## 表访问',
    '',
    table(['表', '操作', '置信度', '位置', '证据'], (context.tableAccesses || []).map((item) => [
      item.table_name, item.operation, item.confidence,
      `${item.json_pointer || '整个文件'}:${item.line_no || 1}`, item.evidence,
    ])),
    '## 字段关系',
    '',
    table(['源字段', '关系', '目标字段', '解析状态', '证据位置'], (relations.relations || []).map((item) => [
      item.sourceFieldId, item.relationType, item.targetFieldId,
      item.resolution, item.evidencePointer,
    ])),
    '## 逻辑事实',
    '',
    table(['类别', '主题', '值', '位置'], (context.logicFacts || []).map((item) => [
      item.fact_kind, item.subject, item.value_text,
      `${item.json_pointer || '整个文件'}:${item.line_start || 1}`,
    ])),
  ];
  if (context.truncated || relations.truncated) {
    lines.push('> 结果已截断；继续通过 PAGE 查询查看完整证据。', '');
  }
  return lines.join('\n');
}

function renderProcedureImpact(identity, context) {
  const lines = [
    `# 过程函数影响预览：${identity.sourceId}`,
    '',
    `- 工作区：${identity.workspaceKey}`,
    `- 索引文件：${context.source.source_path}`,
    '- 范围：当前索引中的静态调用边和动态调用线索；同名动态目标需要人工复核。',
    '- 调用边每类最多显示 20 条，达到上限时可能还有未显示结果。',
    '- 跳转：在源码树右键同一函数，选择“浏览影响证据”打开索引调用行。',
    '',
    '## 调用方',
    '',
    table(['来源', '脚本位置', '行', '置信度'], (context.incoming || []).map((item) => [
      `${item.source_alias_id || item.source_id}.${item.fun_id || ''}`,
      item.json_path || item.script_type, item.line_no, item.confidence,
    ])),
    '## 被调用函数',
    '',
    table(['目标', '脚本位置', '行', '置信度'], (context.outgoing || []).map((item) => [
      `${item.target_alias_id}.${item.target_fun_id}`,
      item.json_path || item.script_type, item.line_no, item.confidence,
    ])),
    '## 动态调用线索',
    '',
    table(['表达式', '原因', '行', '置信度'], (context.dynamic || []).map((item) => [
      item.invoke_expr, item.reason, item.line_no, item.confidence,
    ])),
  ];
  return lines.join('\n');
}

async function loadImpact(backend, identity) {
  if (!identity.workspaceKey || !identity.sourceId || !identity.sourcePath) {
    throw new Error('所选源码缺少完整身份，请刷新 SVN 源码树');
  }
  if (identity.sourceType === 'page') {
    if (!identity.sourcePath.toLowerCase().endsWith('.json')) {
      throw new Error('PAGE 影响预览目前支持 PAGE JSON');
    }
    if (!identity.sourceNamespace) throw new Error('PAGE 缺少命名空间身份，请刷新 SVN 源码树');
    const locator = {
      sourceNamespace: identity.sourceNamespace,
      sourceId: identity.sourceId,
      funId: identity.funId || '',
    };
    const context = await backend.pageQuery(identity.workspaceKey, 'get_source_context', {
      ...locator, limit: 20,
    });
    if (context.sourcePath !== identity.sourcePath) throw new Error('PAGE 索引身份与所选文件不一致，请刷新索引');
    const relations = await backend.pageQuery(identity.workspaceKey, 'list_page_field_relations', {
      ...locator, limit: 100,
    });
    if (relations.sourcePath !== identity.sourcePath
        || relations.indexGeneration !== context.indexGeneration
        || relations.indexedSourceHash !== context.indexedSourceHash) {
      throw new Error('PAGE 关系索引与上下文快照不一致，请重新预览');
    }
    return { kind: 'page', identity, context, relations };
  }
  if (identity.sourceType === 'procedure') {
    const context = await backend.context(identity.workspaceKey, identity.sourceId, identity.funId || '', 20);
    if (context.source?.source_path !== identity.sourcePath
        || (identity.sourceNamespace && context.source.source_namespace !== identity.sourceNamespace)
        || (identity.workingCopyId && context.source.working_copy_id !== identity.workingCopyId)) {
      throw new Error('同名过程函数的索引身份不唯一或已变化；请用精确路径核验后刷新索引');
    }
    return { kind: 'procedure', identity, context };
  }
  throw new Error('影响预览目前支持 PAGE 和过程函数');
}

async function impactMarkdown(backend, identity) {
  const evidence = await loadImpact(backend, identity);
  return evidence.kind === 'page'
    ? renderPageImpact(identity, evidence.context, evidence.relations)
    : renderProcedureImpact(identity, evidence.context);
}

function impactEvidenceChoices(evidence) {
  const { identity, context } = evidence;
  if (evidence.kind === 'page') {
    const choices = (evidence.relations.relations || [])
      .filter((relation) => relation.collectionPointer)
      .map((relation) => ({
        label: `${relation.sourceFieldId || '未命名字段'} → ${relation.targetFieldId || relation.relationType}`,
        description: relation.resolution || '',
        detail: relation.evidencePointer || relation.sourcePointer || '',
        source: {
          ...identity,
          jsonPointer: relation.collectionPointer,
          fragmentType: 'fields',
        },
      }));
    for (const access of context?.tableAccesses || []) {
      if (!access.json_pointer) continue;
      choices.push({
        label: `表访问：${access.operation} ${access.table_name}`,
        description: `第 ${access.line_no || 1} 行 · ${access.confidence || '未标注'}`,
        detail: access.json_pointer || '整个 PAGE',
        source: { ...identity, jsonPointer: access.json_pointer || '' },
        lineNumber: access.line_no || 1,
      });
    }
    for (const fact of context?.logicFacts || []) {
      if (!fact.json_pointer) continue;
      choices.push({
        label: `逻辑事实：${fact.fact_kind} ${fact.subject || ''}`,
        description: `第 ${fact.line_start || 1} 行 · ${fact.confidence || '未标注'}`,
        detail: fact.json_pointer || '整个 PAGE',
        source: { ...identity, jsonPointer: fact.json_pointer || '' },
        lineNumber: fact.line_start || 1,
      });
    }
    return choices;
  }
  const choices = [];
  for (const caller of context.incoming || []) {
    if (!caller.working_copy_id || !caller.source_path) continue;
    choices.push({
      label: `调用方：${caller.source_alias_id || caller.source_id}.${caller.fun_id || ''}`,
      description: `第 ${caller.line_no || 1} 行`,
      detail: caller.json_path || caller.source_id || '',
      source: {
        workspaceKey: identity.workspaceKey,
        sourceType: caller.source_table,
        sourceId: caller.source_id,
        funId: caller.fun_id || '',
        sourcePath: caller.source_path,
        workingCopyId: caller.working_copy_id,
        jsonPointer: caller.json_path?.startsWith('/') ? caller.json_path : '',
        fragmentType: caller.script_type || '',
      },
      lineNumber: caller.line_no || 1,
    });
  }
  for (const callee of context.outgoing || []) {
    choices.push({
      label: `被调用：${callee.target_alias_id}.${callee.target_fun_id}`,
      description: `当前函数第 ${callee.line_no || 1} 行`,
      detail: callee.json_path || '',
      source: identity,
      lineNumber: callee.line_no || 1,
    });
  }
  for (const dynamic of context.dynamic || []) {
    choices.push({
      label: `动态线索：${dynamic.invoke_expr || '未解析表达式'}`,
      description: `当前函数第 ${dynamic.line_no || 1} 行`,
      detail: dynamic.reason || '',
      source: identity,
      lineNumber: dynamic.line_no || 1,
    });
  }
  return choices;
}

module.exports = { impactEvidenceChoices, impactMarkdown, loadImpact, renderPageImpact, renderProcedureImpact };
