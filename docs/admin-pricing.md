# Proveedores y precios

Disponible para administradores en `/admin/precios`, desde el menú **Precios**.

## Catálogo del proveedor

El catálogo privado conserva cada descripción y las dos columnas del PDF LS: mayorista en efectivo y mayorista con SINPE móvil o tarjeta. La búsqueda combina palabras sin distinguir mayúsculas o tildes; la tabla muestra 40 filas por página. Al abrir un producto se usa la columna elegida, inicialmente efectivo. Una discrepancia entre columnas se conserva y se señala para confirmar con el proveedor.

**Cargar/Actualizar catálogo** acepta el JSON preparado y verificado desde el PDF. Su formato es `version: 1`, `supplier: "LS"`, `currency: "CRC"`, `sourceName`, `sourceDate` (AAAA-MM-DD), `sourceSha256` y `products`. Cada fila contiene `id` (`ls-0001`), `description`, `cashCRC`, `cardCRC` y `page`. Se confirma la cantidad antes de importar. El callable valida todo el archivo antes de reemplazar atómicamente `admin_supplier_catalogs/ls`; un archivo inválido no cambia el catálogo anterior.

Los archivos del proveedor y sus precios no se incluyen en el repositorio público ni en los assets de Hosting. Solo los administradores pueden leer el catálogo. La escritura directa del cliente está denegada y el callable verifica el rol administrativo.

## Cálculo

- Valores iniciales solicitados: 20% de ganancia sobre costo, ₡2.900 de envío nacional y ₡7.000 de traslado internacional completo hasta la casa. Los ₡7.000 ya incluyen el movimiento interno en Costa Rica: no se suman los ₡2.900 nacionales.
- La nueva configuración v2 reemplaza los valores iniciales de la calculadora v1. **Ajustar valores predeterminados** permite guardar otro estándar para todos los administradores en `admin_pricing/settings`.
- Todos los costos son por unidad. Si un envío cubre varias unidades, se ajusta la parte correspondiente. La entrega al cliente y otros gastos son opcionales y empiezan en cero.
- La fórmula es `(compra en CRC + traslado + entrega asumida + otros gastos) × (1 + ganancia / 100)`. El 20% es recargo sobre costo, no margen sobre venta. El gráfico muestra la composición y el margen resultante.
- Redondeo hacia arriba a ₡1, ₡100 (inicial), ₡500 o ₡1.000. La ganancia mostrada incluye el redondeo.
- La compra admite CRC o USD. En internacional se consulta la referencia de venta BCCR vía Hacienda; el administrador puede introducir el tipo de cambio cobrado por su banco. Si la consulta falla, debe ingresarlo: no se inventa una tasa.
- **Copiar precio** permite llevar el resultado a Productos. La cotización no modifica precios, stock, variantes, checkout ni tarifas de envío de la tienda. Los cálculos individuales no se guardan.

## Enlaces internacionales

La consulta usa páginas HTTPS públicas de Jomashop, FragranceNet y FragranceX. Lee ofertas exactas en JSON-LD. Para FragranceNet también lee el precio regular y el precio con cupón de cada presentación disponible. El administrador elige cuál aplicar. No convierte un rango ni una cuota en precio final. No inicia sesiones ni intenta eludir bloqueos; si FragranceNet rechaza temporalmente la consulta, se puede elegir una referencia fechada para el mismo enlace durante las 24 horas posteriores a su lectura. El campo de compra también acepta precios copiados como $104.51 o 104,51.

Amazon acepta enlace y precio manual. No hay una integración de Amazon configurada ni se simula una consulta automática. Cualquier otra tienda permite abrir el enlace e ingresar el precio. Los importes externos deben revisarse por cambios, impuestos, descuentos o gastos no incluidos por la tienda.

El servidor exige administrador, limita la consulta a una cada 10 segundos por usuario y solo permite hosts definidos; valida cada redirección, limita tiempo/tamaño y elimina parámetros de enlaces. Los resultados se muestran con su hora de consulta. Cambiar el enlace limpia el precio anterior y descarta respuestas atrasadas.

## Validación y publicación

`npm run test:pricing`, `node --test functions/test/supplierPricing.test.js`, `node --test scripts/firebase-deploy-targets.test.mjs`, pruebas existentes del storefront, build de Vite y reglas con `scripts/pricing-rules.emulator.test.cjs` en el emulador de CI. Un cambio aislado de este módulo publica reglas y solo `importSupplierCatalog`, `lookupExternalPrice` y `getPricingExchangeRate`.
