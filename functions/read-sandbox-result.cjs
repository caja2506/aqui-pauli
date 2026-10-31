'use strict';
const {initializeApp,applicationDefault}=require('firebase-admin/app');
const {getFirestore}=require('firebase-admin/firestore');
(async()=>{const projectId='aqui-pauli';initializeApp({credential:applicationDefault(),projectId});const db=getFirestore();
 const access=await applicationDefault().getAccessToken();
 const run=await fetch('https://cloudscheduler.googleapis.com/v1/projects/aqui-pauli/locations/us-central1/jobs/firebase-schedule-tilopayReconcilePayments-us-central1:run',{method:'POST',headers:{Authorization:'Bearer '+access.access_token,'Content-Type':'application/json'},body:'{}'});console.log('SCHEDULE_TRIGGER',run.status);
 for(let i=0;i<55;i++){const s=await db.doc('_ops/tilopay-hosted-smoke-20261031-v2').get();const d=s.data();if(d&&['complete','error'].includes(d.status)){console.log('SMOKE_RESULT',JSON.stringify({status:d.status,failure:d.failure||null,consult:d.originalConsult||null,forms:d.forms||[]}));return;}await new Promise(ok=>setTimeout(ok,7000));}throw Error('report timeout');
})().catch(e=>{console.error(e.name);process.exitCode=1});