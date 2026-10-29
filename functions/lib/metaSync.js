// Empuja a Meta (items_batch) exactamente las mismas filas que el feed CSV.
// fetch global (Node 18+): node-fetch v2 falla con "Premature close" en respuestas gzip de Graph API.
const { loadFeedRows, rowToBatchItem } = require("./metaFeed");

const GRAPH_API = "https://graph.facebook.com/v22.0";

async function pollBatch({ catalogId, token, handle, tries = 12, waitMs = 2500 }) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, waitMs));
    const u = `${GRAPH_API}/${catalogId}/check_batch_request_status?${new URLSearchParams({ handle, load_ids_of_invalid_requests: "true", access_token: token })}`;
    const r = await (await fetch(u)).json();
    last = r.data?.[0] || r;
    if (last.status && last.status !== "in_progress" && last.status !== "started") break;
  }
  return last;
}

/**
 * @returns {{success, synced, errors, total, skipped, message, details}}
 */
async function syncFeedToMeta({ db, catalogId, token }) {
  const { rows, problems } = await loadFeedRows(db);
  if (!rows.length) return { success: true, synced: 0, errors: 0, total: 0, skipped: problems.length, message: "No hay productos para sincronizar." };

  const requests = rows.map((r) => ({ method: "UPDATE", data: rowToBatchItem(r) }));
  const resp = await fetch(`${GRAPH_API}/${catalogId}/items_batch`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: token, item_type: "PRODUCT_ITEM", allow_upsert: "true", requests: JSON.stringify(requests) }),
  });
  const data = await resp.json();
  if (data.error) {
    return { success: false, synced: 0, errors: requests.length, total: requests.length, skipped: problems.length, message: `Error de Meta API: ${data.error.message}` };
  }
  const handle = data.handles?.[0];
  let status = null;
  if (handle) status = await pollBatch({ catalogId, token, handle });
  const errors = (status?.errors_total_count ?? 0) + (status?.errors?.length && !status?.errors_total_count ? status.errors.length : 0);
  const finished = status?.status === "finished";
  const synced = finished ? Math.max(0, requests.length - errors) : 0;
  const skipped = problems.length;
  const ok = finished && errors === 0;
  const message = ok
    ? `Sincronización completada: ${synced} productos actualizados en Meta${skipped ? ` (${skipped} omitidos por datos incompletos)` : ""}.`
    : finished
      ? `Sincronización con errores: ${synced} actualizados y ${errors} con error.`
      : `Meta recibió ${requests.length} productos pero todavía está procesando (estado: ${status?.status || "desconocido"}).`;
  return { success: ok || (!finished && !errors), synced, errors, total: requests.length, skipped, message, details: { handle, status, problems } };
}

module.exports = { syncFeedToMeta };
