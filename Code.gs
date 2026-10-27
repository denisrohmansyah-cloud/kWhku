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
  settings: ['Pengaturan', ['key','value']],
  deviceStatus: ['Data_Perangkat', ['customerId','meterId','status','lastReceivedAt','lastStatusChangeAt','updatedAt']],
  connections: ['Log_Koneksi', ['timestamp','customerId','meterId','status','lastReceivedAt','details']],
  incidents: ['Log_Gangguan', ['timestamp','customerId','meterId','eventType','severity','message','resolvedAt']]
};

function doGet(e) {
  // API-only endpoint. Website UI di-host terpisah melalui GitHub Pages.
  if (e && e.parameter && e.parameter.health === '1') {
    let configured = true;
    try { assertConfigured_(); } catch (err) { configured = false; }
    return json_({ok:true, service:'kWh-Ku API', configured:configured, time:new Date().toISOString()});
  }
  return json_({ok:true, service:'kWh-Ku API', message:'API aktif. Gunakan POST untuk permintaan dashboard dan data ESP32.'});
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
  return {ok:true, message:'Sheet kWhku siap. Jalankan setupMonitoring() sekali untuk mengaktifkan log koneksi otomatis.'};
}

// Jalankan sekali dari Apps Script Editor setelah setupKWhku().
function setupMonitoring() {
  assertConfigured_();
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  ['Data_Perangkat','Log_Koneksi','Log_Gangguan'].forEach(name => {
    const headers = SHEETS[Object.keys(SHEETS).find(k => SHEETS[k][0] === name)][1];
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1,1,1,headers.length).setValues([headers]);
      sh.setFrozenRows(1);
      sh.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#e32636').setFontColor('#ffffff');
    }
  });
  const exists = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'checkDeviceStatuses');
  if (!exists) ScriptApp.newTrigger('checkDeviceStatuses').timeBased().everyMinutes(1).create();
  checkDeviceStatuses();
  return {ok:true,message:'Monitoring koneksi aktif; pemeriksaan dijalankan setiap menit.'};
}

function seedDemoRows_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sh = ss.getSheetByName('Pelanggan');
  if (sh.getLastRow() > 1) return;
  const now = new Date();
  sh.getRange(2,1,3,10).setValues([
    ['PLG-001','Pelanggan Demo 900 VA Subsidi','ESP32-001','PASCABAYAR',605,900,0,200000,true,now],
    ['PLG-002','Pelanggan Demo 2200 VA','ESP32-002','PASCABAYAR',1444.70,2200,0,250000,true,now],
    ['PLG-003','Pelanggan Demo 900 VA RTM','ESP32-003','PASCABAYAR',1352,900,0,150000,true,now]
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
  const monthKey = Utilities.formatDate(now, CONFIG.TIME_ZONE, 'yyyy-MM');
  const monthStart = Utilities.parseDate(monthKey + '-01 00:00:00', CONFIG.TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
  const result = selected.map(c => {
    const rs = allReadings.filter(r => r.customerId === c.customerId);
    const latest = rs[0] || null;
    const energyMonth = energyBetween_(rs, monthStart.getTime(), now.getTime());
    const tariff = Number(c.tariffRpPerKwh || CONFIG.DEFAULT_TARIFF_RP_PER_KWH);
    const costMonth = energyMonth * tariff;
    const online = latest && ((now-new Date(latest.receivedAt || latest.timestamp))/60000 <= CONFIG.MAX_AGE_MINUTES_ONLINE);
    const mode = String(c.mode || 'PASCABAYAR').toUpperCase();
    const balance = Number(c.tokenBalanceRp || 0);
    const dailyCost = estimateDailyCost_(rs, Number(c.tariffRpPerKwh || CONFIG.DEFAULT_TARIFF_RP_PER_KWH));
    return {
      customerId:c.customerId, name:c.name, meterId:c.meterId, mode,
      tariffRpPerKwh:Number(c.tariffRpPerKwh || CONFIG.DEFAULT_TARIFF_RP_PER_KWH),
      powerVa:Number(c.powerVa || 0), monthlyTargetRp:Number(c.monthlyTargetRp || 0), energyMonthKwh:round_(energyMonth,6),
      costMonthRp:round_(costMonth,2), latest:latest ? normalizeReading_(latest) : null,
      online:!!online, tokenBalanceRp:balance,
      estimatedDaysLeft: mode === 'PRABAYAR' && dailyCost > 0 ? round_(balance/dailyCost,1) : null,
      dailyCostRp:round_(dailyCost,2)
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
/**
 * Merapikan Data_Listrik hanya jika ada baris kosong di tengah data.
 * Header baris 1 dipertahankan; data bertimestamp dipadatkan mulai baris 2.
 */
function compactReadingRowsIfNeeded_(sheet) {
  // Timestamp di kolom A menjadi penentu apakah baris berisi data.
  // Padatkan semua baris data yang valid ke baris 2..N, tanpa mengubah urutannya.
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const width = Math.max(sheet.getLastColumn(), 11);
  const values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  const kept = values.filter(row => {
    const ts = row[0];
    return ts !== '' && ts !== null && ts !== undefined &&
      !(ts instanceof Date && isNaN(ts.getTime()));
  });

  let hasGap = kept.length !== values.length;
  if (!hasGap) {
    let blankSeen = false;
    for (const row of values) {
      const populated = row[0] !== '' && row[0] !== null && row[0] !== undefined;
      if (!populated) blankSeen = true;
      else if (blankSeen) { hasGap = true; break; }
    }
  }
  if (!hasGap) return kept.length;

  // Bersihkan konten lama pada area data, lalu tulis ulang data valid dari baris 2.
  // Format header, frozen row, dan nama kolom tidak diubah.
  sheet.getRange(2, 1, lastRow - 1, width).clearContent();
  if (kept.length) {
    sheet.getRange(2, 1, kept.length, width).setValues(kept);
  }
  return kept.length;
}

function lastReadingRow_(sheet) {
  // Cari baris terakhir yang benar-benar memiliki timestamp, bukan getLastRow()
  // yang dapat terpengaruh format/isi di kolom lain.
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  const timestamps = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = timestamps.length - 1; i >= 0; i--) {
    const ts = timestamps[i][0];
    if (ts !== '' && ts !== null && ts !== undefined) return i + 2;
  }
  return 1;
}

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
      logIncident_(customerId, deviceId, 'INVALID_MEASUREMENT', 'WARNING', 'Pembacaan ditolak karena nilai sensor di luar batas valid.', '');
      return json_({ok:false,message:'Invalid measurement'});
    }
    const parsedTimestamp=body.timestamp ? new Date(body.timestamp) : new Date();
    if (isNaN(parsedTimestamp.getTime())) return json_({ok:false,message:'Invalid timestamp'});
    const timestamp=parsedTimestamp;
    const ss=SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const lock=LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const receivedAt = new Date();
      const readingSheet = ss.getSheetByName('Data_Listrik');
      if (!readingSheet) throw new Error('Sheet Data_Listrik tidak ditemukan');
      // Rapikan baris kosong lama; data bertimestamp dipadatkan mulai baris 2.
      compactReadingRowsIfNeeded_(readingSheet);
      const existing = getRows_('Data_Listrik').filter(r => String(r.customerId) === customerId && String(r.meterId) === deviceId)
        .sort((a,b) => new Date(b.receivedAt || b.timestamp) - new Date(a.receivedAt || a.timestamp));
      const previous = existing[0];
      if (previous && energy + 0.0005 < Number(previous.energyKwh || 0)) {
        logIncident_(customerId, deviceId, 'ENERGY_COUNTER_DROP', 'WARNING',
          'Energi kumulatif turun dari '+Number(previous.energyKwh||0)+' menjadi '+energy+' kWh. Periksa reset meter atau urutan data.', '');
      }
      // Tulis pada baris berikutnya setelah timestamp terakhir yang valid.
      // Ini menghindari data masuk ke baris 54/63 saat ada celah kosong lama.
      const savedRow = lastReadingRow_(readingSheet) + 1;
      readingSheet.getRange(savedRow, 1, 1, 11).setValues([[
        timestamp,customerId,deviceId,voltage,current,power,energy,
        frequency,pf,String(body.source||'ESP32').slice(0,40),receivedAt
      ]]);
      // Format tampilan: V/A/W/Hz/PF dua desimal, energi kWh tiga desimal.
      // Nilai sensor asli tetap disimpan; format ini hanya mengubah tampilan di Sheets.
      readingSheet.getRange(savedRow, 4, 1, 3).setNumberFormat('0.00'); // D:F
      readingSheet.getRange(2, 7, savedRow - 1, 1).setNumberFormat('0.000'); // G: energyKwh, termasuk data lama
      readingSheet.getRange(savedRow, 8, 1, 2).setNumberFormat('0.00'); // H:I
      // Sembunyikan metadata teknis yang tidak digunakan pada tabel penelitian; data tetap tersimpan.
      if (!readingSheet.isColumnHiddenByUser(8)) readingSheet.hideColumns(8, 4); // H:K
      updateDeviceStatus_(customerId, deviceId, 'ONLINE', receivedAt, 'Pembacaan ESP32 diterima.');
    } finally { lock.releaseLock(); }
    return json_({ok:true,message:'Reading saved',customerId,timestamp:timestamp.toISOString(),receivedAt:new Date().toISOString()});
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
function getMonitoring(session, limit) {
  const s = validateSession_(session);
  if (!s.ok) return s;
  const allCustomers = getRows_('Pelanggan').filter(c => truthy_(c.active) && String(c.mode).toUpperCase() === 'PASCABAYAR');
  const selected = s.role === 'ADMIN' ? allCustomers : allCustomers.filter(c => String(c.customerId) === s.customerId);
  const ids = selected.map(c => String(c.customerId));
  const readings = getRows_('Data_Listrik').filter(r => ids.includes(String(r.customerId)))
    .sort((a,b) => new Date(b.receivedAt || b.timestamp) - new Date(a.receivedAt || a.timestamp))
    .slice(0, Math.min(Math.max(Number(limit)||100,1),500)).map(r => {
      const n = normalizeReading_(r);
      n.receivedAt = new Date(r.receivedAt || r.timestamp).toISOString();
      n.voltageV = Number(r.voltageV || 0); n.currentA = Number(r.currentA || 0);
      n.powerW = Number(r.powerW || 0); n.energyKwh = Number(r.energyKwh || 0);
      return n;
    });
  const connections = getRows_('Log_Koneksi').filter(r => ids.includes(String(r.customerId)))
    .sort((a,b) => new Date(b.timestamp)-new Date(a.timestamp)).slice(0,100).map(r => ({
      timestamp:new Date(r.timestamp).toISOString(),customerId:r.customerId,meterId:r.meterId,
      status:String(r.status||''),lastReceivedAt:r.lastReceivedAt ? new Date(r.lastReceivedAt).toISOString() : '',
      details:String(r.details||'')
    }));
  const incidents = getRows_('Log_Gangguan').filter(r => ids.includes(String(r.customerId)))
    .sort((a,b) => new Date(b.timestamp)-new Date(a.timestamp)).slice(0,100).map(r => ({
      timestamp:new Date(r.timestamp).toISOString(),customerId:r.customerId,meterId:r.meterId,
      eventType:String(r.eventType||''),severity:String(r.severity||'INFO'),message:String(r.message||''),
      resolvedAt:r.resolvedAt ? new Date(r.resolvedAt).toISOString() : ''
    }));
  const devices = getRows_('Data_Perangkat').filter(r => ids.includes(String(r.customerId))).map(r => ({
    customerId:r.customerId,meterId:r.meterId,status:String(r.status||'UNKNOWN'),
    lastReceivedAt:r.lastReceivedAt ? new Date(r.lastReceivedAt).toISOString() : '',
    lastStatusChangeAt:r.lastStatusChangeAt ? new Date(r.lastStatusChangeAt).toISOString() : ''
  }));
  return {ok:true,readings,connections,incidents,devices,checkedAt:new Date().toISOString()};
}

// Pemeriksaan terjadwal berjalan di server walaupun website tidak dibuka.
function checkDeviceStatuses() {
  assertConfigured_();
  const customers = getRows_('Pelanggan').filter(c => truthy_(c.active) && String(c.mode).toUpperCase() === 'PASCABAYAR');
  const readings = getRows_('Data_Listrik');
  const now = new Date();
  customers.forEach(c => {
    const rs = readings.filter(r => String(r.customerId) === String(c.customerId))
      .sort((a,b) => new Date(b.receivedAt || b.timestamp) - new Date(a.receivedAt || a.timestamp));
    const last = rs[0];
    const lastSeen = last ? new Date(last.receivedAt || last.timestamp) : null;
    const status = lastSeen && (now - lastSeen) <= CONFIG.MAX_AGE_MINUTES_ONLINE*60000 ? 'ONLINE' : 'OFFLINE';
    updateDeviceStatus_(c.customerId, c.meterId, status, lastSeen, status === 'ONLINE' ? 'Data diterima dalam batas waktu.' : 'Tidak ada data baru melewati batas waktu.');
  });
}

function updateDeviceStatus_(customerId, meterId, status, lastReceivedAt, details) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const statusSheet = ss.getSheetByName('Data_Perangkat');
  const connectionsSheet = ss.getSheetByName('Log_Koneksi');
  const incidentsSheet = ss.getSheetByName('Log_Gangguan');
  if (!statusSheet || !connectionsSheet || !incidentsSheet) return;
  const rows = getRows_('Data_Perangkat');
  const index = rows.findIndex(r => String(r.customerId) === String(customerId) && String(r.meterId) === String(meterId));
  const previous = index >= 0 ? String(rows[index].status || '') : '';
  const now = new Date();
  const seen = lastReceivedAt instanceof Date && !isNaN(lastReceivedAt.getTime()) ? lastReceivedAt : '';
  if (index < 0) {
    statusSheet.appendRow([customerId,meterId,status,seen,now,now]);
  } else {
    statusSheet.getRange(index+2,3,1,4).setValues([[status,seen,(previous !== status ? now : rows[index].lastStatusChangeAt || now),now]]);
  }
  if (previous !== status) {
    connectionsSheet.appendRow([now,customerId,meterId,status,seen,details]);
    if (status === 'OFFLINE') {
      logIncident_(customerId,meterId,'CONNECTION_LOST','WARNING','Tidak ada data ESP32 melewati '+CONFIG.MAX_AGE_MINUTES_ONLINE+' menit.', '');
    } else if (status === 'ONLINE' && previous === 'OFFLINE') {
      resolveLatestIncident_(customerId,meterId,'CONNECTION_LOST',now);
      logIncident_(customerId,meterId,'CONNECTION_RESTORED','INFO','Data ESP32 kembali diterima.','');
    }
  }
}

function logIncident_(customerId,meterId,eventType,severity,message,resolvedAt) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sh = ss.getSheetByName('Log_Gangguan');
  if (!sh) return;
  sh.appendRow([new Date(),customerId,meterId,eventType,severity,message,resolvedAt || '']);
}
function resolveLatestIncident_(customerId,meterId,eventType,when) {
  const sh = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName('Log_Gangguan');
  if (!sh || sh.getLastRow()<2) return;
  const values = sh.getRange(2,1,sh.getLastRow()-1,7).getValues();
  for (let i=values.length-1;i>=0;i--) {
    if (String(values[i][1])===String(customerId) && String(values[i][2])===String(meterId) &&
        String(values[i][3])===eventType && !values[i][6]) {
      sh.getRange(i+2,7).setValue(when); return;
    }
  }
}

function normalizeReading_(r) {
  // Jangan membulatkan nilai mentah di backend: perhitungan energi memakai presisi asli sensor.
  return {timestamp:new Date(r.timestamp).toISOString(),customerId:r.customerId,meterId:r.meterId,
    voltageV:Number(r.voltageV||0),currentA:Number(r.currentA||0),powerW:Number(r.powerW||0),
    energyKwh:Number(r.energyKwh||0),frequencyHz:Number(r.frequencyHz||0),powerFactor:Number(r.powerFactor||0),
    source:r.source||'ESP32'};
}
function estimateDailyCost_(readings,tariff) {
  if(!Array.isArray(readings)||readings.length<2||!(Number(tariff)>0))return 0;
  const ordered=readings.slice().sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)),newest=ordered[ordered.length-1],oldest=ordered[Math.max(0,ordered.length-21)];
  const t0=new Date(oldest.timestamp).getTime(),t1=new Date(newest.timestamp).getTime(),delta=Number(newest.energyKwh)-Number(oldest.energyKwh),hours=(t1-t0)/3600000;
  if(!Number.isFinite(t0)||!Number.isFinite(t1)||hours<=0||!Number.isFinite(delta)||delta<0)return 0;
  return delta/hours*24*Number(tariff);
}
function energyBetween_(readingsDesc,startMs,endMs){
  if(!Array.isArray(readingsDesc)||readingsDesc.length<2||!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs)return 0;
  const ordered=readingsDesc.slice().sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));let total=0;
  for(let i=1;i<ordered.length;i++){const a=ordered[i-1],b=ordered[i],t0=new Date(a.timestamp).getTime(),t1=new Date(b.timestamp).getTime(),e0=Number(a.energyKwh),e1=Number(b.energyKwh);
    if(!Number.isFinite(t0)||!Number.isFinite(t1)||t1<=t0||!Number.isFinite(e0)||!Number.isFinite(e1)||e1<e0)continue;
    const overlap=Math.max(0,Math.min(t1,endMs)-Math.max(t0,startMs));if(overlap>0)total+=(e1-e0)*overlap/(t1-t0)}
  return total;
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
      case 'getMonitoring': return getMonitoring(a[0],a[1]);
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
  // Distribusikan selisih counter ke tanggal yang benar berdasarkan lama interval,
  // agar interval yang melewati tengah malam tidak seluruhnya masuk ke satu hari.
  const asc=readingsDesc.slice().filter(r => r && Number.isFinite(new Date(r.timestamp).getTime()))
    .sort((a,b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const m={};
  for(let i=1;i<asc.length;i++){
    const r0=asc[i-1],r1=asc[i];
    const t0=new Date(r0.timestamp).getTime(),t1=new Date(r1.timestamp).getTime();
    const e0=Number(r0.energyKwh),e1=Number(r1.energyKwh),delta=e1-e0;
    if(!Number.isFinite(t0)||!Number.isFinite(t1)||t1<=t0||!Number.isFinite(delta)||delta<0) continue;
    let cursor=t0;
    while(cursor<t1){
      const day=Utilities.formatDate(new Date(cursor),CONFIG.TIME_ZONE,'yyyy-MM-dd');
      const nextDay=Utilities.parseDate(day+' 00:00:00',CONFIG.TIME_ZONE,'yyyy-MM-dd HH:mm:ss').getTime()+24*60*60*1000;
      const end=Math.min(t1,nextDay);
      if(end<=cursor) break;
      const share=delta*((end-cursor)/(t1-t0));
      m[day]=(m[day]||0)+share;
      cursor=end;
    }
  }
  return Object.keys(m).sort().slice(-62).map(k=>({customerId:customerId,date:k,kwh:m[k],costRp:m[k]*tariff}));
}
