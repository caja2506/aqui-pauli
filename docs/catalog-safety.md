# Seguridad de inventario y precios — 5 noviembre 2026 (Costa Rica)

Solicitud: una unidad disponible como máximo por colonia completa, bloquear compras al agotarse y evitar precios accidentales como ₡100.


La corrección reduce existencias mayores de uno sin reponer ceros, conserva reservas y cambia las colonias a stock propio. Desactiva productos de prueba y precios fuera del umbral; no inventa ni modifica precios comerciales. Guarda los valores anteriores de inventario en la colección privada `catalog_safety_audit`. Las operaciones usan transacciones con lecturas actuales, son repetibles y nunca reponen una unidad vendida.

Protecciones compartidas entre servidor y tienda: mínimo ₡10.000 por colonia completa y ₡1.000 para otros productos; máximo una unidad por colonia en cada pedido, incluso repartida entre variantes; disponibilidad descontando reservas. Son umbrales contra errores, no una validación de costos o márgenes. Bolsos y zapatos conservan Bajo pedido. Los decants conservan precios y variantes.

El pedido reserva la unidad para impedir ventas simultáneas. Al aplicar el pago, el sistema existente consume stock y reserva una sola vez. Las reservas actuales permanecen hasta su confirmación o cancelación. Fichas y tarjetas escuchan cambios de existencias; el carrito limita cantidades y muestra errores de cotización.

`catalog-safety.yml` ejecuta las pruebas, audita, aplica y vuelve a verificar usando las credenciales existentes de GitHub Actions para `aqui-pauli`. No imprime credenciales ni datos de compradores. El flujo se activa únicamente cuando se cambia el script o ese archivo de workflow en main. El código se publica por los workflows existentes de Hosting y Functions.

Validación local: suite Functions, incluyendo concurrencia, agotamiento, descuentos y pagos; pruebas de checkout/carrito, catálogo, sorteo, autenticación y calculadora; compilación Vite. No se generan pedidos ni cobros reales para verificar.
