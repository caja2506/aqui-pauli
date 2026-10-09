# Relevo — WA-RETIRE-001

2026-10-09, Codex root. [Borrador1](https://github.com/caja2506/aqui-pauli/pull/1), rama `codex/retire-store-whatsapp`, base `d50998962b3f4162fd152ef32751bfa79a7c751b`. Carlos quita el vínculo de Facebook; el código retira bot, emisores y enlaces de Aquí Pauli. Autoría final por conector GitHub con lease.

Código revisado `efe5a5a51b35c1e80747295749c2198fbffa9495`: 17 pruebas backend,16 UI y build pasan en CI. Lint general falla por2 errores de archivos intactos; CI del retiro valida9 archivos web modificados. La revisión independiente y comparación de los blobs no detectaron bloqueantes. [Alcance, evidencia y secuencia](WHATSAPP_RETIREMENT.md).

Pendiente: publicar backend y después Hosting apagados, revisar versión efectiva, identificar y retirar acceso dedicado Meta, comprobar retirada real. Incluir `onOrderStatusChange` entre los cinco exports para dejar de producir automatizaciones. No se modificó el runtime, no se borró el número ni se retiraron credenciales en Meta. No hay tokens ni registros operativos en esta entrega. Los pendientes/históricos se conservan.

MotelOps [borrador104](https://github.com/caja2506/motelops/pull/104) sigue sin activar; coordinar con [borrador100](https://github.com/caja2506/motelops/pull/100). No asumir que desuscribir webhooks revoca envíos salientes, ni reactivar la cola antigua sin revisarla.
