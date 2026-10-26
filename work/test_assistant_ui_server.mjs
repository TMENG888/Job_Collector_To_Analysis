// Isolated frontend fixture: no production DB, credentials, model, or collection API.
// Run explicitly, then open http://127.0.0.1:8794/?view=assistant.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../job_collector_ui/public');
const id='00000000-0000-4000-8000-000000000001';
const answer='## 适合你的方向\n\n**Agent应用开发实习**，可结合岗位预算沟通日薪。\n\n| 方向 | 匹配依据 |\n| --- | --- |\n| Agent | 工具调用、状态管理 |\n| RAG | 检索、证据校验 |\n\n```python\nprint("岗位助手")\n```\n\n以上是隔离测试示例，不是实际招聘报价。';
const turn=message=>({conversationId:id,answer,execution:'local',filters:{employment_type:'实习'},trace:[],result:{mode:'search',sources:[]}});
const rows=[{message:'推荐适合我的智能体实习岗位',turn:turn(),at:Date.now()-3000},{message:'如何准备技术面试？',turn:turn(),at:Date.now()-2000}];
if(process.env.ASSISTANT_BENCHMARK_FIXTURE==='1')rows.push({message:'2027届本科，想找北京智能体秋招，怎么谈薪？（隔离样本）',at:Date.now(),turn:{...turn(),assistant_flow_version:4,
  answer:'## 同条件谈薪参考（隔离样本）\n\n正式校招按月薪／年包比较，不把实习日薪折算进来。\n\n本示例以 **16.5K/月** 作为沟通锚点，参考区间为13.8K—19.3K/月。这不是个人薪资预测或录用承诺；真实结果以知识库证据为准。',
  goal:{stage:'campus',graduation_year:2027,salary_period:'month'},filters:{city:'北京',education:'本科',career_stage:'campus',graduation_year:2027},
  trace:['search_jobs','salary_benchmark','job_details'].map(tool=>({kind:'tool',tool,origin:'preflight',status:'ready',rows:12})),
  result:{mode:'salary_benchmark',sources:[],salary_benchmark:{groups:{month:{count:12,published:true,median:16500,pay_months_distribution:{'未公开':6,'14薪':6}},day:{count:0},hour:{count:0},year:{count:1,published:false}},questions:[]}}}});
if(process.env.ASSISTANT_SEGMENT_FIXTURE==='1'){
  const group=(count,median)=>({count,published:count>=5,median,p25:median*.8,p75:median*1.2,pay_months_distribution:{'14薪':count}});
  const segments=['广州','深圳'].flatMap((city,i)=>['智能体/大模型应用','嵌入式开发'].map((role,r)=>({city,role,groups:{month:group(8+i+r,16000+i*2000+r*1000),year:group(0,0)}})));
  rows.push({message:'广州和深圳都可以，本科27届，比较智能体和嵌入式秋招（隔离演示）',at:Date.now(),turn:{...turn(),assistant_flow_version:4,
    answer:'## 分城市、分方向比较\n\n下表为**隔离合成数据**，不是个人报价或实际市场数据。不同城市与方向分别统计，不能混在一起做报价。\n\n条件已保留；后续可说“只比较深圳”继续分析。',
    filters:{cities:['广州','深圳'],roles:['智能体/大模型应用','嵌入式开发'],candidate_education:'本科'},goal:{stage:'campus',graduation_year:2027,salary_period:'month'},
    task:{status:'completed',plan:['确认求职目标','检索资格候选','分城市与方向对标薪资','补查JD并回答'],pending_questions:[]},
    trace:['search_jobs','salary_benchmark','job_details'].map(tool=>({kind:'tool',tool,origin:'preflight',status:'ready',rows:8})),
    result:{mode:'salary_benchmark',sources:[],salary_benchmark:{groups:{},segments,questions:[]}}}});
}
const metadata=()=>({id,title:'聊天交互验收 · 隔离样本',created:Date.now()-3000,updated:Date.now(),turn_count:rows.length});
let chats=0;
const json=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/api/assistant/sessions')return json(res,{persistent:true,sessions:[metadata()]});
    if(url.pathname==='/api/assistant/context')return json(res,{assistant_flow_version:4,knowledge:true,revision:1,candidate_rows:2,indexed_jobs:2,roles:['智能体应用开发（隔离样本）'],model:{configured:false}});
    if(url.pathname==='/api/test/counters')return json(res,{chats,turns:rows.length,collection_calls:0});
    if(req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
      if(url.pathname==='/api/assistant/session'&&body.action==='read')return json(res,{...metadata(),turns:rows,has_resume:false});
      if(url.pathname==='/api/assistant/chat'){
        chats++;const value={...turn(),session:{...metadata(),turn_count:rows.length+1}};rows.push({message:body.message,turn:value,at:Date.now()});return json(res,value);
      }
      return json(res,{error:'隔离测试禁止此写操作'},403);
    }
    let target=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
    if(!target.startsWith(root+path.sep))return json(res,{error:'Forbidden'},403);
    let content=await fs.readFile(target);
    if(target.endsWith('index.html'))content=Buffer.from(content.toString().replace(/<script type="module" src="\/app.js"><\/script>/,'<script type="module">import {loadJobAssistant} from "/job-assistant.js";document.querySelectorAll(".app-view").forEach(el=>el.classList.add("hidden"));document.querySelector("#assistantView").classList.remove("hidden");document.body.classList.add("assistant-chat-page");loadJobAssistant();</script>'));
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[path.extname(target)]||'application/octet-stream';
    res.writeHead(200,{'content-type':mime+'; charset=utf-8','cache-control':'no-store'});res.end(content);
  }catch(error){json(res,{error:error.code==='ENOENT'?'Not found':'Fixture error'},404);}
});
server.listen(8794,'127.0.0.1',()=>console.log('Isolated UI fixture on http://127.0.0.1:8794/?view=assistant (no real tools or model)'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
