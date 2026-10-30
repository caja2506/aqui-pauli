# Contra entrega en la tienda

## Regla comercial

- Identificador: `contra_entrega`; etiqueta: **Contra entrega (efectivo)**.
- Disponible únicamente cuando todas las líneas del carrito son `stock_propio`.
- El comprador paga **₡0 al confirmar** y **el total en efectivo al recibir**.
- Los productos Bajo pedido siguen requiriendo el 50% de esas líneas. Un carrito
  mixto conserva el pago anticipado del 100% de las líneas en stock y el 50% de
  las líneas Bajo pedido; no ofrece contra entrega.
- SINPE, transferencia y los proveedores online conservan sus reglas actuales.
  La disponibilidad de Tilopay sigue dependiendo de su configuración existente.

## Creación de la orden

`cashOnDeliveryClient.createCashOnDeliveryOrder` usa exclusivamente
`createOrderWithReservation`. El navegador envía identificadores, cantidades,
contacto, dirección y notas; no es autoridad para el precio, abastecimiento,
dueño, inventario o estado financiero.

El servidor consulta productos y variantes dentro de la transacción, rechaza
productos Bajo pedido o no disponibles, calcula el total y reserva inventario.
El pedido nace con pago pendiente y monto recibido cero. Su saldo pendiente
es el total del pedido. La confirmación utiliza el total devuelto por el servidor.

Las reglas impiden crear contra entrega directamente desde Firestore, modificar
sus líneas o acreditar dinero desde un navegador. El comprador solo puede leer
su propio pedido.

## Operación administrativa

El estado de preparación o entrega es independiente de que se haya recibido el
efectivo. No se requiere subir un comprobante de SINPE para estos pedidos.
Los estados solo avanzan de pendiente a preparación, envío y entrega; no se
retroceden para simular una cancelación o un pago.

El administrador utiliza **Confirmar efectivo recibido** únicamente después de
recibir el dinero. `manageCashOnDeliveryOrder` verifica el rol administrativo y
registra cobro, saldo, inventario y CRM de forma transaccional e idempotente;
conserva el progreso de entrega. Repetir la confirmación no vuelve a descontar
inventario ni a contar una segunda compra.

La cancelación usa el mismo callable para liberar la reserva de un pedido no
cobrado. Los pedidos cobrados o entregados no se cancelan mediante este flujo.
Antes de cancelar, el administrador confirma que los productos siguen en la
tienda o ya fueron devueltos, porque volverán a quedar disponibles para venta.
Los pedidos contra entrega se conservan como historial y no se eliminan.
Los endpoints de comprobantes y aprobación manual de transferencias rechazan
contra entrega: el efectivo se registra por su acción específica.

## Publicación y pruebas

Publicar primero servidor y reglas, esperar el despliegue correcto y después
publicar la interfaz. Esto evita mostrar un método todavía no soportado.

El alcance de Functions es `createOrderWithReservation`, `deleteOrder`,
`manageCashOnDeliveryOrder`, `submitPaymentProof` y `approvePaymentManually`,
además de las reglas. No requiere desplegar endpoints de PayPal o Tilopay ni
el trigger de notificaciones.

Las regresiones cubren carritos en stock, Bajo pedido y mixtos; datos falsificados;
disponibilidad; registro pendiente; cobro y cancelación administrativos;
idempotencia; permisos; confirmación y Mis Pedidos; textos comerciales; y
conservación de los flujos de pago anteriores. Las comprobaciones del navegador
se realizan sin enviar pedidos ni ejecutar pagos reales.
