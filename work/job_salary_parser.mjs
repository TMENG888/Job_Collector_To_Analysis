// Shared parser: endpoints keep their own units; no day/month/year conversion.
export function parseOriginalSalary(value){
  const raw=String(value||'').normalize('NFKC').trim(),text=raw.replace(/[,，\s]/g,'');
  if(!text||/面议|保密|negotiable/i.test(text))return null;
  const range=text.match(/(\d+(?:\.\d+)?)\s*(万|千|[kK]|元)?[-~～–—至到](\d+(?:\.\d+)?)\s*(万|千|[kK]|元)?/);
  const single=text.match(/(\d+(?:\.\d+)?)\s*(万|千|[kK]|元)?/);
  if(!single||/^\d+薪$/.test(text))return null;
  const scale=u=>u==='万'?10000:/千|k/i.test(u||'')?1000:1;
  const unit=range?.[4]||range?.[2]||single[2]||'';
  const min=range?Number(range[1])*scale(range[2]||unit):Number(single[1])*scale(unit);
  const max=range?Number(range[3])*scale(unit):min;
  const period=/小时|\/时|时薪|\/h\b/i.test(text)?'hour':/天|\/日|日薪|\/day/i.test(text)?'day':/年薪|年包|总包|\/年|每年|万元?\/年|万元?年薪/.test(text)?'year':/月|薪|千|k/i.test(text)?'month':/元/.test(text)&&min>=1000?'month':'';
  if(!period||!(min>0&&max>=min))return null;
  if(max>{hour:10000,day:100000,month:1000000,year:10000000}[period])return null;
  const pay=text.match(/(?:[·•x×*]|\D)(\d{2})(?:[-~～–至到](\d{2}))?薪/);
  const payMonths=period==='month'&&pay&&Number(pay[1])>=12&&Number(pay[2]||pay[1])<=24?{min:Number(pay[1]),max:Number(pay[2]||pay[1])}:null;
  return {raw,period,min,max,midpoint:(min+max)/2,pay_months:payMonths,
    period_inferred:period==='month'&&!/月|薪|千|k/i.test(text),
    annual_nominal:payMonths?{min:min*payMonths.min,max:max*payMonths.max,basis:'按原文薪数计算的名义年薪，不等于保证总包'}:null};
}
