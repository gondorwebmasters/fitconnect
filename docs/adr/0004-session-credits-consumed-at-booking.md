# 0004-session-credits-consumed-at-booking

## Contexto

Con el **Session Pack (Bono)** un `Plan` puede llevar un número finito de
**Session Credits** (`Plan.sessionCount`; null ⇒ ilimitado). Al crear una
suscripción se snapshotean en `Subscription.creditsTotal` / `creditsUsed`
(ver CONTEXT.md → Session Pack, Session Credit). Había que fijar dos decisiones
de diseño que condicionan todo lo demás:

1. **¿Cuándo se gasta un crédito?** Al reservar plaza en un `Schedule`, o cuando
   la clase efectivamente ocurre (asistencia).
2. **¿Qué pasa cuando el miembro llega a 0 créditos?** ¿Se cierra la suscripción
   (nuevo estado / `CANCELED`) o sigue viva hasta el fin de periodo?

## Decisiones

1. **El crédito se consume al reservar, no al pasar la clase.**
   - `addUserToSchedule` descuenta 1 crédito en el momento de la inscripción,
     tanto si se apunta el propio miembro como si lo apunta un admin/coach. Con 0
     créditos la inscripción se rechaza (`NO_SESSION_CREDITS`).
   - Entrar en **waitlist** no consume: exige ≥ 1 crédito disponible y el crédito
     se descuenta al promocionar (mismo UPDATE condicional atómico). Un
     candidato sin créditos se salta **y sale de la waitlist** (igual que quien
     ha alcanzado sus límites de reserva); se prueba con el siguiente y, si nadie
     puede, la plaza queda libre. Si luego recupera créditos, vuelve a apuntarse.
   - **Reembolso** (`creditsUsed − 1`, nunca por debajo de 0): si el miembro se
     desapunta antes de `startDate`, o si el gym cancela el schedule (cambio a
     `CANCELLED`, borrado con inscritos o cut-off automático) — **incluso si la
     clase ya pasó**. Borrar un schedule con inscritos ya no se rechaza: es una
     cancelación más (reembolsa y notifica). No se reembolsa si la suscripción
     ya está cerrada (`CANCELED` o periodo vencido). Reactivar un schedule
     cancelado (`CANCELLED → AVAILABLE`) no vuelve a consumir.
   - Un **no-show** no reembolsa: el crédito se pierde solo por decisión del
     propio miembro.
   - El descuento se hace con un UPDATE condicional atómico
     (`credits_used < credits_total`) para que dos reservas simultáneas con el
     último crédito nunca prosperen ambas.

2. **Llegar a 0 créditos NO cierra la suscripción.**
   - La suscripción sigue `ACTIVE` hasta `currentPeriodEnd`; el CRON de billing
     la pasa a `CANCELED` al vencer, exactamente igual que cualquier suscripción
     con `cancelAtPeriodEnd = true` (los packs nacen siempre con ese flag y nunca
     se auto-renuevan).
   - No se añade ningún valor a `subscriptionState` ni cambia el banner de la
     app: `hasActive` sigue siendo la única puerta de acceso. Solo se bloquean
     las **nuevas** reservas; el miembro conserva schedules ya reservados,
     tareas de entrenamiento, pesos, etc.
   - El fin del bono se comunica exponiendo `remainingCredits` (en
     `Subscription` y en el auth payload de login / getMe), no con un estado.

3. **Los créditos son un snapshot.** Editar `Plan.sessionCount` no altera los
   packs ya vendidos. `changePlan` rechaza cualquier cambio hacia o desde un pack:
   no existe prorrateo con sentido entre días y créditos. Tampoco se puede
   `reactivateSubscription` un pack cerrado (abriría un periodo nuevo sin
   créditos nuevos y renovable). La ruta en ambos casos es cancelación diferida
   + Suscripción Futura / suscripción nueva con el pack (ADR 0002 / 0003).

## Consecuencias

- El contador es **predecible para el miembro**: siempre sabe cuántos créditos le
  quedan en el momento de reservar, sin depender de un proceso posterior de
  asistencia que hoy no existe (no hay tracking de no-show).
- El gym nunca cobra un crédito por sus propios fallos (cancelación tras la
  clase ⇒ reembolso), y el miembro nunca gana créditos por no acudir.
- Se respeta el invariante de ADR 0003: la única ruta viva a `CANCELED` para un
  pack es el CRON al fin de periodo. Agotar créditos nunca transiciona estado.
- Contrato GraphQL aditivo y nullable (`Plan.sessionCount`,
  `Subscription.creditsTotal / creditsUsed / remainingCredits`,
  `User.subscription.remainingCredits`): los fronts pueden regenerar tipos cuando
  adopten la feature sin que nada rompa antes.

## Trade-off

Consumir al reservar penaliza al miembro que reserva y no acude (pierde el
crédito) y exige reembolsar explícitamente en cada ruta de cancelación del gym.
La alternativa (consumir al pasar la clase) habría requerido tracking de
asistencia y dejaría al miembro sin saber cuántos créditos "reales" le quedan
mientras tiene reservas pendientes. Se prefirió la regla simple y equivalente a
un bono físico.

Mantener la suscripción viva a 0 créditos implica que `hasActive = true` no
significa "puede reservar"; los consumidores deben mirar `remainingCredits` para
ese caso. Se aceptó para no introducir un nuevo estado de acceso ni cambiar el
banner ya entendido por los miembros.
