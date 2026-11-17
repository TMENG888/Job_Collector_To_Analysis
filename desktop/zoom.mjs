const steps=[.5,.67,.75,.8,.9,1,1.1,1.25,1.5,1.75,2];
export const checkedZoom=value=>typeof value==='number'&&Number.isFinite(value)&&value>=.5&&value<=2?value:1;
export function nextZoom(current,direction){
  return direction==='in'?(steps.find(n=>n>current+.001)??2):direction==='out'?([...steps].reverse().find(n=>n<current-.001)??.5):1;
}
export function zoomShortcut(input){
  if(input.type!=='keyDown'||!(input.control||input.meta)||input.alt)return null;
  if(['+','=','Add'].includes(input.key)||['NumpadAdd','Equal'].includes(input.code))return 'in';
  if(['-','_','Subtract'].includes(input.key)||['NumpadSubtract','Minus'].includes(input.code))return 'out';
  if(input.key==='0'||['Digit0','Numpad0'].includes(input.code))return 'reset';
  return null;
}
