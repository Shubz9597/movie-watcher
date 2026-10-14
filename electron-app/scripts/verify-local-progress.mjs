// Writes only synthetic profiles into the task's disposable local server.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postProgress, fetchResumePosition } from '../electron/playback/progress-api.js';

const origin = process.argv[2] || 'http://127.0.0.1:18081';
const url = new URL(origin);
if (url.hostname !== '127.0.0.1' || url.port !== '18081') throw new Error('This verifier only targets the disposable local server on 127.0.0.1:18081.');
const subjectId = `verification-${randomUUID()}`;
const desktop = { subjectId, seriesId: 'anilist:6033', season: 1, episode: 21, clientId: randomUUID(), sessionId: randomUUID(), seq: 1 };
const phone = { ...desktop, clientId: randomUUID(), sessionId: randomUUID() };
await postProgress(origin, desktop, 120, 1440);
assert.equal(await fetchResumePosition(origin, phone), 105, 'phone resumes desktop progress with the server rewind');
await postProgress(origin, phone, 345, 1440);
assert.equal(await fetchResumePosition(origin, desktop), 330, 'desktop resumes phone progress');
await postProgress(origin, desktop, 20, 1440);
assert.equal(await fetchResumePosition(origin, phone), 330, 'old desktop sequence does not overwrite the newer phone checkpoint');
await postProgress(origin, { ...desktop, seq: 2 }, 80, 1440);
assert.equal(await fetchResumePosition(origin, phone), 65, 'a deliberate later rewind is accepted');
const list = await (await fetch(`${origin}/v1/continue?subjectId=${subjectId}`)).json();
assert.ok(list.some((row) => row.seriesId === desktop.seriesId && row.episode === 21));
const separate = await (await fetch(`${origin}/v1/continue?subjectId=verification-${randomUUID()}`)).json();
assert.deepEqual(separate, [], 'same database does not join unrelated viewing IDs');
console.log('LOCAL_SHARED_PROGRESS=PASS (desktop→phone, phone→desktop, stale sequence protection, rewind, profile isolation; real PostgreSQL)');
