/** 局域网只读网页：同网段的电脑或手机用浏览器打开即可查看项目、反馈和截图 */
export function webPage({ needToken }: { needToken: boolean }): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BugShot</title>
<style>
:root{--bg:#f3f5f8;--pane:#fff;--line:#dde1e7;--fg:#1b2129;--muted:#5f6b7a;--tab:#175cd3;--tab-bg:#e6effc;--ad:#b54708;--ad-bg:#fdf0e1;--bad:#b42318;--bad-bg:#fde8e6;--ok:#157f3b;--ok-bg:#e3f4e8}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--pane:#1b2027;--line:#2b323c;--fg:#e6e9ee;--muted:#9aa5b3;--tab:#7fb0ff;--tab-bg:#18263d;--ad:#f5a55a;--ad-bg:#382714;--bad:#ff8a7a;--bad-bg:#3b1b18;--ok:#5cc98a;--ok-bg:#15301f;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
header{padding:12px 16px;border-bottom:1px solid var(--line);background:var(--pane);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header b{font-size:16px}input{font:inherit;border:1px solid var(--line);border-radius:6px;padding:5px 9px;background:var(--bg);color:var(--fg)}
main{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:calc(100vh - 56px)}
@media (max-width:720px){main{grid-template-columns:1fr}}
nav{border-right:1px solid var(--line);padding:8px}nav button{display:block;width:100%;text-align:left;border:1px solid transparent;background:none;border-radius:6px;padding:7px 10px;color:inherit;font:inherit;cursor:pointer}
nav button.on{background:var(--tab-bg);border-color:var(--tab)}.sub{font-size:12px;color:var(--muted)}
section{padding:16px;min-width:0}h2{margin:0 0 6px;font-size:18px}.rounds{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}
.rounds button{border:1px solid var(--line);background:var(--pane);border-radius:6px;padding:3px 10px;font:inherit;color:inherit;cursor:pointer}.rounds button.on{border-color:var(--tab);background:var(--tab-bg);font-weight:600}
.chip{font-size:11.5px;border-radius:4px;padding:0 6px;font-weight:600}.t{color:var(--tab);background:var(--tab-bg)}.a{color:var(--ad);background:var(--ad-bg)}.bad{color:var(--bad);background:var(--bad-bg)}.ok{color:var(--ok);background:var(--ok-bg)}
.grp{margin:16px 0 6px}.bug{background:var(--pane);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:6px 0}
.shots{display:flex;gap:8px;overflow-x:auto;margin-top:8px}.shots img{height:240px;border-radius:6px;border:1px solid var(--line)}
pre{white-space:pre-wrap;background:var(--pane);border:1px solid var(--line);border-radius:8px;padding:12px;font-size:13px}
.btn{border:1px solid var(--line);background:var(--pane);color:inherit;border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer}
</style></head><body>
${
  needToken
    ? `<header><b>BugShot</b></header><section><h2>需要访问口令</h2><p class="sub">在 BugShot 桌面端“局域网 · MCP”面板里查看口令。</p><form onsubmit="location.href='/?token='+encodeURIComponent(this.t.value);return false"><input name="t" placeholder="bs_..." autofocus> <button class="btn">进入</button></form></section>`
    : `<header><b>BugShot</b><span class="sub">局域网只读查看</span><input id="q" placeholder="搜项目或反馈内容" style="margin-left:auto"></header>
<main><nav id="list"></nav><section id="view"><p class="sub">选择左侧项目</p></section></main>
<script>
const MODS=['tab1','tab2','tab3','tab4','广告','登录/支付','悬浮窗','其他'];
const ST={testing:'测试中',waiting:'待复测',passed:'已通过'};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let projects=[],cur=null,round=0,detail=null;
const fixedBy=(b,r)=>Object.entries(b.checks).some(([k,v])=>+k<=r&&v==='fixed');
const line=b=>(b.mode==='audit'?'审核状态下-':b.mode==='online'?'上线模式-':'')+(b.page?b.page+'-':'')+b.text;
async function load(){projects=await (await fetch('/api/projects')).json();drawList()}
function drawList(){const q=document.getElementById('q').value.trim();
 document.getElementById('list').innerHTML=projects.filter(p=>!q||p.name.includes(q)).map(p=>'<button class="'+(p.id===cur?'on':'')+'" data-id="'+p.id+'">'+esc(p.name)+'<div class="sub">'+esc(p.developer)+' · 第'+p.round+'轮 · '+ST[p.status]+' · 剩'+p.remaining+'</div></button>').join('')}
async function open(id){cur=id;detail=await (await fetch('/api/projects/'+encodeURIComponent(id))).json();round=detail.rounds.length;drawList();draw()}
function draw(){const p=detail,r=round,rd=p.rounds[r-1];
 const car=p.bugs.filter(b=>b.round<r&&!fixedBy(b,r-1)),fr=p.bugs.filter(b=>b.round===r);
 const st=b=>b.round===r?'':b.checks[r]==='fixed'?'<span class="chip ok">已修复</span>':b.checks[r]==='still'?'<span class="chip bad">仍存在</span>':'<span class="chip">待复测</span>';
 const grp=list=>MODS.map(m=>[m,list.filter(b=>b.module===m)]).filter(x=>x[1].length).map(([m,l])=>'<div class="grp"><span class="chip '+(m==='广告'?'a':'t')+'">'+m+'</span></div>'+l.map((b,i)=>'<div class="bug">'+(i+1)+'. '+esc(line(b))+' '+st(b)+(b.shots.length?'<div class="shots">'+b.shots.map(s=>'<a href="/shots/'+p.id+'/'+s.file+'" target="_blank"><img loading="lazy" src="/shots/'+p.id+'/'+s.file+'"></a>').join('')+'</div>':'')+'</div>').join('')).join('');
 document.getElementById('view').innerHTML='<h2>'+esc(p.name)+'</h2><div class="sub">开发人员：'+esc(p.developer)+' · 类型：'+esc(p.type)+'</div><div class="rounds">'+p.rounds.map(x=>'<button class="'+(x.no===r?'on':'')+'" data-r="'+x.no+'">第'+x.no+'轮 '+(x.end?(x.result==='pass'?'通过':'不通过'):'测试中')+'</button>').join('')+'</div>'+
 (r>1?'<h3>复测清单（'+car.length+'）</h3>'+(grp(car)||'<p class="sub">无</p>')+'<h3>本轮新增（'+fr.length+'）</h3>':'')+(grp(fr)||'<p class="sub">没有反馈</p>')}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.id)open(b.dataset.id);if(b.dataset.r){round=+b.dataset.r;draw()}});
document.getElementById('q').oninput=drawList;load();setInterval(()=>{load();if(cur)fetch('/api/projects/'+encodeURIComponent(cur)).then(r=>r.json()).then(d=>{detail=d;draw()})},15000);
</script>`
}
</body></html>`
}
