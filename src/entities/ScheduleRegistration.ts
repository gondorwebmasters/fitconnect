import { Entity, ManyToOne, PrimaryKeyProp } from '@mikro-orm/core';

import { Schedule } from './Schedule';
import { Subscription } from './Subscription';
import { User } from './User';

/**
 * Una **reserva**: la fila que dice que este miembro ocupa una plaza de este
 * schedule, y **qué suscripción la pagó**.
 *
 * @remarks Es la tabla pivote de siempre (`user_schedules`), ahora con nombre y
 * con una columna más. No es una tabla nueva a propósito: la suscripción que
 * pagó tiene que aparecer y desaparecer **con** la reserva, y cualquier tabla
 * aparte podría quedarse desincronizada con la pertenencia. `schedule.users` y
 * `user.schedules` se siguen usando igual; MikroORM inserta y borra estas filas
 * al añadir y quitar de la colección.
 *
 * `paidBySubscription` es **nullable** por dos motivos distintos: las reservas
 * anteriores a #21 no lo tienen —y por eso la migración exige que ninguna
 * suscripción tuviera créditos: sin packs, ninguna reserva vieja pagó nada que
 * reembolsar— y un miembro sin suscripción vigente puede tener plaza (un admin,
 * un coach) sin que nadie haya pagado.
 *
 * Quién paga lo decide `selectPayingSubscription`; esto solo lo recuerda, para
 * que el reembolso devuelva el crédito a la misma suscripción que lo gastó en
 * vez de re-derivarla (ADR 0006, decisión 6).
 */
@Entity({ tableName: 'user_schedules' })
export class ScheduleRegistration {
  [PrimaryKeyProp]?: ['user', 'schedule'];

  @ManyToOne(() => User, { primary: true, deleteRule: 'cascade' })
  user!: User;

  @ManyToOne(() => Schedule, { primary: true, deleteRule: 'cascade' })
  schedule!: Schedule;

  /**
   * La suscripción que abrió la puerta y a la que se cargó el **Session
   * Credit**, si hubo alguna. `set null` al borrarla: la plaza sobrevive a la
   * suscripción, y no queda crédito que devolver a una fila que ya no existe.
   */
  @ManyToOne(() => Subscription, {
    nullable: true,
    deleteRule: 'set null',
  })
  paidBySubscription?: Subscription | null;
}
