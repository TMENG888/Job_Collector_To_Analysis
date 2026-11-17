import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ANNOTATION_SCHEMA_VERSION,cleanAnnotationSchemaResponse,validateAnnotationSchema,createAnnotationSchemas,schemaHash} from './insight-annotation-schema.mjs';

const role='测试工程',inputFile='kb://all';
function fixture(){
  const example={title:'测试工程师',duties:'负责测试用例设计与执行',reason:'主要交付测试结果'};
  return {schema_version:ANNOTATION_SCHEMA_VERSION,role,definition:'负责软件测试与质量保障',retrieval:{title_keywords:['软件测试','测试工程师'],duty_keywords:['测试用例','缺陷跟踪'],adjacent_keywords:[]},classification:{include:['主要职责是软件测试'],exclude:['主要职责是业务开发'],review:['职责不完整'],positive_examples:[example,{...example}],negative_examples:[{...example,title:'后端开发'},{...example,title:'前端开发'}]},semantics:Object.fromEntries(['skills','tasks','domains','industries'].map(field=>[field,{definition:field,include:['明确原文证据'],exclude:['无证据推测'],normalization:[{canonical:'测试工具',aliases:[]}]}]))};
}
const validate=value=>validateAnnotationSchema(cleanAnnotationSchemaResponse(value).value,role);
const target=(value,parts)=>parts.reduce((obj,key)=>obj[key],value);
const tempRoot=process.env.JOB_TEST_WORK_DIR||(process.platform==='win32'?'E:/Codex/temp/annotation-schema-cleanup':path.join(os.tmpdir(),'annotation-schema-cleanup'));
async function directory(){await fs.mkdir(tempRoot,{recursive:true});return fs.mkdtemp(path.join(tempRoot,'test-'));}
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));};

test('cleans only unknown empty fields at defined object levels and keeps original response intact',()=>{
  const levels=[[],['retrieval'],['classification'],['classification','positive_examples',0],['classification','negative_examples',0],['semantics'],['semantics','skills'],['semantics','skills','normalization',0]];
  for(const level of levels)for(const empty of [null,'',' \t\n',[],{}]){
    const raw=fixture();target(raw,level).extra=empty;const before=JSON.stringify(raw),cleaned=cleanAnnotationSchemaResponse(raw);
    assert.equal(cleaned.cleanup.removedFields.length,1);
    assert.deepEqual(validateAnnotationSchema(cleaned.value,role),validateAnnotationSchema(fixture(),role));
    assert.equal(JSON.stringify(raw),before);
    assert.deepEqual(cleanAnnotationSchemaResponse(cleaned.value).cleanup.removedFields,[]);
  }
  const raw=fixture();raw.industries={};const clean=cleanAnnotationSchemaResponse(raw);
  assert.deepEqual(clean.cleanup.removedFields,['$.industries']);assert.deepEqual(clean.value.semantics.industries,raw.semantics.industries);
});

test('does not discard nonempty unknown fields, false, zero or nested placeholders',()=>{
  for(const extra of ['important',false,0,[''],{nested:null}])for(const level of [[],['semantics'],['retrieval'],['classification','positive_examples',0]]){
    const raw=fixture();target(raw,level).extra=extra;
    assert.throws(()=>validate(raw),/未知字段/);
  }
});

test('missing required fields and invalid values still fail; known valid empties and v1 hashes stay unchanged',()=>{
  const missing=[['schema_version'],['role'],['definition'],['classification'],['semantics'],['retrieval'],...['include','exclude','review','positive_examples','negative_examples'].map(key=>['classification',key]),...['title','duties','reason'].map(key=>['classification','positive_examples',0,key]),...['skills','tasks','domains','industries'].flatMap(key=>[['semantics',key],...['definition','include','exclude','normalization'].map(field=>['semantics',key,field])]),...['title_keywords','duty_keywords','adjacent_keywords'].map(key=>['retrieval',key]),['semantics','skills','normalization',0,'canonical'],['semantics','skills','normalization',0,'aliases']];
  for(const location of missing){const raw=fixture();delete target(raw,location.slice(0,-1))[location.at(-1)];raw.extra={};assert.throws(()=>validate(raw),undefined,location.join('.'));}
  for(const value of ['',null,[],{}]){const raw=fixture();raw.definition=value;assert.throws(()=>validate(raw));}
  const raw=fixture();raw.role='其他岗位';assert.throws(()=>validate(raw),/岗位不一致/);
  const invalid=fixture();invalid.retrieval.duty_keywords[0]='(a+)+$';assert.throws(()=>validate(invalid),/检索词/);
  const legacy=fixture();legacy.schema_version='job-annotation-schema-v1';delete legacy.retrieval;
  assert.equal(schemaHash(validate(legacy)),schemaHash(validateAnnotationSchema(legacy,role)));
  assert.deepEqual(validate(fixture()).retrieval.adjacent_keywords,[]);
});

test('draft records raw response and cleanup paths, freezes cleaned hash, never retries invalid output',async()=>{
  const dir=await directory(),response=fixture();response.industries={};let calls=0;
  Object.defineProperty(response,'_usage',{value:{input:10,output:20,estimate:.0002}});
  const service=createAnnotationSchemas(dir,{directory:dir,model:{request:async()=>{calls++;return response;},status:async()=>({configured:true})}});
  const draft=await service.draft({inputFile,role,shareConfirmed:true,notes:'边界'});
  assert.equal(calls,1);assert.deepEqual(draft.cleanup.removedFields,['$.industries']);assert.equal(draft.usage.estimate,.0002);
  const raw=JSON.parse(await fs.readFile(path.join(dir,'attempts',draft.sourceAttemptId+'.json'),'utf8'));
  assert.deepEqual(raw.response.industries,{});assert.equal(raw.notes,'边界');
  const approved=await service.approve({inputFile,role,id:draft.id,confirmed:true});assert.equal((await service.resolve(inputFile,role)).sha256,draft.sha256);
  delete response.semantics.industries;
  await assert.rejects(service.draft({inputFile,role,shareConfirmed:true}),/结构无效/);assert.equal(calls,2);
  const status=await service.status(inputFile,role);assert.equal(status.lastAttempt.status,'failed');assert.equal(status.approved.id,approved.id);
  const saved=JSON.parse(await fs.readFile(path.join(dir,approved.id+'.json'),'utf8'));saved.schema.extra={};await write(path.join(dir,approved.id+'.json'),saved);
  await assert.rejects(service.resolve(inputFile,role),/未知字段/);
});

test('saved failed attempt recovers locally with scope and note guards; missing data cannot be repaired',async()=>{
  const dir=await directory(),id=randomUUID(),raw=fixture();raw.industries={};let requests=0;
  const attempt={id,inputFile,role,notes:'原边界',createdAt:'2020-01-01T00:00:00.000Z',model:'fixture',usage:{estimate:.01},response:raw};
  await write(path.join(dir,'attempts',id+'.json'),attempt);
  await write(path.join(dir,'index.json'),{[schemaHash([inputFile,role])]:{lastAttempt:{id,status:'failed',error:'规范包含未知字段：industries'}}});
  const service=createAnnotationSchemas(dir,{directory:dir,model:{request:async()=>{requests++;throw Error('network forbidden');},status:async()=>({configured:true})}});
  const before=await fs.readFile(path.join(dir,'attempts',id+'.json'),'utf8');
  await assert.rejects(service.recoverDraft({inputFile:'kb://task/other',role,id,notes:'原边界'}),/最近失败/);
  await assert.rejects(service.recoverDraft({inputFile,role,id,notes:'修改边界'}),/不一致/);
  const recovered=await service.recoverDraft({inputFile,role,id,notes:'原边界'});
  assert.equal(recovered.recoveredFromAttempt,true);assert.deepEqual(recovered.cleanup.removedFields,['$.industries']);assert.equal(requests,0);
  assert.equal(await fs.readFile(path.join(dir,'attempts',id+'.json'),'utf8'),before);
  await assert.rejects(service.recoverDraft({inputFile,role,id,notes:'原边界'}),/最近失败/);
  const missingId=randomUUID(),broken=fixture();delete broken.semantics.industries;
  await write(path.join(dir,'attempts',missingId+'.json'),{...attempt,id:missingId,response:broken});
  await write(path.join(dir,'index.json'),{[schemaHash([inputFile,role])]:{draft:recovered.id,lastAttempt:{id:missingId,status:'failed'}}});
  await assert.rejects(service.recoverDraft({inputFile,role,id:missingId,notes:'原边界'}),/更新的规范/);
  await write(path.join(dir,'index.json'),{[schemaHash([inputFile,role])]:{lastAttempt:{id:missingId,status:'failed'}}});
  await assert.rejects(service.recoverDraft({inputFile,role,id:missingId,notes:'原边界'}),/结构无效/);
  assert.equal(requests,0);
});
