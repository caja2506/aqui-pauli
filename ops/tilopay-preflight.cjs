'use strict';
// Read only: compares secret-version metadata with deployed bindings. Never reads secret payloads.
const requireFunctions = require('node:module').createRequire(require('node:path').resolve(__dirname, '../functions/package.json'));
const { cert } = requireFunctions('firebase-admin/app');
const PROJECT = 'aqui-pauli';
const names = ['TILOPAY_API_USER','TILOPAY_API_PASSWORD','TILOPAY_KEY'];
async function main() {
  const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  if (account.type !== 'service_account' || account.project_id !== PROJECT) throw new Error('Wrong project');
  const access = await cert(account).getAccessToken();
  async function read(url) {
    const r = await fetch(url,{headers:{Authorization:'Bearer '+access.access_token},redirect:'error',signal:AbortSignal.timeout(20000)});
    if (!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  }
  const latest = {};
  for (const name of names) {
    const s = await read('https://secretmanager.googleapis.com/v1/projects/'+PROJECT+'/secrets/'+name+'/versions/latest');
    latest[name] = s.name.split('/').pop();
    console.log('PREFLIGHT_SECRET_METADATA',JSON.stringify({name,version:latest[name],state:s.state,created:s.createTime}));
  }
  for (const name of ['tilopayCreatePayment','tilopayConfirm','tilopayReconcilePayments']) {
    const fn = await read('https://cloudfunctions.googleapis.com/v2/projects/'+PROJECT+'/locations/us-central1/functions/'+name);
    console.log('PREFLIGHT_FUNCTION_METADATA',JSON.stringify({name,state:fn.state,updated:fn.updateTime,bindings:(fn.serviceConfig.secretEnvironmentVariables||[]).filter(b=>names.includes(b.key)).map(b=>({name:b.key,version:b.version,latest:latest[b.key],current:b.version===latest[b.key]||b.version==='latest'}))}));
  }
  console.log('PREFLIGHT_COMPLETE_METADATA_ONLY');
}
main().catch(e=>{console.error('PREFLIGHT_FAILED_METADATA_ONLY',/^HTTP [0-9]+$/.test(e.message)?e.message:e.name);process.exitCode=1;});
