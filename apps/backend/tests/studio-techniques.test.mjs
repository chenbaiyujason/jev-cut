import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTechnique, describeCapabilities, TechniqueValidationError } from '../studio-techniques.mjs';

function fixture() {
  return {
    metadata: { fps: 30, width: 1280, height: 720 },
    timeline: { tracks: [{ id: 'v1', type: 'video' }, { id: 'titles', type: 'video' }, { id: 'a1', type: 'audio' }], items: [], transitions: [], keyframes: [] },
    madCatalog: {
      assets: [{ assetId: 'episode-01', mediaId: 'media-01', sourceFps: 24, sourceDurationFrames: 2400, src: '/media/episode-01.mp4', width: 1920, height: 1080 }],
      shots: [
        { shotId: 'shot-A', assetId: 'episode-01', sourceIn: 240, sourceOut: 480, safeRanges: [{ sourceIn: 244, sourceOut: 476 }] },
        { shotId: 'shot-B', assetId: 'episode-01', sourceIn: 720, sourceOut: 960, safeRanges: [{ sourceIn: 724, sourceOut: 956 }] },
        { shotId: 'shot-C', assetId: 'episode-01', sourceIn: 1200, sourceOut: 1440 },
      ],
    },
  };
}
const segment = (shotId = 'shot-A', sourceIn = 264, sourceOut = 288, extra = {}) => ({ shotId, sourceIn, sourceOut, ...extra });
const repeat = (extra = {}) => ({ technique: 'repeat', requestId: 'repeat1', trackId: 'v1', from: 0, segment: segment(), count: 3, ...extra });
function withItems(project = fixture()) {
  project.timeline.items = compileTechnique({ technique: 'intercut', requestId: 'intro', trackId: 'v1', from: 0, segments: [segment('shot-A', 264, 336), segment('shot-B', 744, 816)] }, project).ops.map(op => op.item);
  return project;
}
function rejects(request, project, code) {
  assert.throws(() => compileTechnique(request, project), error => error instanceof TechniqueValidationError && error.code === code);
}

test('explicit repeat reuses a shot while separating asset, shot and occurrence identities', () => {
  const project = fixture(), before = structuredClone(project), result = compileTechnique(repeat(), project);
  assert.equal(result.ops.length, 3);
  assert.deepEqual(result.occurrences.map(o => o.from), [0, 30, 60]);
  assert.deepEqual(result.occurrences.map(o => o.assetId), ['episode-01', 'episode-01', 'episode-01']);
  assert.equal(new Set(result.occurrences.map(o => o.occurrenceId)).size, 3);
  assert.equal(new Set(result.occurrences.map(o => o.shotId)).size, 1);
  assert.equal(result.ops[0].item.sourceStart, 264);
  assert.equal(result.ops[0].item.sourceEnd, 288);
  assert.equal(result.ops[0].item.volume, -60);
  assert.equal(result.ops[0].item.embeddedAudioMuted, true);
  assert.deepEqual(project, before, 'compilation is read-only');
});

test('intercut preserves A1-B-A2-C-A3 with chronological action fragments and distinct IDs', () => {
  const result = compileTechnique({ technique: 'intercut', requestId: 'abab', from: 0, trackId: 'v1', segments: [segment('shot-A', 264, 288), segment('shot-B', 744, 756), segment('shot-A', 288, 312), segment('shot-C', 1224, 1236), segment('shot-A', 312, 336)] }, fixture());
  assert.deepEqual(result.occurrences.map(o => o.shotId), ['shot-A', 'shot-B', 'shot-A', 'shot-C', 'shot-A']);
  assert.deepEqual(result.occurrences.map(o => o.from), [0, 30, 45, 75, 90]);
  assert.equal(result.occurrences.at(-1).from + result.occurrences.at(-1).durationInFrames, 120);
});

test('stutter compiles small repeated fragments, rejects fragment over half a second', () => {
  const request = { ...repeat(), technique: 'stutter', segment: segment('shot-A', 264, 268), count: 4 };
  const result = compileTechnique(request, fixture());
  assert.deepEqual(result.occurrences.map(o => o.durationInFrames), [5, 5, 5, 5]);
  rejects({ ...request, segment: segment() }, fixture(), 'STUTTER_TOO_LONG');
});

test('fractional source FPS conservatively quantizes without exposing following source frames', () => {
  const project = fixture(); project.madCatalog.assets[0].sourceFps = 24000 / 1001;
  const result = compileTechnique(repeat({ segment: segment('shot-A', 264, 288, { speed: 1.5 }) }), project);
  assert.equal(result.ops[0].item.durationInFrames, 20);
  assert.equal(result.ops[0].item.sourceEnd, 288);
  assert.equal(result.ops[0].item.sourceFps, 24000 / 1001);
  rejects(repeat({ segment: segment('shot-A', 264, 288, { durationInFrames: 31 }) }), project, 'SOURCE_LENGTH');
});

test('source bounds and unsafe residual-cut bands are hard errors even for intentional repetition', () => {
  rejects(repeat({ segment: segment('shot-A', 470, 490) }), fixture(), 'SOURCE_BOUNDS');
  rejects(repeat({ segment: segment('shot-A', 240, 264) }), fixture(), 'UNSAFE_SHOT');
  const project = fixture(); project.madCatalog.shots[0].safeRanges = [{ sourceIn: 244, sourceOut: 288 }, { sourceIn: 296, sourceOut: 476 }];
  rejects(repeat({ segment: segment('shot-A', 264, 312) }), project, 'UNSAFE_SHOT');
});

test('compiler requires explicit replacement for occupied track regions', () => {
  const project = withItems();
  rejects(repeat(), project, 'TIMELINE_COLLISION');
  const first = project.timeline.items[0].id;
  const compiled = compileTechnique(repeat({ replaceOccurrenceIds: [first] }), project);
  assert.deepEqual(compiled.ops[0], { op: 'removeItems', ids: [first] });
  assert.equal(project.timeline.items.length, 2);
  rejects(repeat({ replaceOccurrenceIds: ['missing'] }), project, 'INVALID_OCCURRENCE');
});

test('transition consumes correct source-native handles without shifting timeline clips', () => {
  const project = withItems(), before = structuredClone(project);
  const request = { technique: 'transition', requestId: 'tr1', leftOccurrenceId: project.timeline.items[0].id, rightOccurrenceId: project.timeline.items[1].id, durationInFrames: 10, alignment: 0.4, presentation: 'chromatic' };
  const result = compileTechnique(request, project);
  assert.equal(result.ops.length, 1);
  assert.equal(result.ops[0].durationInFrames, 10);
  const check = result.checks.find(c => c.check === 'hidden-handles-inside-safe-shot-ranges');
  assert.equal(check.leftTailSourceFrames, 5); // 6 project frames * 24 / 30, rounded outwards
  assert.equal(check.rightHeadSourceFrames, 4); // 4 project frames * 24 / 30, rounded outwards
  assert.deepEqual(project, before);
});

test('transition refuses long duration, unsafe hidden handles, wrong adjacency and unknown shader', () => {
  const project = withItems();
  const request = { technique: 'transition', requestId: 'tr1', leftOccurrenceId: project.timeline.items[0].id, rightOccurrenceId: project.timeline.items[1].id, durationInFrames: 10, presentation: 'fade' };
  rejects({ ...request, durationInFrames: 90 }, project, 'TRANSITION_TOO_LONG');
  project.timeline.items[1].sourceStart = 724;
  project.timeline.items[1].sourceEnd = 796;
  rejects(request, project, 'UNSAFE_HANDLES');
  project.timeline.items[1].sourceStart = 744;
  project.timeline.items[1].sourceEnd = 816;
  rejects({ ...request, presentation: 'javascript:alert(1)' }, project, 'INVALID_ENUM');
  project.timeline.items[1].from++;
  rejects(request, project, 'NOT_ADJACENT');
});

test('transition validates combined incoming/outgoing pressure and source identity', () => {
  const project = withItems();
  const request = { technique: 'transition', requestId: 'tr1', leftOccurrenceId: project.timeline.items[0].id, rightOccurrenceId: project.timeline.items[1].id, durationInFrames: 10, presentation: 'fade' };
  project.timeline.items[0].mediaId = 'wrong-source';
  rejects(request, project, 'SOURCE_IDENTITY');
  project.timeline.items[0].mediaId = 'media-01';
  project.timeline.transitions.push({ trackId: 'v1', leftClipId: 'different', rightClipId: project.timeline.items[1].id, durationInFrames: 10, alignment: 0.5 });
  rejects(request, project, 'TRANSITION_PRESSURE');
});

test('transition tolerates native Freecut three-decimal FPS serialization, never a different frame rate', () => {
  const project = fixture(); project.madCatalog.assets[0].sourceFps = 24000 / 1001;
  withItems(project);
  const request = { technique: 'transition', requestId: 'tr-rounded', leftOccurrenceId: project.timeline.items[0].id, rightOccurrenceId: project.timeline.items[1].id, durationInFrames: 10, presentation: 'fade' };
  for (const item of project.timeline.items) item.sourceFps = 23.976;
  assert.equal(compileTechnique(request, project).ops.length, 1);
  project.timeline.items[1].sourceFps = 25;
  rejects(request, project, 'SOURCE_IDENTITY');
});

test('impact emits a bounded scale and RGB pulse, preserving existing effects and returning to rest', () => {
  const project = withItems(), item = project.timeline.items[0];
  item.effects = [{ id: 'existing', enabled: true, effect: { type: 'gpu-effect', gpuEffectType: 'gpu-contrast', params: { amount: 1.1 } } }];
  const result = compileTechnique({ technique: 'impact', requestId: 'hit1', occurrenceId: item.id, localFrame: 10, durationInFrames: 6, scale: 1.12, rgbAmount: 0.008 }, project);
  assert.equal(result.ops[0].updates.effects.length, 2);
  assert.deepEqual(result.ops.filter(op => op.property === 'width').map(op => [op.frame, op.value]), [[0, 1280], [10, 1280], [11, 1280 * 1.12], [16, 1280]]);
  const rgb = result.ops.filter(op => op.property?.startsWith('effect:gpu-rgb-split:'));
  assert.equal(rgb.at(-1).value, 0);
  assert.equal(rgb.at(-1).frame, 16);
  rejects({ technique: 'impact', requestId: 'hit2', occurrenceId: item.id, localFrame: 89, durationInFrames: 3 }, project, 'IMPACT_BOUNDS');
});

test('impact at local zero does not generate duplicate keyframes and rejects animation conflicts', () => {
  const project = withItems(), occurrenceId = project.timeline.items[0].id;
  const request = { technique: 'impact', requestId: 'hit', occurrenceId, localFrame: 0, durationInFrames: 6 };
  const ops = compileTechnique(request, project).ops.filter(op => op.op === 'addKeyframe');
  assert.equal(new Set(ops.map(op => `${op.property}:${op.frame}`)).size, ops.length);
  project.timeline.keyframes.push({ itemId: occurrenceId, properties: [{ property: 'width', keyframes: [] }] });
  rejects(request, project, 'ANIMATION_CONFLICT');
});

test('grade allows constrained shader parameters and rejects unlisted filters, keys and nonnumeric values', () => {
  const project = withItems();
  const request = { technique: 'grade', requestId: 'grade1', occurrenceIds: project.timeline.items.map(i => i.id), effects: [{ gpuEffectType: 'gpu-saturation', params: { amount: 0.85 } }] };
  assert.equal(compileTechnique(request, project).ops.length, 2);
  rejects({ ...request, effects: [{ gpuEffectType: 'gpu-lut', params: { url: 'http://evil.invalid' } }] }, project, 'INVALID_EFFECT');
  rejects({ ...request, effects: [{ gpuEffectType: 'gpu-saturation', params: { amount: 9 } }] }, project, 'INVALID_NUMBER');
  rejects({ ...request, effects: [{ gpuEffectType: 'gpu-saturation', params: { amount: 'eval(...)' } }] }, project, 'INVALID_NUMBER');
  rejects({ ...request, effects: [{ gpuEffectType: 'gpu-saturation', params: { amount: 1, shader: 'any code' } }] }, project, 'UNKNOWN_FIELD');
});

test('JIZURA creates an editable native text item with deterministic, restricted payload', () => {
  const project = fixture();
  const result = compileTechnique({ technique: 'text', requestId: 'title', trackId: 'titles', from: 8, durationInFrames: 24, text: '永不放弃', preset: 'kinetic', intensity: 0.6, seed: 73 }, project);
  assert.equal(result.ops[0].item.text, '永不放弃');
  assert.deepEqual(result.ops[0].item.jizura, { version: 1, preset: 'kinetic', seed: 73, intensity: 0.6, transparent: true, centerFree: false, accentColor: '#ff3366', backgroundColor: '#101018' });
  rejects({ technique: 'text', requestId: 'title', trackId: 'titles', from: 8, durationInFrames: 24, text: '文字', html: '<script>bad</script>' }, project, 'UNKNOWN_FIELD');
});

test('locks, fractional frames, malformed IDs and ID collisions cannot be bypassed', () => {
  rejects(repeat({ from: 0.5 }), fixture(), 'INVALID_NUMBER');
  rejects(repeat({ requestId: '../../payload' }), fixture(), 'INVALID_ID');
  rejects(repeat({ arbitraryCode: 'run()' }), fixture(), 'UNKNOWN_FIELD');
  const project = fixture(); project.timeline.tracks[0].locked = true;
  rejects(repeat(), project, 'LOCKED_TRACK');
  project.timeline.tracks[0].locked = false;
  project.timeline.items.push(compileTechnique(repeat(), project).ops[0].item);
  rejects(repeat({ from: 90 }), project, 'ID_COLLISION');
});

test('capability manifest is portable and contains no function, script, or mutable shared whitelist', () => {
  const manifest = describeCapabilities();
  assert.equal(JSON.parse(JSON.stringify(manifest)).version, 1);
  manifest.techniques.grade.effects['gpu-contrast'].amount[1] = 999;
  assert.equal(describeCapabilities().techniques.grade.effects['gpu-contrast'].amount[1], 1.8);
});
