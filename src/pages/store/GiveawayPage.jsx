import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Gift, Loader2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useGiveaway, useGiveawayEntry, useGiveawayProducts } from '../../hooks/useGiveaway';
import { CONTACT } from '../../components/legal/LegalLayout';
import { GIVEAWAY, enterGiveaway, giveawayErrorMessage, giveawayPrizeLabel, searchGiveawayProducts } from '../../services/giveawayService';
import { formatCRC } from '../../utils/formatters';
import { GIVEAWAY_PHONE_ERROR, isValidGiveawayPhone, normalizeGiveawayPhone } from '../../../functions/lib/giveawayPhone.mjs';

const fieldClass = 'w-full rounded-xl border border-rose-200 bg-white px-4 py-3 text-base text-slate-900 outline-none focus:ring-2 focus:ring-rose-500';
const linkClass = 'font-bold text-rose-700 underline underline-offset-4 hover:text-rose-900';

export function GiveawayForm({ user, onEntered, canEnter = true }) {
  const [form, setForm] = useState({
    fullName: user.displayName || '', phone: '', email: user.email || '', productId: '',
    eligibilityAccepted: false, privacyConsent: false, promotionsConsent: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const phoneInput = useRef(null);
  const catalog = useGiveawayProducts();
  const selected = catalog.products.find((product) => product.productId === form.productId);
  const filtered = searchGiveawayProducts(catalog.products, search);
  // Mantiene visible la selección existente cuando se busca otra colonia.
  const visibleChoices = selected && !filtered.some((product) => product.productId === selected.productId)
    ? [selected, ...filtered] : filtered;
  const canSubmit = canEnter && !catalog.loading && !catalog.error && Boolean(selected);
  const busy = useRef(false);
  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const updatePhone = (input, showError = false) => {
    const valid = isValidGiveawayPhone(input.value);
    input.setCustomValidity(valid ? '' : GIVEAWAY_PHONE_ERROR);
    if (showError || phoneError) setPhoneError(valid ? '' : GIVEAWAY_PHONE_ERROR);
    // Solo normalizamos valores ya válidos. Los inválidos se conservan completos:
    // validarlos de nuevo no debe quitar otro prefijo ni ocultar dígitos de más.
    update('phone', valid ? normalizeGiveawayPhone(input.value) : input.value);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (busy.current || !canSubmit) return;
    if (!isValidGiveawayPhone(form.phone)) {
      setPhoneError(GIVEAWAY_PHONE_ERROR);
      phoneInput.current?.setCustomValidity(GIVEAWAY_PHONE_ERROR);
      phoneInput.current?.focus();
      phoneInput.current?.reportValidity();
      return;
    }
    setPhoneError('');
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await enterGiveaway({ ...form, phone: normalizeGiveawayPhone(form.phone) });
      onEntered(result);
    } catch (err) {
      setError(giveawayErrorMessage(err));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6" data-testid="giveaway-form">
      <fieldset disabled={saving || !canEnter} className="space-y-6 disabled:opacity-70">
        <legend className="sr-only">Tus datos para participar</legend>
        <div>
          <label htmlFor="giveaway-name" className="mb-2 block text-sm font-bold text-slate-800">Nombre completo</label>
          <input id="giveaway-name" name="fullName" autoComplete="name" required minLength={3} maxLength={120}
            value={form.fullName} onChange={(event) => update('fullName', event.target.value)} className={fieldClass} />
        </div>
        <div>
          <label htmlFor="giveaway-phone" className="mb-2 block text-sm font-bold text-slate-800">Teléfono de Costa Rica</label>
          <div className="flex items-center gap-3">
            <span className="text-sm font-bold text-slate-500">+506</span>
            <input ref={phoneInput} id="giveaway-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel-national"
              required aria-invalid={Boolean(phoneError)} aria-describedby={phoneError ? 'giveaway-phone-help giveaway-phone-error' : 'giveaway-phone-help'}
              value={form.phone} onChange={(event) => updatePhone(event.currentTarget)}
              onBlur={(event) => updatePhone(event.currentTarget, true)}
              onInvalid={(event) => updatePhone(event.currentTarget, true)} className={fieldClass} />
          </div>
          <p id="giveaway-phone-help" className="mt-2 text-xs text-slate-500">Ingresá 8 dígitos que empiecen con 2, 4, 5, 6, 7 u 8. Podés pegar el número con +506 o 506, espacios o guiones.</p>
          {phoneError && <p id="giveaway-phone-error" role="alert" className="mt-2 text-sm text-red-700">{phoneError}</p>}
        </div>
        <div>
          <label htmlFor="giveaway-email" className="mb-2 block text-sm font-bold text-slate-800">Correo electrónico</label>
          <input id="giveaway-email" name="email" type="email" autoComplete="email" required maxLength={254}
            readOnly={Boolean(user.email)} value={form.email} onChange={(event) => update('email', event.target.value)}
            aria-describedby="giveaway-email-help" className={`${fieldClass} read-only:bg-rose-50/50`} />
          <p id="giveaway-email-help" className="mt-2 text-xs text-slate-500">
            {user.email ? 'Usamos el correo de tu cuenta de la tienda.' : 'Usaremos este correo para contactarte sobre el sorteo.'}
          </p>
        </div>
        <section className="space-y-3" aria-labelledby="giveaway-prize-heading">
          <h2 id="giveaway-prize-heading" className="text-sm font-bold text-slate-800">¿Cuál colonia te gustaría ganar?</h2>
          <p id="giveaway-prize-help" className="text-sm leading-relaxed text-slate-600">Escogé una colonia o perfume activo con precio de venta menor a ₡50 000, con stock o sin stock. Los productos de ₡50 000 o más no califican.</p>
          {catalog.loading ? (
            <p role="status" className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Cargando colonias del catálogo...</p>
          ) : catalog.error ? (
            <div role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-slate-700"><p>No pudimos cargar las colonias. Volvé a intentarlo antes de participar.</p><button type="button" onClick={catalog.retry} className={`mt-2 ${linkClass}`}>Reintentar carga</button></div>
          ) : catalog.products.length === 0 ? (
            <div role="status" className="rounded-xl bg-rose-50 p-4 text-sm text-slate-700"><p>En este momento no hay colonias del catálogo que califiquen.</p><button type="button" onClick={catalog.retry} className={`mt-2 ${linkClass}`}>Actualizar colonias</button></div>
          ) : (
            <>
              <label htmlFor="giveaway-search" className="block text-sm font-bold text-slate-800">Buscar colonia</label>
              <input id="giveaway-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)}
                placeholder="Nombre o marca, por ejemplo Versace" className={fieldClass} autoComplete="off" />
              <label htmlFor="giveaway-product" className="block text-sm font-bold text-slate-800">Colonia escogida</label>
              <select id="giveaway-product" name="productId" required value={selected?.productId || ''}
                onChange={(event) => update('productId', event.target.value)} aria-describedby="giveaway-prize-help" className={fieldClass}>
                <option value="">Escogé una colonia</option>
                {visibleChoices.map((product) => <option key={product.productId} value={product.productId}>{product.productName} — {formatCRC(product.productPrice)}</option>)}
              </select>
              {filtered.length === 0 && <p role="status" className="text-sm text-slate-600">No hay coincidencias con esa búsqueda.</p>}
              {selected && <p className="rounded-xl bg-rose-50 p-3 text-sm font-bold text-rose-900">Colonia escogida: {selected.productName} — {formatCRC(selected.productPrice)}</p>}
              {form.productId && !selected && <p role="alert" className="text-sm text-red-700">La colonia elegida ya no está en la lista. Escogé otra antes de participar.</p>}
              <button type="button" onClick={catalog.retry} className={`text-xs ${linkClass}`}>Actualizar colonias y precios</button>
            </>
          )}
        </section>
        <div className="space-y-5 border-t border-rose-100 pt-5">
          <p className="rounded-xl bg-rose-50 p-4 text-xs leading-relaxed text-slate-600">
            Responsable: Aquí Pauli ({CONTACT.owner}), {CONTACT.fullPlace}. Tus datos se guardan en la base de datos de la tienda en Firebase y solo los administra el personal autorizado para gestionar el sorteo y contactarte.
            El nombre, teléfono, correo, premio y las dos casillas obligatorias son necesarios para inscribirte. Podés solicitar acceso, rectificación, eliminación o retirar tu consentimiento por DM a{' '}
            <a href="https://www.instagram.com/aqui.paulina/" target="_blank" rel="noopener noreferrer" className={linkClass}>@aqui.paulina</a>.
          </p>
          <label className="flex items-start gap-3 text-sm leading-relaxed text-slate-700">
            <input type="checkbox" name="eligibilityAccepted" required checked={form.eligibilityAccepted}
              onChange={(event) => update('eligibilityAccepted', event.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-rose-600" />
            <span>{GIVEAWAY.eligibilityText}</span>
          </label>
          <label className="flex items-start gap-3 text-sm leading-relaxed text-slate-700">
            <input type="checkbox" name="privacyConsent" required checked={form.privacyConsent}
              onChange={(event) => update('privacyConsent', event.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-rose-600" />
            <span>{GIVEAWAY.privacyConsentText}</span>
          </label>
          <label className="flex items-start gap-3 text-sm leading-relaxed text-slate-700">
            <input type="checkbox" name="promotionsConsent" checked={form.promotionsConsent}
              onChange={(event) => update('promotionsConsent', event.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-rose-600" />
            <span>{GIVEAWAY.promotionsConsentText} <span className="block text-xs text-slate-500">Opcional. Tu decisión no cambia tu participación en el sorteo.</span></span>
          </label>
        </div>
        <p className="text-sm text-slate-600">
          Consultá las <Link to="/sorteo/bases" target="_blank" rel="noopener noreferrer" className={linkClass}>bases del sorteo</Link> antes de participar.
        </p>
        {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}
        <button type="submit" className="flex w-full items-center justify-center gap-2 rounded-2xl bg-rose-600 px-6 py-4 text-base font-black text-white shadow-sm transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50" disabled={saving || !canSubmit}>
          {saving && <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />}
          {saving ? 'Confirmando tu participación...' : 'Participar en el sorteo'}
        </button>
      </fieldset>
    </form>
  );
}

function Receipt({ entry }) {
  return (
    <section role="status" aria-live="polite" className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-center" data-testid="giveaway-receipt">
      <CheckCircle2 aria-hidden="true" className="mx-auto mb-4 h-12 w-12 text-rose-600" />
      <h2 className="text-2xl font-black text-slate-900">¡Ya estás participando!</h2>
      <p className="mt-4 rounded-2xl border border-rose-300 bg-white p-5 text-lg font-bold leading-relaxed text-slate-800">Tu número de participante es <strong className="text-rose-700">#{entry.number}</strong>. Comentá ese número en la publicación del sorteo en Instagram{' '}<a href="https://www.instagram.com/aqui.paulina/" target="_blank" rel="noopener noreferrer" className={linkClass}>@aqui.paulina</a></p>
      <p className="mt-4 text-sm text-slate-600">Colonia escogida: <strong>{giveawayPrizeLabel(entry)}</strong>{Number.isFinite(entry.productPrice) && entry.productPrice > 0 ? ` — ${formatCRC(entry.productPrice)}` : ''}</p>
      <p className="mt-3 text-sm text-slate-600">Tu inscripción quedó guardada. Podés volver a esta página con tu cuenta para consultar tu número.</p>
    </section>
  );
}

export default function GiveawayPage() {
  const { user, loading: authLoading } = useAuth();
  const giveaway = useGiveaway();
  const uid = user && !user.isAnonymous ? user.uid : null;
  const registration = useGiveawayEntry(uid);
  const [submitted, setSubmitted] = useState(null);
  const entry = registration.entry?.campaignId === GIVEAWAY.campaignId ? registration.entry
    : submitted?.uid === uid && uid ? submitted.entry : null;

  let content;
  if (authLoading || registration.loading) {
    content = <p role="status" className="py-10 text-center text-slate-500">Consultando tu inscripción...</p>;
  } else if (entry) {
    content = <Receipt entry={entry} />;
  } else if (registration.error) {
    content = <div role="alert" className="space-y-4 text-sm text-slate-700"><p>No pudimos consultar tu inscripción. Revisá tu conexión antes de continuar.</p><button onClick={registration.retry} className={linkClass}>Volver a consultar</button></div>;
  } else if (giveaway.loading) {
    content = <p role="status" className="py-10 text-center text-slate-500">Cargando el sorteo...</p>;
  } else if (giveaway.error) {
    content = <p role="alert" className="rounded-xl bg-rose-50 p-5 text-sm text-slate-700">No pudimos consultar la disponibilidad del sorteo. Revisá tu conexión y recargá la página.</p>;
  } else if (giveaway.status !== 'active') {
    content = <p role="status" className="rounded-xl bg-rose-50 p-5 text-sm text-slate-700">{giveaway.status === 'closed' ? 'Las inscripciones al sorteo cerraron el sábado 28 de noviembre de 2026 a las 8:00 p. m., hora de Costa Rica.' : giveaway.status === 'upcoming' ? 'Las inscripciones abren el 29 de octubre de 2026, hora de Costa Rica.' : 'Las inscripciones al sorteo están desactivadas por el momento.'}</p>;
  } else if (!uid) {
    content = <section className="space-y-5 text-center" data-testid="giveaway-auth-required"><h2 className="text-xl font-black text-slate-900">Creá tu cuenta para participar</h2><p className="text-sm leading-relaxed text-slate-600">Usamos tu cuenta de la tienda para guardar una única participación y que podás volver a consultar tu número.</p><Link to="/login" state={{ from: '/sorteo', mode: 'register' }} className="block rounded-2xl bg-rose-600 px-6 py-4 font-black text-white hover:bg-rose-700">Registrarme para participar</Link><Link to="/login" state={{ from: '/sorteo' }} className={`inline-block text-sm ${linkClass}`}>Ya tengo cuenta: iniciar sesión</Link></section>;
  } else {
    content = <GiveawayForm key={uid} user={user} canEnter={giveaway.status === 'active'} onEntered={(result) => setSubmitted({ uid, entry: result })} />;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pt-10 pb-[calc(7rem+env(safe-area-inset-bottom,0px))] sm:px-6 lg:pb-12">
      <header className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-rose-100 text-rose-600"><Gift className="h-8 w-8" aria-hidden="true" /></div>
        <h1 className="text-3xl font-black tracking-tight text-slate-900">Sorteo de Aquí Pauli</h1>
        <p className="mt-4 text-base leading-relaxed text-slate-600">Ganá la colonia que querás de nuestro catálogo, con precio de venta menor a ₡50 000.</p>
        <p className="mt-3 text-sm font-bold text-rose-700">Inscripciones desde el 29 de octubre hasta el sábado 28 de noviembre de 2026 a las 8:00 p. m.</p>
        <p className="mt-2 text-sm font-bold text-rose-700">El sorteo será el domingo 29 de noviembre de 2026.</p>
        <p className="mt-1 text-xs text-slate-500">Hora de Costa Rica · Participación gratuita</p>
      </header>
      <div className="rounded-3xl border border-rose-100 bg-white p-5 shadow-sm sm:p-8">{content}</div>
      <p className="mt-6 text-center text-sm"><Link to="/sorteo/bases" className={linkClass}>Ver las bases del sorteo</Link></p>
    </div>
  );
}
