// This is a scheduling heuristic, not a relevance filter or proof of exhaustion.
export class YieldWindow {
  constructor(seen=new Set(),settings={}) {
    this.seen=seen;this.enabled=settings.enabled!==false;
    this.pages=Math.max(3,Number(settings.pages)||5);
    this.minimumRecords=Math.max(60,Number(settings.minimumRecords)||100);
    this.maxNew=Math.max(0,Number(settings.maxNew)||0);
    this.window=[];
  }
  observe(ids) {
    const valid=ids.filter(id=>id!=null && String(id)!=='').map(String);
    let added=0;
    for(const id of new Set(valid))if(!this.seen.has(id)){this.seen.add(id);added++;}
    this.window.push({records:valid.length,added});
    if(this.window.length>this.pages)this.window.shift();
    const records=this.window.reduce((sum,row)=>sum+row.records,0);
    const newRows=this.window.reduce((sum,row)=>sum+row.added,0);
    return {records,newRows,duplicateRate:records?1-newRows/records:0,
      defer:this.enabled && this.window.length>=this.pages && records>=this.minimumRecords && newRows<=this.maxNew};
  }
}
export function yieldNote(probe) {
  return `连续有效列表窗口 ${probe.records} 条，仅新增 ${probe.newRows} 条独立岗位；保存断点并暂缓，未认定穷尽，下次续采可恢复`;
}
