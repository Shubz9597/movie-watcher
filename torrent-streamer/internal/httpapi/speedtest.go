package httpapi

import (
	"crypto/rand"
	"net/http"
	"strconv"
	"sync"
)

// GET /speedtest: a page that measures how fast this server reaches the
// device opening it (over the same Tailscale path the app's downloads take)
// and shows it live. GET /speedtest/data?bytes=N sends N random bytes.
// Downloads to a phone away from home ran at 5 Mbps while the server's
// upload measured ~150 Mbps; this tells the network from the app apart.

const speedtestMax = 500 << 20

var speedtestBlock = sync.OnceValue(func() []byte {
	block := make([]byte, 1<<20)
	_, _ = rand.Read(block)
	return block
})

func RegisterSpeedtest(mux *http.ServeMux) {
	mux.HandleFunc("/speedtest", handleSpeedtestPage)
	mux.HandleFunc("/speedtest/data", handleSpeedtestData)
}

func handleSpeedtestData(w http.ResponseWriter, r *http.Request) {
	n, err := strconv.ParseInt(r.URL.Query().Get("bytes"), 10, 64)
	if err != nil || n <= 0 || n > speedtestMax {
		n = 100 << 20
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(n, 10))
	w.Header().Set("Cache-Control", "no-store")
	block := speedtestBlock()
	for n > 0 {
		chunk := block
		if int64(len(chunk)) > n {
			chunk = chunk[:n]
		}
		if _, err := w.Write(chunk); err != nil {
			return
		}
		n -= int64(len(chunk))
	}
}

func handleSpeedtestPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(speedtestPage))
}

const speedtestPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TorWatch speed test</title>
<style>
body{margin:0;background:#0a0a0a;color:#fff;font:16px -apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box}
.big{font-size:56px;font-weight:700;margin:8px 0}
.small{color:#aaa;font-size:14px}
button{margin-top:24px;min-height:48px;padding:0 28px;border:0;border-radius:10px;background:#fff;color:#000;font-size:16px;font-weight:600}
</style></head><body><main>
<div class="small">Your server to this device</div>
<div class="big" id="speed">–</div>
<div id="detail" class="small">Measures 200 MB from your server.</div>
<button id="go">Start</button>
</main><script>
const go=document.getElementById('go'),speed=document.getElementById('speed'),detail=document.getElementById('detail');
go.onclick=async()=>{
  go.disabled=true;speed.textContent='…';
  const total=200*1024*1024,start=performance.now();let got=0,last=start,lastGot=0,peak=0;
  try{
    const res=await fetch('/speedtest/data?bytes='+total+'&t='+Date.now(),{cache:'no-store'});
    const reader=res.body.getReader();
    for(;;){
      const {done,value}=await reader.read();if(done)break;got+=value.length;
      const now=performance.now();
      if(now-last>500){const mbps=(got-lastGot)*8/((now-last)/1000)/1e6;peak=Math.max(peak,mbps);speed.textContent=mbps.toFixed(1)+' Mbps';detail.textContent=Math.round(got/1048576)+' of 200 MB';last=now;lastGot=got;}
    }
    const secs=(performance.now()-start)/1000,avg=got*8/secs/1e6;
    speed.textContent=avg.toFixed(1)+' Mbps';
    detail.textContent='Average over '+Math.round(got/1048576)+' MB in '+secs.toFixed(1)+' s ('+(avg/8).toFixed(1)+' MB/s). Peak '+peak.toFixed(1)+' Mbps.';
  }catch(e){speed.textContent='Failed';detail.textContent='Couldn’t reach your server.';}
  go.disabled=false;go.textContent='Run again';
};
</script></body></html>`
