import test from 'node:test';
import assert from 'node:assert/strict';
import {selectionRows,selectedText,type Selection} from '../src/terminal/selection.js';
const select=(start:{x:number;y:number},end:{x:number;y:number}):Selection=>({start,end,moved:true,screen:[['中','','文','',' ','A',' ',' '],['b','c',' ',' ',' ',' ',' ',' ']]});
test('selection snaps to CJK boundaries, respects reversed drags and trims trailing padding',()=>{
 assert.equal(selectedText(select({x:1,y:0},{x:2,y:0})),'中文');
 assert.equal(selectedText(select({x:2,y:0},{x:1,y:0})),'中文');
 assert.equal(selectedText(select({x:5,y:0},{x:1,y:1})),'A\nbc');
 assert.equal(selectionRows(select({x:1,y:0},{x:2,y:0}))[0].x,0);
});
