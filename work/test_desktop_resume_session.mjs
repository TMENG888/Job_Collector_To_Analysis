import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopRecruiter} from './job-desktop-recruiter.mjs';

function fixture(overrides={}){
  let time=1000;
  const calls=[];
  const service=createDesktopRecruiter({dataDir:'E:/Codex/work/20261104-remove-profile-liepin/test-data',runtimeDir:'E:/Codex/work/20261104-remove-profile-liepin/test-runtime',rpc:async method=>{calls.push(method);return {running:true,mode:'desktop-native'};},screening:{catalog:async()=>[{id:'test',role:'数据分析',source:'test',version:'1'}]},model:{status:async()=>({configured:true}),cancel(){},request:async()=>({summary:'测试',queries:['数据分析','数据分析师','数据分析实习生'].map(keyword=>({keyword,modelRef:'m1',evidenceRef:'r1'}))})},parse:async()=>({text:'使用 Python 和 SQL 进行业务数据分析，编写统计报告并开发可视化看板。'}),render:async()=>({sha256:'document',pages:[{page:1,sha256:'page1',mime:'image/jpeg',base64:'AA=='},{page:2,sha256:'page2',mime:'image/jpeg',base64:'AA=='}]}),now:()=>time,...overrides});
  return {service,calls,advance(ms){time+=ms;}};
}
const upload=service=>service.upload({filename:'简历.pdf',base64:Buffer.from('%PDF-fixture').toString('base64')});
const acknowledge=(service,preview,pages=['page1','page2'])=>service.acknowledge({ticket:preview.ticket,revision:preview.revision,pages});

test('session PDF requires every page, and changing PDF invalidates approval',async()=>{
  const {service}=fixture();
  try{
    assert.equal((await service.status()).resume.configured,false);
    await upload(service);assert.equal((await service.status()).resume.previewed,false);
    const first=await service.preview();
    await assert.rejects(acknowledge(service,first,['page1']),/逐页核对/);
    assert.equal((await acknowledge(service,first)).previewed,true);
    await upload(service);
    await assert.rejects(acknowledge(service,first),/逐页核对/);
    assert.equal((await service.status()).resume.previewed,false);
    assert.equal('library' in await service.status(),false);
    assert.equal('selectResume' in service,false);
  }finally{service.dispose();}
});
test('expired previews and idle resumes cannot be approved',async()=>{
  const f=fixture();
  try{
    await upload(f.service);const preview=await f.service.preview();
    f.advance(10*60000+1);await assert.rejects(acknowledge(f.service,preview),/逐页核对/);
    f.advance(21*60000);assert.equal((await f.service.status()).resume.configured,false);
    await assert.rejects(f.service.preview(),/上传/);
  }finally{f.service.dispose();}
});
test('clearing during parsing cannot restore an obsolete resume',async()=>{
  let resolveParse;
  const {service}=fixture({parse:()=>new Promise(resolve=>{resolveParse=resolve;})});
  try{
    const pending=upload(service);service.clear();
    resolveParse({text:'使用 Python 和 SQL 进行业务数据分析，编写统计报告并开发可视化看板。'});
    await assert.rejects(pending,/上传已取消/);assert.equal((await service.status()).resume.configured,false);
  }finally{service.dispose();}
});
test('unreviewed PDF cannot authorize delivery or reach a recruiting page',async()=>{
  const {service,calls}=fixture();
  try{
    const resume=await upload(service),plan=await service.generate({shareConfirmed:true,budget:.1});
    await assert.rejects(service.start({planId:plan.id,delivery:{enabled:true,confirmed:true,planId:plan.id,resumeRevision:resume.revision,documentHash:resume.documentHash,maxRecipients:1,intervalSeconds:60}}),/预览/);
    assert.ok(!calls.some(method=>method.startsWith('delivery-')||method==='prepare-action'||method==='navigate'));
  }finally{service.dispose();}
});
