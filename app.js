const $=id=>document.getElementById(id);
const rp=n=>'Rp '+Math.round(Number(n)||0).toLocaleString('id-ID');
const fmt=n=>(Number(n)||0).toLocaleString('id-ID',{maximumFractionDigits:2});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dText=d=>new Date(d).toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'});
const dk=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const dLabel=k=>dText(k+'T00:00:00');
const CFG=window.KWHKU_CONFIG||{},DEMO=!CFG.API_URL;
let session=null,customers=[],daily=[],tokens=[],selId='',shown=new Date();shown.setDate(1);

function toast(m){const t=$('toast');t.textContent=m;t.classList.remove('hidden');setTimeout(()=>t.classList.add('hidden'),3500)}
async function api(fn,...args){
  if(DEMO){if(!window.DemoAPI[fn])throw Error('Operasi tidak tersedia');return window.DemoAPI[fn](...args)}
  const r=await fetch(CFG.API_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({fn,args})});
  if(!r.ok)throw Error('Server '+r.status);return r.json();
}
const admin=()=>session?.role==='ADMIN';
const rows=()=>daily.filter(r=>admin()?(!selId||r.customerId===selId):r.customerId===session.customerId);
const sorted=()=>rows().slice().sort((a,b)=>b.date.localeCompare(a.date)||a.customerId.localeCompare(b.customerId));
const cust=id=>customers.find(c=>c.customerId===id)||{customerId:id,name:id};
const avg=id=>{const a=daily.filter(r=>r.customerId===id);return a.length?a.reduce((s,r)=>s+r.kwh,0)/a.length:0};
const high=r=>r.kwh>avg(r.customerId)*1.5;
const badge=r=>high(r)?'<span class="badge red">Tinggi</span>':'<span class="badge">Normal</span>';

// ---- Login
document.querySelectorAll('.role-btn').forEach(b=>b.onclick=()=>{document.querySelectorAll('.role-btn').forEach(x=>x.classList.toggle('active',x===b));$('role').value=b.dataset.role});
$('demoHint').innerHTML=DEMO?'<b>MODE DEMO</b> (data contoh).<br>Pelanggan: <b>PLG-001</b> / <b>123456</b><br>Admin: <b>admin</b> / <b>admin123</b>':'Masuk dengan akun yang terdaftar di Google Sheets.';
$('liveText').textContent=DEMO?'MODE DEMO':'TERHUBUNG KE SHEETS';
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();const btn=e.target.querySelector('button[type=submit]');btn.disabled=true;btn.textContent='Memeriksa…';
  try{const res=await api('login',$('username').value.trim(),$('password').value);
    if(!res?.ok){toast(res?.message||'Login gagal.');return}
    if(res.role!==($('role').value==='admin'?'ADMIN':'PELANGGAN')){toast('Pilihan role tidak sesuai dengan akun ini.');return}
    session=res;selId='';$('loginView').classList.add('hidden');$('appView').classList.remove('hidden');
    $('profileName').textContent=res.name;$('profileRole').textContent=admin()?'Administrator':'Pelanggan';$('avatar').textContent=(res.name||'U')[0].toUpperCase();
    document.querySelectorAll('.admin-only,.admin-col').forEach(el=>el.classList.toggle('hidden',!admin()));
    $('welcomeTitle').textContent='Halo, '+(admin()?'Admin':res.name.split(' ')[0])+'! 👋';
    $('welcomeSub').textContent=admin()?'Pantau data listrik seluruh pelanggan.':'Berikut ringkasan penggunaan listrik Anda.';
    await refresh();showPage('dashboard');
  }catch(err){toast('Gagal terhubung: '+(err.message||err))}finally{btn.disabled=false;btn.innerHTML='Masuk ke Dashboard <span aria-hidden="true">→</span>'}});
$('logout').onclick=()=>{session=null;customers=[];daily=[];tokens=[];$('password').value='';$('appView').classList.add('hidden');$('loginView').classList.remove('hidden')};
$('mobileMenu').onclick=()=>$('sidebar').classList.toggle('open');

// ---- Navigasi
const titles={dashboard:['Dashboard','Ringkasan penggunaan listrik'],calendar:['Kalender Pemakaian','Lihat pemakaian per tanggal'],history:['Riwayat Penggunaan','Energi dan biaya per hari'],customers:['Data Pelanggan','Kelola pelanggan terdaftar'],tokens:['Token Listrik','Buat dan lihat token pelanggan']};
function showPage(p){if(['customers','tokens'].includes(p)&&!admin())p='dashboard';
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));$('page-'+p).classList.add('active');
  document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===p));
  $('pageHeading').textContent=titles[p][0];$('pageSub').textContent=titles[p][1];$('sidebar').classList.remove('open');
  if(p!=='history'&&selId){selId='';$('historySearch').value=''}
  renderAll()}
document.querySelectorAll('#nav button').forEach(b=>b.onclick=()=>showPage(b.dataset.page));
document.querySelectorAll('[data-goto]').forEach(b=>b.onclick=()=>showPage(b.dataset.goto));

async function refresh(){
  const res=await api('getDashboard',session);if(!res?.ok){if(/Sesi/.test(res?.message||''))$('logout').click();throw Error(res?.message||'Data gagal dimuat')}
  customers=res.customers||[];daily=res.daily||[];
  if(admin()){const t=await api('getTokens',session);tokens=t?.rows||[]}
  renderAll()}

// ---- Render
function renderAll(){if(!session)return;
  $('todayLabel').textContent=new Date().toLocaleDateString('id-ID',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
  const c=admin()?null:customers.find(x=>x.customerId===session.customerId),L=c?.latest,sum=k=>customers.reduce((a,x)=>a+(Number(x[k])||0),0);
  $('costStat').textContent=rp(c?c.costMonthRp:sum('costMonthRp'));$('kwhStat').textContent=fmt(c?c.energyMonthKwh:sum('energyMonthKwh'))+' kWh';
  $('powerStat').textContent=fmt(c?L?.powerW:customers.reduce((a,x)=>a+(Number(x.latest?.powerW)||0),0))+' W';
  const today=dk(new Date());$('todayKwh').innerHTML=fmt(rows().filter(r=>r.date===today).reduce((a,r)=>a+r.kwh,0))+' kWh<small>Hari ini</small>';
  const days=c?.estimatedDaysLeft,pre=c?.mode==='PRABAYAR';
  $('tokenStatLabel').innerHTML=(admin()?'Pelanggan aktif':'Estimasi token habis')+' <span class="stat-icon">▤</span>';
  $('tokenStat').textContent=admin()?customers.length+' pelanggan':pre?(days==null?'—':fmt(days)+' hari'):'Pascabayar';
  if(days!=null){const d=new Date();d.setDate(d.getDate()+Math.floor(days));$('tokenDate').innerHTML=dText(d)+'<small>Perkiraan</small>'}else $('tokenDate').innerHTML='—<small>'+(admin()?'Semua pelanggan':pre?'Belum cukup data':'Pascabayar')+'</small>';
  $('tokenBalance').textContent=c&&pre?rp(c.tokenBalanceRp):'—';$('tokenPercent').textContent=pre&&days!=null?fmt(days)+' hari':'';
  $('tokenProgress').style.width=pre&&days!=null?Math.min(100,days/30*100)+'%':'0%';
  $('tokenUsed').textContent=pre?'Rata-rata ±'+rp(c.dailyCostRp)+'/hari':admin()?'Ringkasan seluruh pelanggan':'Tagihan dihitung akhir bulan';
  const on=customers.filter(x=>x.online).length,heavy=L&&c.powerVa&&L.powerW>c.powerVa*.8;
  $('meterStatus').innerHTML=admin()?on+'/'+customers.length+'<small>Online</small>':(c?.online?'Aktif':'Offline')+'<small>'+(c?.online?'Online':'Data lama')+'</small>';
  $('meterNote').textContent=admin()?'Meter terhubung':'Meter '+(c?.meterId||'');
  $('statusBadge').textContent=admin()?'● '+on+' online':!c?.online?'● Offline':heavy?'● Beban tinggi':'● Normal';
  $('statusBadge').className='badge '+(!admin()&&(!c?.online||heavy)?'red':'');
  renderChart();renderRecent();renderHistory();renderCalendar();renderCustomers();renderTokens()}
function renderChart(){const ds=[];for(let i=6;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);ds.push(dk(d))}
  const rs=rows(),v=ds.map(k=>rs.filter(r=>r.date===k).reduce((a,r)=>a+r.kwh,0)),mx=Math.max(.1,...v);
  $('chart').innerHTML=ds.map((k,i)=>`<div class="bar-col"><div class="bar ${i===6?'current':''}" style="height:${Math.max(5,v[i]/mx*90)}%" title="${fmt(v[i])} kWh"></div><small>${k.slice(8)}/${k.slice(5,7)}</small></div>`).join('')}
function renderRecent(){$('recentTable').innerHTML=sorted().slice(0,5).map(r=>`<tr><td>${dLabel(r.date)}</td><td><b>${fmt(r.kwh)} kWh</b></td><td>${rp(r.costRp)}</td><td>${badge(r)}</td></tr>`).join('')||'<tr><td colspan="4" class="empty">Belum ada data dari ESP32.</td></tr>'}
function renderHistory(){const q=$('historySearch').value.toLowerCase(),f=$('historyFilter').value;
  const d=sorted().filter(r=>(r.date+' '+r.customerId+' '+cust(r.customerId).name).toLowerCase().includes(q)&&(f==='all'||(f==='high')===high(r)));
  $('historyTable').innerHTML=d.map(r=>`<tr><td>${dLabel(r.date)}</td><td class="admin-col ${admin()?'':'hidden'}">${esc(r.customerId)} · ${esc(cust(r.customerId).name)}</td><td><b>${fmt(r.kwh)}</b></td><td>${rp(r.costRp)}</td><td>${badge(r)}</td></tr>`).join('')||`<tr><td colspan="${admin()?5:4}" class="empty">Tidak ada data.</td></tr>`}
$('historySearch').oninput=renderHistory;$('historyFilter').onchange=renderHistory;
function renderCalendar(){const y=shown.getFullYear(),m=shown.getMonth(),first=new Date(y,m,1).getDay(),n=new Date(y,m+1,0).getDate(),by={};
  rows().forEach(r=>{by[r.date]=(by[r.date]||0)+r.kwh});$('monthTitle').textContent=shown.toLocaleDateString('id-ID',{month:'long',year:'numeric'});
  let h=['Min','Sen','Sel','Rab','Kam','Jum','Sab'].map(d=>`<div class="day-name">${d}</div>`).join('')+'<div></div>'.repeat(first);
  for(let d=1;d<=n;d++){const k=dk(new Date(y,m,d));h+=`<div class="day ${by[k]!=null?'has-data':''} ${k===dk(new Date())?'today':''}" data-d="${k}">${d}</div>`}
  $('calendarGrid').innerHTML=h;$('calendarGrid').onclick=e=>{const el=e.target.closest('.day');if(!el)return;const k=el.dataset.d,rs=rows().filter(r=>r.date===k);
    document.querySelectorAll('.day.sel').forEach(x=>x.classList.remove('sel'));el.classList.add('sel');
    $('dayDetail').innerHTML=rs.length?`<b>${dLabel(k)}</b><br>Pemakaian: <b>${fmt(rs.reduce((a,r)=>a+r.kwh,0))} kWh</b> · Biaya: <b>${rp(rs.reduce((a,r)=>a+r.costRp,0))}</b>`:`<b>${dLabel(k)}</b><br>Tidak ada data pemakaian.`}}
$('prevMonth').onclick=()=>{shown.setMonth(shown.getMonth()-1);renderCalendar()};$('nextMonth').onclick=()=>{shown.setMonth(shown.getMonth()+1);renderCalendar()};
function renderCustomers(){if(!admin())return;const q=$('customerSearch').value.toLowerCase();
  $('customerTable').innerHTML=customers.filter(c=>(c.customerId+' '+c.name).toLowerCase().includes(q)).map(c=>`<tr><td><b>${esc(c.customerId)}</b></td><td>${esc(c.name)}</td><td>${fmt(c.powerVa)} VA</td><td>${fmt(c.energyMonthKwh)} kWh</td><td>${rp(c.costMonthRp)}</td><td><span class="badge ${c.online?'':'amber'}">${c.online?'Online':'Offline'}</span></td><td><button class="small-btn" data-view="${esc(c.customerId)}">Lihat riwayat</button></td></tr>`).join('')||'<tr><td colspan="7" class="empty">Belum ada pelanggan.</td></tr>'}
$('customerSearch').oninput=renderCustomers;
$('customerTable').onclick=e=>{const id=e.target.dataset.view;if(!id)return;showPage('history');selId=id;$('historySearch').value=id;renderAll();toast('Riwayat '+cust(id).name)};
function renderTokens(){if(!admin())return;$('tokenTable').innerHTML=tokens.map(t=>`<tr><td>${new Date(t.createdAt).toLocaleString('id-ID')}</td><td><b>${esc(t.customerId)}</b></td><td>${esc(t.name)}</td><td>${rp(t.amountRp)}</td><td class="code">${esc(t.tokenCode||'—')}</td><td>${esc(t.note)}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">Belum ada token dibuat.</td></tr>'}

// ---- Modal admin
function modal(html){$('modalRoot').innerHTML=`<div class="modal-backdrop" id="bd"><div class="modal">${html}</div></div>`;$('bd').onclick=e=>{if(e.target.id==='bd')$('modalRoot').innerHTML=''}}
function openModal(type){const tk=type==='token',pre=customers.filter(c=>c.mode==='PRABAYAR');
  if(tk&&!pre.length)return toast('Belum ada pelanggan prabayar.');
  modal(`<h2>${tk?'Buat token listrik':'Tambah pelanggan'}</h2><p>${tk?'Saldo & kode token internal (bukan token PLN resmi).':'Data disimpan ke Google Sheets.'}</p><form id="mf">${tk?`<div class="field"><label>Pelanggan prabayar</label><select id="mc">${pre.map(c=>`<option value="${esc(c.customerId)}">${esc(c.customerId)} — ${esc(c.name)}</option>`).join('')}</select></div><div class="field"><label>Nominal</label><select id="ma"><option value="20000">Rp 20.000</option><option value="50000" selected>Rp 50.000</option><option value="100000">Rp 100.000</option><option value="200000">Rp 200.000</option></select></div><div class="field"><label>Catatan</label><input id="mn" placeholder="Contoh: pembelian token"></div>`:`<div class="field"><label>ID pelanggan</label><input id="mi" required placeholder="PLG-004"></div><div class="field"><label>Nama</label><input id="mnm" required></div><div class="field"><label>ID meter ESP32</label><input id="mm" required placeholder="ESP32-004"></div><div class="field"><label>Mode</label><select id="mmo"><option value="PRABAYAR">Prabayar</option><option value="PASCABAYAR">Pascabayar</option></select></div><div class="field"><label>Daya</label><select id="mp"><option>900</option><option selected>1300</option><option>2200</option><option>3500</option></select></div><div class="field"><label>Tarif (Rp/kWh)</label><input id="mt" type="number" min="1" value="1500" required></div>`}<div class="modal-actions"><button type="button" class="secondary" id="cm">Batal</button><button class="primary">${tk?'Buat token':'Simpan'}</button></div></form>`);
  $('cm').onclick=()=>$('modalRoot').innerHTML='';
  $('mf').onsubmit=async e=>{e.preventDefault();try{
    const res=tk?await api('adminAddTokenBalance',session,$('mc').value,Number($('ma').value),$('mn').value):await api('adminCreateCustomer',session,{customerId:$('mi').value,name:$('mnm').value,meterId:$('mm').value,mode:$('mmo').value,tariffRpPerKwh:Number($('mt').value),powerVa:Number($('mp').value),tokenBalanceRp:0});
    if(!res?.ok)return toast(res?.message||'Gagal');
    modal(tk?`<h2>Token berhasil dibuat</h2><p>Kode token:</p><p class="code" style="font-size:20px">${esc(res.tokenCode)}</p><p>Saldo baru: <b>${rp(res.balanceRp)}</b></p><div class="modal-actions"><button class="primary" id="ok">Selesai</button></div>`:`<h2>Pelanggan ditambahkan</h2><p>ID: <b>${esc(res.customerId)}</b></p><p>PIN sementara: <b>${esc(res.temporaryPin)}</b></p><p class="sub">Bagikan hanya kepada pelanggan terkait.</p><div class="modal-actions"><button class="primary" id="ok">Selesai</button></div>`);
    $('ok').onclick=()=>$('modalRoot').innerHTML='';await refresh();
  }catch(err){toast('Gagal: '+(err.message||err))}}}
$('createToken').onclick=()=>openModal('token');$('addCustomer').onclick=()=>openModal('customer');

// ---- Cetak rekap & CSV
function printRecap(){const cs=admin()?customers:customers.filter(c=>c.customerId===session.customerId);
  $('printArea').innerHTML=`<h1>Rekap kWh-Ku</h1><p>Dicetak: ${new Date().toLocaleString('id-ID')} · Oleh: ${esc(session.name)}${selId?' · Pelanggan '+esc(selId):''}</p>
  <h3>Ringkasan bulan ini</h3><table><tr><th>ID</th><th>Nama</th><th>Daya</th><th>Energi (kWh)</th><th>Biaya (Rp)</th><th>Saldo token</th></tr>${cs.map(c=>`<tr><td>${esc(c.customerId)}</td><td>${esc(c.name)}</td><td>${fmt(c.powerVa)} VA</td><td>${fmt(c.energyMonthKwh)}</td><td>${rp(c.costMonthRp)}</td><td>${c.mode==='PRABAYAR'?rp(c.tokenBalanceRp):'Pascabayar'}</td></tr>`).join('')}</table>
  <h3>Riwayat harian</h3><table><tr><th>Tanggal</th><th>Pelanggan</th><th>kWh</th><th>Biaya (Rp)</th></tr>${sorted().slice(0,93).map(r=>`<tr><td>${dLabel(r.date)}</td><td>${esc(r.customerId)} ${esc(cust(r.customerId).name)}</td><td>${fmt(r.kwh)}</td><td>${rp(r.costRp)}</td></tr>`).join('')}</table>`;
  window.print()}
$('printHistory').onclick=printRecap;$('printCustomers').onclick=printRecap;
$('exportHistory').onclick=()=>{const q=[['Tanggal','ID Pelanggan','Nama','kWh','Biaya Rp'],...sorted().map(r=>[r.date,r.customerId,cust(r.customerId).name,r.kwh,r.costRp])];
  const csv=q.map(r=>r.map(x=>'"'+String(x??'').replaceAll('"','""')+'"').join(',')).join('\r\n'),a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));a.download='rekap-kWh-Ku.csv';a.click();URL.revokeObjectURL(a.href);toast('CSV diunduh')};
setInterval(()=>{if(session)refresh().catch(e=>console.warn(e))},CFG.REFRESH_MS||30000);
