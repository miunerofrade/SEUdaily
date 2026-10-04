import {test} from 'node:test';import assert from 'node:assert/strict';
import {followSelection} from '../src/terminal/viewport.js';
test('selection moves inside viewport before scrolling at either edge',()=>{
 let top=0;
 for (let selected=0; selected<5; selected++) assert.equal(followSelection(top,selected,5,12),0);
 top=followSelection(top,5,5,12);assert.equal(top,1);
 top=followSelection(top,6,5,12);assert.equal(top,2);
 for (let selected=5;selected>=2;selected--) assert.equal(followSelection(top,selected,5,12),2);
 assert.equal(followSelection(top,1,5,12),1);
 assert.equal(followSelection(5,4,7,7),0);
 assert.equal(followSelection(0,0,5,0),0);
});
