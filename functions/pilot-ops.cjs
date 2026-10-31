'use strict';
const {initializeApp,cert}=require('firebase-admin/app');
const {getFirestore,FieldValue}=require('firebase-admin/firestore');
const {createHash}=require('node:crypto');
const stage='arm';
const tokenHash='6decbdafd2f5715131264551658a377df8ec040e70cc7febc008bf1fa709eeab', sku='zz-tilopay-live-check', variant='v1';
const expected=(c)=>c.merchantId==='88802749'&&c.orderPrefix==='PFC031932';
(async()=>{
 const a=JSON.parse(process.env.PILOT_SA);delete process.env.PILOT_SA;if(a.project_id!=='aqui-pauli')throw Error('Wrong project');
 initializeApp({credential:cert(a)});const db=getFirestore(), config=db.doc('config/payments'), pilot=db.doc('_ops/tilopay-live-pilot');
 const prod=db.doc('products/'+sku), vr=prod.collection('variants').doc(variant);
 async function inspectAttempts(){
  const [orders,evidence]=await Promise.all([db.collection('orders').where('tilopay.mode','==','test').select('tilopay','paymentStatus','status','createdAt').get(),db.doc('_ops/tilopay-hosted-smoke-20261031-v2').get()]);
  const ev=evidence.data()?.originalConsult;
  let blocked=0;
  for(const o of orders.docs){
   const p=o.get('tilopay'),list=Object.values(p?.attemptsById||{});
   const safePrior=list.length===1 && createHash('sha256').update(o.id).digest('hex')==='46a9439a3d41ec2616316adb12bd73ca43a3cb0cccf61a75238e80ab72f7c4c4' &&
      ev?.http===200&&ev?.type==='200'&&ev.rows===0&&ev.message==='does not exist' && p.mode==='test' &&
      !p.reconciliationNeedsReview && !p.duplicatePaymentNeedsReview && !list[0].formInFlight && !list[0].url && !list[0].idTilopay &&
      Date.parse(list[0].creationCheckedAt)<=evidence.updateTime.toMillis();
   console.log('PILOT_ATTEMPT_META',JSON.stringify({key:createHash('sha256').update(o.id).digest('hex').slice(0,12),safePrior,
    legacy:!list.length?{orderStatus:o.get('status'),paymentStatus:o.get('paymentStatus'),createdAt:o.get('createdAt'),status:p.status||null,
       keys:Object.keys(p).filter(k=>/^[a-z][a-zA-Z]{0,32}$/.test(k)),
       knownReferences:(Array.isArray(p.orderNumbers)?p.orderNumbers:[]).map(n=>['TPTEST-A-T1','TPTEST-A-T2','TPTEST-R-T1'].includes(n)),hasSavedUrl:Object.entries(p).some(([k,v])=>typeof v==='string'&&(/url/i.test(k)||/^https?:/.test(v))&&v.length>0)}:null,
      attempts:list.map(a=>({status:a.status,hasUrl:!!a.url,hasTx:!!a.idTilopay,formInFlight:!!a.formInFlight,
      sent:a.requestSentAt,checked:a.creationCheckedAt,reason:a.creationOutcome?.reason||null,last:a.lastObservedState||null,explicitAbsence:a.providerOrderAbsent===true}))}));
   const refs=p.orderNumbers;
   const expectedLegacyRefs=p.status==='approved'?['TPTEST-A-T1','TPTEST-A-T2']:p.status==='declined'?['TPTEST-R-T1']:[];
   const safeLegacy=!list.length && expectedLegacyRefs.length && Array.isArray(refs) && refs.length===expectedLegacyRefs.length
      && expectedLegacyRefs.every(n=>refs.includes(n)) && !JSON.stringify(p).toLowerCase().includes('://') && !p.reconciliationNeedsReview;
   if(!safeLegacy && !safePrior && (!list.length||list.some(v=>v.mode!=='test'||!['test_paid','approved'].includes(v.status))))blocked++;
  }
  console.log('PILOT_TEST_ATTEMPTS',JSON.stringify({orders:orders.size,blocking:blocked}));return blocked;
 }
 if(stage==='inspect'){console.log('PILOT_STARTED_IN_TEST',(await config.get()).get('tilopay.mode')==='test');await inspectAttempts(); return;}
 if(stage==='arm'){
  if(await inspectAttempts())throw Error('Existing test attempt requires review');
  await db.runTransaction(async t=>{const [cs,ps,item,v]=await Promise.all([t.get(config),t.get(pilot),t.get(prod),t.get(vr)]);const c=cs.get('tilopay');
   if(!expected(c)||c.mode!=='test'||c.enabled!==true||c.access!==undefined||ps.exists||item.exists||v.exists)throw Error('Unexpected initial state');
   t.set(pilot,{active:false,tokenHash,productId:sku,variantId:variant,expiresAt:Date.now()+2*3600000,
     phase:'armed',savedConfig:{enabled:c.enabled,mode:c.mode},createdAt:new Date().toISOString()});
   t.set(prod,{active:true,deleted:false,unlisted:true,basePrice:1000,name:'Compra de verificación',slug:sku,
     description:'Una unidad para verificar el pago real de Aquí Pauli.',categoryRefs:[],images:[],createdAt:new Date().toISOString()});
   t.set(vr,{active:true,name:'Única',price:1000,stock:1,reservedStock:0,supplyType:'stock_propio'});
   t.update(config,{'tilopay.enabled':false,'tilopay.mode':'live','tilopay.access':'private-pilot'});
  });
  if(await inspectAttempts())throw Error('Existing test attempt requires review after closing'); 
 }
 if(stage==='activate'){
  await db.runTransaction(async t=>{const [cs,ps,p,v]=await Promise.all([t.get(config),t.get(pilot),t.get(prod),t.get(vr)]);const c=cs.get('tilopay'),gate=ps.data();
   if(!expected(c)||c.mode!=='live'||c.enabled!==false||c.access!=='private-pilot'||gate?.phase!=='armed'||gate.tokenHash!==tokenHash||gate.orderId||gate.expiresAt<=Date.now()||p.get('unlisted')!==true||v.get('price')!==1000||v.get('stock')!==1)throw Error('Pilot not armed');
   t.update(pilot,{active:true,phase:'open',expiresAt:Date.now()+2*3600000});t.update(config,{'tilopay.enabled':true});
  });
 }
 if(stage==='close'){
  await db.runTransaction(async t=>{const [cs,ps]=await Promise.all([t.get(config),t.get(pilot)]);if(cs.get('tilopay.access')!=='private-pilot'||ps.get('tokenHash')!==tokenHash)throw Error('Different pilot');
   t.update(pilot,{active:false,phase:'closed'});t.update(config,{'tilopay.enabled':false});});
 }
 if(stage==='restore-test'){
  await db.runTransaction(async t=>{const [cs,ps]=await Promise.all([t.get(config),t.get(pilot)]);if(cs.get('tilopay.access')!=='private-pilot'||cs.get('tilopay.enabled')!==false||ps.get('tokenHash')!==tokenHash||ps.get('active')===true)throw Error('Close before restoration');
   t.update(config,{'tilopay.enabled':true,'tilopay.mode':'test','tilopay.access':FieldValue.delete()});t.update(prod,{active:false});t.update(pilot,{phase:'restored'});});
 }
 const [cs,ps]=await Promise.all([config.get(),pilot.get()]);const gate=ps.data()||{},c=cs.get('tilopay')||{};
 let order=null;if(gate.orderId){const o=(await db.doc('orders/'+gate.orderId).get()).data();const a=o?.tilopay?.attemptsById?.a1;order={status:o?.status,payment:o?.paymentStatus,mode:a?.mode,amount:a?.amount,reason:a?.creationOutcome?.reason,hasUrl:!!a?.url};}
 const res=await fetch('https://us-central1-aqui-pauli.cloudfunctions.net/tilopayGetConfig',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:{}})});const publicEnabled=(await res.json()).result?.enabled; if(c.access==='private-pilot'&&publicEnabled!==false)throw Error('Public access check failed');
 console.log('PILOT_STATUS',JSON.stringify({mode:c.mode,enabled:c.enabled,access:c.access||'normal',publicEnabled,phase:gate.phase,claimed:!!gate.ownerUid,expiresAt:gate.expiresAt,order}));
})().catch(e=>{console.error('PILOT_OPS_FAILED',e.code||e.name, /^[A-Za-z ]{1,90}$/.test(e.message)?e.message:'see stage');process.exitCode=1;});