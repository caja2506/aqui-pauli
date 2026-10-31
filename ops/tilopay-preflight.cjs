'use strict';
// Read-only activation preflight. Never writes config or creates/captures a payment.
const { cert, initializeApp } = require('../functions/node_modules/firebase-admin/app');
const { getFirestore } = require('../functions/node_modules/firebase-admin/firestore');
const { getToken, tpFetch } = require('../functions/lib/tilopayApi');
const PROJECT = 'aqui-pauli';
const allowedSecrets = ['TILOPAY_API_USER', 'TILOPAY_API_PASSWORD', 'TILOPAY_KEY'];
async function main() {
  const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  if (account.type !== 'service_account' || account.project_id !== PROJECT) throw new Error('Wrong or missing project credential');
  const credential = cert(account);
  const app = initializeApp({credential, projectId:PROJECT});
  const db = getFirestore(app);
  const access = await credential.getAccessToken();
  async function google(url) {
    const response = await fetch(url, {headers:{Authorization:'Bearer '+access.access_token}, redirect:'error', signal:AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error('Google preflight request failed: HTTP '+response.status);
    return response.json();
  }
  const fn = await google('https://cloudfunctions.googleapis.com/v2/projects/'+PROJECT+'/locations/us-central1/functions/tilopayCreatePayment');
  if (fn.state !== 'ACTIVE') throw new Error('Payment function is not ACTIVE');
  const bindings = fn.serviceConfig.secretEnvironmentVariables || [];
  const values = {};
  const versions = {};
  for (const name of allowedSecrets) {
    const binding = bindings.find(b => b.key === name && b.secret === name);
    if (!binding || !/^(latest|[0-9]+)$/.test(String(binding.version))) throw new Error('Missing deployed secret binding: '+name);
    const result = await google('https://secretmanager.googleapis.com/v1/projects/'+PROJECT+'/secrets/'+name+'/versions/'+binding.version+':access');
    const value = Buffer.from(result.payload?.data || '', 'base64').toString('utf8');
    if (!value) throw new Error('Empty secret: '+name);
    values[name] = value;
    versions[name] = binding.version;
  }
  const current = (await db.doc('config/payments').get()).data()?.tilopay || {};
  console.log('PREFLIGHT_CONFIG', JSON.stringify({enabled:current.enabled,mode:current.mode,merchantId:current.merchantId||null,orderPrefix:current.orderPrefix||null}));
  console.log('PREFLIGHT_DEPLOYED_SECRET_VERSIONS', JSON.stringify(versions));
  const token = await getToken({apiUser:values.TILOPAY_API_USER,password:values.TILOPAY_API_PASSWORD});
  console.log('PREFLIGHT_API_AUTH', Boolean(token));
  const sdk = await tpFetch('/api/v1/loginSdk',{body:{apiuser:values.TILOPAY_API_USER,password:values.TILOPAY_API_PASSWORD,key:values.TILOPAY_KEY}});
  console.log('PREFLIGHT_SDK_AUTH', JSON.stringify({http:sdk.status,hasToken:typeof sdk.data?.access_token==='string'&&sdk.data.access_token.length>0,fields:Object.keys(sdk.data||{})}));
  if (!sdk.ok || !sdk.data?.access_token) throw new Error('Current integration key could not be validated');
  const consult = await tpFetch('/api/v1/consult',{token,body:{key:values.TILOPAY_KEY,orderNumber:'TPTEST-A-T2'}});
  const rows = Array.isArray(consult.data?.response) ? consult.data.response : [];
  console.log('PREFLIGHT_EXISTING_TEST_ONLY',JSON.stringify({http:consult.status,type:consult.data?.type,transactions:rows.map(r=>({orderNumber:r.orderNumber,merchantId:r.merchantId,environment:r.environment,capture:r.capture,idTilopay:r.id_tilopay}))}));
  console.log('PREFLIGHT_COMPLETE_NO_WRITES');
}
main().catch(() => {console.error('PREFLIGHT_FAILED_NO_WRITES');process.exitCode=1;});
