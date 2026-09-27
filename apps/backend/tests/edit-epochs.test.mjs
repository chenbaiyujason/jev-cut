import test from 'node:test';
import assert from 'node:assert/strict';
import {beginEditEpoch} from '../edit-epochs.mjs';
test('latest request invalidates old work without cancelling unrelated projects',()=>{const first=beginEditEpoch('p'),other=beginEditEpoch('q'),second=beginEditEpoch('p');assert.equal(first.current(),false);assert.equal(second.current(),true);assert.equal(other.current(),true);second.cancel();assert.equal(second.current(),false);});
