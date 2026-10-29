const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderAnswerQuality(quality){
  if(!quality)return '';
  if(quality.status!=='evaluated')return '<details class="assistant-tool-trace"><summary>回答相关性 · 未评估</summary><p>本轮未取得完整有效的语义评估，不显示估算分数。</p></details>';
  const s=quality.sentences,p=quality.paragraphs,c=quality.coverage;
  return `<details class="assistant-tool-trace assistant-answer-quality"><summary>回答相关性 · 直接回答 ${s.answer}/${s.total} · 噪声 ${s.noise_rate}%</summary>
    <p>正文内容单元：直接回答 ${s.answer} · 必要说明 ${s.support} · 噪声 ${s.noise}。有效内容 ${s.useful_rate}%；按字数加权噪声 ${quality.characters.noise_rate}%。</p>
    <p>段落：${p.total} 段，其中 ${p.direct} 段含直接回答，${p.pure_noise} 段全部为噪声。有直接内容的子问题 ${c.covered}/${c.total}；不足说明不算直接回答。</p>
    ${c.unanswered.length?`<p>未直接回答：${c.unanswered.map(q=>escape(q.question)).join('；')}</p>`:''}
    <p class="assistant-muted">${escape(quality.notice)}${quality.model?` · ${escape(quality.model)}`:''}</p>
    <details><summary>逐句核对模型判断</summary><ol>${quality.units.map(u=>`<li><b>${{answer:'直接回答',support:'必要说明',noise:'噪声'}[u.category]}</b> · ${escape(u.text)} <small>（${escape({direct:'回答子问题',necessary_limit:'必要限制',evidence:'依据',duplicate:'重复',irrelevant:'无关',process_detail:'内部流程',verbose:'冗长'}[u.reason])}）</small></li>`).join('')}</ol></details>
  </details>`;
}
