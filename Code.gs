/**
 * kWhku — Google Apps Script API
 * Deploy as Web App: Execute as Me, access according to your security needs.
 *
 * IMPORTANT:
 * - Replace CONFIG.ADMIN_PIN and CONFIG.DEVICE_API_KEY before deployment.
 * - The device key is a basic shared secret, not a substitute for a secure gateway.
 * - Do not expose the device key in browser-side HTML.
 * - CT-only sensors do not measure true kWh by themselves unless voltage and power
 *   factor are also measured/estimated. Prefer a calibrated energy-meter module.
 */
// Simpan nilai rahasia di Apps Script > Project Settings > Script properties.
// Properti yang digunakan: SPREADSHEET_ID, DEVICE_API_KEY, ADMIN_PIN.
// Nilai fallback di bawah hanya untuk memberi pesan konfigurasi yang jelas.
const CONFIG = {
  get SPREADSHEET_ID() { return PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || 'PASTE_GOOGLE_SHEET_ID_HERE'; },
  get DEVICE_API_KEY() { return PropertiesService.getScriptProperties().getProperty('DEVICE_API_KEY') || 'REPLACE_WITH_LONG_RANDOM_DEVICE_KEY'; },
  get ADMIN_PIN() { return PropertiesService.getScriptProperties().getProperty('ADMIN_PIN') || 'REPLACE_ADMIN_PIN'; },
  get DEFAULT_TARIFF_RP_PER_KWH() { return Number(PropertiesService.getScriptProperties().getProperty('DEFAULT_TARIFF_RP_PER_KWH') || 1500); },
  TIME_ZONE: 'Asia/Jakarta',
  MAX_AGE_MINUTES_ONLINE: 3
};

function assertConfigured_() {
  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'PASTE_GOOGLE_SHEET_ID_HERE') {
    throw new Error('Konfigurasi belum lengkap. Isi Script property SPREADSHEET_ID.');
  }
}


const SHEETS = {
  customers: ['Pelanggan', ['customerId','name','meterId','mode','tariffRpPerKwh','powerVa','tokenBalanceRp','monthlyTargetRp','active','createdAt']],
  readings: ['Data_Listrik', ['timestamp','customerId','meterId','voltageV','currentA','powerW','energyKwh','frequencyHz','powerFactor','source','receivedAt']],
  tokens: ['Token', ['createdAt','customerId','amountRp','balanceAfterRp','note','createdBy','tokenCode']],
  users: ['Users', ['username','pin','role','customerId','active']],
  settings: ['Pengaturan', ['key','value']]
};

function doGet(e) {
  // Frontend di-host di GitHub Pages; Apps Script hanya sebagai API JSON.
  let configured=true; try{assertConfigured_();}catch(err){configured=false;}
  return json_({ok:true, service:'kWh-Ku API', configured:configured, time:new Date().toISOString()});
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function setupKWhku() {
  assertConfigured_();
  if (CONFIG.ADMIN_PIN === 'REPLACE_ADMIN_PIN') throw new Error('Isi Script property ADMIN_PIN sebelum setup.');
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  Object.keys(SHEETS).forEach(key => {
    const [name, headers] = SHEETS[key];
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1,1,1,headers.length).setValues([headers]);
      sh.setFrozenRows(1);
      sh.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#e32636').setFontColor('#ffffff');
    }
  });
  seedDemoRows_();
  return {ok:true, message:'Sheet kWhku siap. Hapus data demo sebelum penggunaan produksi.'};
}

function seedDemoRows_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sh = ss.getSheetByName('Pelanggan');
  if (sh.getLastRow() > 1) return;
  const now = new Date();
  sh.getRange(2,1,3,10).setValues([
    ['PLG-001','Pelanggan Demo 1','ESP32-001','PRABAYAR',CONFIG.DEFAULT_TARIFF_RP_PER_KWH,1300,100000,200000,true,now],
    ['PLG-002','Pelanggan Demo 2','ESP32-002','PASCABAYAR',CONFIG.DEFAULT_TARIFF_RP_PER_KWH,2200,0,250000,true,now],
    ['PLG-003','Pelanggan Demo 3','ESP32-003','PRABAYAR',CONFIG.DEFAULT_TARIFF_RP_PER_KWH,900,50000,150000,true,now]
  ]);
  const users = ss.getSheetByName('Users');
  if (users.getLastRow() === 1) {
    users.getRange(2,1,4,5).setValues([
      ['admin',hashPin_(CONFIG.ADMIN_PIN),'ADMIN','',true],
      ['PLG-001',hashPin_('123456'),'PELANGGAN','PLG-001',true],
      ['PLG-002',hashPin_('123456'),'PELANGGAN','PLG-002',true],
      ['PLG-003',hashPin_('123456'),'PELANGGAN','PLG-003',true]
    ]);
  }
}

function apiLogin_(username, pin) {
  assertConfigured_();
  const u = String(username || '').trim();
  const p = String(pin || '');
  if (!u || p.length < 4 || p.length > 128) return {ok:false,message:'Username/ID atau PIN tidak valid.'};
  const cache=CacheService.getScriptCache();
  const attemptKey='kwhku_login_attempts_'+Utilities.base64EncodeWebSafe(u).slice(0,80);
  const attempts=Number(cache.get(attemptKey)||0);
  if(attempts>=5) return {ok:false,message:'Terlalu banyak percobaan login. Coba lagi sekitar 15 menit.'};
  const rows = getRows_('Users');
  const found = rows.find(r => String(r.username) === u && truthy_(r.active));
  const valid=!!found && (String(found.pin)===hashPin_(p) || String(found.pin)===p);
  if (!valid) {
    cache.put(attemptKey,String(attempts+1),900);
    return {ok:false, message:'Username/ID atau PIN tidak valid.'};
  }
  cache.remove(attemptKey);
  // Migrasi otomatis PIN lama yang tersimpan sebagai teks biasa ke bentuk hash.
  if(String(found.pin)!==hashPin_(p)) {
    const userRow=rows.findIndex(r=>String(r.username)===u)+2;
    SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName('Users').getRange(userRow,2).setValue(hashPin_(p));
  }
  if (String(found.role).toUpperCase() === 'ADMIN') {
    return createSession_({ok:true, role:'ADMIN', username:found.username, name:'Administrator', customerId:''});
  }
  const c = getRows_('Pelanggan').find(r => String(r.customerId) === String(found.customerId) && truthy_(r.active));
  if (!c) return {ok:false, message:'Akun pelanggan tidak aktif atau tidak ditemukan.'};
  return createSession_({ok:true, role:'PELANGGAN', username:found.username, name:c.name, customerId:c.customerId});
}

/** Called by website. Server re-checks role and customer scope. */
function getDashboard(session) {
  const s = validateSession_(session);
  if (!s.ok) return s;
  const customers = getRows_('Pelanggan').filter(c => truthy_(c.active));
  const selected = s.role === 'ADMIN' ? customers : customers.filter(c => c.customerId === s.customerId);
  const allReadings = getRows_('Data_Listrik').sort((a,b) => new Date(b.timestamp)-new Date(a.timestamp));
  const now = new Date();
  const monthStart = new Date(now.getFullYear(),now.getMonth(),1);
  const result = selected.map(c => {
    const rs = allReadings.filter(r => r.customerId === c.customerId);
    const latest = rs[0] || null;
    const monthRows = rs.filter(r => new Date(r.timestamp) >= monthStart);
    const firstMonth = monthRows.length ? monthRows[monthRows.length-1] : null;
    const energyMonth = firstMonth && latest ? Math.max(0, Number(latest.energyKwh||0)-Number(firstMonth.energyKwh||0)) : 0;
    const costMonth = energyMonth * Number(c.tariffRpPerKwh || CONFIG.DEFAULT_TARIFF_RP_PER_KWH);
    const online = latest && ((now-new Date(latest.receivedAt || latest.timestamp))/60000 <= CONFIG.MAX_AGE_MINUTES_ONLINE);
    const mode = String(c.mode || 'PASCABAYAR').toUpperCase();
    const balance = Number(c.tokenBalanceRp || 0);
    const dailyCost = estimateDailyCost_(rs, Number(c.tariffRpPerKwh || CONFIG.DEFAULT_TARIFF_RP_PER_KWH));
    return {
      customerId:c.customerId, name:c.name, meterId:c.meterId, mode,
      tariffRpPerKwh:Number(c.tariffRpPerKwh || CONFIG.DEFAULT_TARIFF_RP_PER_KWH),
      powerVa:Number(c.powerVa || 0), energyMonthKwh:round_(energyMonth,3),
      costMonthRp:Math.round(costMonth), latest:latest ? normalizeReading_(latest) : null,
      online:!!online, tokenBalanceRp:balance,
      estimatedDaysLeft: mode === 'PRABAYAR' && dailyCost > 0 ? round_(balance/dailyCost,1) : null,
      dailyCostRp:Math.round(dailyCost)
    };
  });
  const ids = selected.map(c=>c.customerId);
  const recent = allReadings.filter(r=>ids.includes(r.customerId)).slice(0,100).map(normalizeReading_);
  const daily=[];
  selected.forEach(c=>daily.push.apply(daily,dailyUsage_(allReadings.filter(r=>r.customerId===c.customerId),Number(c.tariffRpPerKwh||CONFIG.DEFAULT_TARIFF_RP_PER_KWH),c.customerId)));
  return {ok:true, role:s.role, customers:result, readings:recent, daily:daily, serverTime:now.toISOString()};
}

function getHistory(session, customerId, limit) {
  const s = validateSession_(session);
  if (!s.ok) return s;
  const allowedId = s.role === 'ADMIN' ? String(customerId || '') : s.customerId;
  if (s.role === 'ADMIN' && !allowedId) {
    return {ok:true, rows:getRows_('Data_Listrik').sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).slice(0,Math.min(Number(limit)||300,1000)).map(normalizeReading_)};
  }
  if (s.role !== 'ADMIN' && customerId && String(customerId)!==s.customerId) return {ok:false,message:'Tidak memiliki akses ke data pelanggan ini.'};
  return {ok:true, rows:getRows_('Data_Listrik').filter(r=>r.customerId===allowedId).sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).slice(0,Math.min(Number(limit)||300,1000)).map(normalizeReading_)};
}

function adminCreateCustomer(session, payload) {
  const s = validateSession_(session);
  if (!s.ok || s.role !== 'ADMIN') return {ok:false,message:'Akses admin diperlukan.'};
  const id = String(payload.customerId||'').trim().toUpperCase();
  const name = String(payload.name||'').trim();
  const meterId = String(payload.meterId||'').trim();
  const mode = String(payload.mode||'PASCABAYAR').toUpperCase();
  const tariff = Number(payload.tariffRpPerKwh);
  if (!/^PLG-[A-Z0-9-]{2,20}$/.test(id) || !name || !meterId || !['PRABAYAR','PASCABAYAR'].includes(mode) || !(tariff>0)) return {ok:false,message:'Periksa ID, nama, meter, mode, dan tarif.'};
  if (getRows_('Pelanggan').some(c=>c.customerId===id)) return {ok:false,message:'ID pelanggan sudah digunakan.'};
  const ss=SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  ss.getSheetByName('Pelanggan').appendRow([id,name,meterId,mode,tariff,Number(payload.powerVa)||1300,Number(payload.tokenBalanceRp)||0,Number(payload.monthlyTargetRp)||0,true,new Date()]);
  // Account is created with a temporary PIN; change it before real deployment.
  const pin=String(Math.floor(100000+Math.random()*900000));
  ss.getSheetByName('Users').appendRow([id,hashPin_(pin),'PELANGGAN',id,true]);
  return {ok:true,customerId:id,temporaryPin:pin,message:'Pelanggan dibuat. Bagikan PIN sementara secara aman dan minta pengguna menggantinya.'};
}

function adminAddTokenBalance(session, customerId, amountRp, note) {
  const s=validateSession_(session);
  if(!s.ok || s.role!=='ADMIN') return {ok:false,message:'Akses admin diperlukan.'};
  const amount=Number(amountRp);
  if(!Number.isFinite(amount)||amount<=0||amount>10000000) return {ok:false,message:'Nominal tidak valid.'};
  const ss=SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sh=ss.getSheetByName('Pelanggan');
  const rows=getRows_('Pelanggan');
  const c=rows.find(r=>r.customerId===String(customerId));
  if(!c) return {ok:false,message:'Pelanggan tidak ditemukan.'};
  if(String(c.mode).toUpperCase()!=='PRABAYAR') return {ok:false,message:'Saldo token hanya untuk pelanggan prabayar.'};
  const row=rows.findIndex(r=>r.customerId===String(customerId))+2;
  const newBalance=Number(c.tokenBalanceRp||0)+amount;
  sh.getRange(row,7).setValue(newBalance);
  const code=genTokenCode_();
  ss.getSheetByName('Token').appendRow([new Date(),customerId,amount,newBalance,String(note||'Penambahan saldo internal'),s.username,code]);
  return {ok:true,balanceRp:newBalance,tokenCode:code,message:'Saldo internal berhasil diperbarui. Ini bukan penerbitan token PLN resmi.'};
}

/** ESP32 sends JSON: {apiKey, deviceId, customerId, timestamp, voltageV, currentA, powerW, energyKwh, frequencyHz, powerFactor, source} */
function doPost(e) {
  try {
    assertConfigured_();
    const body=JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.fn) return json_(handleApi_(body)); // permintaan dari website

    // API perangkat ESP32 (shared key hanya untuk perangkat, bukan browser).
    if (!safeEqual_(String(body.apiKey||''), CONFIG.DEVICE_API_KEY) || CONFIG.DEVICE_API_KEY.indexOf('REPLACE_')===0) {
      return json_({ok:false,message:'Unauthorized device'});
    }
    const deviceId=String(body.deviceId||'').trim();
    const customerId=String(body.customerId||'').trim();
    const customer=getRows_('Pelanggan').find(c=>c.customerId===customerId && c.meterId===deviceId && truthy_(c.active));
    if(!customer) return json_({ok:false,message:'Unknown device/customer'});
    const energy=Number(body.energyKwh);
    const voltage=Number(body.voltageV ?? 0), current=Number(body.currentA ?? 0), power=Number(body.powerW ?? 0);
    const frequency=Number(body.frequencyHz ?? 0), pf=Number(body.powerFactor ?? 0);
    if(!Number.isFinite(energy)||energy<0||energy>1e9||
       ![voltage,current,power,frequency,pf].every(Number.isFinite)||
       voltage<0||voltage>300||current<0||current>1000||power<0||power>1e7||frequency<0||frequency>1000||pf<0||pf>1) {
      return json_({ok:false,message:'Invalid measurement'});
    }
    const parsedTimestamp=body.timestamp ? new Date(body.timestamp) : new Date();
    if (isNaN(parsedTimestamp.getTime())) return json_({ok:false,message:'Invalid timestamp'});
    const timestamp=parsedTimestamp;
    const ss=SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const lock=LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      ss.getSheetByName('Data_Listrik').appendRow([
        timestamp,customerId,deviceId,voltage,current,power,energy,
        frequency,pf,String(body.source||'ESP32').slice(0,40),new Date()
      ]);
    } finally { lock.releaseLock(); }
    return json_({ok:true,message:'Reading saved',customerId,timestamp:timestamp.toISOString()});
  } catch(err) {
    console.error('doPost error:', err);
    return json_({ok:false,message:'Permintaan gagal diproses. Periksa konfigurasi dan log Apps Script.'});
  }
}

function hashPin_(pin) {
  const props=PropertiesService.getScriptProperties();
  let salt=props.getProperty('PIN_SALT');
  if(!salt) { salt=Utilities.getUuid()+Utilities.getUuid(); props.setProperty('PIN_SALT',salt); }
  const bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,salt+'|'+String(pin),Utilities.Charset.UTF_8);
  return 'sha256:'+Utilities.base64EncodeWebSafe(bytes);
}

function createSession_(user) {
  const token = Utilities.getUuid() + Utilities.getUuid();
  const safeUser = {role:user.role, username:user.username, name:user.name, customerId:user.customerId || '', token:token};
  CacheService.getScriptCache().put('kwhku_session_' + token, JSON.stringify({
    username:user.username, role:user.role, customerId:user.customerId || ''
  }), 21600); // 6 jam
  return Object.assign({ok:true}, safeUser);
}

function login(username, pin) {
  // Mempertahankan nama fungsi login jika dipakai dari Apps Script editor.
  return apiLogin_(username, pin);
}

function validateSession_(session) {
  const token = String(session && session.token || '');
  if (!token || token.length < 30) return {ok:false,message:'Sesi tidak valid. Silakan masuk kembali.'};
  const cached = CacheService.getScriptCache().get('kwhku_session_' + token);
  if (!cached) return {ok:false,message:'Sesi berakhir. Silakan masuk kembali.'};
  const s = JSON.parse(cached);
  const u = getRows_('Users').find(r =>
    String(r.username) === String(s.username) &&
    String(r.role).toUpperCase() === String(s.role).toUpperCase() &&
    truthy_(r.active)
  );
  if (!u) return {ok:false,message:'Akun tidak aktif atau sesi tidak valid.'};
  if (String(u.role).toUpperCase() === 'ADMIN') {
    return {ok:true,role:'ADMIN',username:u.username,customerId:''};
  }
  return {ok:true,role:'PELANGGAN',username:u.username,customerId:String(u.customerId)};
}
function getRows_(key) {
  const entry=SHEETS[key]||Object.values(SHEETS).find(x=>x[0]===key);
  if(!entry) throw new Error('Sheet tidak dikenal: '+key);
  const [name,headers]=entry;
  const sh=SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(name);
  if(!sh||sh.getLastRow()<2) return [];
  const values=sh.getRange(2,1,sh.getLastRow()-1,headers.length).getValues();
  return values.map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]])));
}
function normalizeReading_(r) {
  return {timestamp:new Date(r.timestamp).toISOString(),customerId:r.customerId,meterId:r.meterId,
    voltageV:Number(r.voltageV||0),currentA:Number(r.currentA||0),powerW:Number(r.powerW||0),
    energyKwh:Number(r.energyKwh||0),frequencyHz:Number(r.frequencyHz||0),powerFactor:Number(r.powerFactor||0),
    source:r.source||'ESP32'};
}
function estimateDailyCost_(readings,tariff) {
  if(readings.length<2) return 0;
  const newest=readings[0], oldest=readings[Math.min(readings.length-1,20)];
  const hours=(new Date(newest.timestamp)-new Date(oldest.timestamp))/3600000;
  const delta=Number(newest.energyKwh)-Number(oldest.energyKwh);
  if(hours<=0||delta<0) return 0;
  return delta/hours*24*tariff;
}
function truthy_(v){return v===true||String(v).toLowerCase()==='true'||String(v)==='1'||String(v).toLowerCase()==='yes';}
function round_(n,d){const m=Math.pow(10,d||0);return Math.round(n*m)/m;}
function safeEqual_(a,b){if(a.length!==b.length)return false;let out=0;for(let i=0;i<a.length;i++)out|=a.charCodeAt(i)^b.charCodeAt(i);return out===0;}
function json_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}

/** Router API untuk website (POST text/plain berisi JSON {fn,args}). */
function handleApi_(body){
  const a=Array.isArray(body.args)?body.args:[];
  try{
    switch(body.fn){
      case 'login': return apiLogin_(a[0],a[1]);
      case 'getDashboard': return getDashboard(a[0]);
      case 'getHistory': return getHistory(a[0],a[1],a[2]);
      case 'getTokens': return getTokens(a[0]);
      case 'adminCreateCustomer': return adminCreateCustomer(a[0],a[1]||{});
      case 'adminAddTokenBalance': return adminAddTokenBalance(a[0],a[1],a[2],a[3]);
      default: return {ok:false,message:'Operasi tidak dikenal.'};
    }
  }catch(err){console.error(err);return {ok:false,message:'Terjadi kesalahan server.'};}
}
function getTokens(session){
  const s=validateSession_(session); if(!s.ok) return s;
  const names={}; getRows_('Pelanggan').forEach(c=>names[c.customerId]=c.name);
  let rows=getRows_('Token'); if(s.role!=='ADMIN') rows=rows.filter(r=>String(r.customerId)===s.customerId);
  return {ok:true,rows:rows.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,200).map(r=>({
    createdAt:new Date(r.createdAt).toISOString(),customerId:r.customerId,name:names[r.customerId]||r.customerId,
    amountRp:Number(r.amountRp),tokenCode:r.tokenCode||'',note:r.note||''}))};
}
function genTokenCode_(){let d='';for(let i=0;i<20;i++)d+=Math.floor(Math.random()*10);return d.replace(/(\d{4})(?=\d)/g,'$1-');}
/** Pemakaian harian (kWh & Rp) dari selisih energi kumulatif. readingsDesc = terbaru dulu. */
function dailyUsage_(readingsDesc,tariff,customerId){
  const asc=readingsDesc.slice().reverse(),m={};
  for(let i=1;i<asc.length;i++){
    const d=Number(asc[i].energyKwh)-Number(asc[i-1].energyKwh); if(!(d>=0)) continue;
    const k=Utilities.formatDate(new Date(asc[i].timestamp),CONFIG.TIME_ZONE,'yyyy-MM-dd'); m[k]=(m[k]||0)+d;
  }
  return Object.keys(m).sort().slice(-62).map(k=>({customerId:customerId,date:k,kwh:round_(m[k],3),costRp:Math.round(m[k]*tariff)}));
}
