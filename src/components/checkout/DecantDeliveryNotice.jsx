import { MINIMUM_MESSAGE } from '../../../functions/lib/decantSale.mjs';
import { formatCRC } from '../../utils/formatters';

export default function DecantDeliveryNotice({ delivery }) {
  if (!delivery.toFreeShipping) return null;
  return (
    <div aria-live="polite" className="space-y-1 text-sm text-slate-700">
      <p>Te faltan {formatCRC(delivery.toFreeShipping)} para envío gratis.</p>
      {delivery.belowMinimum && <p className="font-semibold">{MINIMUM_MESSAGE}</p>}
    </div>
  );
}
