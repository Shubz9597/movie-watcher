import test from 'node:test';
import assert from 'node:assert/strict';
import { rankSearchResults, uniqueRecentSearches } from '../../src/lib/search-order.ts';

test('exact Interstellar result leads extras and preserves equal-match provider order', () => {
  const results = [{title:'Interstellar: Behind the Scenes'}, {title:'Journey to Interstellar Space'}, {title:'Interstellar',id:157336}, {title:'Interstellar',id:90}];
  assert.deepEqual(rankSearchResults(results, ' INTERSTELLAR ').map(item => item.id), [157336,90,undefined,undefined]);
  assert.equal(results[0].title, 'Interstellar: Behind the Scenes', 'input is not mutated');
});
test('exact series/anime can outrank movie group and Unicode/sequel numbers survive normalization', () => {
  assert.equal(rankSearchResults([{title:'Severance: Extras'}, {title:'Severance',kind:'tv'}], 'Severance')[0].kind, 'tv');
  for (const title of ['進撃の巨人','Naruto Season 2','Amélie']) {
    assert.equal(rankSearchResults([{title:'Something'}, {title}], title)[0].title, title);
  }
  assert.equal(rankSearchResults([{title:'Naruto Season 1'}, {title:'Naruto Season 2'}], 'naruto season 2')[0].title, 'Naruto Season 2');
});
test('recents collapse normalized title labels across IDs and kinds, keeping most recent', () => {
  const entries = [{kind:'movie',item:{id:1,title:'Severance'},searchedAt:1}, {kind:'tv',item:{id:2,title:' severance '},searchedAt:3}, {kind:'movie',item:{id:3,title:'Interstellar'},searchedAt:2}];
  assert.deepEqual(uniqueRecentSearches(entries).map(entry => entry.item.id), [2,3]);
  assert.equal(uniqueRecentSearches(entries,1).length,1);
});
