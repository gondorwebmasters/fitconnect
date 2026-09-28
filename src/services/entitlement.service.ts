import { EntityManager } from '@mikro-orm/core';
import moment from 'moment';

import { Subscription, SubscriptionStatus } from '../entities/Subscription';

import { BaseService } from './base.service';

/** Opciones de una consulta de Entitlement. */
export interface FindLiveSubscriptionOptions {
  /**
   * `EntityManager` a usar. Por defecto el del servicio; los llamantes que
   * consultan dentro de una transacción pasan aquí el transaccional para ver
   * sus propias escrituras (p. ej. el consumo de un Session Credit).
   */
  em?: EntityManager;
  /**
   * Relaciones a popular. Vacío por defecto: quien solo compara ids no paga
   * el coste de traer el plan y sus permisos.
   */
  populate?: string[];
}

/**
 * El **único** dueño de la pregunta "¿qué suscripciones de este miembro están
 * vigentes ahora mismo en esta empresa?" — su **Entitlement** (ver CONTEXT.md
 * y ADR 0006).
 *
 * @remarks Hoy responde con **una sola** suscripción, exactamente como hacían
 * las dos consultas duplicadas que reemplaza (`PermissionService` y
 * `ScheduleService`). Existe para que la regla viva en un sitio: cuando el
 * Entitlement pase a ser un conjunto de verdad, cambia aquí y no en dos sitios.
 */
export class EntitlementService extends BaseService {
  constructor(em: EntityManager) {
    super(em);
  }

  /**
   * La suscripción vigente ahora mismo del miembro: `ACTIVE`/`TRIALING` con el
   * periodo pagado en curso.
   *
   * @remarks Tenencia: con `companyId` explícito se salta el filtro
   * `companyContext` (`filters: false`) para no depender del header de la
   * request; sin empresa en contexto no se filtra por `company` y se deja
   * actuar al filtro.
   *
   * @param userId - Miembro cuyo Entitlement se consulta.
   * @param companyId - Empresa en la que se consulta, si hay alguna en scope.
   * @param options - `EntityManager` y `populate` del llamante.
   * @returns La suscripción vigente, o `null`.
   */
  public async findLiveSubscription(
    userId: string,
    companyId?: string,
    options: FindLiveSubscriptionOptions = {}
  ): Promise<Subscription | null> {
    const { em = this.em, populate } = options;
    const now = moment().toDate();

    return em.findOne(
      Subscription,
      {
        user: userId,
        ...(companyId ? { company: companyId } : {}),
        status: {
          $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
        currentPeriodStart: { $lte: now },
        currentPeriodEnd: { $gte: now },
      },
      {
        ...(populate ? { populate: populate as any } : {}),
        ...(companyId ? { filters: false } : {}),
      }
    );
  }
}
