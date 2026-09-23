# 0005-plan-restriction-evaluated-at-booking

## Contexto

Un gimnasio vende varios `Plan`, pero todo `Schedule` está abierto a todo el
mundo: no hay forma de decir "esta clase es solo para Premium". Con el
**Restricted Schedule (Horario Restringido)** un schedule puede nombrar un
conjunto de planes (`Schedule.allowedPlans`, N:M; vacío ⇒ abierto) y solo admite
a quien tenga una suscripción a uno de ellos. Hacía falta fijar cuatro
decisiones antes de escribir nada:

1. **¿Cuándo se evalúa la regla?** ¿Al reservar, o también después (barrido que
   expulse a quien pierda el plan)?
2. **¿Contra qué suscripción?** ¿La vigente *ahora*, o la que estará vigente el
   día de la clase (una **Suscripción Futura** al plan admitido)?
3. **¿A quién se aplica?** ¿Hay bypass para admin o coach?
4. **¿Dónde vive la regla?** ¿La recalcula la app, o la expone el back?

## Decisiones

1. **La restricción se evalúa solo al inscribirse; nunca revoca una plaza.**
   - `addUserToSchedule` rechaza al llamante cuyo plan no admite el schedule con
     `PLAN_NOT_ALLOWED_IN_SCHEDULE`, un error de validación **nuevo y distinto**
     de aforo, límites de reserva y créditos.
   - No hay desalojo retroactivo: ni al añadir un administrador la restricción a
     un schedule que ya tiene gente, ni al caducar o cambiar de plan el miembro
     antes de la clase. No hay barrido, ni notificación de expulsión, ni
     devolución de crédito por pérdida de elegibilidad. El administrador saca a
     mano al miembro no elegible con `removeUserFromSchedule`, que ya acepta un
     `userId` de destino.

2. **Se mira la suscripción vigente *ahora*, no la del día de la clase.**
   Una **Suscripción Futura** a un plan admitido **no** habilita: daría una
   plaza que depende de un futuro que puede no ocurrir (el miembro cancela, el
   cobro falla), y la alternativa —conceder la plaza y revocarla después—
   contradice la decisión 1. El miembro recibe un "no" claro hoy en vez de una
   plaza en la que no puede confiar.

3. **Se aplica a todos los roles: no hay bypass de admin ni de coach.**
   Se sigue de que la inscripción es autoservicio (`addUserToSchedule` recibe un
   schedule, nunca un usuario de destino): quien se inscribe es siempre el
   llamante, así que "admin" aquí significa "un admin apuntándose a sí mismo".
   Misma regla que el Session Credit de ADR 0004.

4. **El gate va ordenado *detrás* de aforo, límites de reserva y ventana de
   reserva anticipada** (y, cuando exista, del crédito). El miembro debe oír el
   motivo que de verdad aplica: si la clase está llena, el desenlace sigue
   siendo el aforo (lista de espera); si le faltan créditos y *sí* tiene el plan
   correcto, el mensaje debe decirle que compre créditos, no que se cambie de
   plan. Por eso la comprobación vive en la rama de inscripción efectiva, no
   antes de decidir aforo.

5. **La regla vive en el back, y el back la expone ya evaluada.**
   `Schedule.planAccess` es un campo derivado **por llamante**
   (`{ canRegister, reason, requiredPlans }`) que la app consume en vez de
   comparar planes por su cuenta. Su alcance es **solo** esta restricción: no
   absorbe aforo, créditos ni ventana de reserva, o se convertiría en un cajón
   de sastre. El backoffice consume además `allowedPlans` en crudo para
   renderizar y editar la restricción.

6. **Archivar un plan no desata la restricción.** `archivePlan` sigue
   archivando y **no** se desengancha de ningún schedule; solo informa a cuántos
   schedules afecta para que el backoffice avise antes de confirmar. Nunca se
   bloquea el archivado: quien tenga una suscripción viva conserva el acceso
   hasta que caduque y la clase queda cerrada de hecho. Reabrir en silencio una
   clase restringida a propósito es justo el fallo que se evita.

## Consecuencias

- **Ningún gimnasio nota nada hasta que alguien restringe algo**: la colección
  vacía es "abierto", que es lo que son y siguen siendo todos los schedules
  existentes. La migración es aditiva y el contrato GraphQL también.
- La regla tiene **una sola implementación** (`ScheduleService`), consumida por
  la app vía `planAccess`. `Schedule.age` es el contraejemplo de esta casa: un
  campo que ambos fronts seleccionan y nadie valida ni pinta.
- **Tenancy**: un schedule solo puede referenciar planes de su propia empresa.
  La ruta de escritura lo garantiza con el filtro `companyContext` (un plan de
  otra empresa no aparece y la operación se rechaza) y la migración lo ancla
  además con un trigger en el pivote.
- El campo derivado es **por usuario**, así que no es cacheable entre usuarios.
  Para no pagar un N+1 en el calendario, `allowedPlans` se precarga por
  select-in en las queries de lista y la suscripción vigente del llamante se
  resuelve una sola vez por petición.

## Hueco conocido mientras la entrega está a medias

La regla se aplica hoy **solo en la inscripción efectiva**. La **Waitlist** aún
no la comprueba (ni al apuntarse ni al promocionar): es trabajo del issue #11.
Hasta que ese issue aterrice, un miembro no elegible que encuentre la clase
**llena** entra en lista de espera y puede acabar promocionado a una plaza. Es
consecuencia deliberada del orden de la decisión 4 —el aforo no se tapa— y del
recorte de alcance, no un descuido.

Del mismo modo, la restricción sobre la **plantilla semanal**
(`ScheduleProgrammed`) es del issue #12: pedir planes al crear un schedule con
`repeat: true` se **rechaza** en vez de aceptarse y tirarse en silencio, que le
haría creer al administrador que ha restringido la clase.

## Trade-off

Evaluar solo al reservar deja un hueco conocido: un miembro puede asistir a una
clase que reservó legítimamente y para la que ya no cumple. Se acepta a
conciencia — el gimnasio conserva el control manual — porque la alternativa
(expulsar) le quita al miembro algo que ya tenía por un cambio administrativo, y
eso es peor que la incoherencia puntual.

Mirar la suscripción vigente *ahora* y no la del día de la clase rechaza a un
miembro que, el día de la clase, sí tendrá el plan admitido. Es deliberado: es
preferible un "no" fiable hoy a una plaza revocable, que la decisión 1 prohíbe.
