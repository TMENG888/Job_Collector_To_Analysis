import {setAssistantMarkdown,sourceAnchorId} from '../assistant-markdown.js';

const root=document.querySelector('#scratch'),results=[];
function test(name,fn){try{fn();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:error.message});}}
function assert(value,message='断言失败'){if(!value)throw new Error(message);}
function render(value,sources=[]){setAssistantMarkdown(root,value,sources,'test');return root;}
const citation='K0123456789abcdef01234567',sources=[{citation,title:'智能体应用开发工程师'}];
const sample=`## 智能体开发与嵌入式开发怎么选？

**先看职业方向，再比较同城市、同经验岗位的薪资。**

| 对比维度 | 智能体应用开发 | 嵌入式软件开发 |
| :--- | :--- | :--- |
| 常见技术 | Python、RAG、工具调用 | C/C++、RTOS、驱动与调试 |
| 核心工作 | 让模型完成业务任务 | 让软硬件稳定协同运行 |
| 准备重点 | 可评估的端到端项目 | 可验证的硬件与底层项目 |

### 准备建议

1. 确认目标城市、经验和学历条件。
2. 对比岗位 JD，区分必备和加分技能。
   - 优先补齐高频必备技能。
   - 用项目证明能力，而不只是列出名词。

> 招聘薪资是市场样本，不代表学习某项技术就能获得涨薪。

例如：\`Python + RAG\`，岗位证据 [${citation}]。

\`\`\`python
skills = ["Python", "RAG"]
print(skills)
\`\`\`
`;
test('标题、强调、列表、引用与代码块',()=>{render(sample,sources);assert(root.querySelector('h2'));assert(root.querySelector('strong'));assert(root.querySelector('ol > li ul'));assert(root.querySelector('blockquote'));assert(root.querySelector('pre code').textContent.includes('print(skills)'));});
test('GFM 表格和可聚焦滚动容器',()=>{assert(root.querySelectorAll('tbody tr').length===3);assert(root.querySelector('.assistant-markdown-table').tabIndex===0);});
test('外链使用安全打开属性',()=>{render('[文档](https://example.com/guide)');const link=root.querySelector('a');assert(link.target==='_blank');assert(link.rel==='noopener noreferrer');assert(link.referrerPolicy==='no-referrer');});
test('阻止危险协议与实体编码协议',()=>{for(const url of ['javascript:alert(1)','data:text/html,test','file:///C:/secret','vbscript:msgbox(1)','jav&#x61;script:alert(1)']){render(`[链接](${url})`);assert(!root.querySelector('a[href]'),url);}});
test('原始 HTML、SVG、事件属性不成为可执行元素',()=>{render('<script>window.markdownInjected=true</script>\n<img src=x onerror=alert(1)>\n<svg onload=alert(1)><a href="javascript:alert(1)">x</a></svg>');assert(!root.querySelector('script,img,svg'));assert(!root.querySelector('[onload],[onerror]'));assert(root.textContent.includes('<script>'));});
test('Markdown 图片仅保留文字，不发起加载',()=>{render('![示例图片](https://example.com/private.png)');assert(!root.querySelector('img'));assert(root.textContent.trim()==='示例图片');});
test('畸形 HTML 与恶意表格内容不产生活动元素',()=>{render('| 示例 |\n| --- |\n| <math><mtext><img src=x onerror=alert(1)> |\n\n[恶意](javascript&#58;alert(1))');assert(!root.querySelector('math,img,[onerror],a[href]'));});
test('合法岗位引用转换为编号，未知引用保留',()=>{render(`[${citation}] [J999]`,sources);assert(root.querySelector('.assistant-citation').textContent==='[1]');assert(root.querySelector('.assistant-citation').getAttribute('href')==='#'+sourceAnchorId('test',0));assert(root.textContent.includes('[J999]'));});
test('代码和已有链接中的引用不转换',()=>{render('`['+citation+']`\n\n```text\n['+citation+']\n```\n\n[['+citation+']](https://example.com)',sources);assert(!root.querySelector('.assistant-citation'));assert(root.querySelector('code').textContent.includes(citation));});
test('用户消息作为纯文本显示',()=>{const user=document.createElement('div');user.className='assistant-message-text';user.textContent='**我的简历** <script>alert(1)</script>';assert(!user.querySelector('strong,script'));assert(!user.classList.contains('assistant-markdown'));});
test('超长输入限制为 100000 字符',()=>{render('x'.repeat(100010));assert(root.textContent.trim().length===100000);});
const preview=document.querySelector('#preview');setAssistantMarkdown(preview,sample,sources,'preview');
requestAnimationFrame(()=>{
  test('当前视口内表格不撑宽页面',()=>{const wrapper=preview.querySelector('.assistant-markdown-table');assert(wrapper.getBoundingClientRect().width<=preview.getBoundingClientRect().width+1);assert(document.documentElement.scrollWidth<=document.documentElement.clientWidth+1);assert(getComputedStyle(preview).whiteSpace==='normal');});
  const failures=results.filter(item=>!item.pass),status=document.querySelector('#results');
  status.textContent=`${failures.length?'FAIL':'PASS'} · ${results.length-failures.length}/${results.length} 项通过`;
  const list=document.createElement('ul');for(const item of results){const li=document.createElement('li');li.textContent=`${item.pass?'✓':'✗'} ${item.name}${item.error?'：'+item.error:''}`;list.append(li);}status.append(list);
  document.title=`${failures.length?'FAIL':'PASS'} — 助手 Markdown 回归测试`;
});
