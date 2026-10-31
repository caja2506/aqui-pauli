'use strict';
// Authorized Tilopay activation: refresh only three existing function secret bindings to version 2.
// Does not read secret values, change IAM, modify Firestore, or create/capture payments.
const requireFunctions = require('node:module').createRequire(require('node:path').resolve(__dirname, '../functions/package.json'));
const { cert } = requireFunctions('firebase-admin/app');
const PROJECT = 'aqui-pauli';
const names = ['TILOPAY_API_USER','TILOPAY_API_PASSWORD','TILOPAY_KEY'];
const functions = ['tilopayCreatePayment','tilopayConfirm','tilopayReconcilePayments'];
const TARGET = '2';
async function main() {
  const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  if (account.type !== 'service_account' || account.project_id !== PROJECT) throw new Error('Wrong project');
  const access = await cert(account).getAccessToken();
  async function request(url, method='GET', body) {
    const r = await fetch(url,{method,headers:{Authorization:'Bearer '+access.access_token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});
    if (!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  }
  for (const name of names) {
    const s = await request('https://secretmanager.googleapis.com/v1/projects/'+PROJECT+'/secrets/'+name+'/versions/latest');
    if (s.name.split('/').pop() !== TARGET || s.state !== 'ENABLED') throw new Error('Secret version changed');
  }
  const plans = [];
  for (const name of functions) {
    const resource = 'projects/'+PROJECT+'/locations/us-central1/functions/'+name;
    const fn = await request('https://cloudfunctions.googleapis.com/v2/'+resource);
    if (fn.state !== 'ACTIVE' || fn.environment !== 'GEN_2') throw new Error('Function not ready');
    const bindings = fn.serviceConfig.secretEnvironmentVariables || [];
    for (const secret of names) {
      const matches=bindings.filter(b=>b.key===secret && b.secret===secret);
      if(matches.length!==1 || !['1',TARGET].includes(String(matches[0].version))) throw new Error('Unexpected binding');
    }
    const next = bindings.map(b=>names.includes(b.key)?{...b,version:TARGET}:b);
    plans.push({name,resource,next,changed:bindings.some(b=>names.includes(b.key)&&b.version!==TARGET)});
    console.log('ACTIVATION_PLAN',JSON.stringify({name,bindings:bindings.filter(b=>names.includes(b.key)).map(b=>({name:b.key,from:b.version,to:TARGET}))}));
  }
  const pending=[];
  for (const p of plans) {
    if(!p.changed) continue;
    const op=await request('https://cloudfunctions.googleapis.com/v2/'+p.resource+'?updateMask=serviceConfig.secretEnvironmentVariables','PATCH',{name:p.resource,serviceConfig:{secretEnvironmentVariables:p.next}});
    if(!op.name?.startsWith('projects/'+PROJECT+'/locations/us-central1/operations/')) throw new Error('Unexpected operation');
    pending.push({function:p.name,name:op.name});
    console.log('ACTIVATION_STARTED',p.name);
  }
  const deadline=Date.now()+14*60*1000;
  while(pending.length) {
    for(let i=pending.length-1;i>=0;i--) {
      const op=await request('https://cloudfunctions.googleapis.com/v2/'+pending[i].name);
      if(op.error) {console.error('ACTIVATION_OPERATION_ERROR',pending[i].function,op.error.code);throw new Error('Operation failed');}
      if(op.done) {console.log('ACTIVATION_DEPLOYED',pending[i].function);pending.splice(i,1);}
    }
    if(!pending.length) break;
    if(Date.now()>deadline) throw new Error('Operation timed out');
    await new Promise(resolve=>setTimeout(resolve,10000));
  }
  for(const p of plans) {
    const fn=await request('https://cloudfunctions.googleapis.com/v2/'+p.resource);
    if(fn.state!=='ACTIVE') throw new Error('Function not active');
    const bindings=fn.serviceConfig.secretEnvironmentVariables||[];
    if(names.some(name=>!bindings.some(b=>b.key===name&&b.secret===name&&b.version===TARGET))) throw new Error('Version verification failed');
    console.log('ACTIVATION_VERIFIED',JSON.stringify({name:p.name,state:fn.state,version:TARGET,updated:fn.updateTime}));
  }
  console.log('ACTIVATION_COMPLETE_SECRET_BINDINGS_ONLY');
}
main().catch(e=>{console.error('ACTIVATION_FAILED',/^(HTTP [0-9]+|Wrong project|Secret version changed|Function not ready|Unexpected binding|Unexpected operation|Operation failed|Operation timed out|Function not active|Version verification failed)$/.test(e.message)?e.message:e.name);process.exitCode=1;});
