import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedZoom,nextZoom,zoomShortcut} from './zoom.mjs';
test('zoom has usable limits and recovers invalid saved settings',()=>{
  for(const n of [null,'1',NaN,Infinity,0,3])assert.equal(checkedZoom(n),1);
  assert.equal(checkedZoom(.8),.8);assert.equal(nextZoom(.5,'out'),.5);assert.equal(nextZoom(2,'in'),2);
  assert.equal(nextZoom(.9,'in'),1);assert.equal(nextZoom(1.25,'out'),1.1);assert.equal(nextZoom(2,'reset'),1);
});
test('shortcuts work across plus keys and numpads without intercepting normal typing',()=>{
  for(const key of ['+','=','Add'])assert.equal(zoomShortcut({type:'keyDown',control:true,key}),'in');
  for(const code of ['NumpadSubtract','Minus'])assert.equal(zoomShortcut({type:'keyDown',control:true,code}),'out');
  assert.equal(zoomShortcut({type:'keyDown',control:true,code:'Numpad0'}),'reset');
  for(const input of [{type:'keyUp',control:true,key:'+'},{type:'keyDown',key:'+'},{type:'keyDown',control:true,alt:true,key:'+'},{type:'keyDown',control:true,key:'a'}])assert.equal(zoomShortcut(input),null);
});
