'use strict';
const requireFunctions=require('node:module').createRequire(require('node:path').resolve(__dirname,'../functions/package.json'));
const {cert}=requireFunctions('firebase-admin/app');
async function main(){
 const account=JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT||'{}');delete process.env.FIREBASE_SERVICE_ACCOUNT;
 if(account.project_id!=='aqui-pauli')throw new Error('Wrong project');
 const auth=await cert(account).getAccessToken();
 async function req(url,method='GET',body){const r=await fetch(url,{method,headers:{Authorization:'Bearer '+auth.access_token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000),redirect:'error'});return {status:r.status,data:await r.json().catch(()=>({}))};}
 const f=await req('https://cloudfunctions.googleapis.com/v2/projects/aqui-pauli/locations/us-central1/functions/tilopayReconcilePayments');
 console.log('READINESS_FUNCTION',JSON.stringify({http:f.status,state:f.data.state,updated:f.data.updateTime,runtime:f.data.serviceConfig?.serviceAccountEmail}));
 const jobs=await req('https://cloudscheduler.googleapis.com/v1/projects/aqui-pauli/locations/us-central1/jobs');
 const match=(jobs.data.jobs||[]).filter(j=>j.name.endsWith('/firebase-schedule-tilopayReconcilePayments-us-central1'));
 console.log('READINESS_SCHEDULE',JSON.stringify({http:jobs.status,jobs:match.map(j=>({name:j.name,state:j.state,schedule:j.schedule,lastAttemptTime:j.lastAttemptTime,status:j.status?.code}))}));
 if(match.length===1&&match[0].state==='ENABLED'){
   const run=await req('https://cloudscheduler.googleapis.com/v1/'+match[0].name+':run','POST',{});
   console.log('READINESS_TRIGGER',run.status);
 }
 await new Promise(r=>setTimeout(r,15000));
 const logs=await req('https://logging.googleapis.com/v2/entries:list','POST',{resourceNames:['projects/aqui-pauli'],filter:'resource.type="cloud_run_revision" AND resource.labels.service_name="tilopayreconcilepayments" AND timestamp>="2026-10-31T02:43:00Z"',orderBy:'timestamp desc',pageSize:30});
 console.log('READINESS_LOGS',JSON.stringify({http:logs.status,entries:(logs.data.entries||[]).map(e=>({time:e.timestamp,severity:e.severity,reportUnavailable:/report unavailable/.test(e.textPayload||e.jsonPayload?.message||''),hasReconciliationSummary:/tilopayReconcilePayments/.test(e.textPayload||e.jsonPayload?.message||''),httpStatus:e.httpRequest?.status}))}));
 const doc=await req('https://firestore.googleapis.com/v1/projects/aqui-pauli/databases/(default)/documents/_ops/tilopay-readiness-v2-20261030');
 const fields=doc.data.fields||{};
 const safe={};for(const k of ['status','phase','reasonCode','merchantId','orderPrefix','mode','checkedAt'])if(fields[k]?.stringValue)safe[k]=fields[k].stringValue;
 console.log('READINESS_REPORT',JSON.stringify({http:doc.status,...safe}));
}
main().catch(e=>{console.error('READINESS_DIAGNOSTIC_ERROR',e.name);process.exitCode=1;});
