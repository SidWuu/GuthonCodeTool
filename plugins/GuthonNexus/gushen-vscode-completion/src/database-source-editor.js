const path=require('node:path');
const {documentFilename}=require('./source/virtual-fs');

const SCHEME='guthon-database-edit';
const fragmentTypesByLanguage=new Map([
  ['guthon-gss','gss'],['javascript','js'],['sql','sql'],['json','json'],
]);
const documentKey=(workspaceKey,query)=>`${workspaceKey}?${query}`;

class DatabaseSourceEditor {
  constructor({vscode,request,getTool,beforeSave,onSave}) {
    Object.assign(this,{vscode,request,getTool,beforeSave});
    this.documents=new Map();
    this.change=new vscode.EventEmitter();
    this.onDidChangeFile=this.change.event;
    this.decorations=typeof vscode.window.createTextEditorDecorationType==='function' ? Object.fromEntries(
      [['insert','added'],['replace','modified'],['delete','deleted']].map(([kind,color])=>{
        const themeColor=new vscode.ThemeColor(`editorGutter.${color}Background`);
        return [kind,vscode.window.createTextEditorDecorationType({isWholeLine:true,borderColor:themeColor,
          borderStyle:'solid',borderWidth:kind==='delete'?'2px 0 0':'0 0 0 3px',overviewRulerColor:themeColor})];
      })) : null;
    this.listeners=[
      vscode.workspace.onDidCloseTextDocument?.(doc=>{
        if(this.findDocument(doc.uri))this.documents.delete(documentKey(doc.uri.authority,doc.uri.query));
      }),
      vscode.workspace.onDidSaveTextDocument?.(doc=>{
        const record=this.findDocument(doc.uri);
        if(record)void onSave(doc.uri,record.identity);
      }),
      vscode.window.onDidChangeVisibleTextEditors?.(editors=>editors.forEach(editor=>this.highlight(editor))),
      vscode.workspace.onDidChangeTextDocument?.(({document})=>{
        if(document.uri.scheme===SCHEME) this.highlightVisible(document.uri.toString());
      }),
    ].filter(Boolean);
  }
  highlight(editor) {
    if(!this.decorations || !editor?.setDecorations || editor.document.uri.scheme!==SCHEME)return;
    const document=editor.document;
    const record=this.findDocument(document.uri);
    const value=record?.value;
    const visibleChanges=record?.home===this.getTool()?.toolHome && value && !document.isDirty
      && document.getText().replace(/\r\n?/g,'\n')===value.content.replace(/\r\n?/g,'\n') ? value.lineChanges || [] : [];
    const ranges={insert:[],replace:[],delete:[]};
    for(const {kind,start,end} of visibleChanges) {
      const first=Math.min(start,document.lineCount-1);
      const last=kind==='delete' ? first : Math.min(end-1,document.lineCount-1);
      ranges[kind].push(new this.vscode.Range(first,0,last,0));
    }
    for(const [kind,decoration] of Object.entries(this.decorations)) editor.setDecorations(decoration,ranges[kind]);
  }
  highlightVisible(key) {
    for(const editor of this.vscode.window.visibleTextEditors || []) {
      if(editor.document.uri.toString()===key) this.highlight(editor);
    }
  }
  read(identity) {
    return this.request(identity,'edit-read',{pointer:identity.jsonPointer || '',includeLineChanges:true,
      ...(identity.formatPage ? {formatPage:true} : {})});
  }
  async refresh(workspaceKey,paths,onError) {
    const dirty=key=>(this.vscode.workspace.textDocuments || []).some(doc=>doc.isDirty && doc.uri.toString()===key);
    await Promise.all([...this.documents].map(async ([key,record])=>{
      if(record.identity.workspaceKey!==workspaceKey || record.home!==this.getTool()?.toolHome
        || !paths.has(record.identity.sourcePath) || !record.value || record.saving)return;
      const uriKey=record.uri.toString();
      if(dirty(uriKey))return;
      const before=record.value;
      const read=this.read(record.identity);
      record.refresh=read;
      const current=()=>this.documents.get(key)===record && record.refresh===read && record.value===before && !record.saving && !dirty(uriKey);
      try {
        const fresh=await read;
        if(!current())return;
        record.value=fresh;
        if(fresh.content!==before.content || fresh.editable!==before.editable) {
          record.mtime=Date.now();
          this.change.fire([{type:this.vscode.FileChangeType.Changed,uri:record.uri}]);
        }
      } catch(error) {
        if(!current())return;
        record.value={...before,lineChanges:[]};
        onError(error);
      }
      this.highlightVisible(uriKey);
    }));
  }
  findDocument(uri) {
    if(uri.scheme!==SCHEME)return;
    const record=this.documents.get(documentKey(uri.authority,uri.query));
    if(record?.uri?.toString()===uri.toString())return record;
  }
  record(uri) {
    const value=this.findDocument(uri);
    if(!value)throw this.vscode.FileSystemError.FileNotFound(uri);
    if(value.home!==this.getTool()?.toolHome)throw new Error('本地数据目录已切换，请重新打开源码');
    return value;
  }
  owns(identity,document) {
    const record=this.findDocument(document.uri);
    return record?.identity.workspaceKey===identity.workspaceKey && record.identity.sourcePath===identity.sourcePath;
  }
  async uriFor(identity) {
    const home=this.getTool()?.toolHome;
    const {workspaceKey,sourcePath,jsonPointer}=identity;
    const query=new URLSearchParams({home,sourcePath,pointer:jsonPointer || ''}).toString();
    const documentQuery=identity.formatPage ? query + '&formatPage=1' : query;
    const key=documentKey(workspaceKey,documentQuery);
    const existing=this.documents.get(key);
    if(existing)return existing.loading;
    const record={identity,home};
    record.loading=this.read(identity).then(value=>{
      const fragmentType=fragmentTypesByLanguage.get(value.language);
      if(!fragmentType)throw new Error('无法识别 DATABASE 源码语言');
      const filename=documentFilename({...identity,fragmentType});
      record.uri=this.vscode.Uri.from({scheme:SCHEME,authority:workspaceKey,path:`/${filename}`,query:documentQuery});
      record.value=value;
      return record.uri;
    }).catch(error=>{
      this.documents.delete(key);
      throw error;
    });
    this.documents.set(key,record);
    return record.loading;
  }
  async open(identity,options={}) {
    const uri=await this.uriFor(identity);
    const document=await this.vscode.workspace.openTextDocument(uri);
    const line=Number.isInteger(options.lineNumber) && options.lineNumber>0
      ? Math.min(options.lineNumber-1,document.lineCount-1) : -1;
    const editor=await this.vscode.window.showTextDocument(document,{preview:false,viewColumn:options.viewColumn,
      ...(line>=0?{selection:new this.vscode.Range(line,0,line,0)}:{})});
    this.highlight(editor);
    return uri;
  }
  async readFile(uri) {
    return Buffer.from(this.record(uri).value.content,'utf8');
  }
  async stat(uri) {
    const record=this.record(uri);
    const value=record.value;
    return {type:this.vscode.FileType.File,ctime:0,mtime:record.mtime || 0,size:Buffer.byteLength(value.content),
      ...(value.editable?{}:{permissions:this.vscode.FilePermission.Readonly})};
  }
  async writeFile(uri,bytes) {
    const record=this.record(uri);
    const value=record.value;
    if(!value.editable)throw this.vscode.FileSystemError.NoPermissions(uri);
    this.beforeSave(uri,record.identity,value.workcopyPath);
    const content=Buffer.from(bytes).toString('utf8');
    record.saving=true;
    try {
      const saved=await this.request(record.identity,'edit-save',{pointer:record.identity.jsonPointer || '',
        sourceHash:value.sourceHash,content});
      record.value={...value,...saved,content,lineChanges:[]};
    } finally {
      record.saving=false;
    }
    record.mtime=Date.now();
    this.change.fire([{type:this.vscode.FileChangeType.Changed,uri}]);
  }
  watch(){return {dispose(){}};}
  readDirectory(){throw this.vscode.FileSystemError.FileNotADirectory();}
  createDirectory(){throw this.vscode.FileSystemError.NoPermissions();}
  delete(){throw this.vscode.FileSystemError.NoPermissions();}
  rename(){throw this.vscode.FileSystemError.NoPermissions();}
  dispose(){
    for(const listener of this.listeners)listener.dispose();
    for(const decoration of Object.values(this.decorations || {}))decoration.dispose();
    this.change.dispose();this.documents.clear();
  }
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
