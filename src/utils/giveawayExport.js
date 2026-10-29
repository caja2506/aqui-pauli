// El CSV contiene datos personales: solo se genera desde la pantalla admin.
// Citar una celda no impide que Excel ejecute una fórmula; neutralizamos también
// los prefijos de fórmula, incluso si van precedidos de espacios o controles.
export function giveawayCsvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

export function giveawayEntryDate(value) {
  const date = typeof value?.toDate === 'function' ? value.toDate()
    : typeof value?.seconds === 'number' ? new Date(value.seconds * 1000)
      : new Date(value);
  if (value == null || !Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('es-CR', {
    timeZone: 'America/Costa_Rica', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(date);
}

export function buildGiveawayCsv(entries) {
  const rows = [
    ['Número', 'Nombre completo', 'Teléfono', 'Correo', 'Premio', 'Fecha (Costa Rica)', 'Promociones autorizadas'],
    ...[...entries].sort((a, b) => a.number - b.number).map((entry) => [
      entry.number, entry.fullName, entry.phone, entry.email, entry.prizeLabel,
      giveawayEntryDate(entry.createdAt), entry.promotionsConsent === true ? 'Sí' : 'No',
    ]),
  ];
  return '\uFEFF' + rows.map((row) => row.map(giveawayCsvCell).join(',')).join('\r\n') + '\r\n';
}
