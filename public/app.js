const $=s=>document.querySelector(s); let files=[], allItems=[];

function setTheme(t){document.documentElement.dataset.theme=t;localStorage.theme=t}
setTheme(localStorage.theme||'dark'); $('#theme').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');

async function checkAuth(){
  const r=await fetch('/api/me',{credentials:'include'}); const d=await r.json();
  if(!d.authenticated){$('#login').style.display='flex';document.body.style.overflow='hidden'}else{$('#login').style.display='none';document.body.style.overflow='';load();$('#status').textContent='● '+d.user;$('#status').className='status ok'}
}
checkAuth();

$('#loginForm').onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({username:$('#user').value,password:$('#pass').value})});if(r.ok){checkAuth()}else{$('#loginErr').textContent='Invalid credentials'}};
$('#logout').onclick=async()=>{await fetch('/api/logout',{method:'POST',credentials:'include'});location.reload()};

document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab,.panel').forEach(e=>e.classList.remove('active'));b.classList.add('active');$('#'+b.dataset.tab+'-tab').classList.add('active')});

const drop=$('#drop'), fi=$('#fileInput'); drop.onclick=()=>fi.click();
['dragenter','dragover'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('on')}));['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('on')}));drop.addEventListener('drop',e=>addFiles(e.dataTransfer.files));fi.onchange=e=>addFiles(e.target.files);
function addFiles(l){files=[...files,...l];render();if(!$('#title').value&&files[0])$('#title').value=files[0].name.replace(/\.[^/.]+$/,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,40)}
function render(){$('#fileList').innerHTML=files.map((f,i)=>`<div class="file">${f.type.startsWith('image/')?`<img src="${URL.createObjectURL(f)}" class="thumb">`:`<div class="thumb file-icon">📄</div>`}<div class="meta"><b>${f.name}</b><span>${(f.size/1024/1024).toFixed(1)} MB</span></div><button onclick="files.splice(${i},1);render()">×</button></div>`).join('');$('#uploadBtn').disabled=files.length===0}window.render=render;

$('#uploadBtn').onclick=()=>{if(!$('#title').value)return toast('Enter id','err');const btn=$('#uploadBtn'),pw=$('#progWrap'),bar=$('#prog'),txt=$('#progTxt');btn.disabled=true;pw.hidden=false;const fd=new FormData();fd.append('title',$('#title').value);fd.append('description',$('#desc').value);fd.append('collection',$('#collection').value);files.forEach(f=>fd.append('files',f));const xhr=new XMLHttpRequest();xhr.open('POST','/api/upload/new');xhr.withCredentials=true;xhr.upload.onprogress=e=>{if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);bar.style.width=p+'%';txt.textContent=p+'%'}};xhr.onload=()=>{pw.hidden=true;btn.disabled=false;const d=JSON.parse(xhr.response);if(xhr.status===200){toast('✓ '+d.identifier,'ok');files=[];render();$('#title').value='';load()}else if(xhr.status===401){checkAuth()}else toast(d.error,'err')};xhr.send(fd)};

$('#paste').onclick=async()=>$('#urlInput').value=await navigator.clipboard.readText();
$('#urlBtn').onclick=async()=>{const url=$('#urlInput').value,t=$('#urlTitle').value;if(!url||!t)return toast('URL+id','err');$('#urlProg').hidden=false;try{const r=await fetch('/api/upload/url',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({url,title:t})});const d=await r.json();if(r.status===401)return checkAuth();if(!r.ok)throw new Error(d.error);toast('✓ '+d.identifier,'ok');load()}catch(e){toast(e.message,'err')}finally{$('#urlProg').hidden=true}};

function toast(m,t){const el=$('#toast');el.innerHTML=`<div class="${t}">${m}</div>`;setTimeout(()=>el.innerHTML='',3500)}

async function load(){const el=$('#items');el.innerHTML='<div class="loading">Loading…</div>';try{const r=await fetch('/api/items',{credentials:'include'});if(r.status===401)return checkAuth();const d=await r.json();allItems=(d.items||[]).map(i=>({...i,created:new Date(i.created)}));apply()}catch{el.innerHTML='<div class="err">Failed</div>'}}
function apply(){const q=$('#search').value.toLowerCase(),s=$('#sort').value;let items=allItems.filter(i=>i.name.toLowerCase().includes(q));items.sort((a,b)=>s==='date-desc'?b.created-a.created:s==='date-asc'?a.created-b.created:s==='name-asc'?a.name.localeCompare(b.name):b.name.localeCompare(a.name));$('#items').innerHTML=items.length?items.map(i=>`<div class="item-card"><a class="item-main" href="https://archive.org/details/${i.name}" target="_blank"><img class="item-thumb" src="https://archive.org/services/img/${i.name}" loading="lazy" onerror="this.style.display='none'"><div class="item-info"><b>${i.name}</b><span>${i.created.toLocaleDateString()}</span></div></a><button class="copy" onclick="navigator.clipboard.writeText('https://archive.org/details/${i.name}').then(()=>{this.textContent='✓';setTimeout(()=>this.textContent='⎘',1000)})">⎘</button></div>`).join(''):'<div class="empty">No items</div>'}
$('#search').oninput=apply;$('#sort').onchange=apply;$('#refresh').onclick=load;
