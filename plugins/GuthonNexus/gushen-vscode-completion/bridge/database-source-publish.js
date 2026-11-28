const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isWorkspaceKey } = require('./page-context');

const sha256 = content => createHash('sha256').update(content).digest('hex');
const normalize = content => content.replaceAll('\r\n', '\n');
const identityFields = ['origin', 'systemId', 'dataSourceId', 'procedureId', 'procedureAlias', 'funId'];

function createDatabasePublishJournal(directory, { readPlatform, savePlatform, refreshMirror }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('发布记录目录不得为符号链接');

  function location(workspaceKey, id) {
    if (!isWorkspaceKey(workspaceKey) || !/^[a-f0-9]{64}$/.test(id)) {
      throw new Error('需要明确工作区和发布操作标识');
    }
    return path.join(directory, sha256(`${workspaceKey}\n${id}`) + '.json');
  }

  function read(file) {
    for (const name of [`${file}.verified`, `${file}.mirror`, `${file}.rejected`, file]) {
      try { return JSON.parse(fs.readFileSync(name, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT' || name === file) throw error; }
    }
  }

  function persist(file, record) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(record));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.linkSync(temporary, file);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return false;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  function verifyIdentity(target, current) {
    if (!current || identityFields.some(key => current[key] !== target[key])) {
      throw new Error('平台回读对象与审阅目标不一致');
    }
  }

  async function reconcile(file, record) {
    try {
      if (record.state === 'PLATFORM_UNKNOWN' && fs.existsSync(`${file}.evidence`)) {
        const proof = JSON.parse(fs.readFileSync(`${file}.evidence`, 'utf8'));
        persist(`${file}.mirror`, { ...record, state: 'MIRROR_PENDING', platformVersion: proof.version });
        record = read(file);
      }
      if (record.state === 'PLATFORM_UNKNOWN') {
        const actual = await readPlatform(record.target, { operationId: record.operationId });
        verifyIdentity(record.target, actual);
        if (!actual.version || actual.version === record.expectedVersion || typeof actual.content !== 'string'
            || sha256(normalize(actual.content)) !== record.candidateHash) return read(file);
        let accepted;
        try { accepted = JSON.parse(fs.readFileSync(`${file}.accepted`, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (accepted?.version ? actual.version !== accepted.version
          : accepted?.acknowledged !== true && actual.appliedOperationId !== record.operationId) return read(file);
        persist(`${file}.evidence`, { version: actual.version, content: actual.content });
        const proof = JSON.parse(fs.readFileSync(`${file}.evidence`, 'utf8'));
        persist(`${file}.mirror`, { ...record, state: 'MIRROR_PENDING', platformVersion: proof.version });
        record = read(file);
      }
      if (record.state === 'VERIFIED') return record;
      const proof = JSON.parse(fs.readFileSync(`${file}.evidence`, 'utf8'));
      if (proof.version !== record.platformVersion || sha256(normalize(proof.content)) !== record.candidateHash) {
        throw new Error('发布回读证据不一致');
      }
      const mirror = await refreshMirror(record.target, {
        workspaceKey: record.workspaceKey, operationId: record.operationId,
        baseVersion: record.databaseBaseVersion, version: proof.version, content: proof.content,
        ...(record.databaseIdentity ? {databaseIdentity:record.databaseIdentity} : {}),
      });
      if (!mirror.verified) return { ...read(file), ...(mirror.reason ? {reason:mirror.reason} : {}) };
      persist(`${file}.verified`, { ...record, state: 'VERIFIED',
        ...(mirror.workcopyState ? {workcopyState:mirror.workcopyState} : {}) });
    } catch {
      return read(file);
    }
    return read(file);
  }

  return {
    async publish({ workspaceKey, operationId, target: requested, databaseIdentity, databaseBaseVersion, expectedVersion, expectedContent, content }) {
      const file = location(workspaceKey, operationId);
      const target = Object.fromEntries([...identityFields, 'sourceId'].map(key => [key, requested?.[key]]));
      if (Object.values(target).some(value => typeof value !== 'string' || !value || value.length > 256)
          || [databaseBaseVersion, expectedVersion].some(value => typeof value !== 'string' || !value || value.length > 128)
          || [expectedContent, content].some(value => typeof value !== 'string' || Buffer.byteLength(value) > 196608)) {
        throw new Error('过程函数发布需要明确目标、版本及有界正文');
      }
      const origin = new URL(target.origin);
      if (origin.origin !== target.origin || !['https:', 'http:'].includes(origin.protocol)) {
        throw new Error('发布来源必须是规范的平台 origin');
      }
      const candidateHash = sha256(normalize(content));
      const expectedHash = sha256(normalize(expectedContent));
      if (candidateHash === expectedHash) throw new Error('没有需要上传的源码改动');
      const fingerprint = sha256(JSON.stringify([target, databaseIdentity, databaseBaseVersion, expectedVersion, expectedHash, candidateHash]));
      const existing = () => {
        const saved = read(file);
        if (saved.fingerprint !== fingerprint) throw new Error('该发布标识已绑定其他候选或目标');
        return saved;
      };
      if (fs.existsSync(file)) return existing();
      const before = await readPlatform(target);
      verifyIdentity(target, before);
      const admissible = before.canSave === true && before.version === expectedVersion && sha256(normalize(before.content)) === expectedHash;
      const record = { workspaceKey, operationId, target, databaseBaseVersion, expectedVersion, candidateHash, fingerprint,
        state: admissible ? 'PLATFORM_UNKNOWN' : 'NOT_WRITTEN',
        ...(databaseIdentity ? {databaseIdentity} : {}),
        ...(!admissible ? {reason:'PLATFORM_BASE_CHANGED_OR_READONLY'} : {}) };
      if (!persist(file, record)) return existing();
      if (!admissible) return record;
      const slot = path.join(directory, `procedure-${sha256(JSON.stringify([
        target.origin, target.dataSourceId, target.procedureId, target.funId, expectedVersion,
      ]))}.reservation`);
      persist(slot, { workspaceKey, operationId, fingerprint });
      const owner = read(slot);
      if (owner.workspaceKey !== workspaceKey || owner.operationId !== operationId || owner.fingerprint !== fingerprint) {
        const blocked = {...record, state:'NOT_WRITTEN', reason:'VERSION_RESERVED',
          ...(owner.workspaceKey === workspaceKey ? {originalOperationId:owner.operationId} : {})};
        persist(`${file}.rejected`, blocked);
        return read(file);
      }
      if (!persist(`${file}.dispatch`, {operationId})) return existing();
      try {
        const receipt = await savePlatform(target, { operationId, expectedVersion, content: normalize(content) });
        if (receipt?.operationId === operationId) {
          if (['CHECKOUT_REQUIRED','PLATFORM_VERSION_CHANGED'].includes(receipt.rejected)) {
            persist(`${file}.rejected`, {...record,state:'NOT_WRITTEN',reason:receipt.rejected});
            return read(file);
          }
          if (typeof receipt.version === 'string' && receipt.version && receipt.version !== expectedVersion) {
            persist(`${file}.accepted`, {version:receipt.version});
          } else if (receipt.acknowledged === true) {
            persist(`${file}.accepted`, {acknowledged:true});
          }
        }
      } catch {
        return read(file);
      }
      return reconcile(file, record);
    },
    status(workspaceKey, operationId) {
      return read(location(workspaceKey, operationId));
    },
    list(workspaceKey) {
      if (!isWorkspaceKey(workspaceKey)) throw new Error('必须指定有效 workspaceKey');
      return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
        .map(name => read(path.join(directory, name))).filter(record => record.workspaceKey === workspaceKey);
    },
    async verify(workspaceKey, operationId) {
      const file = location(workspaceKey, operationId);
      const record = read(file);
      if (['NOT_WRITTEN', 'VERIFIED'].includes(record.state)) return record;
      // There is no asynchronous step between persisting the record and its
      // dispatch marker. A missing marker here proves the adapter was never called.
      if (!fs.existsSync(`${file}.dispatch`)) {
        persist(`${file}.rejected`, {...record, state:'NOT_WRITTEN', reason:'DISPATCH_NOT_RECORDED'});
        return read(file);
      }
      return reconcile(file, record);
    },
  };
}

module.exports = { createDatabasePublishJournal };
