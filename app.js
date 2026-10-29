const $=id=>document.getElementById(id);
const rp=n=>'Rp '+(num(n)??0).toLocaleString('id-ID',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmt=n=>raw(n);
const num=n=>{if(n===null||n===undefined||(typeof n==='string'&&!n.trim()))return null;const v=typeof n==='number'?n:Number(n);return Number.isFinite(v)?v:null};
const raw=n=>{const v=num(n);return v===null?'0':String(v).replace('.',',')};
const truncate=(n,places)=>{const v=num(n);if(v===null)return '0';const factor=10**places;const cut=Math.trunc((v+Math.sign(v)*Number.EPSILON)*factor)/factor;return String(cut).replace('.',',')};
const fmtEnergy=n=>truncate(n,2);
const fmtW=n=>truncate(n,1);
const fmtV=n=>truncate(n,1);
const fmtHz=n=>truncate(n,1);
const fmtPF=n=>truncate(n,2);
const fmtCurrentA=n=>truncate(n,3);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dText=d=>new Date(d).toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'});
const dk=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const dLabel=k=>dText(k+'T00:00:00');
const CFG=window.KWHKU_CONFIG||{},DEMO=!CFG.API_URL;
let session=null,customers=[],daily=[],tokens=[],monitoring={readings:[],connections:[],incidents:[],devices:[]},monitoringError='',selId='',shown=new Date();shown.setDate(1);

function toast(m){const t=$('toast');t.textContent=m;t.classList.remove('hidden');setTimeout(()=>t.classList.add('hidden'),3500)}
async function api(fn,...args){
  if(DEMO)throw Error('Server belum dikonfigurasi. Data demo dinonaktifkan.');
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),5000);
  try{
    const r=await fetch(CFG.API_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({fn,args}),signal:controller.signal,cache:'no-store'});
    if(!r.ok)throw Error('Server '+r.status);
    return await r.json();
  }catch(err){if(err?.name==='AbortError')throw Error('Server belum merespons dalam 5 detik. Periksa koneksi atau coba sinkronkan kembali.');throw err}
  finally{clearTimeout(timeout)}
}
const admin=()=>session?.role==='ADMIN';
let refreshInFlight=false;
const rows=()=>daily.filter(r=>admin()?(!selId||r.customerId===selId):r.customerId===session.customerId);
const sorted=()=>rows().slice().sort((a,b)=>b.date.localeCompare(a.date)||a.customerId.localeCompare(b.customerId));
const cust=id=>customers.find(c=>c.customerId===id)||{customerId:id,name:id};
const avg=id=>{const a=daily.filter(r=>r.customerId===id);return a.length?a.reduce((s,r)=>s+r.kwh,0)/a.length:0};
const high=r=>r.kwh>avg(r.customerId)*1.5;
const badge=r=>high(r)?'<span class="badge red">Tinggi</span>':'<span class="badge">Normal</span>';

// Password visibility: only reveals the value currently typed in the login form.
$('togglePassword').onclick=()=>{const input=$('password'),show=input.type==='password';input.type=show?'text':'password';$('togglePassword').textContent=show?'🙈':'👁';$('togglePassword').setAttribute('aria-label',show?'Sembunyikan kata sandi':'Tampilkan kata sandi');$('togglePassword').setAttribute('aria-pressed',String(show));};

// ---- Login
document.querySelectorAll('.role-btn').forEach(b=>b.onclick=()=>{document.querySelectorAll('.role-btn').forEach(x=>x.classList.toggle('active',x===b));$('role').value=b.dataset.role});
$('demoHint').textContent='Masuk dengan akun yang terdaftar.';
$('liveText').textContent=DEMO?'MENUNGGU SERVER':'TERHUBUNG DENGAN SERVER';
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();const btn=e.target.querySelector('button[type=submit]');btn.disabled=true;btn.textContent='Memeriksa…';
  try{const res=await api('login',$('username').value.trim(),$('password').value);
    if(!res?.ok){toast(res?.message||'Login gagal.');return}
    
    session=res;try{sessionStorage.setItem('kwhku_session',JSON.stringify(res))}catch(storageError){console.warn('Sesi tidak dapat disimpan di tab ini',storageError)}selId='';$('loginView').classList.add('hidden');$('appView').classList.remove('hidden');$('syncOverlay').classList.remove('hidden');
    $('profileName').textContent=res.name;$('profileRole').textContent=admin()?'Administrator':'Pelanggan';$('appView').classList.toggle('admin-session',admin());$('avatar').textContent=(res.name||'U')[0].toUpperCase();
    document.querySelectorAll('.admin-only,.admin-col').forEach(el=>el.classList.toggle('hidden',!admin()));document.querySelectorAll('.customer-only').forEach(el=>el.classList.toggle('hidden',admin()));
    $('welcomeTitle').textContent='Halo, '+(admin()?'Admin':res.name.split(' ')[0])+'! 👋';
    $('welcomeSub').textContent=admin()?'Pantau data listrik seluruh pelanggan.':'Berikut ringkasan penggunaan listrik Anda.';
    try{await refresh(false);showPage('dashboard')}finally{$('syncOverlay').classList.add('hidden')}
  }catch(err){toast('Gagal terhubung: '+(err.message||err))}finally{btn.disabled=false;btn.innerHTML='Masuk ke Dashboard <span aria-hidden="true">→</span>'}});
$('logout').onclick=()=>{session=null;try{sessionStorage.removeItem('kwhku_session')}catch(_){}customers=[];daily=[];tokens=[];$('password').value='';$('appView').classList.add('hidden');$('loginView').classList.remove('hidden')};
// Restore the authenticated session after a page refresh in the same browser tab.
(async function restoreSessionAfterReload(){
  let saved=null;
  try{saved=JSON.parse(sessionStorage.getItem('kwhku_session')||'null')}catch(_){}
  if(!saved||!saved.ok)return;
  session=saved;selId='';
  $('loginView').classList.add('hidden');$('appView').classList.remove('hidden');$('syncOverlay').classList.remove('hidden');
  $('profileName').textContent=saved.name||saved.customerId||'Pengguna';
  $('profileRole').textContent=admin()?'Administrator':'Pelanggan';
  $('appView').classList.toggle('admin-session',admin());
  $('avatar').textContent=(saved.name||'U')[0].toUpperCase();
  document.querySelectorAll('.admin-only,.admin-col').forEach(el=>el.classList.toggle('hidden',!admin()));
  document.querySelectorAll('.customer-only').forEach(el=>el.classList.toggle('hidden',admin()));
  $('welcomeTitle').textContent='Halo, '+(admin()?'Admin':(saved.name||'Pelanggan').split(' ')[0])+'! 👋';
  $('welcomeSub').textContent=admin()?'Pantau data listrik seluruh pelanggan.':'Berikut ringkasan penggunaan listrik Anda.';
  try{await refresh(false);showPage('dashboard')}catch(err){console.warn('Sinkronisasi awal gagal:',err)}finally{$('syncOverlay').classList.add('hidden')}
})();
$('mobileMenu').onclick=()=>$('sidebar').classList.toggle('open');

// ---- Navigasi
const titles={dashboard:['Dashboard','Ringkasan penggunaan listrik'],calendar:['Kalender Pemakaian','Lihat pemakaian per tanggal'],history:['Riwayat Penggunaan','Energi dan biaya per hari'],monitoring:['Monitoring Teknis','Pembacaan sensor, status koneksi, dan gangguan'],customers:['Data Pelanggan','Kelola pelanggan terdaftar'],powerRequest:['Pengajuan Penambahan Daya','Ajukan perubahan daya dan pantau status persetujuan']};
function showPage(p){if(p==='customers'&&!admin())p='dashboard';
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));$('page-'+p).classList.add('active');
  document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===p));
  $('pageHeading').textContent=titles[p][0];$('pageSub').textContent=titles[p][1];$('sidebar').classList.remove('open');
  if(p!=='history'&&selId){selId='';$('historySearch').value=''}
  renderAll();if(p==='powerRequest')loadPowerRequests().catch(e=>toast(e.message||e))}
document.querySelectorAll('#nav button').forEach(b=>b.onclick=()=>showPage(b.dataset.page));
document.querySelectorAll('[data-goto]').forEach(b=>b.onclick=()=>showPage(b.dataset.goto));

async function refresh(showLoading=false){
  if(!session||refreshInFlight)return;refreshInFlight=true;
  if(showLoading)$('appView').classList.add('is-loading');
  try{
    const res=await api('getDashboard',session);
    if(!res?.ok){if(/Sesi/i.test(res?.message||''))$('logout').click();throw Error(res?.message||'Data gagal dimuat')}
    const nextCustomers=Array.isArray(res.customers)?res.customers:[];
    const allowed=new Set(nextCustomers.map(c=>c.customerId));
    const nextDaily=(Array.isArray(res.daily)?res.daily:[]).filter(r=>allowed.has(r.customerId)&&r.date&&num(r.kwh)!==null&&num(r.costRp)!==null);
    if(!admin()&&!nextCustomers.some(c=>c.customerId===session.customerId)){session=null;$('appView').classList.add('hidden');$('loginView').classList.remove('hidden');throw Error('Akun pelanggan tidak ditemukan atau tidak aktif.');}
    customers=nextCustomers;daily=nextDaily;tokens=[];
    // Load dashboard first so the main view is usable without waiting for technical monitoring.
    const monitoringTask=api('getMonitoring',session,500).then(mon=>{
      if(mon?.ok&&Array.isArray(mon.readings)){monitoring={readings:mon.readings.filter(r=>r&&r.timestamp&&num(r.energyKwh)!==null&&num(r.currentA)!==null&&num(r.voltageV)!==null&&num(r.powerW)!==null),connections:Array.isArray(mon.connections)?mon.connections:[],incidents:Array.isArray(mon.incidents)?mon.incidents:[],devices:Array.isArray(mon.devices)?mon.devices:[],checkedAt:mon.checkedAt||new Date().toISOString()};monitoringError='';}
      else {monitoringError=mon?.message||'Respons monitoring tidak sesuai format.';console.warn('Monitoring tidak tersedia:',monitoringError)}
    }).catch(err=>{monitoringError='Gagal memuat monitoring: '+(err?.message||String(err));console.warn(monitoringError,err)});

    $('liveText').textContent='TERHUBUNG DENGAN SERVER';renderAll();
    // Do not block the entire page on the slower technical-monitoring endpoint.
    monitoringTask.then(()=>{if(session)renderAll()});
  }catch(err){const badge=$('liveText');if(badge)badge.textContent='SERVER TIDAK MERESPONS';console.warn('Pembaruan kWh-Ku gagal:',err?.message||err);throw err}
  finally{refreshInFlight=false;if(showLoading)$('appView').classList.remove('is-loading')}
}

// ---- Render
function renderAll(){if(!session)return;
  $('todayLabel').textContent=new Date().toLocaleDateString('id-ID',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
  const c=admin()?null:customers.find(x=>x.customerId===session.customerId),L=c?.latest,sum=k=>customers.reduce((a,x)=>a+(Number(x[k])||0),0);
  $('costStat').textContent=rp(c?c.costMonthRp:sum('costMonthRp'));$('kwhStat').textContent=fmtEnergy(c?c.energyMonthKwh:sum('energyMonthKwh'))+' kWh';
  $('powerStat').textContent=fmtW(c?L?.powerW:customers.reduce((a,x)=>a+(Number(x.latest?.powerW)||0),0))+' W';
  const today=dk(new Date());$('todayKwh').innerHTML=fmtEnergy(rows().filter(r=>r.date===today).reduce((a,r)=>a+r.kwh,0))+' kWh<small>Hari ini</small>';
  const target=Number(c?.monthlyTargetRp)||0, cost=Number(c?.costMonthRp)||0;
  $('tokenStatLabel').innerHTML=(admin()?'Pelanggan aktif':'Tarif listrik')+' <span class="stat-icon">▤</span>';
  $('tokenStat').textContent=admin()?customers.length+' pelanggan':rp(c?.tariffRpPerKwh||0)+'/kWh';
  $('tokenDate').innerHTML=admin()?'—<small>Tagihan bulanan</small>':'Akhir bulan<small>Periode tagihan</small>';
  $('tokenBalance').textContent=c?rp(cost):rp(sum('costMonthRp'));
  const pct=target>0?Math.min(100,Math.round(cost/target*100)):0;
  $('tokenPercent').textContent=target?pct+'% dari target':'Target belum diatur';
  $('tokenProgress').style.width=pct+'%';
  $('tokenUsed').textContent=target?'Target biaya: '+rp(target):'Target biaya belum diatur';
  const on=customers.filter(x=>x.online).length,heavy=L&&c.powerVa&&L.powerW>c.powerVa*.8;
  $('meterStatus').innerHTML=admin()?on+'/'+customers.length+'<small>Online</small>':(c?.online?'Aktif':'Offline')+'<small>'+(c?.online?'Online':'Data lama')+'</small>';
  $('meterNote').textContent=admin()?'Meter terhubung':'Meter '+(c?.meterId||'');
  $('statusBadge').textContent=admin()?'● '+on+' online':!c?.online?'● Offline':heavy?'● Beban tinggi':'● Normal';
  $('statusBadge').className='badge '+(!admin()&&(!c?.online||heavy)?'red':'');
  renderChart();renderRecent();renderHistory();renderPeriodRecap();renderCalendar();renderCustomers();renderTokens();renderMonitoring()}
function renderChart(){const ds=[];for(let i=6;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);ds.push(dk(d))}
  const rs=rows(),mode=$('chartMode')?.value||'daily';let v=ds.map(k=>rs.filter(r=>r.date===k).reduce((a,r)=>a+r.kwh,0));
  if(mode==='cumulative'){let total=0;v=v.map(x=>(total+=x))}
  const mx=Math.max(0.001,...v);$('chartSubtitle').textContent=mode==='daily'?'Pemakaian energi selama 7 hari terakhir':'Akumulasi energi selama 7 hari terakhir';
  $('chart').innerHTML=ds.map((k,i)=>`<div class="bar-col"><div class="bar ${i===6?'current':''}" style="height:${Math.max(5,v[i]/mx*90)}%" title="${fmtEnergy(v[i])} kWh"></div><small>${k.slice(8)}/${k.slice(5,7)}</small></div>`).join('');
  $('chartSummary').textContent=(mode==='daily'?'Total pemakaian 7 hari: ':'Akumulasi pemakaian 7 hari: ')+fmtEnergy(v[v.length-1]||0)+' kWh';
}
function renderRecent(){$('recentTable').innerHTML=sorted().slice(0,5).map(r=>`<tr><td>${dLabel(r.date)}</td><td><b>${fmtEnergy(r.kwh)} kWh</b></td><td>${rp(r.costRp)}</td><td>${badge(r)}</td></tr>`).join('')||'<tr><td colspan="4" class="empty">Belum ada data dari ESP32.</td></tr>'}
function historyRows(){const q=$('historySearch').value.toLowerCase(),f=$('historyFilter').value,start=$('historyStart').value,end=$('historyEnd').value;
  return sorted().filter(r=>(r.date+' '+r.customerId+' '+cust(r.customerId).name).toLowerCase().includes(q)&&(!start||r.date>=start)&&(!end||r.date<=end)&&(f==='all'||(f==='high')===high(r)));}
function renderHistory(){const d=historyRows();
  $('historyTable').innerHTML=d.map(r=>`<tr><td>${dLabel(r.date)}</td><td class="admin-col ${admin()?'':'hidden'}">${esc(r.customerId)} · ${esc(cust(r.customerId).name)}</td><td><b>${fmtEnergy(r.kwh)}</b></td><td>${rp(r.costRp)}</td><td>${badge(r)}</td></tr>`).join('')||`<tr><td colspan="${admin()?5:4}" class="empty">Tidak ada data.</td></tr>`}
$('historySearch').oninput=renderHistory;$('historyFilter').onchange=renderHistory;$('historyStart').onchange=renderHistory;$('historyEnd').onchange=renderHistory;$('chartMode').onchange=renderChart;
function renderPeriodRecap(){
  const mode=$('recapPeriod')?.value||'week';
  const source=historyRows().filter(r=>r.date&&Number.isFinite(Number(r.kwh)));
  const buckets={};
  source.forEach(r=>{
    const d=new Date(r.date+'T12:00:00');
    let key,label;
    if(mode==='month'){
      key=r.date.slice(0,7);
      label=d.toLocaleDateString('id-ID',{month:'long',year:'numeric'});
    }else{
      const monday=new Date(d);
      const offset=(monday.getDay()+6)%7;
      monday.setDate(monday.getDate()-offset);
      const sunday=new Date(monday);sunday.setDate(monday.getDate()+6);
      key=dk(monday);
      label=dLabel(dk(monday))+' – '+dLabel(dk(sunday));
    }
    if(!buckets[key])buckets[key]={label,kwh:0,cost:0};
    buckets[key].kwh+=Number(r.kwh)||0;
    buckets[key].cost+=Number(r.costRp)||0;
  });
  const entries=Object.entries(buckets).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,mode==='month'?12:10);
  $('periodRecapTable').innerHTML=entries.map(([,v])=>'<tr><td>'+esc(v.label)+'</td><td><b>'+fmtEnergy(v.kwh)+'</b></td><td>'+rp(v.cost)+'</td></tr>').join('')||'<tr><td colspan="3" class="empty">Belum ada data pemakaian untuk direkap.</td></tr>';
}
$('recapPeriod').onchange=renderPeriodRecap;

function renderCalendar(){const y=shown.getFullYear(),m=shown.getMonth(),first=new Date(y,m,1).getDay(),n=new Date(y,m+1,0).getDate(),by={};
  rows().forEach(r=>{by[r.date]=(by[r.date]||0)+r.kwh});$('monthTitle').textContent=shown.toLocaleDateString('id-ID',{month:'long',year:'numeric'});
  let h=['Min','Sen','Sel','Rab','Kam','Jum','Sab'].map(d=>`<div class="day-name">${d}</div>`).join('')+'<div></div>'.repeat(first);
  for(let d=1;d<=n;d++){const k=dk(new Date(y,m,d));h+=`<div class="day ${by[k]!=null?'has-data':''} ${k===dk(new Date())?'today':''}" data-d="${k}">${d}</div>`}
  $('calendarGrid').innerHTML=h;$('calendarGrid').onclick=e=>{const el=e.target.closest('.day');if(!el)return;const k=el.dataset.d,rs=rows().filter(r=>r.date===k);
    document.querySelectorAll('.day.sel').forEach(x=>x.classList.remove('sel'));el.classList.add('sel');
    $('dayDetail').innerHTML=rs.length?`<b>${dLabel(k)}</b><br>Pemakaian: <b>${fmtEnergy(rs.reduce((a,r)=>a+r.kwh,0))} kWh</b> · Biaya: <b>${rp(rs.reduce((a,r)=>a+r.costRp,0))}</b>`:`<b>${dLabel(k)}</b><br>Tidak ada data pemakaian.`}}
$('prevMonth').onclick=()=>{shown.setMonth(shown.getMonth()-1);renderCalendar()};$('nextMonth').onclick=()=>{shown.setMonth(shown.getMonth()+1);renderCalendar()};
function renderCustomers(){if(!admin())return;const q=$('customerSearch').value.toLowerCase();
  $('customerTable').innerHTML=customers.filter(c=>(c.customerId+' '+c.name+' '+c.meterId).toLowerCase().includes(q)).map(c=>`<tr><td><b>${esc(c.customerId)}</b></td><td>${esc(c.name)}<div class="muted">${esc(c.meterId||'')}</div></td><td>${fmt(c.powerVa)} VA<br><span class="muted">${esc(c.mode||'PASCABAYAR')}</span></td><td>${fmtEnergy(c.energyMonthKwh)} kWh</td><td>${rp(c.costMonthRp)}<div class="muted">${rp(c.tariffRpPerKwh)}/kWh</div></td><td><span class="badge ${c.online?'':'amber'}">${c.online?'Online':'Offline'}</span> <span class="badge ${c.active===false?'amber':''}">${c.active===false?'Nonaktif':'Aktif'}</span></td><td><button class="small-btn" data-view="${esc(c.customerId)}">Lihat riwayat</button> <button class="small-btn" data-edit="${esc(c.customerId)}">Edit</button></td></tr>`).join('')||'<tr><td colspan="7" class="empty">Belum ada pelanggan.</td></tr>'}
$('customerSearch').oninput=renderCustomers;
$('customerTable').onclick=e=>{const view=e.target.closest('[data-view]'),edit=e.target.closest('[data-edit]');if(view){const id=view.dataset.view;showPage('history');selId=id;$('historySearch').value=id;renderAll();toast('Riwayat '+cust(id).name)}else if(edit){openEditCustomer(edit.dataset.edit)}};
function openEditCustomer(id){
  if(!admin())return;
  const c=customers.find(x=>x.customerId===id);if(!c)return toast('Pelanggan tidak ditemukan.');
  modal(`<h2>Edit data pelanggan</h2><p>ID pelanggan: <b>${esc(c.customerId)}</b> (tidak dapat diubah)</p>
  <form id="editCustomerForm">
   <div class="field"><label>Nama pelanggan</label><input id="eName" required value="${esc(c.name)}"></div>
   <div class="field"><label>ID meter / perangkat</label><input id="eMeter" required value="${esc(c.meterId||'')}"></div>
   <div class="field"><label>Kategori layanan</label><select id="eMode"><option value="PASCABAYAR" ${String(c.mode).toUpperCase()==='PASCABAYAR'?'selected':''}>Pascabayar</option><option value="PRABAYAR" ${String(c.mode).toUpperCase()==='PRABAYAR'?'selected':''}>Prabayar</option></select></div>
   <div class="field"><label>Golongan tarif</label><select id="eTariff"><option value="415">450 VA subsidi — Rp 415/kWh</option><option value="605">900 VA subsidi — Rp 605/kWh</option><option value="1352">900 VA RTM — Rp 1.352/kWh</option><option value="1444.70">1.300 / 2.200 VA — Rp 1.444,70/kWh</option><option value="1699.53">3.500 VA ke atas — Rp 1.699,53/kWh</option><option value="custom">Tarif khusus / manual</option></select></div>
   <div class="field"><label>Tarif (Rp/kWh)</label><input id="eTariffCustom" type="number" min="0.01" step="0.01" required value="${Number(c.tariffRpPerKwh)||605}"></div>
   <div class="field"><label>Daya tersambung (VA)</label><input id="ePower" type="number" min="1" step="1" required value="${Number(c.powerVa)||900}"></div>
   <div class="field"><label>Target biaya bulanan (Rp)</label><input id="eTarget" type="number" min="0" step="1" required value="${Number(c.monthlyTargetRp)||0}"></div>
   <div class="field"><label>Status akun</label><select id="eActive"><option value="true" ${c.active===false?'':'selected'}>Aktif</option><option value="false" ${c.active===false?'selected':''}>Nonaktif</option></select></div>
   <p class="muted">Perubahan tarif berlaku untuk estimasi biaya yang dihitung dari data pemakaian. Riwayat pengukuran mentah tidak diubah.</p>
   <div class="modal-actions"><button type="button" class="secondary" id="editCancel">Batal</button><button class="primary" type="submit">Simpan perubahan</button></div>
  </form>`);
  const tariff=$('eTariff'),custom=$('eTariffCustom');
  const known=['415','605','1352','1444.7','1699.53'];
  tariff.value=known.includes(String(Number(c.tariffRpPerKwh)))?String(Number(c.tariffRpPerKwh)):'custom';
  tariff.onchange=()=>{if(tariff.value!=='custom')custom.value=tariff.value;};
  $('editCancel').onclick=()=>$('modalRoot').innerHTML='';
  $('editCustomerForm').onsubmit=async e=>{e.preventDefault();const btn=e.target.querySelector('button[type=submit]');btn.disabled=true;btn.textContent='Menyimpan…';
   try{const res=await api('adminUpdateCustomer',session,id,{name:$('eName').value.trim(),meterId:$('eMeter').value.trim(),mode:$('eMode').value,tariffRpPerKwh:Number(custom.value),powerVa:Number($('ePower').value),monthlyTargetRp:Number($('eTarget').value),active:$('eActive').value==='true'});
    if(!res?.ok){toast(res?.message||'Gagal menyimpan');btn.disabled=false;btn.textContent='Simpan perubahan';return}
    $('modalRoot').innerHTML='';toast('Data pelanggan berhasil diperbarui');await refresh();
   }catch(err){toast('Gagal menyimpan: '+(err.message||err));btn.disabled=false;btn.textContent='Simpan perubahan'}
  };
 }
function renderTokens(){}

function renderMonitoring(){
  const monitorStart=$('monitorStart')?.value||'',monitorEnd=$('monitorEnd')?.value||'';
  const localDay=v=>{const d=new Date(v);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(d):''};
  const allVisible=(monitoring.readings||[]).filter(r=>(admin()||r.customerId===session?.customerId)&&(!monitorStart||localDay(r.timestamp)>=monitorStart)&&(!monitorEnd||localDay(r.timestamp)<=monitorEnd)).slice().sort((a,b)=>new Date(b.receivedAt||b.timestamp)-new Date(a.receivedAt||a.timestamp));
  const readings=allVisible.slice(0,5);
  const stamps=allVisible.map(r=>new Date(r.timestamp).getTime()).filter(Number.isFinite).sort((a,b)=>a-b);
  const intervals=stamps.slice(1).map((t,i)=>t-stamps[i]).filter(t=>t>0),gaps=intervals.filter(t=>t>90000).length;
  const avgInterval=intervals.length?intervals.reduce((sum,t)=>sum+t,0)/intervals.length/1000:0;
  $('dataQuality').innerHTML='<b>Kualitas data:</b> '+allVisible.length+' pembacaan pada data yang dimuat; '+gaps+' jeda antar-pembacaan lebih dari 90 detik; interval rata-rata '+(avgInterval?fmt(avgInterval)+' detik':'belum tersedia')+'.'+(stamps.length?' Rentang: '+new Date(stamps[0]).toLocaleString('id-ID')+' – '+new Date(stamps[stamps.length-1]).toLocaleString('id-ID')+'.':'')+(monitoringError?' <span class="monitoring-error">Peringatan API: '+esc(monitoringError)+'</span>':'');
  const connections=(monitoring.connections||[]).filter(r=>admin()||r.customerId===session?.customerId).slice(0,5);
  const incidents=(monitoring.incidents||[]).filter(r=>admin()||r.customerId===session?.customerId).slice(0,5);
  const devices=(monitoring.devices||[]).filter(r=>admin()||r.customerId===session?.customerId);
  const latest=readings[0];
  const status=devices.find(d=>!latest||d.meterId===latest.meterId)?.status || (customers.find(c=>c.customerId===session?.customerId)?.online?'ONLINE':'OFFLINE');
  const timeLabel=v=>v?new Date(v).toLocaleString('id-ID',{dateStyle:'short',timeStyle:'medium'}):'—';
  $('monStatus').innerHTML='<span class="badge '+(status==='ONLINE'?'':'amber')+'">'+esc(status)+'</span>';
  $('monLastSeen').textContent=latest?'Terakhir diterima '+timeLabel(latest.receivedAt||latest.timestamp):'Belum ada data';
  $('monVoltage').textContent=latest?fmtV(latest.voltageV)+' V':'— V';
  $('monCurrent').textContent=latest?fmtCurrentA(latest.currentA)+' A':'— A';
  $('monFrequency').textContent=latest?fmtHz(latest.frequencyHz)+' Hz':'— Hz';
  $('monPowerFactor').textContent=latest?fmtPF(latest.powerFactor):'—';
  $('monEnergy').textContent=latest?fmtEnergy(latest.energyKwh)+' kWh':'— kWh';
  $('monPower').textContent='Daya '+(latest?fmt(latest.powerW)+' W':'— W');
  $('monitorReadings').innerHTML=readings.map(r=>'<tr><td>'+timeLabel(r.timestamp)+'</td><td>'+timeLabel(r.receivedAt||r.timestamp)+'</td><td>'+esc(r.customerId)+' · '+esc(r.meterId)+'</td><td><b>'+fmtEnergy(r.energyKwh)+' kWh</b></td><td>'+fmt(r.powerW)+' W</td><td>'+fmt(r.voltageV)+' V</td><td>'+fmtCurrentA(r.currentA)+' A</td><td>'+fmt(r.frequencyHz)+' Hz</td><td>'+fmtPF(r.powerFactor)+'</td></tr>').join('')||'<tr><td colspan="9" class="empty">Belum ada data pembacaan.</td></tr>';
  $('monitorConnections').innerHTML=connections.map(r=>'<tr><td>'+timeLabel(r.timestamp)+'</td><td>'+esc(r.customerId)+'</td><td>'+esc(r.meterId)+'</td><td><span class="badge '+(r.status==='ONLINE'?'':'amber')+'">'+esc(r.status)+'</span></td><td>'+esc(r.details||'—')+'</td></tr>').join('')||'<tr><td colspan="5" class="empty">Belum ada perubahan koneksi. Jalankan setupMonitoring() pada Apps Script.</td></tr>';
  $('monitorIncidents').innerHTML=incidents.map(r=>'<tr><td>'+timeLabel(r.timestamp)+'</td><td>'+esc(r.customerId)+'</td><td>'+esc(r.meterId)+'</td><td>'+esc(r.eventType)+'</td><td><span class="badge '+(r.severity==='CRITICAL'||r.severity==='WARNING'?'red':'')+'">'+esc(r.severity)+'</span></td><td>'+esc(r.message)+'</td><td>'+timeLabel(r.resolvedAt)+'</td></tr>').join('')||'<tr><td colspan="7" class="empty">Belum ada gangguan tercatat.</td></tr>';
}
$('exportMonitoring').onclick=()=>{
  const start=$('monitorStart').value,end=$('monitorEnd').value;
  const readings=(monitoring.readings||[]).filter(r=>(admin()||r.customerId===session?.customerId)&&(!start||String(r.timestamp).slice(0,10)>=start)&&(!end||String(r.timestamp).slice(0,10)<=end));
  const data=[['timestamp','receivedAt','customerId','meterId','energyKwh','powerW','voltageV','currentA','frequencyHz','powerFactor'],...readings.map(r=>[r.timestamp,r.receivedAt||'',r.customerId,r.meterId,r.energyKwh,r.powerW,r.voltageV,r.currentA,r.frequencyHz,r.powerFactor])];
  const csv=data.map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\r\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));a.download='kWh-Ku-monitoring.csv';a.click();URL.revokeObjectURL(a.href);toast('CSV monitoring diunduh');
};
$('monitorStart').onchange=renderMonitoring;$('monitorEnd').onchange=renderMonitoring;

// ---- Modal admin
function modal(html){$('modalRoot').innerHTML=`<div class="modal-backdrop" id="bd"><div class="modal">${html}</div></div>`;$('bd').onclick=e=>{if(e.target.id==='bd')$('modalRoot').innerHTML=''}}
function openModal(type){const tk=false;
  modal(`<h2>${tk?'Buat token listrik':'Tambah pelanggan'}</h2><p>${tk?'Saldo & kode token internal (bukan token PLN resmi).':'Data disimpan ke Google Sheets.'}</p><form id="mf">${tk?`<div class="field"><label>Pelanggan prabayar</label><select id="mc">${pre.map(c=>`<option value="${esc(c.customerId)}">${esc(c.customerId)} — ${esc(c.name)}</option>`).join('')}</select></div><div class="field"><label>Nominal</label><select id="ma"><option value="20000">Rp 20.000</option><option value="50000" selected>Rp 50.000</option><option value="100000">Rp 100.000</option><option value="200000">Rp 200.000</option></select></div><div class="field"><label>Catatan</label><input id="mn" placeholder="Contoh: pembelian token"></div>`:`<div class="field"><label>ID pelanggan</label><input id="mi" required placeholder="PLG-004"></div><div class="field"><label>Nama</label><input id="mnm" required></div><div class="field"><label>ID meter ESP32</label><input id="mm" required placeholder="ESP32-004"></div><input type="hidden" id="mmo" value="PASCABAYAR"><div class="field"><label>Mode layanan</label><input value="Pascabayar" disabled></div><div class="field"><label>Daya tersambung</label><select id="mp" required><option value="450">450 VA</option><option value="900">900 VA</option><option value="1300" selected>1.300 VA</option><option value="2200">2.200 VA</option><option value="3500">3.500 VA</option><option value="5500">5.500 VA</option><option value="6600">6.600 VA ke atas</option></select></div><div class="field"><label>Golongan tarif</label><select id="mt" required><option value="415">450 VA subsidi — Rp 415/kWh</option><option value="605">900 VA subsidi — Rp 605/kWh</option><option value="1352">900 VA RTM (nonsubsidi) — Rp 1.352/kWh</option><option value="1444.70" selected>1.300 / 2.200 VA — Rp 1.444,70/kWh</option><option value="1699.53">3.500–5.500 VA — Rp 1.699,53/kWh</option><option value="1699.53">6.600 VA ke atas — Rp 1.699,53/kWh</option></select></div>`}<div class="modal-actions"><button type="button" class="secondary" id="cm">Batal</button><button class="primary">${tk?'Buat token':'Simpan'}</button></div></form>`);
  $('cm').onclick=()=>$('modalRoot').innerHTML='';
  $('mf').onsubmit=async e=>{e.preventDefault();try{
    const res=await api('adminCreateCustomer',session,{customerId:$('mi').value,name:$('mnm').value,meterId:$('mm').value,mode:'PASCABAYAR',tariffRpPerKwh:Number($('mt').value),powerVa:Number($('mp').value),tokenBalanceRp:0});
    if(!res?.ok)return toast(res?.message||'Gagal');
    modal(tk?`<h2>Token berhasil dibuat</h2><p>Kode token:</p><p class="code" style="font-size:20px">${esc(res.tokenCode)}</p><p>Saldo baru: <b>${rp(res.balanceRp)}</b></p><div class="modal-actions"><button class="primary" id="ok">Selesai</button></div>`:`<h2>Pelanggan ditambahkan</h2><p>ID: <b>${esc(res.customerId)}</b></p><p>PIN sementara: <b>${esc(res.temporaryPin)}</b></p><p class="sub">Bagikan hanya kepada pelanggan terkait.</p><div class="modal-actions"><button class="primary" id="ok">Selesai</button></div>`);
    $('ok').onclick=()=>$('modalRoot').innerHTML='';await refresh();
  }catch(err){toast('Gagal: '+(err.message||err))}}}
$('addCustomer').onclick=()=>openModal('customer');

// ---- Cetak rekap & CSV
function printRecap(){const cs=admin()?customers:customers.filter(c=>c.customerId===session.customerId);
  $('printArea').innerHTML=`<h1>Rekap kWh-Ku</h1><p>Dicetak: ${new Date().toLocaleString('id-ID')} · Oleh: ${esc(session.name)}${selId?' · Pelanggan '+esc(selId):''}</p>
  <h3>Ringkasan bulan ini</h3><table><tr><th>ID</th><th>Nama</th><th>Daya</th><th>Energi (kWh)</th><th>Biaya (Rp)</th><th>Tarif (Rp/kWh)</th></tr>${cs.map(c=>`<tr><td>${esc(c.customerId)}</td><td>${esc(c.name)}</td><td>${fmt(c.powerVa)} VA</td><td>${fmtEnergy(c.energyMonthKwh)}</td><td>${rp(c.costMonthRp)}</td><td>${rp(c.tariffRpPerKwh)}</td></tr>`).join('')}</table>
  <h3>Riwayat harian</h3><table><tr><th>Tanggal</th><th>Pelanggan</th><th>kWh</th><th>Biaya (Rp)</th></tr>${historyRows().slice(0,500).map(r=>`<tr><td>${dLabel(r.date)}</td><td>${esc(r.customerId)} ${esc(cust(r.customerId).name)}</td><td>${fmt(r.kwh)}</td><td>${rp(r.costRp)}</td></tr>`).join('')}</table>`;
  window.print()}
$('printHistory').onclick=printRecap;$('printCustomers').onclick=printRecap;
$('exportHistory').onclick=()=>{const q=[['Tanggal','ID Pelanggan','Nama','kWh','Biaya Rp'],...historyRows().map(r=>[r.date,r.customerId,cust(r.customerId).name,r.kwh,r.costRp])];
  const csv=q.map(r=>r.map(x=>'"'+String(x??'').replaceAll('"','""')+'"').join(',')).join('\r\n'),a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));a.download='rekap-kWh-Ku.csv';a.click();URL.revokeObjectURL(a.href);toast('CSV diunduh')};
setInterval(()=>{if(session)refresh().catch(()=>{})},Math.max(10000,Number(CFG.REFRESH_MS)||30000));

 
// ---- Pengajuan penambahan daya
let powerRequests=[];
async function loadPowerRequests(){
 if(!session)return;
 const res=await api('getPowerRequests',session);
 if(!res?.ok)throw Error(res?.message||'Pengajuan gagal dimuat');
 powerRequests=Array.isArray(res.rows)?res.rows:[];
 const visible=powerRequests;
 $('powerRequestTable').innerHTML=visible.map(r=>`<tr><td>${r.createdAt?new Date(r.createdAt).toLocaleString('id-ID'):'—'}</td><td>${esc(r.customerId)} · ${esc(r.name||r.customerId)}</td><td>${fmt(r.currentPowerVa)} VA</td><td>${fmt(r.requestedPowerVa)} VA</td><td>${esc(r.reason||'—')}</td><td><span class="badge ${r.status==='DISETUJUI'?'':'amber'}">${esc(r.status)}</span></td><td>${admin()&&r.status==='MENUNGGU'?'<button class="small-btn" data-approve="'+esc(r.requestId)+'">Setujui</button> <button class="small-btn" data-reject="'+esc(r.requestId)+'">Tolak</button>':'—'}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">Belum ada pengajuan.</td></tr>';
}
$('powerRequestForm').onsubmit=async e=>{e.preventDefault();const btn=e.target.querySelector('button[type=submit]');btn.disabled=true;btn.textContent='Mengirim…';try{const res=await api('submitPowerRequest',session,Number($('requestedPowerVa').value),$('powerRequestReason').value.trim());if(!res?.ok)throw Error(res?.message||'Pengajuan gagal');$('powerRequestReason').value='';toast('Pengajuan berhasil dikirim');await loadPowerRequests()}catch(err){toast(err.message||String(err))}finally{btn.disabled=false;btn.textContent='Kirim pengajuan'}};
$('powerRequestTable').onclick=async e=>{const a=e.target.closest('[data-approve]'),r=e.target.closest('[data-reject]');if(!a&&!r)return;const id=(a||r).dataset[a?'approve':'reject'];const action=a?'DISETUJUI':'DITOLAK';let tariff=null;if(a){const req=powerRequests.find(x=>String(x.requestId)===String(id));const va=Number(req?.requestedPowerVa);let opts=va<=450?'415 = 450 VA subsidi':va<=900?'605 = 900 VA subsidi; 1352 = 900 VA RTM':va<=2200?'1444.70 = 1.300/2.200 VA': '1699.53 = 3.500 VA ke atas';const selected=prompt('Masukkan tarif Rp/kWh sesuai golongan pelanggan. Pilihan yang relevan: '+opts,va<=450?'415':va<=900?'605':va<=2200?'1444.70':'1699.53');if(selected===null)return;tariff=Number(selected);if(!Number.isFinite(tariff)||tariff<=0){toast('Tarif tidak valid');return}}if(!confirm((a?'Setujui dan terapkan daya serta tarif Rp '+tariff+'/kWh?':'Tolak pengajuan ini?')))return;try{const res=await api('reviewPowerRequest',session,id,action,tariff);if(!res?.ok)throw Error(res?.message||'Gagal memproses');toast(res.message||'Pengajuan diproses');await refresh();await loadPowerRequests()}catch(err){toast(err.message||String(err))}};
$('resetMyData').onclick=async()=>{if(admin())return;if(!confirm('Reset akan menghapus riwayat pembacaan dan rekap pemakaian akun Anda dari sistem. Tindakan ini tidak dapat dibatalkan. Lanjutkan?'))return;if(!confirm('Konfirmasi terakhir: hapus semua data pembacaan listrik milik akun Anda?'))return;try{const res=await api('resetCustomerData',session);if(!res?.ok)throw Error(res?.message||'Reset gagal');toast('Data pembacaan berhasil direset');await refresh()}catch(err){toast(err.message||String(err))}};
