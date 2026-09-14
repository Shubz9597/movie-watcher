// Actual shell, carousel and search page with deterministic catalog/library
// fixtures and a simulated VisualViewport. Native keyboard testing is separate.
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import puppeteer from 'puppeteer';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(app,'src','__home-search-smoke.html');
const output = path.join(app,'..','.tmp','home-search-review');
const html = `<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import {AppShell} from '/components/shared/AppShell.tsx';
import Home from '/pages/HomePage.tsx'; import Search from '/pages/SearchPage.tsx';
import {PlatformProvider} from '/platform/PlatformProvider.tsx';
import {LibraryContextProvider} from '/lib/library-react.tsx';
import {createLibraryStateFixture} from '/platform/library-fixtures.ts';
import {installFixtureAdapter,FixtureConnection,FixtureStorage} from '/platform/fixtures.ts';
import '/globals.css';
const viewport = Object.assign(new EventTarget(), {height:innerHeight,width:innerWidth,offsetTop:0,scale:1});
Object.defineProperty(window,'visualViewport',{value:viewport,configurable:true});
window.keyboard = height => {viewport.height=height; viewport.dispatchEvent(new Event('resize'));};
installFixtureAdapter('ok');
const originalFetch = window.fetch;
window.fetch = async (...args) => {
  const url = String(args[0]);
  if(url.includes('/v2/catalog/search')) {
    const type = new URL(url).searchParams.get('type');
    const rows = type === 'anime' ? [] : [...Array.from({length:7},(_,i)=>({id:'tmdb:movie:'+i,type:'movie',title:'Interstellar: Extra '+i,year:2020+i,providerIds:{tmdb:'movie:'+i},mergedFrom:[]})),{id:'tmdb:movie:157336',type:'movie',title:'Interstellar',year:2014,providerIds:{tmdb:'movie:157336'},mergedFrom:[]}];
    return new Response(JSON.stringify({results:rows}),{headers:{'Content-Type':'application/json'}});
  }
  const response = await originalFetch(...args);
  if(url.includes('/v2/catalog/sections')) {
    const data = await response.json();
    // Solid-color fixture backdrops expose accidental color bleed in actions.
    data.results = data.results.map((row,i)=>({...row,artwork:{...row.artwork,background:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="'+['#0d486f','#821d2d','#27613b'][i%3]+'"/></svg>')}}));
    return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
  }
  return response;
};
const recent = [{kind:'movie',item:{id:1,title:'Severance'},searchedAt:1},{kind:'tv',item:{id:2,title:'Severance'},searchedAt:2},{kind:'movie',item:{id:157336,title:'Interstellar'},searchedAt:3}];
localStorage.setItem('moviewatcher.global-search.recent',JSON.stringify(recent));
window.store = createLibraryStateFixture('populated');
const platform = {kind:'fixture',connection:new FixtureConnection('ok'),storage:new FixtureStorage()};
function App(){const [route,setRoute]=React.useState('home'); window.navigate=setRoute;
const navigate=(route,params)=>{window.lastNavigation={route,params}; if(route==='home'||route==='search')setRoute(route);};
return React.createElement(PlatformProvider,{platform},React.createElement(LibraryContextProvider,{store:window.store},React.createElement(AppShell,{routePath:route,navigate,onBack:()=>{},onOpenSettings:()=>{}},route==='search'?React.createElement(Search,{navigate}):React.createElement(Home,{navigate}))));}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;
let server,browser;
try{
  await mkdir(output,{recursive:true});await writeFile(fixture,html);
  server=await createServer({configFile:path.join(app,'vite.config.browser.mts'),root:path.join(app,'src'),server:{host:'127.0.0.1',port:5191,strictPort:true},logLevel:'error'});await server.listen();
  browser=await puppeteer.launch({headless:true});
  for(const [name,width,height] of [['phone',390,844],['narrow',320,740],['landscape',844,390]]){
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setViewport({width,height,isMobile:true,hasTouch:true});
    await page.goto('http://127.0.0.1:5191/__home-search-smoke.html');
    await page.addStyleTag({content:':root{--app-safe-top:44px;--app-safe-bottom:24px}'});
    await page.waitForSelector('[aria-label="Next featured title"]');
    const footer=await page.$eval('nav[aria-label="Main destinations"]',el=>({top:parseFloat(getComputedStyle(el).paddingTop),bottom:parseFloat(getComputedStyle(el).paddingBottom)}));
    assert.ok(footer.top>=8 && footer.bottom>=32);
    const seen=new Set();
    for(let i=0;i<3;i++){
      const hero=await page.$('[aria-label="Trending highlights"]');
      const title=await hero.$eval('h1',el=>el.textContent);seen.add(title);
      assert.equal(await hero.$$eval('button',nodes=>nodes.some(el=>el.textContent.includes('Browse'))),false);
      const watch=await hero.$eval('button:has(svg.lucide-play)',el=>({height:el.getBoundingClientRect().height,background:getComputedStyle(el).backgroundColor}));
      const saved=await hero.$eval('button[aria-label*="Watch Later"]',el=>({height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width,background:getComputedStyle(el).backgroundColor}));
      assert.equal(watch.background,'rgb(255, 255, 255)');assert.equal(saved.background,'rgb(32, 32, 32)');
      assert.ok(Math.abs(saved.height-48)<0.5);assert.ok(saved.width<165);
      if(title.startsWith('Frieren')){
        await hero.$eval('button[aria-label*="Watch Later"]',el=>el.click());
        await page.waitForFunction(()=>window.store.getSnapshot().memberships['anilist:154587']?.watchLater===true);
        await page.screenshot({path:path.join(output,name+'-anime.png')});
      }
      await page.$eval('[aria-label="Next featured title"]',el=>el.click());
      await page.waitForFunction(title=>document.querySelector('[aria-label="Trending highlights"] h1').textContent!==title,{},title);
    }
    assert.equal(seen.size,3);
    await page.evaluate(()=>window.navigate('search'));
    await page.waitForSelector('.search-page input');
    assert.equal(await page.$$eval('[aria-label="Recent searches"] li',els=>els.filter(el=>el.textContent==='Severance').length),1);
    // Hardware-keyboard focus alone must not hide the footer.
    assert.equal(await page.$('.search-keyboard-open'),null);
    await page.evaluate(()=>window.keyboard(Math.round(innerHeight*0.58)));
    await page.waitForSelector('.search-keyboard-open');
    assert.equal(await page.$eval('nav[aria-label="Main destinations"]',el=>getComputedStyle(el).display),'none');
    assert.ok(await page.$eval('[aria-label="Search results"]',el=>el.clientHeight)>90);
    await page.screenshot({path:path.join(output,name+'-keyboard-recents.png')});
    await page.type('.search-page input','Interstellar');
    await page.waitForSelector('[aria-label="Open Interstellar"]');
    assert.equal(await page.$eval('[aria-label="Search results"] ul button',el=>el.getAttribute('aria-label')),'Open Interstellar');
    assert.ok(await page.$eval('[aria-label="Open Interstellar"] h3',el=>el.getBoundingClientRect().bottom) < Math.round(height*0.58), 'first result title fits above the keyboard');
    await page.screenshot({path:path.join(output,name+'-keyboard-results.png')});
    await page.keyboard.press('Enter');
    await page.evaluate(()=>window.keyboard(innerHeight));
    await page.waitForFunction(()=>!document.querySelector('.search-keyboard-open'));
    assert.notEqual(await page.$eval('nav[aria-label="Main destinations"]',el=>getComputedStyle(el).display),'none');
    assert.deepEqual(errors,[]);await page.close();console.log(name+': footer, carousel actions/colors, anime save, keyboard space, deduplicated recents and exact-first search passed');
  }
}finally{await browser?.close();await server?.close();await rm(fixture,{force:true});}
