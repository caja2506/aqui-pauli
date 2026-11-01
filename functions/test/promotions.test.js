const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryFirestore } = require("./helpers/memoryFirestore");
const { checkCode, discountedTotals, giftForOrder } = require("../lib/discounts");
const { makeCards, generateBatch } = require("../lib/cardBatches");
const { normalizeCode, cardState, activeSamples } = require("../lib/promotions.mjs");
const config = require("../scripts/decants.json");

test("semilla de nueve muestras y código normalizado", () => {
  assert.equal(activeSamples(config).length,9);
  assert.equal(activeSamples(config)[7].id,"moschino-toy-2");
  assert.equal(activeSamples({...config,promoActive:false}).length,0);
  assert.equal(normalizeCode(" ap7k 3m9p "),"AP-7K3M9P");
  assert.equal(normalizeCode("AP-IOO101"),"");
});
test("dos perfumes dan una muestra y una opción inactiva se sustituye por sorpresa", async () => {
  const {db}=createMemoryFirestore({"config/decants":{...config,options:config.options.map(o=>({...o,active:o.id!=="moschino-toy-2"}))},
    "products/a":{categoryRefs:[{id:"LTD4HApgXSUBRmJt0ZVo"}]},"products/b":{categoryRefs:[{id:"d7002zlsGNkSBbQpYnGw"}]}});
  const gift=await db.runTransaction(tx=>giftForOrder(db,tx,[{productId:"a"},{productId:"b"}],"moschino-toy-2"));
  assert.deepEqual(gift,{size:"3 ml",choice:"sorpresa",name:"Sorpresa",chosenByCustomer:false});
});
test("máximo diez errores por ventana y uid; validación correcta no consume", async () => {
  const [card]=makeCards({lote:"QA",n:1});
  const {db,get}=createMemoryFirestore({["discountCodes/"+card.code]:card});
  await assert.rejects(checkCode(db,null,card.code),{code:"unauthenticated"});
  assert.equal((await checkCode(db,"a",card.code)).message,null);
  for (let i=0;i<10;i++) assert.ok((await checkCode(db,"a","AP-XXXX")).message);
  await assert.rejects(checkCode(db,"a",card.code),{code:"resource-exhausted"});
  assert.equal((await checkCode(db,"b",card.code)).message,null);
  assert.equal(get("discountCodes/"+card.code).used,false);
});
test("el descuento se redondea una vez y respeta el envío",()=>{
  const gross={subtotal:44901.50,total:46901.50,subtotalMinor:4490150,totalMinor:4690150,shippingCost:2000,
    lines:[{lineTotalMinor:2500000},{lineTotalMinor:1990150}]};
  const net=discountedTotals(gross,"AP-7K3M9P");
  assert.equal(net.discount.amount,4490);
  assert.equal(net.total,42411.5);
  assert.equal(net.lines.reduce((s,l)=>s+l.lineTotalMinor,0),net.subtotalMinor);
});
test("100 tarjetas únicas duran 60 días, con fechas y filtros independientes", () => {
  const start=Date.UTC(2026,10,1);
  const cards=makeCards({n:100,lote:"QA"},start);
  assert.equal(new Set(cards.map(c=>c.code)).size,100);
  for (const c of cards) {
    assert.equal(normalizeCode(c.code),c.code);
    assert.equal(Date.parse(c.expiresAt)-Date.parse(c.createdAt),60*86400000);
    assert.equal(cardState(c,start),"Por imprimir"); assert.equal(cardState({...c,printed:true},start),"Impresos");
    assert.equal(cardState(c,Date.parse(c.expiresAt)),"Vencidos"); assert.equal(cardState({...c,used:true},start),"Usados");
  }
});
test("generar un lote escribe todo o nada y no regenera el mismo lote", async()=>{
  const docs = new Map();
  const collection = name => ({doc:id=>({path:name+"/"+id,get:async()=>({exists:docs.has(name+"/"+id)})})});
  const db={collection,batch:()=>{const writes=[];return {create:(ref,data)=>writes.push([ref.path,data]),commit:async()=>{
    if(writes.some(([p])=>docs.has(p))) throw Object.assign(Error("exists"),{code:6});
    for(const [p,data] of writes) docs.set(p,data);
  }};}};
  const args={lote:"QA",n:3};
  await generateBatch(db,args);
  await assert.rejects(generateBatch(db,args),/ya existe/);
  assert.equal(docs.size,4);
});

test("una captura pendiente no libera la tarjeta aunque cambie el estado local", async()=>{
  const { releaseCancelledReservation } = require("../lib/orderFulfillment");
  const [card]=makeCards({lote:"QA",n:1});
  for (const captureStatus of ["PENDING","DENIED"]) {
    const {db,get}=createMemoryFirestore({["discountCodes/"+card.code]:{...card,used:true,orderId:"order1"},
      "orders/order1":{status:"cancelado",paymentStatus:"rechazado",paypal:{captureStatus},discount:{code:card.code}}});
    await releaseCancelledReservation({db,orderId:"order1"});
    assert.equal(get("discountCodes/"+card.code).used,captureStatus==="PENDING");
  }
});
