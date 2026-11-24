const path=require('node:path');
const {documentFilename}=require('./source/virtual-fs');

const SCHEME='guthon-database-edit';

class DatabaseSourceEditor {
  constructor({vscode,request,getTool,beforeSave,onSave}) {
    Object.assign(this,{vscode,request,getTool,beforeSave});
    this.documents=new Map();
    this.change=new vscode.EventEmitter();
    this.onDidChangeFile=this.change.event;
    this.closed=vscode.workspace.onDidCloseTextDocument?.(doc=>this.documents.delete(doc.uri.toString()));
    this.saved=vscode.workspace.onDidSaveTextDocument?.(doc=>{
      if(this.documents.has(doc.uri.toString()))void onSave(doc.uri);
    });
  }
  record(uri) {
    const value=this.documents.get(uri.toString());
    if(!value)throw this.vscode.FileSystemError.FileNotFound(uri);
    if(value.home!==this.getTool()?.toolHome)throw new Error('本地数据目录已切换，请重新打开源码');
    return value;
  }
  owns(identity,document) {
    const record=this.documents.get(document.uri.toString());
    return record?.identity.workspaceKey===identity.workspaceKey && record.identity.sourcePath===identity.sourcePath;
  }
  async uriFor(identity) {
    const fragmentType=identity.sourceType==='procedure'?'gss':identity.fragmentType || 'json';
    const filename=documentFilename({...identity,fragmentType});
    const home=this.getTool()?.toolHome;
    const query=new URLSearchParams({home,sourcePath:identity.sourcePath,pointer:identity.jsonPointer || ''}).toString();
    const uri=[...this.documents.values()].find(value=>value.uri.authority===identity.workspaceKey && value.uri.query===query)?.uri
      || this.vscode.Uri.from({scheme:SCHEME,authority:identity.workspaceKey,path:`/${filename}`,query});
    const key=uri.toString();
    if(!this.documents.has(key)) {
      const record={identity,home,uri,loading:this.request(identity,'edit-read',{pointer:identity.jsonPointer || ''})};
      this.documents.set(key,record);
      try {record.value=await record.loading;}
      catch(error) {this.documents.delete(key);throw error;}
    }
    return uri;
  }
  async open(identity,options={}) {
    const uri=await this.uriFor(identity);
    const document=await this.vscode.workspace.openTextDocument(uri);
    const line=Number.isInteger(options.lineNumber) && options.lineNumber>0
      ? Math.min(options.lineNumber-1,document.lineCount-1) : -1;
    await this.vscode.window.showTextDocument(document,{preview:false,viewColumn:options.viewColumn,
      ...(line>=0?{selection:new this.vscode.Range(line,0,line,0)}:{})});
    return uri;
  }
  async readFile(uri) {
    const record=this.record(uri);
    return Buffer.from((record.value || await record.loading).content,'utf8');
  }
  async stat(uri) {
    const record=this.record(uri);
    const value=record.value || await record.loading;
    return {type:this.vscode.FileType.File,ctime:0,mtime:record.mtime || 0,size:Buffer.byteLength(value.content),
      ...(value.editable?{}:{permissions:this.vscode.FilePermission.Readonly})};
  }
  async writeFile(uri,bytes) {
    const record=this.record(uri);
    const value=record.value || await record.loading;
    if(!value.editable)throw this.vscode.FileSystemError.NoPermissions(uri);
    this.beforeSave(uri,record.identity,value.workcopyPath);
    const content=Buffer.from(bytes).toString('utf8');
    const saved=await this.request(record.identity,'edit-save',{pointer:record.identity.jsonPointer || '',
      sourceHash:value.sourceHash,content});
    record.value={...value,...saved,content};
    record.mtime=Date.now();
    this.change.fire([{type:this.vscode.FileChangeType.Changed,uri}]);
  }
  watch(){return {dispose(){}};}
  readDirectory(){throw this.vscode.FileSystemError.FileNotADirectory();}
  createDirectory(){throw this.vscode.FileSystemError.NoPermissions();}
  delete(){throw this.vscode.FileSystemError.NoPermissions();}
  rename(){throw this.vscode.FileSystemError.NoPermissions();}
  dispose(){this.closed?.dispose();this.saved?.dispose();this.change.dispose();this.documents.clear();}
}

function databaseEditIdentity(workspace,item,home) {
  return {workspaceKey:workspace.workspaceKey,root:workspace.root,sourcePath:item.record.sourcePath,
    sourceId:item.record.sourceId,sourceType:item.record.sourceType,sourceName:item.record.name,
    recordId:item.record.recordId,documentName:item.label || item.record.name || item.record.funId,
    sourceMode:'database',home,workcopyDir:workspace.workcopyDir};
}

function ownsWorkcopyDocument(workspace,identity,document) {
  return document.uri.scheme==='file'
    && path.resolve(document.uri.fsPath)===path.resolve(workspace.workcopyDir,identity.sourcePath);
}

module.exports={DatabaseSourceEditor,SCHEME,databaseEditIdentity,ownsWorkcopyDocument};
