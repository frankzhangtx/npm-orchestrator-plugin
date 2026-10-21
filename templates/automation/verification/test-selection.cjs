"use strict";
// Conservative source-reference closure, not a claim of compiler-level impact
// analysis. Unsupported/dynamic inputs retain the approved module test matrix.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const crypto = require('node:crypto');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const {matchesPath} = require('./contract.cjs');
function git(root,args) {
 const r=cp.spawnSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:32*1024*1024});
 if(r.status!==0) throw new Error('source snapshot unavailable');
 return r.stdout;
}
function mask(text) {
 // Preserve offsets and newlines while removing comments and string bodies.
 return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
  s=>s.replace(/[^\n]/g,' '));
}
function describe(text, testSource = false) {
 const clean=mask(text), pkg=/\bpackage\s+([\w.]+)/.exec(clean)?.[1];
 if(!pkg || (!testSource && clean.includes('`')) || /\b(typealias|expect|actual|external|native)\b/.test(clean)) throw new Error('unsupported source syntax');
 const declarations=[...clean.matchAll(/\b(class|object|interface|enum)\s+([A-Za-z_$][\w$]*)/g)];
 if(!declarations.length) throw new Error('top-level or generated declarations require module coverage');
 const symbols=new Set(declarations.map(m=>m[2]));
 for(const m of clean.matchAll(/\bfun\s+([A-Za-z_$][\w$]*)\s*\(/g))symbols.add(m[1]);
 // Java method names as well as Kotlin names; over-selection is deliberate.
 for(const m of clean.matchAll(/\b([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[\w., ]+)?\s*\{/g))
  if(!['if','for','while','switch','catch','when','synchronized'].includes(m[1]))symbols.add(m[1]);
 return {clean,pkg,symbols:[...symbols],classes:declarations.map(m=>m[2]),
  references:new Set(text.match(/[A-Za-z_$][\w$]*/g)??[]),isTest:/@(?:[\w.]*\.)?(?:Test|ParameterizedTest|TestFactory)\b|\bextends\s+TestCase\b/.test(clean)};
}
function apiShape(text) {
 const clean=mask(text), ranges=[];
 // Only block-bodied methods may change. Fields, annotations, imports,
 // signatures, expression bodies and constructors remain byte-equivalent
 // modulo comments/whitespace. Unsupported edits therefore widen coverage.
 const methods=/\b(?:fun\s+[\w$]+\s*\([^{}]*?\)\s*(?::\s*[^={\n]+)?|[\w$<>\[\].?]+\s+[\w$]+\s*\([^{};]*?\)\s*(?:throws\s+[\w., ]+)?)\s*\{/g;
 for(const m of clean.matchAll(methods)) {
  const start=m.index+m[0].lastIndexOf('{');let depth=1,end=start+1;
  for(;end<clean.length && depth;end++){if(clean[end]==='{')depth++;else if(clean[end]==='}')depth--;}
  if(depth)throw new Error('unbalanced method body');
  if(!ranges.some(([a,b])=>start>=a&&end<=b))ranges.push([start,end]);
 }
 if(!ranges.length)throw new Error('no supported block-bodied methods');
 let shape='',cursor=0;
 for(const [a,b] of ranges.sort((a,b)=>a[0]-b[0])){shape+=text.slice(cursor,a)+'{BODY}';cursor=b;}
 shape+=text.slice(cursor);
 const withoutComments=shape.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
  token=>token.startsWith('//')||token.startsWith('/*')?' ':token);
 return (withoutComments.match(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]/g)??[]).join('');
}
function selectTests(config,contract,root,paths,plan,baseline,variantMatches,comparisonHead="HEAD") {
 const fallback=reason=>({mode:'fallback',targets:[],reasons:[reason]});
 try {
  const business=paths.filter(p=>p!==contract.planPath&&p!==`automation/tasks/${contract.id}.json`);
  if(!business.length || business.length>8 || contract.allowedPaths.some(p=>p.includes('*')))
   return fallback('Fast selection requires at most eight concrete source/test paths.');
  if(business.some(p=>!p.endsWith('.kt')&&!p.endsWith('.java')))return fallback('Resources or non-Java/Kotlin inputs require module verification.');
  if(plan.affectedModules.length!==1)return fallback('Cross-module impact requires module verification.');
  const module=config.androidProject.capabilities.modules.find(m=>m.gradlePath===plan.affectedModules[0]);
  if(module.type!=='application')return fallback('Library/API changes require consumer verification.');
  const files=[...new Set(git(root,['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean))].sort();
  const sourceFor=p=>module.sources.find(s=>s.paths.some(pattern=>matchesPath(pattern,p)));
  const selectedFiles=files.filter(p=>sourceFor(p));
  if(selectedFiles.length>20000)return fallback('Source graph exceeds bounded analysis size.');
  const entries=[];
  for(const file of selectedFiles) {
   const source=sourceFor(file);
   if(!/\.(java|kt)$/.test(file)) {
    if(/\.(groovy|scala|kts)$/.test(file))throw new Error('unsupported language in source graph');
    continue;
   }
   require('./project.cjs').safePath(root,file);
   const absolute=path.join(root,file),stat=fs.lstatSync(absolute);
   if(!stat.isFile()||stat.size>1024*1024)throw new Error('unsupported source file');
   const text=fs.readFileSync(absolute,'utf8');
   // An invisible reference can bypass any lexical closure. Widen instead of
   // interpreting absence of a direct reference as absence of impact.
   if(/\b(?:forName|loadClass|ServiceLoader|java\.lang\.reflect|kotlin\.reflect|DexClassLoader)\b/.test(text))
    throw new Error('dynamic class loading/reflection in module');
   let info;
   try { info=describe(text,source.kind==='test'); }
   catch(error) { info={unsupported:error.message,clean:mask(text),symbols:[],classes:[],references:new Set(text.match(/[A-Za-z_$][\w$]*/g)??[]),isTest:false}; }
   entries.push({file,source,text,sha256:hash(text),...info});
  }
  const seeds=[];
  for(const file of business) {
   const entry=entries.find(e=>e.file===file);
   if(!entry) {
    if(baseline && sourceFor(file)?.kind==='test' && !fs.existsSync(path.join(root,file)))continue;
    throw new Error(`missing/deleted or unmapped source: ${file}`);
   }
   if(entry.unsupported)throw new Error(`${entry.file}: ${entry.unsupported}`);
   if(entry.source.name==='testFixtures'||entry.source.name.startsWith('androidTest'))throw new Error('shared/device test source');
   if(entry.source.kind==='production') {
    if(/\b(?:override|open|abstract|interface|annotation)\b|@(?!JvmStatic\b|JvmOverloads\b)/.test(entry.clean))
     throw new Error('polymorphic or annotated production boundary');
    if(!baseline) {
     const before=git(root,['show',`${comparisonHead}:${file}`]);
     if(apiShape(before)!==apiShape(entry.text))throw new Error('API, field, import or non-method-body change');
    }
   }
   seeds.push(entry);
  }
  const reached=new Set(seeds.map(e=>e.file));
  const symbols=new Set(seeds.flatMap(e=>e.symbols));
  for(let changed=true;changed;) {
   changed=false;
   for(const e of entries)if(!reached.has(e.file)&&[...symbols].some(s=>e.references.has(s))) {
    if(e.unsupported)throw new Error(`${e.file}: ${e.unsupported}`);
    reached.add(e.file);for(const s of e.symbols)symbols.add(s);changed=true;
   }
   if(reached.size>64)throw new Error('reference closure is too broad for a small change');
  }
  const targets=new Map();
  const add=(gradleTask,filter)=>targets.set(`${gradleTask}\0${filter}`,{gradleTask,filter});
  for(const target of contract.targetTests) {
   if(!baseline) { add(target.gradleTask,target.filter);continue; }
   if(target.filter.includes('*'))throw new Error('wildcard baseline targets require module coverage');
   // A declared method may be the new behavior that Coder will introduce.
   // Capture its existing class instead, preserving every old method without
   // requiring the new method to exist before implementation. Unknown/new
   // classes remain absent from baseline selection.
   for(const e of entries.filter(e=>e.source.kind==='test'))for(const c of e.classes) {
    const className=`${e.pkg}.${c}`;
    if(target.filter===className||target.filter.startsWith(`${className}.`))add(target.gradleTask,className);
   }
  }
  const testFiles=entries.filter(e=>reached.has(e.file)&&e.source.kind==='test');
  for(const e of testFiles) {
   // Check all reached test sources before recognizing annotations. Inherited
   // tests and custom engines need not declare an @Test method in this file;
   // treating an unrecognized file as a helper could silently drop its cases.
   // Nested classes also cannot safely map to JVM binary names here.
   if(e.classes.length!==1 || /\babstract\s+class\b|\b(?:extends|implements)\b|\bclass\s+\w+[^{}]*:/.test(e.clean))throw new Error('nested or inherited test classes require module coverage');
   if(!e.isTest)throw new Error(`${e.file}: unrecognized test source requires module coverage`);
   for(const task of module.tasks.filter(t=>t.kind==='unit'&&plan.tasks.fullUnitTestTasks.includes(t.path)&&variantMatches(e.source,t.variant)))
    add(task.path,`${e.pkg}.${e.classes[0]}`);
  }
  if([...targets.values()].some(t=>!config.gradleVerification.focusedTestTasks.includes(t.gradleTask)))throw new Error('selected variant lacks a configured filtered Test task');
  if(!testFiles.length)throw new Error('no existing test mapping for affected sources');
  for(const seed of seeds.filter(e=>e.source.kind==='production')) {
   if(!testFiles.some(e=>seed.symbols.some(s=>e.references.has(s))))throw new Error(`no direct regression coverage for ${seed.file}`);
  }
  return {mode:'selected',targets:[...targets.values()].sort((a,b)=>a.gradleTask.localeCompare(b.gradleTask)||a.filter.localeCompare(b.filter)),
   reasons:['Contract targets, changed test classes and transitive source/test references; all selected variants retained.'],
   sourceFiles:[...reached].sort(),testFiles:testFiles.map(e=>e.file),graphSha256:hash(JSON.stringify(entries.map(e=>[e.file,e.sha256])))};
 }catch(error){return fallback(`Conservative fallback: ${error.message}`);}
}
module.exports={selectTests,apiShape};
