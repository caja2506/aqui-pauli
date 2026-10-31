import { useEffect, useState } from 'react';
import { doc, onSnapshot, runTransaction, serverTimestamp } from 'firebase/firestore';
import { db } from '../../firebase';
import { tilopayCreatePayment } from '../../services/payments/tilopayClient';
import { isValidTilopayPaymentUrl } from '../../services/payments/tilopayUrl';

const SKU = 'zz-tilopay-live-check';
const OWNER_TOKEN = 'aqp_live_pilot_operator';
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const hash = async token => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
const settings = () => doc(db, 'config', 'payments');
const product = () => doc(db, 'products', SKU);
const variant = () => doc(db, 'products', SKU, 'variants', 'v1');

export default function TilopayPilotPage() {
  const [config, setConfig] = useState(null);
  const [token, setToken] = useState(() => sessionStorage.getItem(OWNER_TOKEN) || '');
  const [ownsLink, setOwnsLink] = useState(false);
  const [portalLive, setPortalLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [formCheck, setFormCheck] = useState(null);
  useEffect(() => onSnapshot(settings(), snap => setConfig(snap.data()?.tilopay || {}),
    () => setError('La cuenta necesita acceso al panel Admin.')), []);
  const seedHash = config?.pilotSeed?.tokenHash;
  useEffect(() => { let current = true; setOwnsLink(false);
    if (token && seedHash) hash(token).then(value => { if (current) setOwnsLink(value === seedHash); });
    return () => { current = false; };
  }, [token, seedHash]);
  const stage = config?.pilotSeed?.stage;
  async function checkForm() {
    if (busy) return;
    setBusy(true); setError(''); setFormCheck(null);
    try {
      const result = await tilopayCreatePayment({ checkClosedPilotForm: true, shortPilotReference: true });
      const url = isValidTilopayPaymentUrl(result.url) ? result.url : null;
      const message = url ? 'Tilopay generó el formulario de ₡1 000.'
        : result.formReason === 'MERCHANT_TRANSACTION_BLOCK' ? 'Tilopay volvió a responder que el comercio tiene un bloqueo (402).'
          : result.message || 'Tilopay no devolvió un formulario.';
      setFormCheck({ url, message, reference: result.providerReference });
    } catch (e) {
      setError(['functions/permission-denied','functions/failed-precondition','functions/unauthenticated'].includes(e.code)
        ? e.message : 'No recibimos el resultado. Podés volver a consultarlo en esta misma pantalla.');
    } finally { setBusy(false); }
  }
  async function act(action) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      let next = token;
      if (action === 'prepare' || action === 'replace') {
        next = hex(crypto.getRandomValues(new Uint8Array(32)));
        sessionStorage.setItem(OWNER_TOKEN, next); setToken(next);
      }
      const digest = await hash(next);
      await runTransaction(db, async tx => {
        const c = (await tx.get(settings())).data()?.tilopay;
        if (c?.merchantId !== '88802749' || c.orderPrefix !== 'PFC031932') throw Error('Revisá la configuración del comercio.');
        if (action === 'prepare') {
          const [p,v] = await Promise.all([tx.get(product()),tx.get(variant())]);
          if (c.mode !== 'test' || !c.enabled || c.access || c.pilotSeed || p.exists() || v.exists()) throw Error('El estado inicial cambió. Recargá la página.');
          tx.set(product(), {active:true,deleted:false,unlisted:true,name:'Compra de verificación',slug:SKU,basePrice:1000,
            description:'Una unidad para verificar un pago real de Aquí Pauli.',images:[],categoryRefs:[],createdAt:new Date().toISOString()});
          tx.set(variant(), {name:'Única',active:true,price:1000,stock:1,reservedStock:0,supplyType:'stock_propio'});
          tx.update(settings(), {'tilopay.enabled':false,'tilopay.pilotSeed':{stage:'prepared',tokenHash:digest}});
        } else if (action === 'activate' || action === 'replace') {
          if (c.mode !== 'test' || c.enabled !== false || c.access || c.pilotSeed?.stage !== 'prepared') throw Error('La prueba no está en preparación.');
          if (action === 'replace') { tx.update(settings(), {'tilopay.pilotSeed.tokenHash':digest}); return; }
          if (!portalLive || c.pilotSeed.tokenHash !== digest) throw Error('Confirmá primero el modo del portal Tilopay y el enlace de esta pestaña.');
          tx.update(settings(), {'tilopay.mode':'live','tilopay.access':'private-pilot','tilopay.enabled':true,
            'tilopay.pilotSeed.stage':'open','tilopay.pilotSeed.startedAt':serverTimestamp()});
        } else if (action === 'close') {
          if (c.mode !== 'live' || c.access !== 'private-pilot' || c.pilotSeed?.stage !== 'open') throw Error('La prueba ya no está abierta.');
          tx.update(settings(), {'tilopay.enabled':false,'tilopay.pilotSeed.stage':'closed'});
          tx.update(product(), {active:false});
        }
      });
    } catch (e) { setError(e.code ? 'No se pudo guardar desde esta cuenta de Admin. Recargá y verificá el estado.' : e.message); }
    finally { setBusy(false); }
  }
  const button = (label, action, enabled=true) => <button type="button" disabled={busy || !enabled} onClick={() => act(action)}
    className="block rounded-xl bg-slate-900 px-5 py-3 font-bold text-white disabled:opacity-50">{label}</button>;
  const expires = config?.pilotSeed?.startedAt?.toMillis?.() + 7200000;
  const purchaseUrl = new URL(`/producto/${SKU}#tilopay-pilot=${token}`, window.location.origin).href;
  return <section className="mx-auto my-6 max-w-xl space-y-5 rounded-2xl bg-white p-6 shadow-sm">
    <h1 className="text-2xl font-black">Prueba privada de tarjeta</h1>
    <p>Una sesión de compra, un pedido y un total de <strong>₡1 000</strong>.</p>
    {!config ? <p>Cargando configuración…</p> : !stage ? <>
      <p>Este paso crea el artículo oculto y pausa el inicio de pagos con tarjeta mientras se cambia el ambiente del portal.</p>
      {button('1. Preparar prueba de ₡1 000','prepare',config.mode==='test' && config.enabled)}
    </> : stage==='prepared' ? <>
      <strong>Preparada. Las compras con tarjeta están pausadas.</strong>
      <p>Avisá que la prueba está preparada. Cuando se confirme que el portal Tilopay está en producción, habilitá aquí el enlace privado.</p>
      {!ownsLink ? button('Preparar enlace en esta pestaña','replace') : <>
        <label className="flex items-center gap-2"><input type="checkbox" checked={portalLive} onChange={e=>setPortalLive(e.target.checked)}/> Confirmé que el portal Tilopay está en producción.</label>
        {button('2. Habilitar enlace privado','activate',portalLive)}
      </>}
    </> : stage==='open' ? <>
      <strong>El acceso está limitado a esta prueba.</strong>
      {ownsLink && Date.now()<expires ? <><p>Compartí este enlace únicamente con quien hará la compra. Abrilo en una sola pestaña.</p>
        <a target="_blank" rel="noopener noreferrer" className="block font-bold underline" href={purchaseUrl}>Abrir compra real de ₡1 000</a>
        <button type="button" className="font-bold underline" onClick={async()=>{
          try { await navigator.clipboard.writeText(purchaseUrl); setCopied(true); }
          catch { setError('Copiá la dirección del enlace «Abrir compra real de ₡1 000».'); }
        }}>{copied ? 'Enlace copiado' : 'Copiar enlace privado'}</button></> : <p>El enlace se entrega desde la pestaña que lo preparó y tiene una vigencia de dos horas.</p>}
      {button('Cerrar el acceso a nuevos formularios','close')}
    </> : stage === 'closed' ? <>
      <p>Esta prueba usa una referencia de ocho dígitos para el mismo pedido de ₡1 000. No necesitás ingresar la tarjeta.</p>
      <button type="button" disabled={busy} onClick={checkForm}
        className="block rounded-xl bg-slate-900 px-5 py-3 font-bold text-white disabled:opacity-50">
        {busy ? 'Consultando Tilopay…' : formCheck ? 'Consultar el resultado' : 'Probar con referencia corta'}
      </button>
      {formCheck && <p role="status">{formCheck.message}</p>}
      {formCheck?.reference && <p>Referencia enviada a Tilopay: <strong>{formCheck.reference}</strong></p>}
      {formCheck?.url && <a className="block font-bold underline" href={formCheck.url} target="_blank" rel="noopener noreferrer">
        Abrir formulario de Tilopay
      </a>}
    </> : <p>El estado de la prueba no permite abrir un formulario.</p>}
    {error && <p role="alert" className="font-bold text-red-700">{error}</p>}
  </section>;
}
