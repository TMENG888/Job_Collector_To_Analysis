// Tokens prevent cancelled or replaced async pipelines from starting new work.
export class PipelineRuns {
  runs=new Map();
  begin(id){if(this.runs.has(id))throw Error('任务流水线仍在运行');const token={cancelled:false};this.runs.set(id,token);return token;}
  current(id,token){return this.runs.get(id)===token&&!token.cancelled;}
  has(id){return this.runs.has(id);}
  cancel(id){const token=this.runs.get(id);if(token)token.cancelled=true;return Boolean(token);}
  finish(id,token){if(this.runs.get(id)===token)this.runs.delete(id);}
}
