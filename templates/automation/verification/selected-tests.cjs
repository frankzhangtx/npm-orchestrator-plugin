"use strict";
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const fileHash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const {identity}=require('./contract.cjs');
const mergeTargets=(...groups)=>[...new Map(groups.flat().map(t=>[JSON.stringify([t.gradleTask,t.filter]),t])).values()];
function matches(filter,item) {
 const pattern=new RegExp('^'+filter.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*')+'$');
 return pattern.test(item.className)||pattern.test(`${item.className}.${item.name}`);
}
function validateSelected(targets,collection) {
 assert(Array.isArray(collection.cases),'Selected regression case inventory is missing');
 assert(collection.cases.every(c=>c.result==='SUCCESS'),'Selected regression tests failed or were skipped');
 for(const t of targets)assert(collection.cases.some(c=>c.taskPath===t.gradleTask&&matches(t.filter,c)),`No executed cases for selected filter ${t.gradleTask} ${t.filter}`);
 return collection.cases.length;
}
function validateBaselineCases(baselineCases,cases) {
 const current=new Map(cases.map(c=>[identity(c),c]));
 for(const old of baselineCases) {
  const found=current.get(identity(old));
  assert(found,`Missing selected baseline case ${identity(old)}`);
  assert(found.result==='SUCCESS',`Selected baseline case failed or was skipped ${identity(old)}`);
 }
 return baselineCases.length;
}
function validateTargets(targets,config) {
 assert(Array.isArray(targets)&&targets.length>0&&targets.every(t=>config.gradleVerification.focusedTestTasks.includes(t.gradleTask)&&typeof t.filter==='string'&&/^[A-Za-z0-9_.#$*-]+$/.test(t.filter)),'Selected test target is not configured');
}
function selectedBaseline(contractFile,configFile,evidence,config) {
 const file=path.join(evidence,'baseline-selected.json');
 if(!fs.existsSync(file)) {
  const meta=path.join(evidence,'baseline.json');
  assert(!fs.existsSync(meta)||read(meta).testSelection?.mode!=='selected','Selected baseline evidence is missing');
  return null;
 }
 assert(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink(),'Selected baseline evidence must be a regular file');
 const result=read(file);
 assert(result.version===1&&result.phase==='baseline'&&result.state==='PASSED','Invalid selected baseline evidence');
 assert(result.contractSha256===fileHash(contractFile)&&result.configSha256===fileHash(configFile),'Selected baseline contract or configuration changed');
 validateTargets(result.targets,config);validateSelected(result.targets,result);
 assert(result.cases.every(c=>typeof c.taskPath==='string'&&typeof c.className==='string'&&c.className&&typeof c.name==='string'&&c.name),'Invalid selected baseline case identity');
 assert(new Set(result.cases.map(identity)).size===result.cases.length,'Duplicate selected baseline case identity');
 const meta=path.join(evidence,'baseline.json');
 if(fs.existsSync(meta))assert(read(meta).baselineSelectedSha256===fileHash(file),'Selected baseline evidence changed');
 return result;
}
function runSelected(contractFile,configFile,root,evidence,plan,baseline=false) {
 const contract=read(contractFile),config=read(configFile);
 require('./contract.cjs').validateContract(contract,config);
 const bounded=contract.verification.scope?.version===3;
 assert([2,3].includes(contract.verification.scope?.version)&&plan.testSelection?.mode==='selected','Explicit selected-test approval is required');
 if(bounded) {
  const approved=contract.verification.scope.regressionTests;
  assert(plan.testSelection.targets.every(t=>approved.some(a=>a.gradleTask===t.gradleTask&&a.filter===t.filter)),
   'Selected tests exceed the approved verification boundary');
  if(!plan.testSelection.targets.length) {
   const result={version:1,phase:baseline?'baseline':'selected',state:'NOT_REQUIRED',targets:[],testsExecuted:false,cases:[],reason:'No supplemental regression targets were approved'};
   console.log(JSON.stringify({selectedTests:result}));return result;
  }
 }
 const baselineFile=path.join(evidence,'baseline-selected.json');
 if(baseline)assert(!fs.existsSync(baselineFile),'Selected baseline already exists; it cannot be overwritten');
 const previous=baseline?null:selectedBaseline(contractFile,configFile,evidence,config);
 const previousSha=previous?fileHash(baselineFile):null;
 // A narrower current graph must not discard previously measured regressions.
 const targets=mergeTargets(plan.testSelection.targets,previous?.targets??[]);
 if(bounded)assert(targets.every(t=>contract.verification.scope.regressionTests.some(a=>a.gradleTask===t.gradleTask&&a.filter===t.filter)),
  'Baseline targets exceed the approved verification boundary');
 validateTargets(targets,config);
 // An exact class/filter already executed by the current sealed focused GREEN
 // need not run again. The enclosing phase validates its evidence and binding.
 const marker=path.join(evidence,'green-verification.json'),green=path.join(evidence,'green-inventory.json');
 let reused=[],remaining=targets,reusedCases=[];
 if(!baseline&&fs.existsSync(marker)&&fs.existsSync(green)) {
  const m=read(marker),bytes=fs.readFileSync(green);
  if(m.state==='PASSED'&&m.greenSha256===crypto.createHash('sha256').update(bytes).digest('hex')) {
   const result=JSON.parse(bytes); result.cases=(result.cases??[]).map(c=>c.actual??c);
   reused=targets.filter(t=>contract.targetTests.some(x=>x.gradleTask===t.gradleTask&&x.filter===t.filter)&&result.cases?.some(c=>c.taskPath===t.gradleTask&&matches(t.filter,c)));
   reusedCases=(result.cases??[]).filter(c=>reused.some(t=>t.gradleTask===c.taskPath&&matches(t.filter,c)));
   validateSelected(reused,{cases:reusedCases});
   remaining=targets.filter(t=>!reused.includes(t));
  }
 }
 const directory=path.join(evidence,'selected-test-attempts',crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
 let collection={cases:[]};
 if(remaining.length) {
  collection=require('./inventory.cjs').runGradle(root,config,{...contract,targetTests:remaining},baseline?'baseline':'selected',directory,false);
  if(bounded&&!baseline)assert(JSON.stringify(collection.runtime)===JSON.stringify(read(path.join(evidence,'test-manifest.json')).runtime),
   'Selected regression runtime differs from sealed RED');
 }
 validateSelected(remaining,collection);
 // Overlapping filters can execute a case as well as reuse its focused result.
 // Both sources have passed independently; merge identities for baseline checks.
 const combinedCases=[...new Map([...reusedCases,...collection.cases].map(c=>[identity(c),c])).values()];
 if(previous) {
  assert(fileHash(baselineFile)===previousSha,'Selected baseline evidence changed during verification');
  validateBaselineCases(previous.cases,combinedCases);
 }
 const result={version:1,phase:baseline?'baseline':'selected',state:'PASSED',targets,reusedFocusedTargets:reused,executedTargets:remaining,cases:collection.cases,combinedCases,
  baselineSelectedSha256:previousSha,selection:plan.testSelection};
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 if(baseline)fs.writeFileSync(baselineFile,JSON.stringify({version:1,phase:'baseline',state:'PASSED',contractSha256:fileHash(contractFile),configSha256:fileHash(configFile),targets,cases:combinedCases,selection:plan.testSelection},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({selectedTests:result}));return result;
}
function runBaselineRegression(contractFile,configFile,root,evidence) {
 const contract=read(contractFile),config=read(configFile);
 require('./contract.cjs').validateContract(contract,config);
 assert(contract.verification.scope?.version===2,'Explicit affected-tests approval is required');
 const baseline=selectedBaseline(contractFile,configFile,evidence,config);
 if(!baseline) {
  const result={version:1,phase:'baseline-regression',state:'NOT_REQUIRED',reason:'Baseline used module verification; no selected baseline was captured'};
  console.log(JSON.stringify({selectedBaselineRegression:result}));return result;
 }
 const baselineSha=fileHash(path.join(evidence,'baseline-selected.json'));
 const directory=path.join(evidence,'selected-test-attempts',crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
 const collection=require('./inventory.cjs').runGradle(root,config,{...contract,targetTests:baseline.targets},'selected',directory,false);
 assert(fileHash(path.join(evidence,'baseline-selected.json'))===baselineSha,'Selected baseline evidence changed during verification');
 validateSelected(baseline.targets,collection);validateBaselineCases(baseline.cases,collection.cases);
 const result={version:1,phase:'baseline-regression',state:'PASSED',targets:baseline.targets,cases:collection.cases,
  baselineSelectedSha256:baselineSha};
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({selectedBaselineRegression:result}));return result;
}
module.exports={runSelected,runBaselineRegression,validateSelected,validateBaselineCases,matches};
if(require.main===module){try{
 if(process.argv[2]==='--baseline-regression')runBaselineRegression(...process.argv.slice(3));
 else {
 const [contract,config,root,evidence,plan,baseline]=process.argv.slice(2);
 runSelected(contract,config,root,evidence,JSON.parse(plan),baseline==='baseline');
 }
}catch(error){console.error(error.message);process.exitCode=1;}}
