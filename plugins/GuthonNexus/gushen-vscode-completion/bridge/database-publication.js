const {createHash} = require('node:crypto');
const {createDatabasePublishJournal, sourceHash, MAX_PAGE_BYTES} = require('./database-source-publish');

function createDatabasePublication(directory, { resolveContext, assertDatabaseWorkspace, authorizeTarget, confirmCandidate, browserRequest, refreshMirror }) {
  const journalFor = (context, recheckCandidate) => createDatabasePublishJournal(directory, {
    async readPlatform(target, evidence) {
      const actual = await browserRequest(context, 'read', target, evidence);
      if (!evidence) await recheckCandidate();
      return actual;
    },
    savePlatform: (target, evidence) => browserRequest(context, 'save', target, evidence),
    refreshMirror,
  });

  async function reviewedTarget(input, readOnly = false) {
    const {workspaceKey, contextId, recordId, sourceId, sourcePath, reviewId, sourceHash:expectedHash, native} = input;
    const approval = {recordId, sourceId, sourcePath, reviewId, sourceHash:expectedHash,
      ...(input.compareMirror === true ? {compareMirror:true} : {})};
    const candidate = await confirmCandidate(workspaceKey, approval);
    const identity = {...candidate.databaseIdentity, workspaceBinding:candidate.workspaceBinding};
    const context = await resolveContext(workspaceKey, contextId, identity.workspaceBinding, readOnly);
    const {system_id:systemId, data_source_id:dataSourceId, source_alias_id:alias, fun_id:funId} = identity;
    const isPage = identity.source_table === 'page';
    if (candidate.workspaceKey !== workspaceKey || identity.workspaceKey !== workspaceKey
        || candidate.reviewId !== reviewId || candidate.sourceHash !== expectedHash || identity.source_id !== sourceId
        || !systemId
        || ((!readOnly || candidate.pageOrigins.length) && !candidate.pageOrigins.includes(context.pageOrigin))
        || (!readOnly && (context.pageOrigin !== native?.origin || native.systemId !== systemId))) {
      throw new Error('平台、系统或源码与本地审阅不一致');
    }
    let target;
    if (isPage) {
      if (!/^PG-[A-Za-z0-9-]{1,96}$/.test(sourceId) || !candidate.pageType
          || (!readOnly && (native.pageId !== sourceId || native.pageAlias !== alias || native.pageType !== candidate.pageType))) {
        throw new Error('平台 PAGE 与本地审阅不一致');
      }
      target = {origin:context.pageOrigin, systemId, pageId:sourceId, pageAlias:alias, pageType:candidate.pageType, sourceId};
    } else {
      if (identity.source_table !== 'procedure' || !dataSourceId
          || (!readOnly && (native.dataSourceId !== dataSourceId || native.procedureAlias !== alias || native.funId !== funId
          || !/^PR-[A-Za-z0-9-]{1,96}$/.test(native.procedureId || '')))) {
        throw new Error('平台过程、函数或数据源与本地审阅不一致');
      }
      target = {origin:context.pageOrigin, systemId, dataSourceId, procedureAlias:alias, funId,
        ...(readOnly ? {} : {procedureId:native.procedureId}), sourceId};
    }
    await authorizeTarget(workspaceKey, target, identity.workspaceBinding);
    return {approval, candidate, identity, context, target};
  }

  function checkReadback(target, actual) {
    if (typeof actual?.version !== 'string' || !actual.version || actual.version.length > 128
        || Object.keys(target).filter(key => key !== 'sourceId').some(key => target[key] !== actual[key])) {
      throw new Error('谷神返回的对象身份或版本与上传目标不符。请核对当前项目和源码对象。');
    }
    if (target.pageId && actual.canSave !== true) {
      throw new Error('谷神页面设计器里还有未保存的编辑。请先处理设计器中的草稿，再同步并审阅。');
    }
    if (!target.pageId && !/^PR-[A-Za-z0-9-]{1,96}$/.test(actual.procedureId || '')) {
      throw new Error('谷神未返回可核对的父过程 ID');
    }
    if (typeof actual.content !== 'string'
        || Buffer.byteLength(actual.content) > (target.pageId ? MAX_PAGE_BYTES : 196608)) {
      throw new Error('谷神回读源码为空或超过审阅大小限制');
    }
  }

  async function mergeReview(approval, candidate, target, actual) {
    const {merge} = await confirmCandidate(candidate.workspaceKey, {...approval, mergeSource:actual.content});
    const actualHash = sourceHash(target, actual.content);
    const mirrorMatches = actualHash === sourceHash(target, candidate.baseContent);
    if (merge?.state !== 'READY') {
      return merge?.state === 'NO_BASELINE' && mirrorMatches ? undefined : merge;
    }
    const mergedHash = sourceHash(target, merge.content);
    if (mergedHash === actualHash) return {state:'ALREADY_CURRENT', baseVersion:merge.baseVersion};
    if (mirrorMatches && mergedHash === sourceHash(target, candidate.content)) return undefined;
    const reviewId = createHash('sha256').update(JSON.stringify([
      approval.reviewId, merge.baseHash, actualHash, mergedHash,
    ])).digest('hex');
    return {...merge, reviewId};
  }

  return {
    async inspectSource(input) {
      const {approval, candidate, context, target} = await reviewedTarget(input, true);
      const actual = await browserRequest(context, 'read', target);
      checkReadback(target, actual);
      const native = {...target, ...(target.pageId ? {} : {procedureId:actual.procedureId}), version:actual.version};
      const merge = input.threeWay === true && candidate.compareMirror
        ? await mergeReview(approval, candidate, native, actual) : undefined;
      const mirrorMatches = sourceHash(target, actual.content) === sourceHash(target, candidate.baseContent);
      if (merge || mirrorMatches) {
        return {...native, ...(merge ? {merge} : {}), ...(!mirrorMatches ? {latestContent:actual.content} : {})};
      }
      if (input.includeLatest === true) return {...native, latestContent:actual.content};
      throw new Error(`谷神上的${target.pageId ? '页面' : '函数'}与本地只读源码不同。请在 Nexus 右键「同步此节点源码」，合并修改后再上传。`);
    },
    async submit(input) {
      const {workspaceKey, contextId, reviewId, native, confirmationId, mergeReviewId} = input;
      if (confirmationId !== undefined && (typeof confirmationId !== 'string'
          || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(confirmationId))) {
          throw new Error('DATABASE 上传需要有效的确认标识');
      }
      const {approval, candidate, identity, context, target} = await reviewedTarget(input);
      const operationId = createHash('sha256').update(JSON.stringify(
        [workspaceKey, reviewId, target, native.version, ...(confirmationId ? [confirmationId] : []),
          ...(mergeReviewId === undefined ? [] : [mergeReviewId])])).digest('hex');
      const journal = journalFor(context, async () => {
        await resolveContext(workspaceKey, contextId, identity.workspaceBinding);
        await confirmCandidate(workspaceKey, approval);
      });
      let {baseContent, content} = candidate;
      if (mergeReviewId !== undefined) {
        if (!candidate.compareMirror || typeof mergeReviewId !== 'string' || !/^[a-f0-9]{64}$/.test(mergeReviewId)) {
          throw new Error('DATABASE 上传需要有效的三方合并审阅标识');
        }
        const recorded = journal.find(workspaceKey, operationId);
        if (recorded) return recorded;
        const actual = await browserRequest(context, 'read', target);
        checkReadback(target, actual);
        const merge = await mergeReview(approval, candidate, target, actual);
        if (merge?.state !== 'READY' || merge.reviewId !== mergeReviewId) {
          throw new Error('谷神源码或合并结果已变化，请重新审阅三方合并');
        }
        baseContent = actual.content;
        content = merge.content;
      }
      return journal.publish({workspaceKey, operationId, target, databaseIdentity:identity,
        databaseBaseVersion:candidate.databaseBaseVersion, expectedVersion:native.version,
        expectedContent:baseContent, content, mergedWorkcopy:mergeReviewId !== undefined,
        reviewedWorkcopyHash:candidate.compareMirror ? candidate.sourceHash : undefined});
    },
    list(workspaceKey) {
      return journalFor().list(workspaceKey);
    },
    async verify(workspaceKey, contextId, operationId, closeUnchanged = false) {
      const journal = journalFor();
      const record = journal.status(workspaceKey, operationId);
      if (record.state !== 'PLATFORM_UNKNOWN') {
        await assertDatabaseWorkspace(workspaceKey, undefined, record.databaseIdentity.workspaceBinding);
        return journal.verify(workspaceKey, operationId, closeUnchanged);
      }
      const context = await resolveContext(workspaceKey, contextId, record.databaseIdentity.workspaceBinding);
      if (context.pageOrigin !== record.target.origin) {
        throw new Error('核验页签与原发布操作不一致');
      }
      await authorizeTarget(workspaceKey, record.target, record.databaseIdentity.workspaceBinding);
      return journalFor(context).verify(workspaceKey, operationId, closeUnchanged);
    },
  };
}

function publicationStatus(record) {
  const {workspaceKey, operationId, state, reason, originalOperationId, platformVersion, platformCode, target, workcopyState, platformDiffers} = record;
  return {workspaceKey, operationId, state, reason, originalOperationId, platformVersion, platformCode, workcopyState, platformDiffers,
    ...(record.reviewedVersion ? {saveBaseVersion:record.expectedVersion} : {}),
    target: {origin:target.origin, systemId:target.systemId, dataSourceId:target.dataSourceId,
      procedureId:target.procedureId, procedureAlias:target.procedureAlias, funId:target.funId,
      pageId:target.pageId, pageAlias:target.pageAlias, pageType:target.pageType}};
}

module.exports = {createDatabasePublication, publicationStatus};
