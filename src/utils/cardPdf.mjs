import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const mm = 72 / 25.4;
const plum = rgb(0.36, 0.09, 0.21), rose = rgb(0.722, 0.212, 0.431), blush = rgb(0.973, 0.784, 0.863);
const crDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Costa_Rica' });

export async function cardPdf(cards) {
  if (!cards.length) throw new Error('El lote no tiene tarjetas para imprimir.');
  const pdf = await PDFDocument.create();
  pdf.setTitle('Aquí Pauli · Tarjetas de descuento');
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const w = 90 * mm, h = 55 * mm;
  let page;
  for (const [i, card] of cards.entries()) {
    if (i % 8 === 0) page = pdf.addPage([612, 792]);
    const x = (612 - 2*w - 16)/2 + (i%2)*(w+16);
    const y = (792 + 4*h + 3*12)/2 - h - Math.floor((i%8)/2)*(h+12);
    page.drawRectangle({ x, y, width:w, height:h, color:rgb(1,0.976,0.985) });
    page.drawRectangle({ x, y:y+h-6, width:w, height:6, color:rose });
    const label = (str, dx, dy, size, face=font, color=plum) => page.drawText(str,{x:x+dx,y:y+dy,size,font:face,color});
    label('AQUÍ PAULI',14,h-22,8,bold,rose);
    label('Gracias por tu compra',14,h-43,15,bold);
    page.drawSvgPath('M0 3 C0 -1 6 -2 7 3 C9 -2 15 -1 15 3 C15 7 10 10 7 13 C4 10 0 7 0 3 Z',{x:x+w-32,y:y+h-31,color:rose,scale:0.9});
    label('Tu código único',14,h-61,9);
    page.drawRectangle({x:x+14,y:y+h-89,width:w-28,height:23,color:blush});
    label(card.code,21,h-83,16,bold);
    label('10% de descuento en tu próxima compra',14,h-106,10,bold);
    label('Usalo en aquipauli.com',14,h-121,10);
    label('Válido hasta '+crDate.format(new Date(card.expiresAt))+' · Un solo uso',14,13,8);
    for (const [cx,sx] of [[x,-1],[x+w,1]]) for(const [cy,sy] of [[y,-1],[y+h,1]]) {
      const line=(x1,y1,x2,y2)=>page.drawLine({start:{x:x1,y:y1},end:{x:x2,y:y2},thickness:0.45,color:rgb(.45,.4,.42)});
      line(cx+sx*2,cy,cx+sx*6,cy); line(cx,cy+sy*2,cx,cy+sy*5);
    }
  }
  return pdf.save();
}
