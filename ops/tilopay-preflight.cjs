'use strict';
// Read-only activation preflight. Never writes config or creates/captures a payment.
const requireFunctions = require('node:module').createRequire(require('node:path').resolve(__dirname, '../functions/package.json'));
const { cert, initializeApp } = requireFunctions('firebase-admin/app');
const { getFirestore } = requireFunctions('firebase-admin/firestore');
const { getToken, tpFetch } = require('../functions/lib/tilopayApi');
const PROJECT = 'aqui-pauli';
const allowedSecrets = ['TILOPAY_API_USER', 'TILOPAY_API_PASSWORD', 'TILOPAY_KEY'];
let phase = 'project-credential';
async function main() {
  const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  if (account.type !== 'service_account' || account.project_id !== PROJECT) throw new Error('Wrong or missing project credential');
  console.log('PREFLIGHT_DEPLOY_IDENTITY', account.client_email);
  const credential = cert(account);
  const app = initializeApp({credential, projectId:PROJECT});
  const db = getFirestore(app);
  const access = await credential.getAccessToken();
  async function google(url) {
    const response = await fetch(url, {headers:{Authorization:'Bearer '+access.access_token}, redirect:'error', signal:AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error('Google preflight request failed: HTTP '+response.status);
    return response.json();
  }
  phase = 'read-deployed-function';
  for (const name of allowedSecrets) {
    const response = await fetch('https://secretmanager.googleapis.com/v1/projects/'+PROJECT+'/secrets/'+name+':testIamPermissions', {
      method:'POST',headers:{Authorization:'Bearer '+access.access_token,'Content-Type':'application/json'},
      body:JSON.stringify({permissions:['secretmanager.secrets.get','secretmanager.secrets.getIamPolicy','secretmanager.secrets.setIamPolicy','secretmanager.versions.access']}),
      redirect:'error',signal:AbortSignal.timeout(20000)
    });
    const result = await response.json();
    console.log('PREFLIGHT_SECRET_PERMISSION',JSON.stringify({name,http:response.status,permissions:result.permissions||[]}));
  }
  console.log('PREFLIGHT_PERMISSION_CHECK_NO_WRITES');

}
main().catch((error) => {console.error('PREFLIGHT_FAILED_NO_WRITES',phase, /^Google preflight request failed: HTTP [0-9]+$/.test(error.message) ? error.message : error.code || error.name);process.exitCode=1;});
