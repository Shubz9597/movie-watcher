import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeHashNavigation, navigateHash, goBackHash } from '../../src/lib/hash-navigation.ts';
import { SettingsOverlayController } from '../../src/mobile/settings-overlay-controller.ts';

// Browser-history model: back/forward restores both the route and its state.
function browserAt(hash = '#home') {
  const target = new EventTarget();
  const entries = [{ hash, state: null }];
  let position = 0;
  target.location = { hash };
  const update = () => {
    target.location.hash = entries[position].hash;
    target.dispatchEvent(new Event('popstate'));
  };
  target.history = {
    get state() { return entries[position].state; },
    get length() { return entries.length; },
    replaceState(state, _, url) {
      entries[position] = { state, hash: url ?? target.location.hash };
      target.location.hash = entries[position].hash;
    },
    pushState(state, _, url) {
      entries.splice(++position);
      entries.push({ state, hash: url ?? target.location.hash });
      target.location.hash = entries[position].hash;
    },
    back() { if (position > 0) { position--; update(); } },
    forward() { if (position < entries.length - 1) { position++; update(); } },
  };
  initializeHashNavigation(target);
  return target;
}

test('Back traverses nested pages with the full query; forward restores the title', () => {
  const target = browserAt();
  navigateHash(target, 'see-all', { title: 'Comedy movies', api: 'tmdb:genre:movie:35', kind: 'movie' });
  const collection = target.location.hash;
  navigateHash(target, 'title', { kind: 'movie', id: '42' });
  goBackHash(target);
  assert.equal(target.location.hash, collection);
  target.history.forward();
  assert.equal(target.location.hash, '#title?kind=movie&id=42');
  goBackHash(target);
  goBackHash(target);
  assert.equal(target.location.hash, '#home');
});

test('a deep link falls back to Home without leaving the app or adding a Back loop', () => {
  const target = browserAt('#title?kind=movie&id=42');
  goBackHash(target);
  assert.equal(target.location.hash, '#home');
  assert.equal(target.history.length, 1);
  goBackHash(target);
  assert.equal(target.history.length, 1);
});

test('reloading preserves navigation and repeated navigation creates no duplicate entry', () => {
  const target = browserAt();
  navigateHash(target, 'library', { collection: 'favourites', sort: 'title' });
  navigateHash(target, 'library', { collection: 'favourites', sort: 'title' });
  initializeHashNavigation(target);
  assert.equal(target.history.length, 2);
  goBackHash(target);
  assert.equal(target.location.hash, '#home');
});

test('selecting a search result replaces its overlay entry; Back returns to its originating page', () => {
  const target = browserAt();
  navigateHash(target, 'library');
  target.history.pushState({ ...target.history.state, torwatchOverlay: 'search' }, '');
  navigateHash(target, 'title', { id: '42' });
  assert.equal(target.history.length, 3);
  assert.equal(target.history.state.torwatchOverlay, undefined);
  goBackHash(target);
  assert.equal(target.location.hash, '#library');
  goBackHash(target);
  assert.equal(target.location.hash, '#home');
});

test('selecting the current page leaves exactly one overlay dismissal to the dialog', () => {
  const target = browserAt();
  navigateHash(target, 'title', { id: '42' });
  target.history.pushState({ ...target.history.state, torwatchOverlay: 'search' }, '');
  navigateHash(target, 'title', { id: '42' });
  assert.equal(target.history.state.torwatchOverlay, 'search');
  target.history.back(); // dialog onOpenChange(false)
  assert.equal(target.location.hash, '#title?id=42');
  assert.equal(target.history.state.torwatchOverlay, undefined);
});

test('native history Back dismisses settings without changing the underlying page; forward reopens it', () => {
  const target = browserAt('#library?collection=favourites');
  const overlay = new SettingsOverlayController(target, target.history);
  target.dispatchEvent(new Event('torwatch:open-settings'));
  target.dispatchEvent(new Event('torwatch:open-settings'));
  assert.equal(target.history.length, 2);
  assert.equal(overlay.isOpen(), true);
  target.history.back();
  assert.equal(overlay.isOpen(), false);
  assert.equal(target.location.hash, '#library?collection=favourites');
  target.history.forward();
  assert.equal(overlay.isOpen(), true);
  overlay.close();
  assert.equal(overlay.isOpen(), false);
  assert.equal(target.history.state.torwatchOverlay, undefined);
  overlay.dispose();
});
