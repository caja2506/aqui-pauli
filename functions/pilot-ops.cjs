'use strict';
const {initializeApp,cert}=require('firebase-admin/app');const {getFirestore}=require('firebase-admin/firestore');
(async()=>{const a=JSON.parse(process.env.PILOT_SA);delete process.env.PILOT_SA;if(a.project_id!=='aqui-pauli')throw Error('project mismatch');
initializeApp({credential:cert(a)});const db=getFirestore();const [cfg,p,gate]=await Promise.all([db.doc('config/payments').get(),db.doc('products/zz-tilopay-live-check').get(),db.doc('_ops/tilopay-live-pilot').get()]);const c=cfg.get('tilopay')||{};
console.log('PILOT_STATUS',JSON.stringify({mode:c.mode,enabled:c.enabled,access:c.access||'normal',stage:c.pilotSeed?.stage||'not_prepared',productExists:p.exists,privateSlotExists:gate.exists}));
})().catch(e=>{console.error('PILOT_STATUS_FAILED',e.name);process.exitCode=1;});