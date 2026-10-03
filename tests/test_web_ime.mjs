import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isImeComposing } from '../apps/web/src/ime.ts';

test('IME confirmation is ignored, including a browser reporting 229 after composition ends', () => {
  assert.equal(isImeComposing({isComposing:true,keyCode:13},false),true);
  assert.equal(isImeComposing({isComposing:false,keyCode:13},true),true);
  assert.equal(isImeComposing({isComposing:false,keyCode:229},false),true);
  assert.equal(isImeComposing({isComposing:false,keyCode:13},false),false);
});
