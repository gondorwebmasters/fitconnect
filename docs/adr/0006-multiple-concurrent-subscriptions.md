# 0006-multiple-concurrent-subscriptions

## Contexto

Hasta ahora el sistema asumía **una sola suscripción vigente por usuario y
empresa**. La asunción no estaba en la base de datos —`Subscription` no tiene
ninguna restricción `unique`— sino repartida por la lógica de servicio: dos
consultas `findOne` (`findLiveSubscriptionForUser` en `schedule.service.ts`,
`getUserActiveSubscriptionInCompany` en `permission.service.ts`), el reparto en
vertientes de `createSubscription`, y un payload de login con `plan`, `status`
y `remainingCredits` en singular.

**Restricted Schedule** (ADR 0005) rompió esa asunción por la vía de los
hechos: si un horario admite solo ciertos planes, un miembro que quiera entrar
a dos familias de horarios distintas necesita los dos planes **a la vez**. El
caso que lo forzó: un miembro con *Premium* (temporal, ilimitado) que además
contrata *Entrenamientos personalizados* (un **Session Pack**), y debe poder
apuntarse a los horarios de ambos, gastando crédito solo en los del segundo.

La pregunta difícil no es *si* permitir varias, sino **qué significa "tu plan"**
cuando hay varias, porque de esa única respuesta cuelgan los permisos, el
banner, el cambio de plan y quién paga cada reserva.

## Decisiones

1. **Las suscripciones vigentes son simétricas.** No hay plan "base" ni plan
   "complemento": ningún campo nuevo en `Plan`, ninguna jerarquía. Un miembro
   puede tener solo un Session Pack y eso es una membresía tan válida como
   cualquier otra.

2. **El conjunto tiene nombre: Entitlement.** Las suscripciones vigentes de un
   miembro en una empresa forman su **Entitlement** (ver CONTEXT.md). Las
   reglas de acceso se escriben sobre el conjunto, no sobre "la" suscripción.
   `Subscription` conserva su significado de siempre: una fila, un plan, un
   periodo, sus créditos.

3. **Los permisos son la unión** de los planes del Entitlement. Un plan nunca
   puede *quitar* acceso que otro concede.

4. **`hasActive` = Entitlement no vacío.** Un Session Pack por sí solo lo pone a
   `true`.

5. **El gate de horarios deja de mirar `hasActive`.** Pasa a preguntar si
   *alguna suscripción concreta* del Entitlement admite ese horario **y** está
   en `ACTIVE`/`TRIALING`. Una suscripción `PAST_DUE` no abre ninguna puerta
   aunque el miembro conserve acceso general por otra.

6. **Paga la suscripción que abre la puerta.** Cuando varias califican —lo que
   incluye todo horario sin restricción, que es todo horario preexistente— gana
   la de `creditsTotal === null`. Nunca se gasta un crédito si otra suscripción
   vigente ya admite al miembro gratis. La suscripción que pagó se **persiste
   en la reserva**: el reembolso devuelve el crédito a esa, no a una re-derivada.

7. **Nunca dos vigentes al mismo plan.** Se rechaza en `createSubscription` y
   también en `changePlan` (`USER_ALREADY_ACTIVE_IN_PLAN`). La ruta para
   encadenar dos bonos iguales es una **Suscripción Futura**.

8. **Las reglas de solape pasan a razonar por plan**, no por usuario: como
   máximo una Suscripción Futura *por plan*, su inicio posterior al fin de la
   vigente *de ese mismo plan*, el `cancelAtPeriodEnd` automático solo sobre la
   vigente *del mismo plan*, y el bloqueo de **Suscripción Retroactiva** solo
   ante solape *del mismo plan*.

9. **`createSubscription` siempre añade.** Deja de reinterpretar "otro plan,
   inicio hoy" como cambio de plan; el cambio va por `changePlan`, explícito y
   con `subscriptionId`.

10. **`subscriptionState` sigue siendo uno solo y agregado**, con precedencia
    `ACTIVE > SCHEDULED > EXPIRED > NONE`. Informa del acceso al gimnasio, no
    del estado de cada producto: agotar los créditos de un bono no produce
    banner, se comunica con `remainingCredits` (ADR 0004).

## Consecuencias

- Las dos consultas `findOne` duplicadas tienen ya **un solo dueño**:
  `EntitlementService` (`src/services/entitlement.service.ts`). `ScheduleService`
  y `PermissionService` delegan en él, así que cada regla de arriba se
  implementa una vez. El servicio conserva las dos propiedades que en su día
  forzaron la duplicación: acepta un `EntityManager` transaccional y funciona
  sin empresa en contexto.
- `remainingCredits` y `creditsTotal` sueltos en el payload de login dejan de
  tener sentido global: la verdad es `subscriptions[]`. Los escalares quedan
  **deprecados**, resolviendo de forma determinista a la vigente ilimitada y,
  en empate o ausencia, a la de `currentPeriodEnd` más lejano — estable, de
  modo que comprar un bono no cambia lo que muestra una app antigua.
- La unión de permisos hace que **mande el plan más permisivo**. Un plan con
  `planPermissions` amplios por descuido eleva al miembro mientras dure; hay
  que auditar los planes existentes antes de activarla.
- La decisión 9 es un **cambio de contrato** que rompe tres puntos de llamada
  (el panel de miembro del backoffice y dos pantallas de la app) y deja obsoleta
  la copia cliente de la inferencia, que incluye la suposición literal
  `if (activeSubs.length > 1) { no se pueden crear más }`. Una app antigua que
  intente cambiar de plan contra el back nuevo acabaría **pagando dos
  suscripciones**: el despliegue va app primero, con el flujo de compra de bono
  tras un flag, y el flag se activa una vez el back está arriba.
- N suscripciones significan **N cobros** y dunning independiente. No se
  agrupan; agrupar es un proyecto de facturación aparte. En la práctica un
  Session Pack es pago único y nunca autorenueva.
- Un miembro con solo un Session Pack entra a **todos los horarios sin
  restricción**, porque `allowedPlans` vacío significa abierto. Cerrarlo es
  trabajo de datos del gimnasio (marcar los horarios generales), no de código.

## Trade-off

**Simétricas en vez de base + complemento.** Tipar el plan (`MEMBERSHIP` /
`ADD_ON`) habría preservado intactos el payload singular, el cambio de plan y el
banner, tocando mucho menos código. Se rechazó por dos razones: obliga a quien
crea un plan a clasificarlo antes de poder venderlo, una decisión que no le
corresponde y que el dominio no le pide; y es directamente falsa, porque un
miembro puede contratar *solo* el bono y entonces ese bono **es** su membresía.
Una taxonomía que miente en un caso real acaba necesitando excepciones. El
precio aceptado es que "tu plan" deja de existir y hubo que dar respuesta
explícita —no inferida— al banner, al payload y al cambio de plan.

**Unión de permisos, sin intersección ni precedencia.** Es la única regla que no
depende del orden ni de una jerarquía que hemos decidido no tener. El precio es
que no existe forma de que un plan restrinja lo que otro concede; si algún día
hace falta, será una regla nueva, no un ajuste de ésta.

**Gana la ilimitada al pagar.** La alternativa —gastar siempre crédito si hay
bono— es más simple de implementar y más fácil de explicar, pero cobra al
miembro por entrar a una clase abierta a la que su otra suscripción ya le daba
derecho gratis. Ese es exactamente el cobro que el miembro percibiría como un
error, y ningún gimnasio quiere defenderlo por teléfono.

**Persistir quién pagó.** Obliga a dar entidad a la tabla pivote de las
reservas (`user_schedules` → `ScheduleRegistration`), que hasta ahora era
invisible, y a llevarle una columna más. Se aceptó porque la alternativa
—re-derivar la suscripción al desapuntarse, como se hacía— devuelve el crédito a
la suscripción equivocada en cuanto hay más de una vigente, y un crédito que
aparece donde no debe es un fallo silencioso que solo se detecta cuando las
cuentas ya no cuadran. Se eligió la pivote y no una tabla aparte porque quién
pagó tiene que aparecer y desaparecer **con** la reserva; cualquier tabla propia
podría desincronizarse de la pertenencia. Las reservas anteriores se quedan sin
anotar y no hay nada que reconstruir: la migración **comprueba** que ninguna
suscripción llevaba créditos —sin **Session Pack** ninguna reserva pudo pagar
uno— y aborta si la asunción resulta falsa.
