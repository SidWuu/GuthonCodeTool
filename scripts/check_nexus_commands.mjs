#!/usr/bin/env node
// Verify public command registration and CLI/Node protocol references.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const plugin=path.join(root,'plugins/GuthonNexus/gushen-vscode-completion');
const manifest=JSON.parse(fs.readFileSync(path.join(plugin,'package.json'),'utf8'));
const metadata=JSON.parse(fs.readFileSync(path.join(root,'scripts/common/command_metadata.json'),'utf8'));
const sources=[];
function walk(directory) {
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
  const file=path.join(directory,entry.name);
  if(entry.isDirectory())walk(file);else if(entry.isFile() && entry.name.endsWith('.js'))sources.push(fs.readFileSync(file,'utf8'));
 }
}
walk(path.join(plugin,'src'));
const registered=new Set(sources.flatMap(source=>[...source.matchAll(/registerCommand\(\s*['"]([^'"]+)['"]/g)].map(match=>match[1])));
for(const source of sources) {
 for(const match of source.matchAll(/\[((?:\s*[\'"\'][^\'"\']+[\'"\']\s*,?)+)\]\.map\(\(?\s*(\w+)\s*\)?\s*=>\s*vscode\.commands\.registerCommand\(\s*`([^`]+)`/g)) {
  const placeholder='${'+match[2]+'}';
  const values=[...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(value=>value[1]);
  if(!values.length || !match[3].includes(placeholder))continue;
  for(const value of values)registered.add(match[3].replace(placeholder,value));
 }
}
const contributed=manifest.contributes.commands.map(item=>item.command);
if(new Set(contributed).size!==contributed.length)throw new Error('Duplicate contributed Nexus commands');
const errors=[];
for(const command of contributed)if(!registered.has(command))errors.push('Contributed command has no registration: '+command);
for(const event of manifest.activationEvents||[])if(event.startsWith('onCommand:')&&!registered.has(event.slice(10)))errors.push('Stale command activation: '+event);
for(const [menu,items] of Object.entries(manifest.contributes.menus||{})) {
 for(const item of items)if(item.command?.startsWith('gushenCompletion.') && !registered.has(item.command))errors.push(`Stale ${menu} menu command: ${item.command}`);
}
const extension=fs.readFileSync(path.join(plugin,'src/extension.js'),'utf8');
const tools=/const TOOL_COMMANDS = \{([\s\S]*?)\n\};/.exec(extension);
if(!tools)throw new Error('Nexus TOOL_COMMANDS authority was not found');
for(const match of tools[1].matchAll(/\b\w+:\s*['"]([^'"]+)['"]/g))if(!Object.hasOwn(metadata.commands,match[1]))errors.push('Tool command has no CLI protocol metadata: '+match[1]);
const generated=fs.readFileSync(path.join(plugin,'data/tool-command-metadata.json'));
if(!generated.equals(fs.readFileSync(path.join(root,'scripts/common/command_metadata.json'))))errors.push('Generated command metadata differs from authority');
if(errors.length)throw new Error(errors.join('\n'));
console.log(`Nexus commands: ${contributed.length} contributions, registrations, activation and menus consistent`);
