const {createHash} = require('node:crypto');
const {createDatabasePublishJournal} = require('./database-source-publish');

function createDatabasePublication(directory, { resolveContext, assertDatabaseWorkspace, confirmCandidate, browserRequest, refreshMirror }) {
  const journalFor = (context, recheckCandidate) => createDatabasePublishJournal(directory, {
    async readPlatform(target, evidence) {
      const actual = await browserRequest(context, 'read', target, evidence);
      if (!evidence) await recheckCandidate();
      return actual;
    },
    savePlatform: (target, evidence) => browserRequest(context, 'save', target, evidence),
    refreshMirror,
  });

  return {
    async submit(input) {
      const {workspaceKey, contextId, recordId, sourceId, sourcePath, reviewId, sourceHash, native} = input;
      const context = await resolveContext(workspaceKey, contextId);
      const approval = {recordId, sourceId, sourcePath, reviewId, sourceHash};
      const candidate = await confirmCandidate(workspaceKey, approval);
      const identity = {...candidate.databaseIdentity, workspaceBinding:candidate.workspaceBinding};
      const {system_id:systemId, data_source_id:dataSourceId, source_alias_id:procedureAlias, fun_id:funId} = identity;
      if (candidate.workspaceKey !== workspaceKey || identity.workspaceKey !== workspaceKey
          || candidate.reviewId !== reviewId || candidate.sourceHash !== sourceHash
          || identity.source_table !== 'procedure' || identity.source_id !== sourceId
          || !systemId || context.pageOrigin !== native?.origin || !candidate.pageOrigins.includes(native.origin)
          || context.systemId !== systemId || native.systemId !== systemId
          || context.dataSourceId !== dataSourceId || native.dataSourceId !== dataSourceId
          || native.procedureAlias !== procedureAlias || native.funId !== funId
          || !/^PR-[A-Za-z0-9-]{1,96}$/.test(native.procedureId || '')) {
        throw new Error('平台过程、函数或数据源与本地审阅不一致');
      }
      const target = {origin:context.pageOrigin, systemId, dataSourceId, procedureAlias, funId,
        procedureId:native.procedureId, sourceId};
      const operationId = createHash('sha256').update(JSON.stringify(
        [workspaceKey, reviewId, target, native.version])).digest('hex');
      return journalFor(context, async () => {
        await resolveContext(workspaceKey, contextId);
        await confirmCandidate(workspaceKey, approval);
      }).publish({workspaceKey, operationId, target, databaseIdentity:identity,
        databaseBaseVersion:candidate.databaseBaseVersion, expectedVersion:native.version,
        expectedContent:candidate.baseContent, content:candidate.content});
    },
    list(workspaceKey) {
      return journalFor().list(workspaceKey);
    },
    async verify(workspaceKey, contextId, operationId) {
      const journal = journalFor();
      const record = journal.status(workspaceKey, operationId);
      if (record.state !== 'PLATFORM_UNKNOWN') {
        await assertDatabaseWorkspace(workspaceKey, undefined, record.databaseIdentity.workspaceBinding);
        return journal.verify(workspaceKey, operationId);
      }
      const context = await resolveContext(workspaceKey, contextId, record.databaseIdentity.workspaceBinding);
      const {origin, systemId, dataSourceId} = record.target;
      if (context.pageOrigin !== origin || context.systemId !== systemId || context.dataSourceId !== dataSourceId) {
        throw new Error('核验页签与原发布操作不一致');
      }
      return journalFor(context).verify(workspaceKey, operationId);
    },
  };
}

function publicationStatus(record) {
  const {workspaceKey, operationId, state, reason, originalOperationId, platformVersion, target, workcopyState} = record;
  return {workspaceKey, operationId, state, reason, originalOperationId, platformVersion, workcopyState,
    target: {origin:target.origin, systemId:target.systemId, dataSourceId:target.dataSourceId,
      procedureId:target.procedureId, procedureAlias:target.procedureAlias, funId:target.funId}};
}

module.exports = {createDatabasePublication, publicationStatus};
