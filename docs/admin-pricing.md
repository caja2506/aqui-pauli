# Calculadora de precios

Disponible para administradores en `/admin/precios`, desde el menú **Precios**.

- Costos por unidad: compra, envío del proveedor/importación, entrega al cliente asumida por la tienda y otros costos.
- La compra puede ingresarse en CRC o USD. En USD se exige el tipo de cambio manual efectivamente cobrado; el resto de los gastos siempre se ingresa en CRC.
- El porcentaje es un recargo sobre el costo total: costo × (1 + porcentaje / 100). No es margen sobre el precio de venta. La pantalla muestra también el margen resultante.
- El precio sugerido se redondea hacia arriba a ₡1, ₡100, ₡500 o ₡1.000. Se muestra la ganancia después del redondeo.
- La primera apertura no inventa un porcentaje: cada tienda debe definirlo y pulsar **Guardar estándar**. La ganancia y el redondeo se comparten entre administradores mediante `admin_pricing/settings`.
- La configuración solo admite lectura/escritura de administradores. No guarda costos ni nombres de productos en Firestore. Los costos del cálculo se limpian al salir; el estándar persiste.
- **Copiar precio** permite llevar el resultado al editor de productos. No actualiza automáticamente catálogo, variantes, checkout ni tarifas de envío.

Pruebas: `npm run test:pricing`, pruebas de rutas existentes, build de Vite y `scripts/pricing-rules.emulator.test.cjs` en el emulador de CI. El despliegue de cambios aislados de reglas usa exclusivamente `firestore:rules`.
