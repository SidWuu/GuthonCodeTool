const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isWorkspaceKey } = require('./page-context');

const sha256 = content => createHash('sha256').update(content).digest('hex');
const pageFields = ['origin', 'systemId', 'pageId', 'pageAlias', 'pageType'];
const procedureFields = ['origin', 'systemId', 'dataSourceId', 'procedureId', 'procedureAlias', 'funId'];
const identityFields = target => target?.pageId ? pageFields : procedureFields;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const procedureSaveBlockers = ['CHECKOUT_REQUIRED', 'CHECKED_OUT_BY_OTHER', 'PLATFORM_LOGIN_REQUIRED'];
const nativeRejections = [...procedureSaveBlockers, 'CHECKOUT_UNVERIFIED',
    'PLATFORM_VERSION_CHANGED', 'PLATFORM_CONTENT_CHANGED', 'PAGE_DRAFT_PENDING'];

const PAGE_HASH_VERSION = 2;
const PROCEDURE_HASH_VERSION = 2;
const bundledDefaults = path.join(__dirname, 'database-page-defaults.json');
const pageDefaultsFile = fs.existsSync(bundledDefaults) ? bundledDefaults
    : path.resolve(__dirname, '../../../scripts/common/database_page_defaults.json');
const pageDefaults = require(pageDefaultsFile);

function canonicalPage(value, pageAlias, includeDefaults, location = []) {
    if (Array.isArray(value)) {
        const items = [...location.slice(0, -1), `${location.at(-1)}[]`];
        return '[' + value.map(item => canonicalPage(item, pageAlias, includeDefaults, items)).join(',') + ']';
    }
    if (value && typeof value === 'object') {
        // The runtime hydrates model defaults that the DATABASE mirror omits.
        const defaults = !includeDefaults && (!location.length || location[0] === 'views')
            ? pageDefaults[location.slice(-2).join('/')] : undefined;
        return '{' + Object.keys(value).sort().filter(key =>
            !(value.tbId && value.fdId && ['scale', 'length'].includes(key) && value[key] === 0)
            && !(defaults && Object.hasOwn(defaults, key) && value[key] === defaults[key])
            && !(!includeDefaults && !location.length && key === 'pageAliasId' && pageAlias && value[key] === pageAlias)
        ).map(key => {
            const item = value[key];
            const normalized = value.pageId && key === 'pageType' && (typeof item === 'string' || Number.isInteger(item))
                ? String(item) : item;
            return JSON.stringify(key) + ':' + canonicalPage(normalized, pageAlias, includeDefaults, [...location, key]);
        }).join(',') + '}';
    }
    return JSON.stringify(typeof value === 'string' ? value.replaceAll('\r\n', '\n') : value);
}

function sourceHash(target, content, version = target.pageId ? PAGE_HASH_VERSION : PROCEDURE_HASH_VERSION) {
    if (target.pageId) return sha256(canonicalPage(JSON.parse(content), target.pageAlias, version === 1));
    if (version === 1) return sha256(content.replaceAll('\r\n', '\n'));
    // Match comparable_script in the DATABASE Workcopy and source database.
    const normalized = content.replace(/\r\n?/g, '\n');
    return sha256(normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized);
}

function publicationFingerprint({target, databaseIdentity, databaseBaseVersion, expectedVersion, reviewedVersion, candidateHash}, expectedHash) {
    return sha256(JSON.stringify([target, databaseIdentity, databaseBaseVersion, reviewedVersion ?? expectedVersion, expectedHash, candidateHash]));
}

function readbackHash(record, content) {
    return sourceHash(record.target, content, record.pageHashVersion ?? record.procedureHashVersion ?? 1);
}

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

  function savedReceipt(file) {
    try { return JSON.parse(fs.readFileSync(`${file}.accepted`, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  function statusWithReceipt(file, record = read(file)) {
    if (record.state !== 'PLATFORM_UNKNOWN') return record;
    const version = savedReceipt(file)?.version;
    return version ? {...record, platformVersion:version} : record;
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
    if (!current || identityFields(target).some(key => current[key] !== target[key])) {
      throw new Error('平台回读对象与审阅目标不一致');
    }
  }

  function reservationPath(target, expectedVersion) {
      const versionKey = target.pageId ? [target.origin, target.pageId, expectedVersion]
          : [target.origin, target.dataSourceId, target.procedureId, target.funId, expectedVersion];
      return path.join(directory, `${target.pageId ? 'page' : 'procedure'}-${sha256(JSON.stringify(versionKey))}.reservation`);
  }

  function recordUnwritten(file, record, detail) {
      persist(`${file}.rejected`, {...record, ...detail});
      const slot = reservationPath(record.target, record.expectedVersion);
      if (fs.existsSync(slot)) {
          const owner = read(slot);
          if (owner.workspaceKey === record.workspaceKey && owner.operationId === record.operationId
              && owner.fingerprint === record.fingerprint) fs.unlinkSync(slot);
      }
      return read(file);
  }

  async function reconcile(file, record, closeUnchanged = false) {
    try {
      if (record.state === 'PLATFORM_UNKNOWN') {
        if (!fs.existsSync(`${file}.evidence`)) {
          const actual = await readPlatform(record.target, { operationId: record.operationId });
          verifyIdentity(record.target, actual);
          const accepted = savedReceipt(file);
          const actualHash = typeof actual.content === 'string' ? readbackHash(record, actual.content) : '';
          if (!accepted && actual.version === record.expectedVersion && actualHash
              && publicationFingerprint(record, actualHash) === record.fingerprint) {
            if (fs.existsSync(`${file}.native-rejection`)) {
              const rejection = JSON.parse(fs.readFileSync(`${file}.native-rejection`, 'utf8'));
              return recordUnwritten(file, record, {state:'NOT_WRITTEN', reason:'PLATFORM_SAVE_REJECTED', ...rejection});
            }
            if (closeUnchanged) {
              return recordUnwritten(file, record, {state:'CLOSED_UNCHANGED', reason:'PLATFORM_BASE_UNCHANGED'});
            }
            return {...read(file), reason:'PLATFORM_BASE_UNCHANGED'};
          }
          if (closeUnchanged) throw new Error('谷神已返回保存回执，或源码与上传前不一致。请重新检查上传结果。');
          if (!actualHash || !actual.version || actual.version === record.expectedVersion) return statusWithReceipt(file);
          const provenByVersion = !!accepted?.version && actual.version === accepted.version;
          if (accepted?.version ? !provenByVersion
            : accepted?.acknowledged !== true && actual.appliedOperationId !== record.operationId) {
            return statusWithReceipt(file);
          }
          const differs = actualHash !== record.candidateHash;
          if (differs && !(record.target.pageId && provenByVersion)) return statusWithReceipt(file);
          persist(`${file}.evidence`, {version:actual.version, content:actual.content,
            ...(differs ? {contentHash:actualHash} : {})});
        } else if (closeUnchanged) {
          throw new Error('这次保存已有回读证据，请继续核对本地更新。');
        }
        const proof = JSON.parse(fs.readFileSync(`${file}.evidence`, 'utf8'));
        persist(`${file}.mirror`, {...record, state:'MIRROR_PENDING', platformVersion:proof.version,
          ...(proof.contentHash ? {platformDiffers:true} : {})});
        record = read(file);
      }
      if (record.state === 'VERIFIED' || record.state === 'SAVED_WITH_DIFFERENCES') return record;
      const proof = JSON.parse(fs.readFileSync(`${file}.evidence`, 'utf8'));
      const expectedHash = proof.contentHash ?? record.candidateHash;
      if (proof.version !== record.platformVersion || readbackHash(record, proof.content) !== expectedHash
          || (proof.contentHash && (!record.target.pageId || savedReceipt(file)?.version !== proof.version))) {
        throw new Error('发布回读证据不一致');
      }
      const mirror = await refreshMirror(record.target, {
        workspaceKey: record.workspaceKey, operationId: record.operationId,
        baseVersion: record.databaseBaseVersion, version: proof.version, content: proof.content,
        ...(record.databaseIdentity ? {databaseIdentity:record.databaseIdentity} : {}),
        ...(record.reviewedWorkcopyHash ? {reviewedWorkcopyHash:record.reviewedWorkcopyHash} : {}),
        ...(record.mergedWorkcopy ? {mergedWorkcopy:true, platformDiffers:!!record.platformDiffers} : {}),
      });
      if (!mirror.verified) return { ...read(file), ...(mirror.reason ? {reason:mirror.reason} : {}) };
      persist(`${file}.verified`, {...record, state:record.platformDiffers ? 'SAVED_WITH_DIFFERENCES' : 'VERIFIED',
        ...(mirror.workcopyState ? {workcopyState:mirror.workcopyState} : {}) });
    } catch (error) {
      if (closeUnchanged) throw error;
      return statusWithReceipt(file);
    }
    return read(file);
  }

  return {
    async publish({ workspaceKey, operationId, target: requested, databaseIdentity, databaseBaseVersion,
                    expectedVersion, expectedContent, content, reviewedWorkcopyHash, mergedWorkcopy }) {
      const file = location(workspaceKey, operationId);
      const target = Object.fromEntries([...identityFields(requested), 'sourceId'].map(key => [key, requested?.[key]]));
      const maxBytes = target.pageId ? MAX_PAGE_BYTES : 196608;
      if (Object.values(target).some(value => typeof value !== 'string' || !value || value.length > 256)
          || [databaseBaseVersion, expectedVersion].some(value => typeof value !== 'string' || !value || value.length > 128)
          || [expectedContent, content].some(value => typeof value !== 'string' || Buffer.byteLength(value) > maxBytes)) {
        throw new Error('源码上传需要明确目标、版本及符合大小限制的正文');
      }
      const origin = new URL(target.origin);
      if (origin.origin !== target.origin || !['https:', 'http:'].includes(origin.protocol)) {
        throw new Error('发布来源必须是规范的平台 origin');
      }
      const candidateHash = sourceHash(target, content);
      const expectedHash = sourceHash(target, expectedContent);
      const fingerprint = publicationFingerprint({target, databaseIdentity, databaseBaseVersion, expectedVersion, candidateHash}, expectedHash);
      const existing = () => {
        const saved = read(file);
        // Operations created before normalization still use their original hashes.
        const retryFingerprint = !saved.pageHashVersion && !saved.procedureHashVersion
            ? publicationFingerprint({target, databaseIdentity, databaseBaseVersion, expectedVersion,
                candidateHash:sourceHash(target, content, 1)}, sourceHash(target, expectedContent, 1))
            : fingerprint;
        if (saved.fingerprint !== retryFingerprint) throw new Error('该发布标识已绑定其他候选或目标');
        return saved;
      };
      if (fs.existsSync(file)) return existing();
      if (candidateHash === expectedHash) throw new Error('没有需要上传的源码改动');
      const before = await readPlatform(target);
      verifyIdentity(target, before);
      if (typeof before.version !== 'string' || !before.version || before.version.length > 128
          || typeof before.content !== 'string') throw new Error('谷神回读缺少可核对的版本或正文');
      let reason;
      if (sourceHash(target, before.content) !== expectedHash) {
          reason = before.version !== expectedVersion ? 'PLATFORM_VERSION_CHANGED' : 'PLATFORM_CONTENT_CHANGED';
      } else if (before.canSave !== true) {
          reason = target.pageId ? 'PAGE_DRAFT_PENDING'
              : procedureSaveBlockers.includes(before.blockedReason) ? before.blockedReason : 'CHECKOUT_REQUIRED';
      }
      const dispatchVersion = reason ? expectedVersion : before.version;
      const record = { workspaceKey, operationId, target, databaseBaseVersion, expectedVersion:dispatchVersion, candidateHash, fingerprint,
        state: reason ? 'NOT_WRITTEN' : 'PLATFORM_UNKNOWN',
        ...(dispatchVersion !== expectedVersion ? {reviewedVersion:expectedVersion} : {}),
        ...(target.pageId ? {pageHashVersion:PAGE_HASH_VERSION} : {procedureHashVersion:PROCEDURE_HASH_VERSION}),
        ...(databaseIdentity ? {databaseIdentity} : {}),
        ...(reviewedWorkcopyHash ? {reviewedWorkcopyHash} : {}),
        ...(mergedWorkcopy ? {mergedWorkcopy:true} : {}),
        ...(reason ? {reason} : {}) };
      if (!persist(file, record)) return existing();
      if (reason) return record;
      const slot = reservationPath(target, dispatchVersion);
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
        const receipt = await savePlatform(target, {
          operationId, expectedVersion:dispatchVersion, content: target.pageId ? content : content.replaceAll('\r\n', '\n'),
          ...(!target.pageId ? {expectedContent:before.content} : {}),
        });
        if (receipt?.operationId === operationId) {
          if (nativeRejections.includes(receipt.rejected)) {
            return recordUnwritten(file, record, {state:'NOT_WRITTEN', reason:receipt.rejected});
          }
          if (receipt.rejected === 'PLATFORM_SAVE_REJECTED') {
            persist(`${file}.native-rejection`,
                Number.isSafeInteger(receipt.platformCode) ? {platformCode:receipt.platformCode} : {});
          }
          if (typeof receipt.version === 'string' && receipt.version && receipt.version !== dispatchVersion) {
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
      return statusWithReceipt(location(workspaceKey, operationId));
    },
    find(workspaceKey, operationId) {
      const file = location(workspaceKey, operationId);
      return fs.existsSync(file) ? statusWithReceipt(file) : undefined;
    },
    list(workspaceKey) {
      if (!isWorkspaceKey(workspaceKey)) throw new Error('必须指定有效 workspaceKey');
      return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
        .flatMap(name => {
          const file = path.join(directory, name);
          const record = read(file);
          return record.workspaceKey === workspaceKey ? [statusWithReceipt(file, record)] : [];
        });
    },
    async verify(workspaceKey, operationId, closeUnchanged = false) {
      const file = location(workspaceKey, operationId);
      const record = read(file);
      if (['NOT_WRITTEN', 'VERIFIED', 'SAVED_WITH_DIFFERENCES', 'CLOSED_UNCHANGED'].includes(record.state)) return record;
      if (closeUnchanged && record.state !== 'PLATFORM_UNKNOWN') throw new Error('这次保存已有回执，请继续核对本地更新。');
      // There is no asynchronous step between persisting the record and its
      // dispatch marker. A missing marker here proves the adapter was never called.
      if (!fs.existsSync(`${file}.dispatch`)) {
        persist(`${file}.rejected`, {...record, state:'NOT_WRITTEN', reason:'DISPATCH_NOT_RECORDED'});
        return read(file);
      }
      return reconcile(file, record, closeUnchanged);
    },
  };
}

module.exports = { createDatabasePublishJournal, sourceHash, MAX_PAGE_BYTES, pageDefaultsFile };
