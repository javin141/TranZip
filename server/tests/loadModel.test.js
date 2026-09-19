import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOAD_BANDS,
  averageScore,
  bandFromBusLoad,
  bandFromCrowdLevel,
  busTypeInfo,
  isLiveWindow,
  journeyLoadScore,
  scoreToBand,
} from '../lib/loadModel.js';

test('band scores are the values the README documents, ordered from quietest to busiest', () => {
  assert.equal(LOAD_BANDS.seats.score, 0.2);
  assert.equal(LOAD_BANDS.standing.score, 0.6);
  assert.equal(LOAD_BANDS.limited.score, 0.9);
  assert.equal(LOAD_BANDS.unknown.score, null); // unknown must never masquerade as a number
  assert.ok(LOAD_BANDS.seats.score < LOAD_BANDS.standing.score);
  assert.ok(LOAD_BANDS.standing.score < LOAD_BANDS.limited.score);
});

test('bus and rail codes that mean the same crowding land on the same band', () => {
  assert.equal(bandFromBusLoad('SEA'), bandFromCrowdLevel('l'));
  assert.equal(bandFromBusLoad('SDA'), bandFromCrowdLevel('m'));
  assert.equal(bandFromBusLoad('LSD'), bandFromCrowdLevel('h'));
});

test('a short crowded hop cannot outweigh a long comfortable ride (README worked example)', () => {
  // 5 min in limited standing (0.9) then 40 min with seats (0.2).
  const score = journeyLoadScore([
    { score: bandFromBusLoad('LSD').score, weightMinutes: 5 },
    { score: bandFromCrowdLevel('l').score, weightMinutes: 40 },
  ]);
  assert.ok(Math.abs(score - (0.9 * 5 + 0.2 * 40) / 45) < 1e-12);
  assert.equal(scoreToBand(score).key, 'seats');
});

test('the same legs in the opposite proportions flip the journey to a busier band', () => {
  const mostlyCrowded = journeyLoadScore([
    { score: 0.9, weightMinutes: 40 },
    { score: 0.2, weightMinutes: 5 },
  ]);
  assert.equal(scoreToBand(mostlyCrowded).key, 'limited');
});

test('busTypeInfo maps LTA bus types to a label and capacity, and ignores unknown types', () => {
  assert.deepEqual(busTypeInfo('SD'), { label: 'Single deck', capacity: 80 });
  assert.equal(busTypeInfo('dd').label, 'Double deck'); // case-insensitive
  assert.equal(busTypeInfo('BD').capacity, 120);
  assert.equal(busTypeInfo('XX'), null);
  assert.equal(busTypeInfo(undefined), null);
});

test('bandFromBusLoad maps LTA Load codes to bands', () => {
  assert.equal(bandFromBusLoad('SEA').key, 'seats');
  assert.equal(bandFromBusLoad('sda').key, 'standing'); // case-insensitive
  assert.equal(bandFromBusLoad('LSD').key, 'limited');
  assert.equal(bandFromBusLoad(undefined).key, 'unknown');
  assert.equal(bandFromBusLoad('garbage').key, 'unknown');
});

test('bandFromCrowdLevel maps LTA CrowdLevel codes to bands', () => {
  assert.equal(bandFromCrowdLevel('l').key, 'seats');
  assert.equal(bandFromCrowdLevel('M').key, 'standing'); // case-insensitive
  assert.equal(bandFromCrowdLevel('h').key, 'limited');
  assert.equal(bandFromCrowdLevel(null).key, 'unknown');
});

test('averageScore ignores unknown (null) samples and averages the rest', () => {
  assert.equal(averageScore([0.2, 0.6]), 0.4);
  assert.equal(averageScore([0.2, null, 0.6]), 0.4);
  assert.equal(averageScore([null, null]), null);
  assert.equal(averageScore([]), null);
});

test('journeyLoadScore weights each leg by time on board', () => {
  // 10 min at 0.2 (seats) + 30 min at 0.8 (busy) -> pulled toward the longer leg.
  const score = journeyLoadScore([
    { score: 0.2, weightMinutes: 10 },
    { score: 0.8, weightMinutes: 30 },
  ]);
  assert.equal(score, (0.2 * 10 + 0.8 * 30) / 40);
});

test('journeyLoadScore ignores legs with no known score or zero weight', () => {
  const score = journeyLoadScore([
    { score: null, weightMinutes: 10 },
    { score: 0.5, weightMinutes: 0 },
    { score: 0.3, weightMinutes: 5 },
  ]);
  assert.equal(score, 0.3);
});

test('journeyLoadScore returns null when nothing is known', () => {
  assert.equal(journeyLoadScore([{ score: null, weightMinutes: 10 }]), null);
  assert.equal(journeyLoadScore([]), null);
});

test('scoreToBand buckets a 0-1 score into seats/standing/limited', () => {
  assert.equal(scoreToBand(0.1).key, 'seats');
  assert.equal(scoreToBand(0.44).key, 'seats');
  assert.equal(scoreToBand(0.45).key, 'standing');
  assert.equal(scoreToBand(0.74).key, 'standing');
  assert.equal(scoreToBand(0.75).key, 'limited');
  assert.equal(scoreToBand(null).key, 'unknown');
});

test('isLiveWindow is true only within the given window ahead of now', () => {
  const now = Date.parse('2026-01-01T12:00:00+08:00');
  assert.equal(isLiveWindow('2026-01-01T12:20:00+08:00', 25, now), true);
  assert.equal(isLiveWindow('2026-01-01T12:30:00+08:00', 25, now), false);
  assert.equal(isLiveWindow('2026-01-01T11:00:00+08:00', 25, now), true); // already due
});
