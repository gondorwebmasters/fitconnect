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
      this.tenancyAwareFindOptions(companyId, options)
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
      this.tenancyAwareFindOptions(companyId, options)
    );
  }

  /**
   * Vigente = `ACTIVE`/`TRIALING` con el periodo pagado en curso ahora mismo.
   *
   * @remarks El predicado vive aquí y no en cada lectura para que la singular y
   * la plural no puedan divergir.
   *
   * @param userId - Miembro cuyo Entitlement se consulta.
   * @param companyId - Empresa, si hay alguna en scope; sin ella no se filtra.
   * @returns El `where` de la consulta.
   */
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

  /**
   * Las opciones de la consulta: el `populate` del llamante más la decisión de
   * tenencia.
   *
   * @remarks Con empresa explícita se salta el filtro `companyContext`
   * (`filters: false`) para no depender del header de la request; sin empresa se
   * deja actuar al filtro.
   *
   * @param companyId - Empresa, si hay alguna en scope.
   * @param options - Opciones del llamante, de las que solo se lee `populate`.
   * @returns Las opciones de `findOne`/`find`.
   */
  private tenancyAwareFindOptions(
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
 * La suscripción del **Entitlement** que **paga** una reserva: la que abre la
 * puerta del schedule (ADR 0006, decisiones 5 y 6).
 *
 * @remarks Dos preguntas en una sola respuesta, porque son la misma: quién
 * admite al miembro en este schedule y a quién se le carga el **Session
 * Credit**. Separarlas fue el error que arregla #21 — re-derivar la
 * suscripción al reembolsar devuelve el crédito a otra en cuanto hay más de
 * una vigente.
 *
 * Candidata es la que está ella misma en `ACTIVE`/`TRIALING` —una `PAST_DUE` no
 * abre ninguna puerta aunque el miembro conserve acceso general por otra— y
 * cuyo plan admite el schedule. `requiredPlans` vacío ⇒ **Restricted Schedule**
 * sin restricción: admiten todas, que es el caso de todo schedule preexistente.
 *
 * Entre varias candidatas **gana la ilimitada**: nunca se gasta un crédito en
 * una clase a la que otra suscripción vigente ya da derecho gratis, que es
 * exactamente el cobro que un miembro leería como un error de facturación. Solo
 * si ninguna lo es se cobra a un **Session Pack**, y entre packs al que **antes
 * caduca**, para no dejar créditos varados en uno que expira mientras se gastan
 * los de otro que dura más. El desempate final por `id` no describe ninguna
 * regla de negocio: solo impide que el orden en que llegue el conjunto decida.
 *
 * Un pack **sin créditos** sigue siendo candidata cuando no hay ninguna otra:
 * la reserva debe fallar con `NO_SESSION_CREDITS`, no colarse gratis.
 *
 * @param entitlement - Suscripciones vigentes del miembro.
 * @param requiredPlans - Planes que admite el schedule; vacío ⇒ sin restricción.
 * @returns La suscripción que abre la puerta y paga, o `null` si ninguna.
 */
export function selectPayingSubscription(
  entitlement: Subscription[],
  requiredPlans: Plan[]
): Subscription | null {
  const candidates = entitlement.filter(
    subscription =>
      opensDoors(subscription) && admitsSchedule(subscription, requiredPlans)
  );

  return candidates.reduce<Subscription | null>(
    (payer, candidate) =>
      payer === null || paysBefore(candidate, payer) ? candidate : payer,
    null
  );
}

/**
 * ¿Admite esta suscripción el schedule? Sin planes exigidos, todas; con ellos,
 * solo la suscrita a alguno.
 */
function admitsSchedule(
  subscription: Subscription,
  requiredPlans: Plan[]
): boolean {
  return (
    requiredPlans.length === 0 ||
    requiredPlans.some(
      plan => plan.id === (subscription.plan as Plan | undefined)?.id
    )
  );
}

/** ¿Debe pagar `candidate` en lugar de `payer`? Ver {@link selectPayingSubscription}. */
function paysBefore(candidate: Subscription, payer: Subscription): boolean {
  if (isUnlimited(candidate) !== isUnlimited(payer)) {
    return isUnlimited(candidate);
  }

  if (hasCreditLeft(candidate) !== hasCreditLeft(payer)) {
    return hasCreditLeft(candidate);
  }

  const byExpiry = expiresAtMs(candidate) - expiresAtMs(payer);
  if (byExpiry !== 0) return byExpiry < 0;

  return candidate.id < payer.id;
}

/** ¿Le queda al menos un crédito? Ilimitada ⇒ siempre. */
function hasCreditLeft(subscription: Subscription): boolean {
  if (isUnlimited(subscription)) {
    return true;
  }

  return (subscription.creditsUsed ?? 0) < (subscription.creditsTotal ?? 0);
}

/**
 * Cuándo se acaba esta suscripción, en milisegundos, para ordenar **cuál se
 * gasta antes**. Mismo fin de periodo que {@link periodEndOf} — también el de
 * prueba, porque un bono en prueba caduca igual.
 *
 * @remarks El vacío va a `+Infinity`, al revés que en `periodEndMs`, y la
 * diferencia es intencionada: allí se busca la que dura **más** y una sin fecha
 * no puede ganar; aquí la que se acaba **antes**, y una sin fecha no puede
 * gastarse la primera. Misma fecha, dos órdenes distintos.
 */
function expiresAtMs(subscription: Subscription): number {
  const end = periodEndOf(subscription);
  return end ? moment(end).valueOf() : Infinity;
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

/**
 * La suscripción del Entitlement que reportan los **escalares deprecados** del
 * payload de auth (`planName`, `status`, `endDate`, `cancelAtPeriodEnd`,
 * `remainingCredits`, `creditsTotal`) y el campo singular de
 * `getActiveSubscription` — issue #20, ADR 0006.
 *
 * @remarks Gana la vigente **ilimitada**; en empate, o si ninguna lo es, la de
 * `currentPeriodEnd` más lejano. La regla existe por **estabilidad**: comprar un
 * Session Pack no puede cambiar lo que muestra una app antigua que solo sabe
 * leer el singular. El desempate final por `id` no describe ninguna regla de
 * negocio: solo impide que el orden en que llegue el conjunto decida.
 *
 * Los escalares son una vista degradada y no deben usarse para decidir nada: la
 * verdad es el conjunto. Un `remainingCredits` global no significa nada cuando
 * el miembro sostiene dos Session Packs.
 *
 * @param entitlement - Suscripciones vigentes del miembro.
 * @returns La suscripción a reportar, o `null` si el Entitlement está vacío.
 */
export function selectReportedSubscription(
  entitlement: Subscription[]
): Subscription | null {
  return entitlement.reduce<Subscription | null>(
    (reported, candidate) =>
      reported === null || outranks(candidate, reported) ? candidate : reported,
    null
  );
}

/** ¿Debe `candidate` desplazar a `reported` como suscripción reportada? */
function outranks(candidate: Subscription, reported: Subscription): boolean {
  if (isUnlimited(candidate) !== isUnlimited(reported)) {
    return isUnlimited(candidate);
  }

  const byPeriodEnd = periodEndMs(candidate) - periodEndMs(reported);
  if (byPeriodEnd !== 0) return byPeriodEnd > 0;

  return candidate.id < reported.id;
}

/** Ilimitada = sin snapshot de créditos (plan temporal, no Session Pack). */
function isUnlimited(subscription: Subscription): boolean {
  return (
    subscription.creditsTotal === null ||
    subscription.creditsTotal === undefined
  );
}

/**
 * Hasta cuándo cubre una suscripción: el fin del periodo pagado y, si no lo
 * hay, el fin del trial.
 *
 * @remarks Vive aquí, junto a la regla que lo usa para ordenar, porque el
 * payload de auth reporta exactamente la misma fecha: una sola definición de
 * "hasta cuándo" para que el `endDate` que ve el front y el desempate de
 * {@link selectReportedSubscription} no puedan divergir.
 *
 * @param subscription - Suscripción a fechar.
 * @returns El fin de la cobertura, o `null` si no tiene ninguna fecha.
 */
export function periodEndOf(subscription: Subscription): Date | null {
  return subscription.currentPeriodEnd ?? subscription.trialEnd ?? null;
}

/**
 * Fin del periodo en milisegundos; `-Infinity` si no hay ninguno, de modo que
 * una suscripción sin fecha queda por detrás de cualquiera que la tenga.
 */
function periodEndMs(subscription: Subscription): number {
  const end = periodEndOf(subscription);
  return end ? moment(end).valueOf() : -Infinity;
}
