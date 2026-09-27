/**
 * A bounded, model-facing MAD edit vocabulary compiled to Freecut headless ops.
 * No network, code evaluation, media mutation, or model calls occur here.
 * All ranges are half-open. Source frames use sourceFps; timeline/keyframes use
 * project fps. A new occurrence can deliberately reuse the very same shot.
 */
const VERSION = 1;
const TECHNIQUES = ['repeat', 'reprise', 'intercut', 'stutter', 'impact', 'transition', 'grade', 'text'];
const TRANSITIONS = ['fade', 'wipe', 'slide', 'dissolve', 'additiveDissolve', 'blurDissolve', 'dipToColorDissolve', 'glitch', 'chromatic', 'radialBlur', 'lensWarpZoom'];
const GRADES = {
  'gpu-contrast': { amount: [0.5, 1.8] },
  'gpu-saturation': { amount: [0, 1.8] },
  'gpu-temperature': { temperature: [-0.6, 0.6], tint: [-0.4, 0.4] },
  'gpu-grayscale': { amount: [0, 1] },
  'gpu-exposure': { exposure: [-1, 1] },
};
const SEGMENT_KEYS = ['shotId', 'sourceIn', 'sourceOut', 'speed', 'durationInFrames', 'volumeDb'];
const COMMON_KEYS = ['technique', 'requestId'];
const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class TechniqueValidationError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'TechniqueValidationError'; this.code = code; this.details = details; }
}
function fail(code, message, details) { throw new TechniqueValidationError(code, message, details); }
function object(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${name} must be an object`); return value; }
function only(value, fields, name) {
  object(value, name);
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail('UNKNOWN_FIELD', `${name}.${key} is not allowed`);
}
function number(value, min, max, name, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail('INVALID_NUMBER', `${name} must be ${integer ? 'an integer' : 'finite'} in [${min}, ${max}]`);
  return value;
}
function frame(value, name, min = 0) { return number(value, min, Number.MAX_SAFE_INTEGER, name, true); }
function id(value, name) { if (typeof value !== 'string' || !safeId.test(value)) fail('INVALID_ID', `${name} must be a portable ID of at most 64 characters`); return value; }
function member(value, values, name) { if (!values.includes(value)) fail('INVALID_ENUM', `${name} must be one of ${values.join(', ')}`); return value; }
function boolean(value, name) { if (typeof value !== 'boolean') fail('INVALID_INPUT', `${name} must be boolean`); return value; }
function color(value, name) { if (typeof value !== 'string' || !/^#[a-f0-9]{6}$/i.test(value)) fail('INVALID_COLOR', `${name} must be a six-digit hex color`); return value; }
function boundedText(value, name, max = 140) { if (typeof value !== 'string' || !value.trim() || [...value].length > max || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value)) fail('INVALID_TEXT', `${name} must be nonempty plain text of at most ${max} characters`); return value; }
function roundSourceFrames(timelineFrames, sourceFps, fps, speed) { return Math.ceil(timelineFrames * sourceFps * speed / fps - 1e-9); }

export function describeCapabilities() {
  return {
    version: VERSION,
    engine: 'freecut-headless',
    units: { from: 'integer project frames', durationInFrames: 'integer project frames', localFrame: 'integer item-local project frames', sourceIn: 'integer source-native frames, inclusive', sourceOut: 'integer source-native frames, exclusive', volumeDb: 'dB [-60, 6]; -60 mutes the new video occurrence', speed: 'source playback rate [0.25, 4]' },
    identities: { assetId: 'one media asset', shotId: 'one bounded shot inside an asset', occurrenceId: 'one independently editable use of that shot; generated item.id' },
    constraints: ['Existing project is never mutated by compilation.', 'Explicit reuse is allowed; every use has a separate occurrence ID.', 'Visible source ranges and hidden transition handles must stay inside one safe shot range.', 'New clips cannot overlap existing items on the same track unless replaceOccurrenceIds explicitly names them.', 'No arbitrary script, shader, URL, effect name, or effect parameter is accepted.'],
    techniques: {
      repeat: { fields: ['requestId', 'trackId', 'from', 'segment', 'count', 'gapFrames?', 'replaceOccurrenceIds?'], count: [2, 8], description: 'Repeat exactly the same bounded source range with distinct occurrences.' },
      reprise: { fields: ['requestId', 'trackId', 'from', 'segment', 'count', 'gapFrames?', 'replaceOccurrenceIds?'], description: 'Repeat/reprise alias; place recalls with explicit gaps without changing other items.' },
      intercut: { fields: ['requestId', 'trackId', 'from', 'segments', 'replaceOccurrenceIds?'], segments: [2, 16], description: 'Compile the given order, including A1-B-A2-C-A3. Source intervals may deliberately recur.' },
      stutter: { fields: ['requestId', 'trackId', 'from', 'segment', 'count', 'replaceOccurrenceIds?'], count: [2, 8], maxFragmentSeconds: 0.5, description: 'Consecutive short repeated fragments; min 2 project frames each.' },
      impact: { fields: ['requestId', 'occurrenceId', 'localFrame', 'durationInFrames', 'scale?', 'rgbAmount?', 'rgbAngle?'], scale: [1, 1.25], rgbAmount: [0, 0.025], description: 'Short width/height and RGB split pulse which explicitly returns to rest.' },
      transition: { fields: ['requestId', 'leftOccurrenceId', 'rightOccurrenceId', 'durationInFrames', 'presentation', 'alignment?', 'direction?'], presentations: [...TRANSITIONS], description: 'Cut-centered transition; no timeline shift, no silent duration clamping.' },
      grade: { fields: ['requestId', 'occurrenceIds', 'effects'], effects: structuredClone(GRADES), description: 'Only bounded known grading shader parameters.' },
      text: { fields: ['requestId', 'trackId', 'from', 'durationInFrames', 'text', 'renderer?', 'preset?', 'intensity?', 'seed?', 'color?', 'accentColor?', 'backgroundColor?', 'transparent?', 'centerFree?', 'fontSize?', 'fontFamily?', 'replaceOccurrenceIds?'], renderer: ['jizura', 'native'], preset: ['impact', 'kinetic', 'quiet'], description: 'Editable plain text with a deterministic JIZURA payload; no supplied HTML/JS.' },
    },
    segment: { required: ['shotId', 'sourceIn', 'sourceOut'], optional: ['speed', 'durationInFrames', 'volumeDb'] },
  };
}

function context(project, request) {
  object(project, 'project'); object(project.metadata, 'project.metadata'); object(project.timeline, 'project.timeline');
  const fps = number(project.metadata.fps, 1, 240, 'project.metadata.fps');
  const items = project.timeline.items ?? [], tracks = project.timeline.tracks ?? [];
  if (!Array.isArray(items) || !Array.isArray(tracks)) fail('INVALID_PROJECT', 'timeline items and tracks must be arrays');
  const catalog = project.madCatalog ?? { assets: [], shots: [] };
  const assets = new Map((catalog.assets ?? []).map(asset => [asset.assetId, asset]));
  const shots = new Map((catalog.shots ?? []).map(shot => [shot.shotId, shot]));
  const ctx = { project, fps, items, tracks, assets, shots, request, checks: [], occurrences: [] };
  ctx.checks.push({ check: 'integer-timeline-and-source-frames', passed: true, projectFps: fps });
  return ctx;
}
function requireTrack(ctx, trackId) {
  id(trackId, 'trackId');
  const track = ctx.tracks.find(t => t.id === trackId);
  if (!track || (track.type ?? track.kind) === 'audio') fail('INVALID_TRACK', 'A pre-existing visual track is required', { trackId });
  if (track.locked || track.isLocked) fail('LOCKED_TRACK', `Track ${trackId} is locked`);
  return track;
}
function requireItem(ctx, occurrenceId, { video = false } = {}) {
  id(occurrenceId, 'occurrenceId');
  const item = ctx.items.find(i => i.id === occurrenceId);
  if (!item || (video && item.type !== 'video')) fail('INVALID_OCCURRENCE', 'Referenced occurrence does not exist or is not video', { occurrenceId });
  requireTrack(ctx, item.trackId);
  if (item.locked || item.isLocked) fail('LOCKED_ITEM', `${occurrenceId} is locked`);
  return item;
}
function catalogRange(ctx, shotId, sourceIn, sourceOut) {
  const shot = ctx.shots.get(id(shotId, 'shotId'));
  if (!shot) fail('UNKNOWN_SHOT', `No catalog shot ${shotId}`);
  const asset = ctx.assets.get(shot.assetId);
  if (!asset) fail('UNKNOWN_ASSET', `No catalog asset ${shot.assetId}`);
  id(asset.mediaId, 'asset.mediaId');
  number(asset.sourceFps, 1, 240, 'asset.sourceFps'); frame(asset.sourceDurationFrames, 'asset.sourceDurationFrames', 1);
  frame(shot.sourceIn, 'shot.sourceIn'); frame(shot.sourceOut, 'shot.sourceOut', shot.sourceIn + 1);
  frame(sourceIn, 'sourceIn'); frame(sourceOut, 'sourceOut', sourceIn + 1);
  if (shot.sourceOut > asset.sourceDurationFrames || sourceIn < shot.sourceIn || sourceOut > shot.sourceOut) fail('SOURCE_BOUNDS', 'Requested range crosses a shot or source boundary', { shotId, sourceIn, sourceOut, allowed: [shot.sourceIn, shot.sourceOut] });
  const ranges = shot.safeRanges ?? [{ sourceIn: shot.sourceIn, sourceOut: shot.sourceOut }];
  if (!Array.isArray(ranges) || ranges.length === 0) fail('UNSAFE_SHOT', 'Shot has no verified safe source range', { shotId });
  for (const range of ranges) {
    frame(range.sourceIn, 'safeRange.sourceIn'); frame(range.sourceOut, 'safeRange.sourceOut', range.sourceIn + 1);
    if (range.sourceIn < shot.sourceIn || range.sourceOut > shot.sourceOut) fail('INVALID_PROJECT', 'Catalog safeRange lies outside its shot', { shotId });
  }
  const safe = ranges.find(r => sourceIn >= r.sourceIn && sourceOut <= r.sourceOut);
  if (!safe) fail('UNSAFE_SHOT', 'Source range crosses an unsafe cut/transition region', { shotId, sourceIn, sourceOut });
  return { shot, asset, safe };
}
function occurrenceRange(ctx, item) {
  if (item.isReversed) fail('UNSUPPORTED_TIMING', 'Reverse clips require separately conformed source handles');
  const shotId = item.mad?.shotId ?? item.shotId;
  if (!shotId) fail('MISSING_PROVENANCE', 'A catalog shotId is required to validate hidden handles', { occurrenceId: item.id });
  const range = catalogRange(ctx, shotId, item.sourceStart, item.sourceEnd);
  // Freecut persistence rounds FPS to three decimals (23.976 / 29.970).
  // Accept that serialization precision, while all safety arithmetic continues
  // to use the catalog's exact source-native rate.
  if (!Number.isFinite(item.sourceFps) || item.mediaId !== range.asset.mediaId || Math.abs(item.sourceFps - range.asset.sourceFps) > 0.0005) fail('SOURCE_IDENTITY', 'Occurrence source identity/FPS differs from its catalog asset');
  const speed = number(item.speed ?? 1, 0.25, 4, 'item.speed');
  const needed = roundSourceFrames(item.durationInFrames, range.asset.sourceFps, ctx.fps, speed);
  if (item.sourceStart + needed > item.sourceEnd) fail('SOURCE_LENGTH', 'Visible timeline duration exceeds available source frames');
  return { ...range, speed, visibleSourceEnd: item.sourceStart + needed };
}
function newId(ctx, suffix) {
  const occurrenceId = `mad-${ctx.request.requestId}-${suffix}`;
  id(occurrenceId, 'generated occurrenceId');
  if (ctx.items.some(item => item.id === occurrenceId) || ctx.occurrences.some(item => item.occurrenceId === occurrenceId)) fail('ID_COLLISION', 'requestId already exists in project; use revision/idempotency handling before applying again', { occurrenceId });
  return occurrenceId;
}
function replacementOps(ctx, request) {
  const ids = request.replaceOccurrenceIds ?? [];
  if (!Array.isArray(ids) || ids.length > 64 || new Set(ids).size !== ids.length) fail('INVALID_REPLACEMENT', 'replaceOccurrenceIds must contain up to 64 unique occurrence IDs');
  for (const occurrenceId of ids) {
    const item = requireItem(ctx, occurrenceId);
    if (item.trackId !== request.trackId) fail('INVALID_REPLACEMENT', 'Replacement can only remove explicitly named items on the target track');
  }
  return ids.length ? [{ op: 'removeItems', ids: [...ids] }] : [];
}
function checkPlacement(ctx, request, newItems) {
  const removed = new Set(request.replaceOccurrenceIds ?? []);
  const occupied = ctx.items.filter(item => item.trackId === request.trackId && !removed.has(item.id));
  for (const item of newItems) {
    for (const other of occupied) if (item.from < other.from + other.durationInFrames && item.from + item.durationInFrames > other.from) fail('TIMELINE_COLLISION', 'New occurrence overlaps an existing item on the same track', { occurrenceId: other.id });
    occupied.push(item);
  }
  ctx.checks.push({ check: 'nonoverlapping-timeline-placement', passed: true, newOccurrences: newItems.length });
}
function segmentItem(ctx, segment, trackId, from, index) {
  only(segment, SEGMENT_KEYS, `segment[${index}]`);
  const { shot, asset, safe } = catalogRange(ctx, segment.shotId, segment.sourceIn, segment.sourceOut);
  const speed = number(segment.speed ?? 1, 0.25, 4, 'speed');
  const maxDuration = Math.floor((segment.sourceOut - segment.sourceIn) * ctx.fps / (asset.sourceFps * speed) + 1e-9);
  const durationInFrames = frame(segment.durationInFrames ?? maxDuration, 'durationInFrames', 2);
  if (durationInFrames > maxDuration) fail('SOURCE_LENGTH', 'Visible timeline duration exceeds available source frames', { durationInFrames, maxDuration });
  frame(from + durationInFrames, 'occurrence end frame', 1);
  const sourceEnd = segment.sourceIn + roundSourceFrames(durationInFrames, asset.sourceFps, ctx.fps, speed);
  const occurrenceId = newId(ctx, `o${index}`);
  const volumeDb = number(segment.volumeDb ?? -60, -60, 6, 'volumeDb');
  const item = {
    type: 'video', id: occurrenceId, trackId, from, durationInFrames,
    label: `${ctx.request.technique} · ${shot.shotId}`, mediaId: asset.mediaId, src: asset.src ?? '',
    sourceStart: segment.sourceIn, sourceEnd, sourceDuration: asset.sourceDurationFrames, sourceFps: asset.sourceFps,
    speed, volume: volumeDb, embeddedAudioMuted: volumeDb <= -60,
    ...(asset.width ? { sourceWidth: asset.width } : {}), ...(asset.height ? { sourceHeight: asset.height } : {}),
    mad: { version: VERSION, assetId: asset.assetId, shotId: shot.shotId, occurrenceId, technique: ctx.request.technique, intentionalReuse: true, safeSourceIn: safe.sourceIn, safeSourceOut: safe.sourceOut },
  };
  ctx.occurrences.push({ assetId: asset.assetId, shotId: shot.shotId, occurrenceId, from, durationInFrames, sourceIn: item.sourceStart, sourceOut: item.sourceEnd, sourceFps: asset.sourceFps });
  return item;
}
function compileSequence(ctx, request) {
  const intercut = request.technique === 'intercut';
  only(request, [...COMMON_KEYS, 'trackId', 'from', ...(intercut ? ['segments'] : ['segment', 'count', ...(request.technique !== 'stutter' ? ['gapFrames'] : [])]), 'replaceOccurrenceIds'], 'request');
  requireTrack(ctx, request.trackId); let from = frame(request.from, 'from');
  let segments;
  if (intercut) {
    if (!Array.isArray(request.segments) || request.segments.length < 2 || request.segments.length > 16) fail('INVALID_SEQUENCE', 'intercut needs 2–16 segments');
    segments = request.segments;
  } else segments = Array.from({ length: number(request.count, 2, 8, 'count', true) }, () => request.segment);
  const gap = frame(request.gapFrames ?? 0, 'gapFrames');
  if (gap > ctx.fps * 60) fail('INVALID_NUMBER', 'gapFrames must be at most 60 seconds');
  const ops = replacementOps(ctx, request), added = [];
  for (const [index, segment] of segments.entries()) {
    const item = segmentItem(ctx, segment, request.trackId, from, index);
    if (request.technique === 'stutter' && item.durationInFrames > Math.floor(ctx.fps * 0.5)) fail('STUTTER_TOO_LONG', 'Each stutter fragment must be at most 0.5 seconds');
    added.push(item); ops.push({ op: 'addItem', item }); from += item.durationInFrames + gap;
  }
  checkPlacement(ctx, request, added);
  ctx.checks.push({ check: 'visible-source-ranges-inside-safe-shots', passed: true }, { check: 'intentional-reuse-with-distinct-occurrence-ids', passed: true });
  return { ops, explanation: `按给定顺序创建 ${added.length} 个独立片段；允许有意复用同一镜头，所有可见帧仍限制在安全源区间。` };
}
function compileTransition(ctx, request) {
  only(request, [...COMMON_KEYS, 'leftOccurrenceId', 'rightOccurrenceId', 'durationInFrames', 'presentation', 'alignment', 'direction'], 'request');
  const left = requireItem(ctx, request.leftOccurrenceId, { video: true }), right = requireItem(ctx, request.rightOccurrenceId, { video: true });
  if (left.trackId !== right.trackId || left.from + left.durationInFrames !== right.from) fail('NOT_ADJACENT', 'Transition requires exactly adjacent video occurrences on one track');
  const duration = frame(request.durationInFrames, 'durationInFrames', 1);
  if (duration >= Math.min(left.durationInFrames, right.durationInFrames) || duration > ctx.fps) fail('TRANSITION_TOO_LONG', 'MAD transition must be at most one second and shorter than each visible clip');
  const alignment = number(request.alignment ?? 0.5, 0, 1, 'alignment');
  const before = Math.floor(duration * alignment), after = duration - before;
  const l = occurrenceRange(ctx, left), r = occurrenceRange(ctx, right);
  const leftTail = roundSourceFrames(after, l.asset.sourceFps, ctx.fps, l.speed);
  const rightHead = roundSourceFrames(before, r.asset.sourceFps, ctx.fps, r.speed);
  if (left.sourceEnd + leftTail > l.safe.sourceOut || right.sourceStart - rightHead < r.safe.sourceIn) fail('UNSAFE_HANDLES', 'Transition hidden handles would cross a shot boundary or unsafe cut', { leftNeededSourceOut: left.sourceEnd + leftTail, leftSafeSourceOut: l.safe.sourceOut, rightNeededSourceIn: right.sourceStart - rightHead, rightSafeSourceIn: r.safe.sourceIn });
  const existing = ctx.project.timeline.transitions ?? [];
  if (existing.some(t => t.leftClipId === left.id && t.rightClipId === right.id)) fail('TRANSITION_EXISTS', 'This cut already has a transition');
  const start = right.from - before, end = right.from + after;
  for (const t of existing) {
    if (t.trackId !== left.trackId) continue;
    const incoming = ctx.items.find(i => i.id === t.rightClipId);
    if (!incoming) continue;
    const tStart = incoming.from - Math.floor(t.durationInFrames * (t.alignment ?? 0.5));
    if (start < tStart + t.durationInFrames && end > tStart) fail('TRANSITION_PRESSURE', 'Transition window overlaps another transition; shorten it explicitly');
  }
  const op = { op: 'addTransition', leftClipId: left.id, rightClipId: right.id, type: 'crossfade', durationInFrames: duration, presentation: member(request.presentation, TRANSITIONS, 'presentation'), alignment, timing: 'linear' };
  if (request.direction !== undefined) op.direction = member(request.direction, ['from-left', 'from-right', 'from-top', 'from-bottom'], 'direction');
  ctx.checks.push({ check: 'hidden-handles-inside-safe-shot-ranges', passed: true, leftTailSourceFrames: leftTail, rightHeadSourceFrames: rightHead }, { check: 'cut-centered-no-timeline-shift', passed: true });
  return { ops: [op], explanation: `在切点两侧使用 ${duration} 帧转场；隐藏画面也没有跨越原片镜头边界。` };
}
function compileImpact(ctx, request) {
  only(request, [...COMMON_KEYS, 'occurrenceId', 'localFrame', 'durationInFrames', 'scale', 'rgbAmount', 'rgbAngle'], 'request');
  const item = requireItem(ctx, request.occurrenceId, { video: true });
  const start = frame(request.localFrame, 'localFrame'), duration = frame(request.durationInFrames, 'durationInFrames', 2);
  if (start + duration >= item.durationInFrames || duration > ctx.fps * 0.5) fail('IMPACT_BOUNDS', 'Impact needs a rest frame after its pulse and must be at most 0.5 seconds');
  const scale = number(request.scale ?? 1.08, 1, 1.25, 'scale');
  const rgbAmount = number(request.rgbAmount ?? 0.006, 0, 0.025, 'rgbAmount'), rgbAngle = number(request.rgbAngle ?? 0, 0, Math.PI * 2, 'rgbAngle');
  const dimensions = { width: number(ctx.project.metadata.width, 1, 16384, 'project.width'), height: number(ctx.project.metadata.height, 1, 16384, 'project.height') };
  const fit = item.sourceWidth > 0 && item.sourceHeight > 0 ? Math.min(dimensions.width / item.sourceWidth, dimensions.height / item.sourceHeight) : 1;
  const width = item.transform?.width ?? (item.sourceWidth ? item.sourceWidth * fit : dimensions.width), height = item.transform?.height ?? (item.sourceHeight ? item.sourceHeight * fit : dimensions.height);
  const keyed = (ctx.project.timeline.keyframes ?? []).find(k => k.itemId === item.id);
  if (keyed?.properties?.some(p => ['width', 'height'].includes(p.property))
      || keyed?.vectorProperties?.some(p => p.property === 'scale')
      || keyed?.expressions?.length || keyed?.propertyLinks?.length
      || item.motionModifiers?.length || item.motionLayers?.length) fail('ANIMATION_CONFLICT', 'Existing scale/procedural animation must be composed explicitly before adding impact');
  const ops = [], peak = start + 1, end = start + duration;
  for (const [property, base] of [['width', width], ['height', height]]) {
    for (const [at, value, easing] of [[0, base, 'hold'], [start, base, 'linear'], [peak, base * scale, 'ease-out'], [end, base, 'hold']]) {
      if (at === 0 && start === 0 && ops.some(op => op.property === property)) continue;
      ops.push({ op: 'addKeyframe', itemId: item.id, property, frame: at, value, easing });
    }
  }
  if (rgbAmount > 0) {
    const effectId = newId(ctx, 'rgb');
    if ((item.effects ?? []).some(e => e.id === effectId)) fail('ID_COLLISION', 'Impact already exists');
    const effect = { id: effectId, enabled: true, effect: { type: 'gpu-effect', gpuEffectType: 'gpu-rgb-split', params: { amount: 0, angle: rgbAngle } } };
    ops.unshift({ op: 'updateItem', id: item.id, updates: { effects: [...(item.effects ?? []), effect] } });
    const property = `effect:gpu-rgb-split:${effectId}:amount`;
    for (const [at, value, easing] of [[0, 0, 'hold'], [start, 0, 'linear'], [peak, rgbAmount, 'ease-out'], [end, 0, 'hold']]) {
      if (at === 0 && start === 0 && ops.some(op => op.property === property)) continue;
      ops.push({ op: 'addKeyframe', itemId: item.id, property, frame: at, value, easing });
    }
  }
  ctx.checks.push({ check: 'impact-is-bounded-and-returns-to-rest', passed: true, localStartFrame: start, localEndFrame: end });
  return { ops, explanation: '将重音强化编译为短促缩放与 RGB 分离关键帧，脉冲后回到原值。' };
}
function compileGrade(ctx, request) {
  only(request, [...COMMON_KEYS, 'occurrenceIds', 'effects'], 'request');
  if (!Array.isArray(request.occurrenceIds) || request.occurrenceIds.length < 1 || request.occurrenceIds.length > 32 || new Set(request.occurrenceIds).size !== request.occurrenceIds.length) fail('INVALID_OCCURRENCE', 'grade needs 1–32 unique occurrence IDs');
  if (!Array.isArray(request.effects) || request.effects.length < 1 || request.effects.length > 4) fail('INVALID_EFFECT', 'grade needs 1–4 whitelisted effects');
  const effects = request.effects.map(effect => {
    only(effect, ['gpuEffectType', 'params'], 'effect');
    if (!Object.hasOwn(GRADES, effect.gpuEffectType)) fail('INVALID_EFFECT', 'Effect is not in the grading whitelist');
    const ranges = GRADES[effect.gpuEffectType]; only(effect.params, Object.keys(ranges), 'effect.params');
    if (!Object.keys(effect.params).length) fail('INVALID_EFFECT', 'Effect needs explicit parameters');
    for (const [key, value] of Object.entries(effect.params)) number(value, ...ranges[key], `effect.params.${key}`);
    return structuredClone(effect);
  });
  const ops = [];
  for (const occurrenceId of request.occurrenceIds) {
    const item = requireItem(ctx, occurrenceId, { video: true });
    if ((item.effects ?? []).length + effects.length > 8) fail('EFFECT_BUDGET', 'An occurrence can have at most 8 effects through this API');
    for (const effect of effects) ops.push({ op: 'addEffect', itemId: item.id, ...effect });
  }
  ctx.checks.push({ check: 'fixed-effect-and-parameter-whitelist', passed: true });
  return { ops, explanation: '只应用已验证参数范围内的调色效果，保留其他图层和音频。' };
}
function compileText(ctx, request) {
  only(request, [...COMMON_KEYS, 'trackId', 'from', 'durationInFrames', 'text', 'renderer', 'preset', 'intensity', 'seed', 'color', 'accentColor', 'backgroundColor', 'transparent', 'centerFree', 'fontSize', 'fontFamily', 'replaceOccurrenceIds'], 'request');
  requireTrack(ctx, request.trackId);
  const from = frame(request.from, 'from'), duration = frame(request.durationInFrames, 'durationInFrames', 2);
  if (duration > ctx.fps * 30) fail('TEXT_TOO_LONG', 'One text cue must be at most 30 seconds');
  const renderer = member(request.renderer ?? 'jizura', ['jizura', 'native'], 'renderer');
  const item = { id: newId(ctx, 'text'), type: 'text', trackId: request.trackId, from, durationInFrames: duration, label: 'MAD typography', text: boundedText(request.text, 'text'), color: color(request.color ?? '#ffffff', 'color'), fontSize: number(request.fontSize ?? 100, 16, 400, 'fontSize'), fontFamily: boundedText(request.fontFamily ?? 'sans-serif', 'fontFamily', 80), fontWeight: 'bold', textAlign: 'center', verticalAlign: 'middle' };
  if (renderer === 'jizura') item.jizura = { version: 1, preset: member(request.preset ?? 'impact', ['impact', 'kinetic', 'quiet'], 'preset'), seed: number(request.seed ?? 42, 0, 0xffffffff, 'seed', true), intensity: number(request.intensity ?? 0.7, 0, 1, 'intensity'), transparent: boolean(request.transparent ?? true, 'transparent'), centerFree: boolean(request.centerFree ?? false, 'centerFree'), accentColor: color(request.accentColor ?? '#ff3366', 'accentColor'), backgroundColor: color(request.backgroundColor ?? '#101018', 'backgroundColor') };
  checkPlacement(ctx, request, [item]);
  ctx.checks.push({ check: 'plain-text-deterministic-renderer-payload', passed: true, renderer });
  return { ops: [...replacementOps(ctx, request), { op: 'addItem', item }], explanation: `创建可编辑的 ${renderer === 'jizura' ? 'JIZURA 动态' : '原生'}文字图层。` };
}

/** Compile one request against the exact project revision that will be edited. */
export function compileTechnique(request, project) {
  object(request, 'request'); member(request.technique, TECHNIQUES, 'technique');
  id(request.requestId, 'requestId');
  if (request.requestId.length > 40) fail('INVALID_ID', 'requestId must be at most 40 characters');
  const ctx = context(project, request);
  const result = ['repeat', 'reprise', 'intercut', 'stutter'].includes(request.technique) ? compileSequence(ctx, request)
    : request.technique === 'transition' ? compileTransition(ctx, request)
      : request.technique === 'impact' ? compileImpact(ctx, request)
        : request.technique === 'grade' ? compileGrade(ctx, request) : compileText(ctx, request);
  return { version: VERSION, technique: request.technique, requestId: request.requestId, ...result, checks: ctx.checks, occurrences: ctx.occurrences };
}
