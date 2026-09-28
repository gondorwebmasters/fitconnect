import { EntityManager } from '@mikro-orm/core';
import moment from 'moment';

import { Plan } from '../entities/Plan';
import {
  Subscription,
  SubscriptionAccessState,
  SubscriptionStatus,
} from '../entities/Subscription';

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
 * @remarks El Entitlement es un **conjunto**: {@link findLiveSubscriptions} es
 * la respuesta completa y la que leen las reglas de acceso. La lectura
 * singular {@link findLiveSubscription} sigue existiendo para los caminos que
 * todavía cargan un solo crédito (ADR 0004); ambas comparten predicado, así
 * que no pueden divergir.
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
    const { em = this.em } = options;

    return em.findOne(
      Subscription,
      this.liveSubscriptionWhere(userId, companyId),
      this.findOptions(companyId, options)
    );
  }

  /**
   * El Entitlement completo: **todas** las suscripciones vigentes del miembro
   * en la empresa.
   *
   * @remarks Comparte predicado y semántica de tenencia con
   * {@link findLiveSubscription} — misma pregunta, respuesta plural. La unión de
   * permisos (ADR 0006, decisión 3) parte de aquí: ningún llamante que necesite
   * el conjunto debe escribir su propia consulta.
   *
   * Mientras nada permita al miembro sostener dos suscripciones vigentes
   * (issue #22), el conjunto tiene como máximo un elemento y el resultado es
   * indistinguible del de la consulta singular.
   *
   * @param userId - Miembro cuyo Entitlement se consulta.
   * @param companyId - Empresa en la que se consulta, si hay alguna en scope.
   * @param options - `EntityManager` y `populate` del llamante.
   * @returns Las suscripciones vigentes; vacío si el Entitlement está vacío.
   */
  public async findLiveSubscriptions(
    userId: string,
    companyId?: string,
    options: FindLiveSubscriptionOptions = {}
  ): Promise<Subscription[]> {
    const { em = this.em } = options;

    return em.find(
      Subscription,
      this.liveSubscriptionWhere(userId, companyId),
      this.findOptions(companyId, options)
    );
  }

  /** Vigente = `ACTIVE`/`TRIALING` con el periodo pagado en curso ahora mismo. */
  private liveSubscriptionWhere(userId: string, companyId?: string) {
    const now = moment().toDate();

    return {
      user: userId,
      ...(companyId ? { company: companyId } : {}),
      status: {
        $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
      },
      currentPeriodStart: { $lte: now },
      currentPeriodEnd: { $gte: now },
    };
  }

  /** `populate` del llamante + el bypass de tenencia cuando hay empresa. */
  private findOptions(
    companyId: string | undefined,
    options: FindLiveSubscriptionOptions
  ) {
    return {
      ...(options.populate ? { populate: options.populate as any } : {}),
      ...(companyId ? { filters: false } : {}),
    };
  }
}

/**
 * La suscripción del **Entitlement** que abre la puerta de un **Restricted
 * Schedule**: alguna cuyo plan esté entre los admitidos **y** que ella misma
 * esté en `ACTIVE`/`TRIALING` (ADR 0006, decisión 5). Una `PAST_DUE` no abre
 * ninguna puerta aunque el miembro conserve acceso general por otra.
 *
 * @remarks Devuelve la suscripción y no un booleano porque es la que pagará el
 * **Session Credit** (ADR 0004). Cuando varias califiquen habrá que elegir
 * —gana la ilimitada—, pero eso es trabajo de #21; aquí vale la primera,
 * porque nada permite todavía sostener dos vigentes a la vez.
 *
 * @param entitlement - Suscripciones vigentes del miembro.
 * @param requiredPlans - Planes que admite el schedule.
 * @returns La suscripción que admite el schedule, o `null` si ninguna.
 */
export function findAdmittingSubscription(
  entitlement: Subscription[],
  requiredPlans: Plan[]
): Subscription | null {
  return (
    entitlement.find(
      subscription =>
        opensDoors(subscription) &&
        requiredPlans.some(
          plan => plan.id === (subscription.plan as Plan | undefined)?.id
        )
    ) ?? null
  );
}

/** ¿Abre puertas esta suscripción por sí misma? Solo `ACTIVE`/`TRIALING`. */
function opensDoors(subscription: Subscription): boolean {
  return (
    subscription.status === SubscriptionStatus.ACTIVE ||
    subscription.status === SubscriptionStatus.TRIALING
  );
}

/**
 * El `subscriptionState` del miembro, **agregado sobre todo su Entitlement**
 * con precedencia `ACTIVE > SCHEDULED > EXPIRED > NONE` (ADR 0006, decisión 10).
 *
 * @remarks `ACTIVE` gana a todo lo demás: un miembro vigente en un plan y
 * caducado en otro lee `ACTIVE`. El resto de la precedencia
 * (`SCHEDULED > EXPIRED > NONE`) la resuelve quien mira las suscripciones **no**
 * vigentes, y llega aquí ya decidida en `whenEmpty`.
 *
 * @param entitlement - Suscripciones vigentes del miembro.
 * @param whenEmpty - Estado a reportar si el Entitlement está vacío.
 * @returns El estado de acceso agregado.
 */
export function aggregateSubscriptionState(
  entitlement: Subscription[],
  whenEmpty: SubscriptionAccessState
): SubscriptionAccessState {
  return entitlement.length > 0 ? SubscriptionAccessState.ACTIVE : whenEmpty;
}
