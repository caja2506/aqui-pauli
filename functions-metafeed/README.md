# metaFeed (Cloud Function, codebase `metafeed`)

Serves `https://aquipauli.com/meta-feed.csv` (Hosting rewrite -> `metaFeed`, us-central1) for the Meta catalog.

NOT part of `firebase.json` `functions`, so the GitHub Actions deploy (Hosting only) never touches it.
Deploy manually from an isolated dir with `firebase.json` = `{"functions":[{"source":"metafeed","codebase":"metafeed"}]}`,
copy these files into `metafeed/`, run `npm install`, then `firebase deploy --only functions:metafeed --project aqui-pauli`.

Availability: made-to-order (`bajo_pedido`) variants are emitted as `in stock` because WhatsApp hides non-"in stock" items.

## Código compartido con el botón "Sync WhatsApp"
`feed.js` es una COPIA de `functions/lib/metaFeed.js` (fuente única; mismos IDs/disponibilidad/precio/texto que empuja `syncCatalogBatch`).
Editá siempre `functions/lib/metaFeed.js` y luego `cp functions/lib/metaFeed.js functions-metafeed/feed.js`
(el test `functions/test/metaFeed.test.js` falla si difieren).
