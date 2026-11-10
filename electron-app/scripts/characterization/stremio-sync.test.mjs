import test from 'node:test';
import assert from 'node:assert/strict';
import { STREMIO_SESSION_ENDED, stremioSyncNote } from '../../src/lib/stremio-status.ts';

const now = Date.parse('2026-11-10T12:00:00Z');
const account = { email: 'me@example.com', linkedAt: '2026-11-10T11:00:00Z', lastSyncAt: '2026-11-10T11:57:00Z', lastError: '', imported: 4 };

test('a healthy link says when it last synced and how much came in', () => {
  assert.deepEqual(stremioSyncNote(account, now), { text: 'Synced 3 min ago · 4 updates brought in', problem: false });
  assert.equal(stremioSyncNote({ ...account, lastSyncAt: '2026-11-10T11:59:50Z', imported: 1 }, now).text, 'Synced just now · 1 update brought in');
  assert.equal(stremioSyncNote({ ...account, lastSyncAt: null }, now).text, 'Not synced yet');
});

test('Stremio ending the session asks to link again', () => {
  assert.deepEqual(stremioSyncNote({ ...account, lastError: STREMIO_SESSION_ENDED }, now), { text: 'Stremio signed TorWatch out. Link it again.', problem: true });
});

test('a failed sync is a problem the viewer sees, not the raw error', () => {
  const note = stremioSyncNote({ ...account, lastError: 'stremio datastoreGet: dial tcp: i/o timeout' }, now);
  assert.equal(note.problem, true);
  assert.doesNotMatch(note.text, /dial tcp/);
});
