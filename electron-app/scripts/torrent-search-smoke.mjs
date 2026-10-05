import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'vite';
import puppeteer from 'puppeteer';
// Exercise the real source picker with deterministic pack/search responses.
const fixture='src/__torrent_search_audit.html';
const output='../.tmp/torrent-search-review';
const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import EpisodePanel from '/components/EpisodePanelWrapper.tsx';
import TorrentPanel from '/components/TorrentPanel.tsx';
import {PlatformProvider} from '/platform/PlatformProvider.tsx';
import {RouterProvider} from '/lib/router-adapter.tsx';
import {FixtureConnection,FixtureStorage} from '/platform/fixtures.ts';
import {saveSeasonPack} from '/lib/season-pack-cache.ts';
import '/globals.css';
window.calls=0;window.searchFailed=false;window.navigation=null;
const hash='a'.repeat(40),other='b'.repeat(40);
saveSeasonPack('anilist:6033',1,{title:'Saved Kai pack',indexer:'Saved',infoHash:hash},'magnet:?xt=urn:btih:'+hash);
window.fetch=async(input)=>{
 const url=String(input);let payload={results:[]};
 if(url.includes('/subtitles/list?'))window.subtitleQuery=new URL(url).searchParams.toString();
 if(url.includes('/files?'))payload=[{index:7,name:'Dragon Ball Kai - 01.mkv',length:1000}];
 if(url.includes('/v1/torrents/search')){
  window.calls++;
  if(window.searchFailed)return new Response(JSON.stringify({error:'Test provider outage'}),{status:502});
  payload={results:[{title:'Saved Kai pack',indexer:'Torrentio',infoHash:hash,magnetUri:'magnet:?xt=urn:btih:'+hash,fileIndex:7},{title:'Other Kai release',indexer:'Torrentio',infoHash:other,magnetUri:'magnet:?xt=urn:btih:'+other,fileIndex:0,episodeMatch:true}]};
 }
 return new Response(JSON.stringify(payload),{headers:{'Content-Type':'application/json'}});
};
const platform={kind:'fixture',connection:new FixtureConnection('ok'),storage:new FixtureStorage(),player:{}};
const episode={id:'s1e1',seasonNumber:1,episodeNumber:1,absoluteNumber:1,name:'Episode one',airDate:'2009-04-05'};
const root=createRoot(document.getElementById('root'));
window.mountMovie=()=>{window.searchFailed=false;window.playlist=null;URL.createObjectURL=(blob)=>{blob.text().then(text=>window.playlist=text);return 'blob:audit'};root.render(React.createElement(PlatformProvider,{platform:{...platform,kind:'electron',desktop:{}}},React.createElement(RouterProvider,{navigate:()=>{}},React.createElement(TorrentPanel,{title:'Movie fixture',kind:'movie',imdbId:'tt91919'}))));};
root.render(React.createElement(PlatformProvider,{platform},React.createElement(RouterProvider,{navigate:(route,params)=>window.navigation={route,params}},React.createElement(EpisodePanel,{kind:'anime',title:'Dragon Ball Kai',anilistId:6033,seasons:[{seasonNumber:1,name:'Season 1'}],initialSeason:1,initialEpisodes:[episode],initialEpisode:1}))));
</script></body></html>`;
let server,browser;
try{
 await mkdir(output,{recursive:true});
 await writeFile(fixture,html);
 server=await createServer({configFile:'vite.config.browser.mts',root:'src',server:{host:'127.0.0.1',port:5197,strictPort:true},logLevel:'error'});await server.listen();
 browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewport({width:390,height:844,isMobile:true});await page.goto('http://127.0.0.1:5197/__torrent_search_audit.html');
 await page.waitForFunction(()=>document.body.textContent.includes('Find other sources'));
 assert.equal(await page.evaluate(()=>window.calls),0);
 await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Find other sources')).click());
 await page.waitForFunction(()=>document.body.textContent.includes('Other Kai release'));
 assert.equal(await page.evaluate(()=>window.calls),1);
 assert.equal(await page.$$eval('.content-auto-row',els=>els.length),2);
 await page.evaluate(()=>{const row=[...document.querySelectorAll('.content-auto-row')].find(e=>e.textContent.includes('Other Kai release'));[...row.querySelectorAll('button')].find(e=>e.textContent.includes('Play')).click()});
 await page.waitForFunction(()=>window.navigation!==null);
 assert.equal(await page.evaluate(()=>window.navigation.params.fileIndex),'0');
 await page.evaluate(()=>{window.searchFailed=true;[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Find other sources')).click()});
 await page.waitForFunction(()=>document.querySelector('[role="alert"]')?.textContent.includes('Test provider outage'));
 assert.equal(await page.$$eval('.content-auto-row',els=>els.length),1);
 assert.deepEqual(errors,[]);
 await page.screenshot({path:output+'/source-picker.png'});
 await page.setViewport({width:1280,height:900});
 await page.evaluate(()=>window.mountMovie());
 await page.waitForSelector('button[aria-label="More playback options"]');
 await page.evaluate(()=>{document.querySelectorAll('button[aria-label="More playback options"]')[1].click()});
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(e=>e.textContent.includes('Open in external player')));
 await page.evaluate(()=>[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Open in external player')).click());
 await page.waitForFunction(()=>window.playlist!==null);
 const playlist=await page.evaluate(()=>window.playlist);
 assert.equal(new URL(playlist.trim().split('\n').at(-1)).searchParams.get('fileIndex'),'0');
 assert.equal(new URLSearchParams(await page.evaluate(()=>window.subtitleQuery)).get('fileIndex'),'0');
 assert.deepEqual(errors,[]);
 console.log('PASS: saved continuity; alternatives; deduplication; fileIndex=0 playback and M3U; visible outage with retained saved pack.');
}finally{await browser?.close();await server?.close();await rm(fixture,{force:true});}
