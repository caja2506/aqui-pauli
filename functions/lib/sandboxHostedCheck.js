"use strict";
const { randomUUID, createHash } = require("node:crypto");
const api = require("./tilopayApi");
const reportPath = "_ops/tilopay-hosted-smoke-20261031-v1";
const vocabulary=new Set(("the a an in on of to for not no is was can be has been does this your please must maximum minimum max min valid invalid required missing too long length characters alphanumeric numeric " +
"el la un una los las de del no es en a con se debe ser para por favor tiene puede tener mayor menor máximo maxima máximo minima mínimo longitud caracteres válido válida inválido inválida obligatorio obligatoria falta " +
"error campo field format formato reference referencia order orden number número numero ordernumber transaction transacción transaccion payment pago payer customer comercio merchant integration integración integracion platform plataforma api general apigeneral incorrect incorrecta incorrecto " +
"amount monto currency moneda crc usd key llave valor inválidos invalidos invalid credentials credenciales authentication autorización autorizacion autorizado autorizada registered registrada registrado register allowed permitido permitida validación validacion " +
"url urls redirect retorno domain dominio sitio website address dirección direccion postal postcode email correo telephone teléfono telefono billtostate billtoemail billtofirstname billtolastname " +
"duplicate duplicada duplicado found encuentra existe encontrado encontrada data datos response respuesta server internal unsupported exceed exceeded exceeded exceeding exceeds between more than than invalidado" ).split(/\s+/));
function safeMessage(v) {
 if(typeof v!=="string") return null;
 return v.toLowerCase().replace(/https?:\/\/\S+|\S+@\S+|[0-9-]{5,}/g," [omitted] ").match(/[\p{L}]+|\d+|\?/gu)
   ?.slice(0,40).map(w=>vocabulary.has(w)||/^\d{1,2}$/.test(w)?w:"…").join(" ").replace(/(?:… ){2,}/g,"… ")||null;
}
function shape(r){
 const data=r?.data||{};
 return {http:r?.status??null,type:/^\d{3}$/.test(String(data.type))?String(data.type):null,json:r?.jsonValid===true,
   rows:Array.isArray(data.response)?data.response.length:null,hasUrl:typeof data.url==="string"&&data.url.length>0,
   validUrl:api.isValidPaymentUrl(data.url),message:safeMessage(data.message||data.error||data.result),
   keys:Object.keys(data).filter(k=>["type","message","error","result","html","url","response","status","code","description"].includes(k))};
}
async function run(db, credentials) {
 const project=process.env.GCLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT;
 if(project!=="aqui-pauli") return;
 const report=db.doc(reportPath);const config=db.doc("config/payments");
 const test=async()=>{const v=(await config.get()).get("tilopay");return v?.enabled===true&&v.mode==="test"&&v.merchantId==="88802749"&&v.orderPrefix==="PFC031932";};
 if(!await test()) return;
 try{await report.create({status:"running"})}catch(e){if(e.code===6||e.code==="already-exists")return;throw e}
 const results=[];
 try{
 const c=credentials();const token=await api.getToken({apiUser:c.apiUser,password:c.password});
 const recent=await db.collection("orders").where("createdAt",">=","2026-10-31T04:10:00").where("createdAt","<","2026-10-31T04:30:00").select().get();
 const original=recent.docs.find(d=>createHash("sha256").update(d.id).digest("hex")==="46a9439a3d41ec2616316adb12bd73ca43a3cb0cccf61a75238e80ab72f7c4c4");
 if(original){const o=(await original.ref.get()).data();const a=o.tilopay?.attemptsById?.a1;
 if(a?.mode==="test"&&typeof a.orderNumber==="string"){const consult=await api.tpFetch("/api/v1/consult",{token,body:{key:c.key,orderNumber:a.orderNumber}});await report.update({originalConsult:shape(consult)});}}
 const dummy={customerName:"Cliente Prueba",customerPhone:"88888888",customerEmail:"prueba@example.com",shippingAddress:{provincia:"Alajuela",canton:"Grecia",distrito:"Grecia",señas:"Direccion de prueba",codigoPostal:"20301"}};
 for(const variant of ["store","api-platform","short-api"]){
   if(!await test()) throw Error("mode changed");
   const id=randomUUID().replace(/-/g,"");const number=variant==="short-api"?"AP"+id.slice(0,14):api.tilopayReference(id,1);
   const payload=api.buildProcessPayload({key:c.key,order:dummy,orderId:"SandboxFormCheck",amountMinor:100000,orderNumber:number,redirect:"https://aquipauli.com/tilopay/retorno/SandboxFormCheck"});
   if(variant!=="store") payload.platform="api";
   const r=await api.tpFetch("/api/v1/processPayment",{token,body:payload});const result=shape(r);
   results.push({variant,...result});await report.update({forms:results});
   if(result.validUrl||!r.ok&&r.status>=500||!r.jsonValid) break;
 }
 await report.update({status:"complete"});
 }catch(e){await report.update({status:"error",failure:e.name==="TimeoutError"?"timeout":"diagnostic_failed"});}
}
module.exports={run};
