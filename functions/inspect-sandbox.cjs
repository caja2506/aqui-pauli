'use strict';
const {createHash}=require('node:crypto');
const {initializeApp,cert}=require('firebase-admin/app');
const {getFirestore}=require('firebase-admin/firestore');
const {currentSnapshot,snapshotFingerprint}=require('./lib/tilopayOrder');
const {computeTotalsCRC}=require('./lib/pricing');
(async()=>{
 const project='aqui-pauli';const account=JSON.parse(process.env.DIAGNOSTIC_SA);delete process.env.DIAGNOSTIC_SA;
 if(account.project_id!==project) throw new Error('project mismatch');
 const credential=cert(account);initializeApp({credential});const db=getFirestore();
 const targetHash='46a9439a3d41ec2616316adb12bd73ca43a3cb0cccf61a75238e80ab72f7c4c4';
 const recent=await db.collection('orders').where('createdAt','>=','2026-10-31T04:10:00').where('createdAt','<','2026-10-31T04:30:00').select().get();
 const match=recent.docs.find(s=>createHash('sha256').update(s.id).digest('hex')===targetHash);
 const cfg=(await db.doc('config/payments').get()).get('tilopay');console.log('CONFIG',JSON.stringify({enabled:cfg.enabled,mode:cfg.mode}));if(cfg.mode!=='test') throw Error('not test');
 if(match) {
 const ref=match.ref;const order=(await ref.get()).data();const docs=(await ref.collection('items').get()).docs;
 const code=v=>typeof v==='string'&&/^[a-z_0-9-]{1,64}$/.test(v)?v:null;
 const t=order.tilopay||{}; console.log('ORDER',JSON.stringify({status:code(order.status),method:code(order.paymentMethod),paymentStatus:code(order.paymentStatus),amount:order.total,createdAt:order.createdAt,updatedAt:order.updatedAt,mode:code(t.mode),attemptCount:t.attemptCount,lines:docs.length,hasLock:!!t.checkoutLockId}));
 for(const a of Object.values(t.attemptsById||{})) {
 let integrity;try{integrity=snapshotFingerprint(currentSnapshot(order,docs,a.snapshot))===a.orderVersion}catch{integrity=false}
 console.log('ATTEMPT',JSON.stringify({status:code(a.status),amount:a.amount,mode:code(a.mode),requestAt:a.requestSentAt,creationCheckedAt:a.creationCheckedAt,hasUrl:!!a.url,hostAccepted:require('./lib/tilopayApi').isValidPaymentUrl(a.url),lastObservation:code(a.lastObservationState),transient:a.lastObservationTransient,checkedAt:a.lastCheckedAt,reasonClass:['No se confirmó una página','La consulta','Respuesta de consult','El contenido','Tilopay no devolvió','Las filas','Contexto de la','Faltan campos'].find(p=>(a.reason||'').startsWith(p))||'other',snapshotMatches:integrity,referenceLength:a.orderNumber?.length,hasProviderTransaction:!!a.idTilopay}));
 }
 try{const totals=await computeTotalsCRC(db,docs.map(d=>d.data()),{canton:order.shippingAddress?.canton,shippingType:order.shippingType});console.log('QUOTE_REPLAY',JSON.stringify({amount:totals.total,lines:totals.lines.length}));}catch(e){console.log('QUOTE_REPLAY',JSON.stringify({reason:e.reason||'internal',line:e.lineIndex}));}
 }else console.log('ORDER_NOT_IN_WINDOW');
 const variant=await db.doc('products/zz-tilopay-test/variants/v1').get();const p=await db.doc('products/zz-tilopay-test').get(); console.log('FIXTURE',JSON.stringify({productActive:p.get('active'),variantActive:variant.get('active'),stock:variant.get('stock'),reserved:variant.get('reservedStock'),price:variant.get('price')}));
 const token=await credential.getAccessToken();
 const q=await fetch('https://logging.googleapis.com/v2/entries:list',{method:'POST',headers:{Authorization:'Bearer '+token.access_token,'Content-Type':'application/json'},body:JSON.stringify({resourceNames:['projects/'+project],filter:'timestamp >= "2026-10-31T04:14:00Z" AND timestamp <= "2026-10-31T04:24:00Z" AND resource.type="cloud_run_revision" AND (resource.labels.service_name="tilopaygetquote" OR resource.labels.service_name="tilopaycreatepayment" OR resource.labels.service_name="tilopayconfirm")',pageSize:200})});
 console.log('LOG_ACCESS',q.status);if(q.ok){const j=await q.json();for(const e of j.entries||[]){console.log('CALL_LOG',JSON.stringify({at:e.timestamp,service:e.resource?.labels?.service_name,http:e.httpRequest?.status,reason:/^[A-Z_]+$/.test(e.jsonPayload?.reason||'')?e.jsonPayload.reason:null}));}}
})().catch(e=>{console.error('DIAG_ERROR',e.name,typeof e.code==='number'?e.code:'');process.exitCode=1});