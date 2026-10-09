# Cambios de Aquí Pauli

## 2026-10-09 — WA-RETIRE-001: preparar retirada de WhatsApp

Se prepara el canal apagado por defecto: bot, mensajes manuales/automáticos y nuevas automatizaciones se frenan; la web retira invitaciones a WhatsApp y soporte conserva el historial sin simular envíos. La lógica de pedidos, pagos/SINPE, Telegram y catálogo Meta no cambia.

[Borrador1](https://github.com/caja2506/aqui-pauli/pull/1). Pasan17 pruebas backend,16 web y build; el lint general tiene2 errores preexistentes documentados. No desplegado ni desconectado en producción. Se elimina el comprobante por WhatsApp sin añadir una vía sustituta. Ver [alcance, pruebas y publicación pendiente](docs/WHATSAPP_RETIREMENT.md).
