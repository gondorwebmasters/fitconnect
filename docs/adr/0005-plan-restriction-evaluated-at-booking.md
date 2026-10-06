# 0005-plan-restriction-evaluated-at-booking

## Contexto

Un **Schedule** puede restringirse a un conjunto de **Plans** (`allowedPlans`):
solo los miembros suscritos a uno de ellos pueden apuntarse. Conjunto vacío ⇒
horario abierto (ver CONTEXT.md → Restricted Schedule).

Una restricción de acceso que depende de la suscripción del miembro plantea una
pregunta que no tiene respuesta obvia: **la elegibilidad es un hecho que cambia
en el tiempo**, y una reserva vive entre el momento en que se hace y el momento
en que la clase ocurre. Entre medias pueden pasar cosas:

1. El administrador restringe a *Premium* un horario donde ya hay 8 inscritos,
   3 de ellos con plan *Básico*.
2. Un miembro reserva con *Premium* y su suscripción caduca —o arranca una
   **Suscripción Futura** a *Básico*— antes de que la clase se celebre.
3. El gimnasio archiva el *Plan* que varios horarios exigen.

Había que fijar **cuándo se evalúa la restricción** y **qué pasa con las
reservas ya hechas** cuando la respuesta cambia.

## Decisiones

1. **La restricción se evalúa solo en el momento de reservar**, contra la
   suscripción **viva en ese instante** (`hasActive`), no contra la que estará
   viva el día de la clase.
   - Una **Suscripción Futura** al plan exigido no habilita, aunque vaya a haber
     empezado cuando la clase ocurra.
   - En **waitlist** se comprueba dos veces: al entrar y al promocionar. Quien
     ya no cumple al promocionar se salta **y sale de esa waitlist**; se prueba
     con el siguiente y, si nadie puede, la plaza queda libre. Es literalmente
     la misma mecánica que la de créditos agotados (ADR 0004).

2. **Una reserva hecha es firme. No hay expulsión retroactiva.**
   - Restringir un horario a posteriori no echa a los ya inscritos.
   - Perder el plan exigido después de reservar no echa de la clase reservada.
   - Solo se bloquean las reservas **nuevas**. Quien deba salir, lo saca el
     administrador a mano, con la ruta que ya existe
     (`removeUserFromSchedule`, que sí acepta `userId`).

3. **Sin excepciones por rol.** La restricción aplica igual a miembros, coaches
   y administradores. Un admin que se apunta a una clase *Premium* sin *Premium*
   vivo es rechazado.

4. **Archivar un Plan exigido por horarios está permitido**, avisando al
   administrador de cuántos horarios lo referencian. El horario queda cerrado de
   facto. La restricción **nunca se retira automáticamente**.

## Consecuencias

- El gate es una comprobación local y barata dentro de `addUserToSchedule`: una
  sola pregunta sobre el *ahora*, sin proyectar el estado de la suscripción a una
  fecha futura. No hace falta ningún proceso de barrido, ni notificaciones de
  expulsión, ni devolución de créditos por pérdida de elegibilidad.
- La invariante es la misma que ya rige los créditos (ADR 0004) y la cancelación
  diferida (ADR 0003): **perder derecho no revoca lo ya concedido**. Las tres
  reglas se explican con una sola frase, que es lo que hace el sistema
  aprendible.
- Un lector futuro encontrará miembros dentro de clases para las que hoy no
  califican. **Eso es correcto por diseño**, no un bug de datos.
- `hasActive = true` sigue sin significar "puede reservar": ya había que mirar
  créditos, y ahora también el plan. La app no reimplementa la regla — la
  consume del campo derivado que expone el back.

## Trade-off

**Evaluar al reservar** es injusto en un caso concreto: el miembro que va a tener
*Premium* la semana que viene no puede reservar hoy la clase de la semana que
viene. Se aceptó porque la alternativa —evaluar contra la fecha de la clase—
obliga a preguntar por el estado de la suscripción en un momento futuro, que es
una predicción y no un hecho: una cancelación posterior dejaría reservas huérfanas
y volvería a plantear la pregunta de la expulsión, ahora sin escapatoria.

**No expulsar** significa que un horario restringido puede contener miembros no
elegibles durante toda la vida de sus reservas. Se aceptó porque la alternativa
—expulsión retroactiva— exige barrido periódico, notificaciones, devolución de
créditos y una decisión sobre qué pasa con las clases que empiezan en una hora;
mucha maquinaria, y con consecuencias visibles y desagradables para el miembro,
por un caso que el administrador resuelve a mano en dos clics.

**Permitir archivar el plan** deja horarios inalcanzables que nadie ha marcado
como cerrados. Se prefirió a las dos alternativas: bloquear el archivado somete
al administrador a una decisión que quizá es intencionada (los suscriptores vivos
siguen entrando hasta que caduquen), y retirar la restricción automáticamente
abre en silencio una clase que alguien restringió a propósito — el peor de los
tres fallos, porque no deja rastro.
