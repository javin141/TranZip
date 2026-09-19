import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipGroups } from './format.js';

const leg = (id, type) => ({ id, type });
const shape = (legs) => chipGroups(legs).map((group) => `${group.type}:${group.legs.map((item) => item.id).join('+')}`);

test('consecutive walking legs collapse into a single chip', () => {
  // Google splits one stretch on foot into "walk", "take entrance B", "walk".
  const legs = [leg('w1', 'walk'), leg('w2', 'walk'), leg('w3', 'walk'), leg('m1', 'mrt'), leg('w4', 'walk'), leg('m2', 'mrt')];
  assert.deepEqual(shape(legs), ['walk:w1+w2+w3', 'mrt:m1', 'walk:w4', 'mrt:m2']);
});

test('separate stretches of walking stay separate chips', () => {
  const legs = [leg('w1', 'walk'), leg('b1', 'bus'), leg('w2', 'walk'), leg('m1', 'mrt'), leg('w3', 'walk')];
  assert.deepEqual(shape(legs), ['walk:w1', 'bus:b1', 'walk:w2', 'mrt:m1', 'walk:w3']);
});

test('rides are never merged, even back to back', () => {
  assert.deepEqual(shape([leg('b1', 'bus'), leg('b2', 'bus'), leg('m1', 'mrt'), leg('m2', 'mrt')]), ['bus:b1', 'bus:b2', 'mrt:m1', 'mrt:m2']);
});

test('a walk-only route and an empty route are handled', () => {
  assert.deepEqual(shape([leg('w1', 'walk'), leg('w2', 'walk')]), ['walk:w1+w2']);
  assert.deepEqual(chipGroups([]), []);
  assert.deepEqual(chipGroups(undefined), []);
});

test('the legs themselves are not changed, so the step-by-step timeline still lists every one', () => {
  const legs = [leg('w1', 'walk'), leg('w2', 'walk')];
  chipGroups(legs);
  assert.equal(legs.length, 2);
});
