// A successful HTTP response is not evidence of a valid or empty job page.
export function selectIguopinRows(records,city='全国',limit=Infinity){
  const selected=city==='全国'?records:records.filter(row=>(row.district_list||[]).some(item=>String(item.area_cn||'').includes(city)));
  return [...new Map(selected.map(row=>[String(row.job_id),row])).values()].slice(0,limit);
}
export function parseIguopinPage(body) {
  const fail = message => Object.assign(new Error(`国聘：${message}，停止渠道并保留断点`), {code:'invalid_response',stopChannel:true});
  const data = body?.data;
  if (!data || !Array.isArray(data.list)) throw fail('响应缺少岗位列表');
  const total = Number(data.total), pageSize = Number(data.page_size || 20);
  if (data.total == null || !Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1) throw fail('分页总数或页大小无效');
  if (data.list.some(row => !row || row.job_id == null || String(row.job_id).trim() === '' || !String(row.job_name || '').trim())) throw fail('岗位缺少稳定 ID 或名称');
  if (total === 0 && data.list.length) throw fail('总数与岗位列表矛盾');
  return {...data,total,page_size:pageSize};
}
