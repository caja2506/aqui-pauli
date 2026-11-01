// Exercise the mobile/admin page with local Firestore doubles. No connected database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithEsbuild } from 'vite';
import { cardState } from '../functions/lib/promotions.mjs';
const require = createRequire(import.meta.url);
const file = 'src/pages/admin/DiscountCardsPage.jsx';
const compiled = await transformWithEsbuild(await readFile(new URL('../'+file,import.meta.url),'utf8'), file,
  {loader:'jsx',jsx:'automatic',format:'cjs',target:'es2022'});

test('CRM distingue por imprimir, impresos, usados y vencidos y muestra el pedido de canje', () => {
  const future = new Date(Date.now()+86400000).toISOString();
  const rows = ['AA','BB','CC','DD'].map((key,i)=>({code:'AP-'+key.repeat(3),batchId:'QA',printed:i===1,
    used:i===2,usedAt:i===2?future:null,orderId:i===2?'pedido-ejemplo':null,expiresAt:i===3?'2000-01-01':future}));
  for(const [i,filter] of ['Por imprimir','Impresos','Usados','Vencidos'].entries()){
    const values=[[{id:'QA'}],'QA',filter,{lot:'QA',rows}];
    let n=0;
    const module={exports:{}};
    function load(name){
      if(name==='react') return {...React,useEffect(){},useState(initial){const slot=n++;return [slot<values.length?values[slot]:initial,()=>{}];}};
      if(name==='react/jsx-runtime') return require(name);
      if(name==='react-router-dom') return { Link:({children})=>children };
      if(name.includes('promotions.mjs')) return {cardState};
      if(['../../firebase','firebase/functions','firebase/firestore'].includes(name)) return {};
      throw Error('Dependencia inesperada '+name);
    }
    new Function('require','module','exports',compiled.code)(load,module,module.exports);
    const html=renderToStaticMarkup(React.createElement(module.exports.default));
    assert.ok(html.includes(rows[i].code));assert.ok(!html.includes(rows[(i+1)%4].code));
    assert.ok(html.includes('Descargar PDF para imprimir'));assert.ok(html.includes('Generar códigos'));
    if(i===2) assert.ok(html.includes('pedido-ejemplo'));
  }
});
