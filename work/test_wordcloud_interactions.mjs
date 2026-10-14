import assert from 'node:assert/strict';
import {installWordCloudInteractions} from '../job_collector_ui/public/insight-wordcloud.js';
const handlers={};
installWordCloudInteractions({addEventListener(name,fn,options){handlers[name]=fn;if(name==='wheel')assert.equal(options.passive,false);}});
function fixture(){
  let view='0 0 900 640';
  const output={textContent:'100%'};
  return {dataset:{cloudBase:view,cloudScale:'1'},parentElement:{previousElementSibling:{querySelector(){return output;}}},output,
    getAttribute(){return view;},setAttribute(name,value){view=value;},getBoundingClientRect(){return {width:450,height:320};},
    classList:{add(){},remove(){}},setPointerCapture(){}};
}
const svg=fixture(),other=fixture();
let prevented=false;
handlers.wheel({target:{closest(){return svg;}},ctrlKey:true,deltaY:-100,preventDefault(){prevented=true;}});
assert.equal(prevented,true);
assert.ok(Number(svg.dataset.cloudScale)>1);
assert.equal(other.dataset.cloudScale,'1');
const before=svg.getAttribute();
handlers.wheel({target:{closest(){return svg;}},ctrlKey:false,deltaY:-100,preventDefault(){throw Error('ordinary scrolling must remain available');}});
assert.equal(svg.getAttribute(),before);
handlers.pointerdown({target:{closest(){return svg;}},button:0,pointerId:1,clientX:10,clientY:10});
handlers.pointermove({pointerId:1,clientX:30,clientY:30});
assert.notEqual(svg.getAttribute(),before);
handlers.pointerup();
handlers.click({target:{closest(){return {dataset:{cloudZoom:'reset'},closest(){return {nextElementSibling:{querySelector(){return svg;}}};}};}}});
assert.equal(svg.getAttribute(),'0 0 900 640');
assert.equal(svg.output.textContent,'100%');
console.log('PASS: Ctrl wheel, ordinary scroll, isolated zoom, drag and reset');
