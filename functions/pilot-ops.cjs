'use strict';
const {initializeApp,cert}=require('firebase-admin/app');const {getFirestore}=require('firebase-admin/firestore');const crypto=require('node:crypto');
(async()=>{const a=JSON.parse(process.env.PILOT_SA);delete process.env.PILOT_SA;if(a.project_id!=='aqui-pauli')throw Error('project mismatch');initializeApp({credential:cert(a)});const db=getFirestore();
const cfg=(await db.doc('config/payments').get()).get('tilopay')||{},gate=(await db.doc('_ops/tilopay-live-pilot').get()).data()||{};
const out={mode:cfg.mode,stage:cfg.pilotSeed?.stage,open:cfg.enabled===true&&cfg.access==='private-pilot',claimed:!!gate.ownerUid,expiresAt:gate.expiresAt,order:null};
if(gate.orderId){const o=(await db.doc('orders/'+gate.orderId).get()).data()||{};const t=o.tilopay||{},att=t.attemptsById?.[t.currentAttempt]||{};
const {buildProcessPayload,PROVINCE_ISO}=require('./lib/tilopayApi');
const address=o.shippingAddress||{};
const request=buildProcessPayload({key:'format-check-only',redirect:'https://aquipauli.com/tilopay/retorno/'+encodeURIComponent(gate.orderId),orderId:gate.orderId,order:o,orderNumber:att.orderNumber,amountMinor:att.amountMinor});
const required=["amount","billToAddress","billToAddress2","billToCity","billToCountry","billToEmail","billToFirstName","billToLastName","billToState","billToTelephone","billToZipPostCode","capture","currency","key","orderNumber","platform","redirect","subscription"];
const inspect={
 requiredFieldsFilled:required.every(k=>typeof request[k]==='string'&&request[k].length>0),
 submittedFields:Object.keys(request).length,
 validAmount:request.amount==='1000.00'&&request.currency==='CRC',
 provinceFromOrder:Object.hasOwn(PROVINCE_ISO,String(address.provincia||'').trim().toLowerCase()),
 postalFromOrder:/^\d{5}$/.test(String(address.codigoPostal||'')),
 nameHasSurname:String(o.customerName||'').trim().split(/\s+/).length>=2,
 cityDistrictAddressPresent:[address.canton,address.distrito,address.señas].every(v=>typeof v==='string'&&!!v.trim()),
 phoneFromOrder:/\d{8}$/.test(String(o.customerPhone||'').replace(/\D/g,'')),
 emailPresent:/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(o.customerEmail||'').trim()),
 oldPostal: String(address.codigoPostal || '10101').replace(/\D/g, '').slice(0,5) || '10101',
 correctedPostal:request.billToZipPostCode, consistentPostal:request.shipToZipPostCode===request.billToZipPostCode,
 referenceMatches:request.orderNumber===att.orderNumber,
 merchantMatches:att.merchantId===cfg.merchantId,
};
out.formatReview=inspect;
out.order={number:o.orderNumber,total:o.total,createdAt:o.createdAt,status:o.status,paymentStatus:o.paymentStatus,mode:att.mode,amount:att.amount,requestAt:att.requestSentAt,checkedAt:att.creationCheckedAt,creation:att.creationOutcome||null,hasUrl:!!att.url,observation:att.lastObservedState||null,providerOrderAbsent:att.providerOrderAbsent===true,confirmedAt:att.lastCheckedAt||null,captured:att.financialEvidence==='captured',txSeen:!!att.idTilopay};}
const key=crypto.randomBytes(32),iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const ct=Buffer.concat([c.update(JSON.stringify(out),'utf8'),c.final()]);const ek=crypto.publicEncrypt({key:"-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArgBOFc1PvS2IQ2WcRruJ\nV4COW0Edq5WfQOO//h6LWSNbxUh1CTZDOYd8j13XPa0cMUQOSymYyqgxj86VB8Lk\nP4stSKkc5FicBgAekv1YXYUT5wXLaDp8gQ2UquTOySa/fEg/8q9bGLq62t0LlOZ8\nXtaIbDMCQzNackwGknu4ah5MO9cHpfW5cL5b0W9r/rcCy7c69wXWDbp4iq5PtuyG\nbFwERaLvj5fDhLNJZlXyTmDSfiDKBOLNzxHBUQmrlO68gv3tSwtE6v7Zdt+7LqC1\ngIz/THfxeDT7X5EMXyAi2I8EKBW1MiCOYvaAw66fCtsVvpDsC7ywLNAjMSN/lJfY\n+wIDAQAB\n-----END PUBLIC KEY-----",oaepHash:'sha256'},key);
console.log('PILOT_RECEIPT_ENCRYPTED', Buffer.concat([ek,iv,c.getAuthTag(),ct]).toString('base64'));
})().catch(e=>{console.error('PILOT_READ_FAILED',e.name);process.exitCode=1;});