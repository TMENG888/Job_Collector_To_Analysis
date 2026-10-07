// RFC4180-style rows, including escaped quotes and multiline JD fields.
export function parseChannelCsv(text) {
  const table=[];let row=[],field='',quoted=false;
  text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){
      if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;
    }else if(c===','&&!quoted){row.push(field);field='';}
    else if((c==='\n'||c==='\r')&&!quoted){
      if(c==='\r'&&text[i+1]==='\n')i++;
      row.push(field);if(row.some(Boolean))table.push(row);row=[];field='';
    }else field+=c;
  }
  if(quoted)throw new Error('历史标准化 CSV 引号未闭合，停止以避免覆盖原数据');
  if(field||row.length){row.push(field);table.push(row);}
  const headers=table.shift()||[];
  return table.map(values=>Object.fromEntries(headers.map((h,i)=>[h,values[i]||''])));
}
