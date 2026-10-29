// Checkpoints remain the durable recovery source. Batched native ingestion gives
// the UI fresh counts without copying/backing up the whole SQLite DB per card.
export function createCollectorProgressSink({enabled=false,write,now=Date.now,intervalMs=15000,maxRows=200}={}){
  const pending=new Map();let lastWrite=null;
  const flush=async()=>{
    if(!enabled||!pending.size)return;
    const rows=[...pending.values()];await write(rows);
    pending.clear();lastWrite=now();
  };
  return {flush,async append(rows){
    if(!enabled)return;
    for(const row of rows)if(row?.platform&&row?.job_id)pending.set(`${row.platform}:${row.job_id}`,row);
    if(lastWrite==null||pending.size>=maxRows||now()-lastWrite>=intervalMs)await flush();
  },get pending(){return pending.size;}};
}
