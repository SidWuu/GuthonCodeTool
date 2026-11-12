// Parse only literal objects, arrays and strings. No JavaScript is evaluated.
function parseLiteral(source,start) {
  let pos=start, nodes=0;
  const ws=()=>{while(/\s/.test(source[pos] || '') && pos<source.length) pos++;};
  function string() {
    const quote=source[pos++];let out='';
    while(pos<source.length) {
      let c=source[pos++];if(c===quote) return out;
      if(quote==='`' && c==='$' && source[pos]==='{') throw new Error('模板包含表达式');
      if(c!=='\\') {out+=c;continue;}
      c=source[pos++];
      const simple={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','0':'\0'};
      if(c==='u' || c==='x') {
        const length=c==='u'?4:2, digits=source.slice(pos,pos+length);
        if(!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) throw new Error('字符串转义无效');
        out+=String.fromCharCode(parseInt(digits,16));pos+=length;
      } else if(c==='\n') {} else if(c==='\r') {if(source[pos]==='\n') pos++;}
      else out+=simple[c] ?? c;
    }
    throw new Error('字符串未结束');
  }
  function value(depth=0) {
    if(++nodes>100000 || depth>20) throw new Error('静态数据过大');
    ws();const c=source[pos];
    if(c==='"' || c==="'" || c==='`') return string();
    if(c==='{' || c==='[') {
      pos++;const obj=c==='{'?Object.create(null):[];const close=c==='{'?'}':']';ws();
      while(source[pos]!==close) {
        if(pos>=source.length) throw new Error('静态数据未结束');
        if(c==='{') {
          ws();let key;
          if(source[pos]==='"' || source[pos]==="'") key=string();
          else {const m=/^[A-Za-z_$][\w$]*/.exec(source.slice(pos));if(!m) throw new Error('属性名无效');key=m[0];pos+=key.length;}
          if(Object.hasOwn(obj,key)) throw new Error('属性重复');ws();if(source[pos++]!==':') throw new Error('属性缺少值');obj[key]=value(depth+1);
        } else obj.push(value(depth+1));
        ws();if(source[pos]===','){pos++;ws();}else if(source[pos]!==close) throw new Error('缺少分隔符');
      }
      pos++;return obj;
    }
    throw new Error('静态数据包含非字面量');
  }
  return value();
}
function extractCatalog(bundle,source) {
  const pattern=/(?:var|let|const)\s+[\w$]+\s*=\s*(?=\{\s*util\s*:\s*\{\s*fullName\s*:\s*["']\$vs\.util["'])/g;
  const matches=[...bundle.matchAll(pattern)];
  if(matches.length!==1) throw new Error('无法唯一识别官方 API 静态数据');
  const modules=parseLiteral(bundle,matches[0].index+matches[0][0].length);
  for(const [name,module] of Object.entries(modules)) {
    if(!/^[\w$.]+$/.test(name) || module.fullName!==`$vs.${name}` || typeof module.description!=='string' || !Array.isArray(module.functions)) throw new Error('官方 API 模块结构变化');
    for(const fn of module.functions) if(typeof fn.label!=='string' || typeof fn.name!=='string' || typeof fn.doc!=='string' || !Array.isArray(fn.params) || fn.params.some(p=>typeof p.text!=='string'||typeof p.varName!=='string')) throw new Error('官方 API 函数结构变化');
  }
  return {schemaVersion:1,source,modules};
}
module.exports={extractCatalog,parseLiteral};
