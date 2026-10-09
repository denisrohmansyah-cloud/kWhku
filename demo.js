// MODE DEMO: data contoh di browser (dipakai bila config.js API_URL kosong).
window.DemoAPI=(()=>{
  let seed=7;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
  const pad=n=>String(n).padStart(2,'0'),dk=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
  const C=[['PLG-001','Budi Santoso','PRABAYAR',1300,100000],['PLG-002','Siti Aminah','PASCABAYAR',2200,0],['PLG-003','Agus Pratama','PRABAYAR',900,50000]]
    .map((a,i)=>({customerId:a[0],name:a[1],meterId:'ESP32-00'+(i+1),mode:a[2],tariffRpPerKwh:1500,powerVa:a[3],tokenBalanceRp:a[4],active:true}));
  const U={admin:{pin:'admin123',role:'ADMIN',name:'Administrator',customerId:''}};
  C.forEach(c=>U[c.customerId]={pin:'123456',role:'PELANGGAN',name:c.name,customerId:c.customerId});
  const R=[],end=Date.now(),sess={};
  C.forEach((c,i)=>{let e=120+i*35;for(let h=720;h>=0;h--){const t=end-h*36e5,hr=new Date(t).getHours(),w=hr>=18&&hr<=22?1.6:hr>=6&&hr<=9?1.1:.5,inc=(.25+i*.08)*w*(.7+rnd()*.6);e+=inc;
    R.push({timestamp:new Date(t).toISOString(),customerId:c.customerId,meterId:c.meterId,voltageV:+(218+rnd()*6).toFixed(1),currentA:+(inc*1000/220).toFixed(2),powerW:Math.round(inc*1000),energyKwh:+e.toFixed(3),frequencyHz:50,powerFactor:.9,source:'DEMO'})}});
  const TK=[{createdAt:new Date(end-5*864e5).toISOString(),customerId:'PLG-001',name:'Budi Santoso',amountRp:100000,tokenCode:'4821-0937-5512-6640-1198',note:'Saldo awal'},
            {createdAt:new Date(end-3*864e5).toISOString(),customerId:'PLG-003',name:'Agus Pratama',amountRp:50000,tokenCode:'7302-1184-9961-0275-3341',note:'Saldo awal'}];
  const code=()=>Array.from({length:5},()=>pad(Math.floor(rnd()*100))+pad(Math.floor(rnd()*100))).join('-');
  const daily=(rs,c)=>{const m={};for(let i=1;i<rs.length;i++){const d=rs[i].energyKwh-rs[i-1].energyKwh;if(d<0)continue;const k=dk(new Date(rs[i].timestamp));m[k]=(m[k]||0)+d}
    return Object.keys(m).sort().map(k=>({customerId:c.customerId,date:k,kwh:+m[k].toFixed(3),costRp:Math.round(m[k]*c.tariffRpPerKwh)}))};
  const me=s=>s&&sess[s.token];
  const bad={ok:false,message:'Sesi tidak valid. Silakan masuk kembali.'};
  return {
    login(u,p){const x=U[u];if(!x||x.pin!==p)return {ok:false,message:'Username/ID atau PIN tidak valid.'};
      const token='demo'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)+'xxxxxxxxxx';sess[token]=x;
      return {ok:true,role:x.role,username:u,name:x.name,customerId:x.customerId,token}},
    getDashboard(s){const u=me(s);if(!u)return bad;const sel=u.role==='ADMIN'?C:C.filter(c=>c.customerId===u.customerId);
      const ms=new Date();ms.setDate(1);ms.setHours(0,0,0,0);let dl=[];const out=sel.map(c=>{
        const rs=R.filter(r=>r.customerId===c.customerId),L=rs[rs.length-1],mr=rs.filter(r=>new Date(r.timestamp)>=ms),e=mr.length?L.energyKwh-mr[0].energyKwh:0,d=daily(rs,c);dl=dl.concat(d);
        const l7=d.slice(-7),dc=l7.length?l7.reduce((a,x)=>a+x.costRp,0)/l7.length:0;
        return {...c,energyMonthKwh:+e.toFixed(3),costMonthRp:Math.round(e*c.tariffRpPerKwh),latest:L,online:true,estimatedDaysLeft:c.mode==='PRABAYAR'&&dc>0?+(c.tokenBalanceRp/dc).toFixed(1):null,dailyCostRp:Math.round(dc)}});
      return {ok:true,role:u.role,customers:out,readings:[],daily:dl,serverTime:new Date().toISOString()}},
    getTokens(s){const u=me(s);if(!u)return bad;return {ok:true,rows:TK.filter(t=>u.role==='ADMIN'||t.customerId===u.customerId).slice().reverse()}},
    adminCreateCustomer(s,p){const u=me(s);if(!u||u.role!=='ADMIN')return {ok:false,message:'Akses admin diperlukan.'};
      const id=String(p.customerId||'').trim().toUpperCase();if(!/^PLG-[A-Z0-9-]{2,20}$/.test(id)||!p.name||!p.meterId)return {ok:false,message:'Periksa ID (format PLG-xxx), nama, dan meter.'};
      if(C.some(c=>c.customerId===id))return {ok:false,message:'ID pelanggan sudah digunakan.'};
      const pin=String(Math.floor(1e5+rnd()*9e5));C.push({customerId:id,name:p.name,meterId:p.meterId,mode:p.mode,tariffRpPerKwh:p.tariffRpPerKwh,powerVa:p.powerVa,tokenBalanceRp:0,active:true});
      U[id]={pin,role:'PELANGGAN',name:p.name,customerId:id};return {ok:true,customerId:id,temporaryPin:pin,message:'Pelanggan dibuat (demo).'}},
    adminAddTokenBalance(s,id,amt,note){const u=me(s);if(!u||u.role!=='ADMIN')return {ok:false,message:'Akses admin diperlukan.'};
      const c=C.find(x=>x.customerId===id);if(!c||c.mode!=='PRABAYAR')return {ok:false,message:'Pelanggan prabayar tidak ditemukan.'};
      c.tokenBalanceRp+=Number(amt);const tc=code();TK.push({createdAt:new Date().toISOString(),customerId:id,name:c.name,amountRp:Number(amt),tokenCode:tc,note:note||'Penambahan saldo'});
      return {ok:true,balanceRp:c.tokenBalanceRp,tokenCode:tc,message:'Token dibuat (demo).'}}
  };
})();
