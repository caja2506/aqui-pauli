import { MessageCircle } from 'lucide-react';

const WA_NUMBER = '50670956070';
const WA_MESSAGE = '¡Hola! 👋 Me gustaría saber más sobre sus productos.';

export default function WhatsAppButton() {
  const waLink = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(WA_MESSAGE)}`;

  return (
    <a
      href={waLink}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chatea con nosotros por WhatsApp"
      className="fixed bottom-6 right-6 z-50 group"
    >
      <span className="absolute -top-12 right-0 bg-slate-900 text-white text-xs font-medium px-3 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap shadow-lg pointer-events-none">
        ¡Chateá con nosotros! 💬
      </span>
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-[#25D366] text-white shadow-lg hover:shadow-xl hover:scale-110 transition-all duration-300 active:scale-95">
        <MessageCircle className="w-7 h-7 fill-white stroke-white" />
      </div>
      <span className="absolute top-0 right-0 w-3.5 h-3.5 bg-red-500 border-2 border-white rounded-full animate-pulse" />
    </a>
  );
}
