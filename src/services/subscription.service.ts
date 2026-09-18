import { EntityManager, QueryOrder } from '@mikro-orm/core';
import moment from 'moment';

import { Customer } from '../entities/Customer';
import { Invoice } from '../entities/Invoice';
import { PaymentMethod, PaymentMethodStatus } from '../entities/PaymentMethod';
import { Plan, PlanInterval } from '../entities/Plan';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';
import { User } from '../entities/User';
import {
  CurrentUser,
  EmailConfig,
  ServiceResponse,
} from '../types/common.type';
import {
  BadRequestError,
  ConflictError,
  createServiceResponse,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  BAD_REQUEST_ERRORS,
  CONFLICT_ERRORS,
  INTERNAL_ERRORS,
  UnauthorizedError,
} from '../utils/errors.util';
import { sendSubscriptionExpiryWarning } from '../utils/templates.util';

import { BaseService } from './base.service';
import { CustomerService } from './customer.service';
import { EmailService } from './email.service';
import { InvoiceService } from './invoice.service';
import { NotificationService } from './notification.service';
import { PaymentProcessor } from './payment-processor.interface';
import { TransactionService } from './transaction.service';

// ─────────────────────────────────────────────
// TIPOS DE ENTRADA
// ─────────────────────────────────────────────

interface CreateSubscriptionInput {
  userId: string;
  planId: string;
  paymentMethodId?: string;
  trialPeriodDays?: number;
  quantity?: number;
  metadata?: Record<string, any>;
  companyId: string;
  startDate?: string | Date;
}

interface UpdateSubscriptionInput {
  subscriptionId: string;
  planId?: string;
  quantity?: number;
  paymentMethodId?: string;
  metadata?: Record<string, any>;
}

interface CancelSubscriptionInput {
  subscriptionId: string;
  cancelAtPeriodEnd?: boolean;
  cancellationReason?: string;
}

interface RadicalCancelSubscriptionInput {
  subscriptionId: string;
  reason: string;
}

/**
 * Input para el cambio de plan con prorrateo.
 * upgrade = cobra la diferencia ahora.
 * downgrade = acredita los días restantes al siguiente período.
 */
interface ChangePlanInput {
  subscriptionId: string;
  newPlanId: string;
  /** Si true cobra/acredita la diferencia proporcional de inmediato */
  prorate?: boolean;
}

/**
 * Input para operaciones administrativas sobre una suscripción.
 */
interface AdminOverrideInput {
  subscriptionId: string;
  /** Nuevo estado a forzar */
  status?: SubscriptionStatus;
  /** Nueva fecha de fin de período (extiende o acorta el período actual) */
  currentPeriodEnd?: Date;
  /** Fecha del próximo cobro */
  nextBillingDate?: Date;
  /** Resetea el contador de intentos fallidos */
  resetFailedAttempts?: boolean;
  /** Razón del cambio (queda en metadata.admin_history) */
  reason: string;
  /** ID del admin que realiza la operación */
  adminId: string;
}

// ─────────────────────────────────────────────
// CONFIGURACIÓN DE DUNNING
// ─────────────────────────────────────────────

const DUNNING_CONFIG = {
  /** Número máximo de intentos antes de marcar como PAST_DUE */
  maxAttempts: 3,
  /** Días entre reintentos [intento 1, intento 2, intento 3] */
  retryIntervalDays: [3, 5, 7],
};

// ─────────────────────────────────────────────
// SERVICIO
// ─────────────────────────────────────────────

/**
 * SubscriptionService
 *
 * Gestiona el ciclo de vida completo de las suscripciones.
 *
 * EL FRONTEND SOLO LLAMA A createSubscription. El backend decide
 * automaticamente si eso significa crear desde cero o sustituir una suscripcion
 * activa de otro plan en la misma empresa (lo que coloquialmente es "cambiar
 * de plan"). Nunca deberian coexistir dos Subscription en estado ACTIVE o
 * TRIALING para la misma empresa y el mismo usuario - ver
 * findActiveAndFutureSubscriptions() para la regla que lo garantiza.
 */
export class SubscriptionService extends BaseService {
  private readonly customerService: CustomerService;
  private readonly invoiceService: InvoiceService;
  private readonly transactionService: TransactionService;
  private readonly emailService: EmailService;
  private readonly notificationService: NotificationService;

  constructor(em: EntityManager, paymentProcessor: PaymentProcessor) {
    super(em, paymentProcessor);
    this.customerService = new CustomerService(em);
    this.invoiceService = new InvoiceService(em);
    this.transactionService = new TransactionService(em, paymentProcessor);
    this.emailService = new EmailService();
    this.notificationService = new NotificationService(em);
  }

  // ═══════════════════════════════════════════
  // OPERACIONES DE USUARIO
  // ═══════════════════════════════════════════

  /**
   * Crea una suscripción nueva. Punto de entrada único desde el frontend.
   *
   * El backend decide automáticamente qué significa "crear" según el
   * estado actual del usuario respecto a la empresa del plan elegido:
   *
   *  1. Ya tiene una suscripción ACTIVE/TRIALING al MISMO plan
   *       → ConflictError. No tiene sentido volver a asignarle la misma
   *         suscripción que ya tiene activa.
   *
   *  2. Ya tiene una suscripción ACTIVE/TRIALING a OTRO plan de la misma
   *     empresa
   *       → esto es un cambio de plan. Se delega a executePlanChange()
   *         (el mismo núcleo que usa changePlan), que muta la suscripción
   *         existente y aplica prorrateo si corresponde. No se crea una
   *         entidad nueva.
   *
   *  3. Ninguno de los casos anteriores
   *       → se crea la suscripción desde cero.
   */
  public async createSubscription(
    input: CreateSubscriptionInput
  ): Promise<ServiceResponse> {
    this.validateCreateInput(input);

    const user = await this.getUserOrFail(input.userId);
    const plan = await this.getActivePlanOrFail(input.planId);
    this.validateStartDateForPlan(plan, input.startDate);

    // ────────────────────────────────────────────────────────────────
    // VERTIENTE 0: Suscripción Retroactiva (plan gratuito + inicio pasado)
    // ────────────────────────────────────────────────────────────────
    // Rama dedicada de cortocircuito: se salta el resto de la lógica
    // (futura / cambio de plan / reemplazo de cancelada) para que la fecha
    // de inicio retroactiva no pueda ser reescrita silenciosamente a hoy.
    if (this.isBackdatedFreeRequest(plan, input.startDate)) {
      return this.createBackdatedSubscription(user, plan, input);
    }

    // Obtener todas las suscripciones de la empresa en estado ACTIVE o TRIALING
    const companySubscriptions = await this.findActiveAndFutureSubscriptions(
      user,
      plan
    );

    // Clasificar las suscripciones en:
    // - currentActive: Suscripción que está activa/vigente hoy
    // - futureActive: Suscripción programada para empezar en el futuro
    const currentActive = companySubscriptions.find(
      s => !this.isUnusedFutureSubscription(s)
    );
    const futureActive = companySubscriptions.find(s =>
      this.isUnusedFutureSubscription(s)
    );

    // ────────────────────────────────────────────────────────────────
    // VERTIENTE 1: Ya existe una suscripción futura programada
    // ────────────────────────────────────────────────────────────────
    if (futureActive) {
      const startInput = input.startDate ? moment(input.startDate) : moment();
      const isFutureInput = startInput.isAfter(moment(), 'day');
      const isImmediatePlanChange = currentActive && !isFutureInput;

      if (!isImmediatePlanChange) {
        // Si el plan coincide, permitimos actualizar su fecha de inicio
        if (futureActive.plan.id === plan.id) {
          // Validamos que el nuevo inicio no colisione con el período de la suscripción actual en curso
          if (
            currentActive &&
            startInput.isBefore(moment(currentActive.currentPeriodEnd), 'day')
          ) {
            throw new ConflictError(
              CONFLICT_ERRORS.USER_ALREADY_ACTIVE_IN_PLAN
            );
          }
          await this.updateFutureSubscriptionDate(
            futureActive,
            plan,
            input.startDate
          );

          return createServiceResponse(
            200,
            'Subscription start date updated successfully',
            true,
            { subscription: futureActive }
          );
        }

        // No permitimos programar múltiples suscripciones futuras (evitamos solapamientos ilimitados)
        throw new ConflictError(
          CONFLICT_ERRORS.FUTURE_SUBSCRIPTION_ALREADY_SCHEDULED
        );
      }
    }

    // ────────────────────────────────────────────────────────────────
    // VERTIENTE 2: Existe una suscripción en curso actualmente
    // ────────────────────────────────────────────────────────────────
    if (currentActive) {
      if (input.startDate) {
        const start = moment(input.startDate);
        // CASO A: La fecha de inicio es posterior al período de la suscripción actual.
        // Se programa la futura y se marca la actual para no renovarse automáticamente.
        if (
          start.isSameOrAfter(moment(currentActive.currentPeriodEnd), 'day')
        ) {
          currentActive.cancelAtPeriodEnd = true;
          this.appendHistory(
            currentActive,
            'cancel_scheduled',
            'system',
            `Scheduled to cancel at period end due to future subscription starting on ${start.format('YYYY-MM-DD')}`
          );
          await this.em.flush();

          return this.createSubscriptionFromScratch(user, plan, input);
        } else {
          // CASO B: La fecha es en el futuro pero solapa con el período activo actual
          if (!start.isSame(moment(), 'day')) {
            if (currentActive.plan.id === plan.id) {
              throw new ConflictError(
                CONFLICT_ERRORS.USER_ALREADY_ACTIVE_IN_PLAN
              );
            }
            throw new BadRequestError(
              BAD_REQUEST_ERRORS.CANNOT_SCHEDULE_PLAN_CHANGE_IN_FUTURE
            );
          }
        }
      }

      // CASO C: Inicio hoy/inmediato. Se trata como cambio de plan normal de la suscripción activa
      return this.resolveExistingActiveSubscription(currentActive, plan, input);
    }

    // ────────────────────────────────────────────────────────────────
    // VERTIENTE 3: Ninguna suscripción activa ni futura — se crea desde cero.
    // ────────────────────────────────────────────────────────────────
    // (La antigua rama de "sustituir una cancelada con período pendiente" se
    // eliminó: con la cancelación diferida-por-defecto una suscripción CANCELED
    // nunca conserva un período vivo, así que era código muerto. Ver ADR 0003.)
    return this.createSubscriptionFromScratch(user, plan, input);
  }

  /**
   * Cambia el plan de una suscripción activa con prorrateo opcional.
   * Punto de entrada público — resuelve la suscripción por ID y delega
   * el trabajo real a executePlanChange().
   */
  public async changePlan(input: ChangePlanInput): Promise<ServiceResponse> {
    const { subscription, newPlan } =
      await this.resolveChangePlanTargets(input);

    return this.executePlanChange(subscription, newPlan, input.prorate);
  }

  /**
   * Actualiza método de pago, cantidad o metadata de una suscripción.
   * Para cambiar de plan usar changePlan() que gestiona el prorrateo.
   */
  public async updateSubscription(
    input: UpdateSubscriptionInput
  ): Promise<ServiceResponse> {
    if (!input.subscriptionId) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.SUBSCRIPTION_ID_REQUIRED);
    }

    const subscription = await this.em.findOne(
      Subscription,
      { id: input.subscriptionId },
      { populate: ['user', 'plan', 'customer', 'defaultPaymentMethod'] }
    );

    if (!subscription) throw new NotFoundError('Subscription');

    if (input.quantity !== undefined) {
      if (input.quantity <= 0) {
        throw new BadRequestError(
          BAD_REQUEST_ERRORS.QUANTITY_MUST_BE_GREATER_THAN_0
        );
      }
      subscription.quantity = input.quantity;
    }

    if (input.paymentMethodId) {
      subscription.defaultPaymentMethod = await this.getPaymentMethodOrFail(
        input.paymentMethodId,
        subscription.customer
      );
      this.appendHistory(
        subscription,
        'payment_method_updated',
        'user',
        'Payment method updated'
      );
    }

    if (input.metadata) {
      subscription.metadata = { ...subscription.metadata, ...input.metadata };
    }

    await this.em.flush();

    return createServiceResponse(
      200,
      'Subscription updated successfully',
      true,
      {
        subscription,
      }
    );
  }

  /**
   * Cancela una suscripción — SIEMPRE de forma diferida (al final del período
   * ya pagado). El miembro conserva el acceso durante el período que pagó; el
   * CRON de billing (processBillingCycle) es quien realiza la transición real a
   * CANCELED cuando currentPeriodEnd vence. No está restringido a admins: un
   * miembro puede cancelar su propia suscripción.
   *
   * El campo de entrada `cancelAtPeriodEnd` está OBSOLETO y se ignora en el
   * servidor: la cancelación es siempre diferida sea cual sea su valor. Se
   * mantiene en el esquema GraphQL para que el backoffice siga funcionando sin
   * cambios. La única ruta de terminación inmediata es la cancelación radical
   * de admin (radicalCancelSubscription). Ver ADR 0003.
   */
  public async cancelSubscription(
    input: CancelSubscriptionInput,
    requesterCompanyId?: string
  ): Promise<ServiceResponse> {
    if (!input.subscriptionId) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.SUBSCRIPTION_ID_REQUIRED);
    }

    const subscription = await this.em.findOne(
      Subscription,
      { id: input.subscriptionId },
      { populate: ['plan', 'user', 'customer', 'defaultPaymentMethod'] }
    );

    if (!subscription) throw new NotFoundError('Subscription');
    this.assertBelongsToCompany(subscription, requesterCompanyId);
    if (!subscription.isActive) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.SUBSCRIPTION_NOT_ACTIVE);
    }

    // Cancelación siempre diferida: status y currentPeriodEnd quedan intactos.
    subscription.cancelAtPeriodEnd = true;
    this.appendHistory(
      subscription,
      'cancel_scheduled',
      'user',
      `Cancellation scheduled at period end. Reason: ${input.cancellationReason ?? 'not specified'}`
    );

    if (input.cancellationReason) {
      subscription.metadata = {
        ...subscription.metadata,
        cancellation_reason: input.cancellationReason,
      };
    }

    await this.em.flush();

    return createServiceResponse(
      200,
      'Subscription cancellation scheduled at period end',
      true,
      {
        subscription,
      }
    );
  }

  /**
   * Cancelación RADICAL (inmediata) — única ruta de terminación instantánea,
   * reservada a administradores (gate de permisos en el resolver). Trunca el
   * período: el miembro pierde los días restantes. Requiere un motivo
   * obligatorio que queda en el audit log atribuido al admin.
   *
   * Deja la suscripción en un estado que satisface el invariante
   * "CANCELED ⇒ currentPeriodEnd <= now" por construcción. Ver ADR 0003.
   */
  public async radicalCancelSubscription(
    input: RadicalCancelSubscriptionInput,
    adminId: string,
    requesterCompanyId?: string
  ): Promise<ServiceResponse> {
    if (!input.subscriptionId) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.SUBSCRIPTION_ID_REQUIRED);
    }
    if (!input.reason) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.REASON_REQUIRED);
    }

    const subscription = await this.em.findOne(Subscription, {
      id: input.subscriptionId,
    });

    if (!subscription) throw new NotFoundError('Subscription');
    this.assertBelongsToCompany(subscription, requesterCompanyId);

    const now = new Date();
    this.applyCanceledTransition(subscription, now);
    // Trunca el período pagado: el invariante CANCELED ⇒ período terminado se
    // mantiene por construcción, y el miembro pierde los días restantes.
    subscription.currentPeriodEnd = now;
    subscription.cancelAtPeriodEnd = false;

    this.appendHistory(
      subscription,
      'radical_canceled',
      adminId,
      `[ADMIN] Immediate (radical) cancellation. Reason: ${input.reason}`
    );

    subscription.metadata = {
      ...subscription.metadata,
      cancellation_reason: input.reason,
    };

    await this.em.flush();

    return createServiceResponse(
      200,
      'Subscription cancelled immediately',
      true,
      {
        subscription,
      }
    );
  }

  /**
   * Pausa una suscripción activa.
   * El CRON no la tocará mientras esté en estado PAUSED.
   */
  public async pauseSubscription(
    subscriptionId: string,
    requesterCompanyId?: string
  ): Promise<ServiceResponse> {
    const subscription = await this.em.findOne(
      Subscription,
      { id: subscriptionId },
      { populate: ['plan', 'user', 'customer', 'defaultPaymentMethod'] }
    );

    if (!subscription) throw new NotFoundError('Subscription');
    this.assertBelongsToCompany(subscription, requesterCompanyId);
    if (!subscription.isActive) {
      throw new BadRequestError(
        BAD_REQUEST_ERRORS.ONLY_ACTIVE_SUBSCRIPTIONS_CAN_BE_PAUSED
      );
    }

    subscription.status = SubscriptionStatus.PAUSED;
    subscription.nextBillingDate = undefined;

    this.appendHistory(
      subscription,
      'paused',
      'user',
      'Subscription paused by user'
    );

    await this.em.flush();

    return createServiceResponse(
      200,
      'Subscription paused successfully',
      true,
      {
        subscription,
      }
    );
  }

  /**
   * Reanuda una suscripción pausada.
   * Recalcula nextBillingDate a partir de hoy y cobra inmediatamente
   * si el período actual ya ha vencido.
   */
  public async resumeSubscription(
    subscriptionId: string,
    requesterCompanyId?: string
  ): Promise<ServiceResponse> {
    const subscription = await this.em.findOne(
      Subscription,
      { id: subscriptionId },
      { populate: ['plan', 'user', 'customer', 'defaultPaymentMethod'] }
    );

    if (!subscription) throw new NotFoundError('Subscription');
    this.assertBelongsToCompany(subscription, requesterCompanyId);
    if (subscription.status !== SubscriptionStatus.PAUSED) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.SUBSCRIPTION_NOT_PAUSED);
    }

    const now = new Date();
    const isFree = subscription.plan.amount === 0;

    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = this.calculatePeriodEnd(
      now,
      subscription.plan
    );
    subscription.nextBillingDate = subscription.currentPeriodEnd;
    subscription.failedPaymentAttempts = 0;

    this.appendHistory(
      subscription,
      'resumed',
      'user',
      'Subscription resumed by user'
    );

    await this.em.flush();

    if (
      !isFree &&
      subscription.currentPeriodEnd &&
      subscription.currentPeriodEnd < now
    ) {
      await this.attemptCharge(subscription);
    }

    return createServiceResponse(
      200,
      'Subscription resumed successfully',
      true,
      {
        subscription,
      }
    );
  }

  /**
   * Reactiva una suscripción en estado PAST_DUE o CANCELED.
   *
   * Plan gratuito → ACTIVE directo, sin requerir método de pago.
   * PAST_DUE → intenta cobrar las facturas pendientes y vuelve a ACTIVE.
   * CANCELED → crea un período nuevo desde hoy e intenta cobrar.
   *
   * Requiere método de pago válido solo si el plan tiene coste.
   */
  public async reactivateSubscription(
    subscriptionId: string,
    requesterCompanyId?: string
  ): Promise<ServiceResponse> {
    const subscription = await this.em.findOne(
      Subscription,
      { id: subscriptionId },
      { populate: ['user', 'plan', 'customer', 'defaultPaymentMethod'] }
    );

    if (!subscription) throw new NotFoundError('Subscription');
    this.assertBelongsToCompany(subscription, requesterCompanyId);

    const reactivableStatuses = [
      SubscriptionStatus.PAST_DUE,
      SubscriptionStatus.CANCELED,
      SubscriptionStatus.UNPAID,
      SubscriptionStatus.INCOMPLETE_EXPIRED,
    ];

    if (!reactivableStatuses.includes(subscription.status)) {
      throw new BadRequestError(
        `Cannot reactivate a subscription in status "${subscription.status}". ` +
          `Only ${reactivableStatuses.join(', ')} subscriptions can be reactivated.`
      );
    }

    // Un Session Pack es de un solo uso: reactivarlo abriría un periodo nuevo
    // sin créditos nuevos y con cancelAtPeriodEnd = false (renovable). La
    // ruta correcta es una suscripción nueva con el pack.
    if (this.isSessionPack(subscription.plan)) {
      throw new BadRequestError(
        BAD_REQUEST_ERRORS.CANNOT_REACTIVATE_SESSION_PACK
      );
    }

    const isFree = subscription.plan.amount === 0;

    if (!isFree) {
      const pm =
        subscription.defaultPaymentMethod ??
        (await this.getDefaultPaymentMethod(subscription.customer));

      const isPaymentMethodReady =
        !!pm?.externalToken && pm?.status === PaymentMethodStatus.ACTIVE;
      if (!isPaymentMethodReady) {
        throw new BadRequestError(
          BAD_REQUEST_ERRORS.VALID_PM_REQUIRED_REACTIVATE
        );
      }

      subscription.defaultPaymentMethod ??= pm;
    }

    const now = new Date();
    subscription.status = isFree
      ? SubscriptionStatus.ACTIVE
      : SubscriptionStatus.INCOMPLETE;
    subscription.failedPaymentAttempts = 0;
    subscription.canceledAt = undefined;
    subscription.endedAt = undefined;
    subscription.cancelAtPeriodEnd = false;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = this.calculatePeriodEnd(
      now,
      subscription.plan
    );
    subscription.nextBillingDate = subscription.currentPeriodEnd;

    this.appendHistory(
      subscription,
      'reactivation_attempted',
      'user',
      isFree
        ? 'Free plan reactivated — no charge required'
        : 'User requested reactivation'
    );

    await this.em.flush();

    if (!isFree) {
      await this.attemptCharge(subscription);
      await this.em.refresh(subscription);
    }

    const success = subscription.status === SubscriptionStatus.ACTIVE;

    return createServiceResponse(
      success ? 200 : 402,
      success
        ? 'Subscription reactivated successfully'
        : 'Reactivation failed: payment could not be processed',
      success,
      { subscription }
    );
  }

  /**
   * Actualiza el método de pago de una suscripción PAST_DUE e intenta
   * cobrar las facturas pendientes de inmediato.
   */
  public async updatePaymentMethodAndRetry(
    subscriptionId: string,
    paymentMethodId: string,
    requesterCompanyId?: string
  ): Promise<ServiceResponse> {
    const subscription = await this.em.findOne(
      Subscription,
      { id: subscriptionId },
      { populate: ['user', 'plan', 'customer', 'defaultPaymentMethod'] }
    );

    if (!subscription) throw new NotFoundError('Subscription');
    this.assertBelongsToCompany(subscription, requesterCompanyId);

    const allowedStatuses = [
      SubscriptionStatus.PAST_DUE,
      SubscriptionStatus.UNPAID,
      SubscriptionStatus.INCOMPLETE,
    ];

    if (!allowedStatuses.includes(subscription.status)) {
      throw new BadRequestError(
        `This operation is only available for subscriptions in status: ${allowedStatuses.join(', ')}`
      );
    }

    subscription.defaultPaymentMethod = await this.getPaymentMethodOrFail(
      paymentMethodId,
      subscription.customer
    );
    subscription.failedPaymentAttempts = 0;

    this.appendHistory(
      subscription,
      'payment_method_updated',
      'user',
      'Payment method updated and immediate retry triggered'
    );

    await this.em.flush();

    await this.attemptCharge(subscription);
    await this.em.refresh(subscription);

    const success = subscription.status === SubscriptionStatus.ACTIVE;

    return createServiceResponse(
      success ? 200 : 402,
      success
        ? 'Payment method updated and subscription reactivated'
        : 'Payment method updated but charge still failed',
      success,
      { subscription }
    );
  }

  /**
   * Permite a un administrador forzar cambios en una suscripción.
   * Todos los cambios quedan registrados en el audit log (metadata.history).
   */
  public async adminOverride(
    input: AdminOverrideInput,
    requesterCompanyId?: string
  ): Promise<ServiceResponse> {
    if (!input.reason) {
      throw new BadRequestError(
        BAD_REQUEST_ERRORS.ADMIN_OVERRIDE_REASON_REQUIRED
      );
    }

    const subscription = await this.em.findOne(
      Subscription,
      { id: input.subscriptionId },
      { populate: ['plan', 'user'] }
    );

    if (!subscription) throw new NotFoundError('Subscription');
    this.assertBelongsToCompany(subscription, requesterCompanyId);

    const changes: string[] = [];

    if (input.status !== undefined && input.status !== subscription.status) {
      // adminOverride ya NO puede transicionar a CANCELED: consolidamos todas
      // las rutas hacia CANCELED en el CRON (diferida) y la cancelación radical
      // de admin, de modo que el invariante CANCELED ⇒ período terminado se
      // mantenga por construcción. Ver ADR 0003 y radicalCancelSubscription.
      if (input.status === SubscriptionStatus.CANCELED) {
        throw new BadRequestError(
          BAD_REQUEST_ERRORS.ADMIN_OVERRIDE_CANNOT_CANCEL
        );
      }

      const oldStatus = subscription.status;
      subscription.status = input.status;

      if (input.status === SubscriptionStatus.ACTIVE) {
        subscription.canceledAt = undefined;
        subscription.endedAt = undefined;
      }

      changes.push(`status: ${oldStatus} → ${input.status}`);
    }

    if (input.currentPeriodEnd !== undefined) {
      const old = subscription.currentPeriodEnd?.toISOString() ?? 'none';
      subscription.currentPeriodEnd = input.currentPeriodEnd;
      changes.push(
        `currentPeriodEnd: ${old} → ${input.currentPeriodEnd.toISOString()}`
      );
    }

    if (input.nextBillingDate !== undefined) {
      const old = subscription.nextBillingDate?.toISOString() ?? 'none';
      subscription.nextBillingDate = input.nextBillingDate;
      changes.push(
        `nextBillingDate: ${old} → ${input.nextBillingDate.toISOString()}`
      );
    }

    if (input.resetFailedAttempts) {
      changes.push(
        `failedPaymentAttempts: ${subscription.failedPaymentAttempts} → 0`
      );
      subscription.failedPaymentAttempts = 0;
    }

    if (changes.length === 0) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.ADMIN_OVERRIDE_NO_CHANGES);
    }

    this.appendHistory(
      subscription,
      'admin_override',
      input.adminId,
      `[ADMIN] ${input.reason} — Changes: ${changes.join(', ')}`
    );

    await this.em.flush();

    return createServiceResponse(
      200,
      'Admin override applied successfully',
      true,
      {
        subscription,
        changes,
      }
    );
  }

  /**
   * Fuerza la renovación de una suscripción activa ahora mismo.
   */
  public async forceRenewal(
    subscriptionId: string,
    adminId: string,
    requesterCompanyId?: string
  ): Promise<ServiceResponse> {
    const subscription = await this.em.findOne(
      Subscription,
      { id: subscriptionId },
      { populate: ['user', 'plan', 'customer', 'defaultPaymentMethod'] }
    );

    if (!subscription) throw new NotFoundError('Subscription');
    this.assertBelongsToCompany(subscription, requesterCompanyId);

    const validStatuses = [
      SubscriptionStatus.ACTIVE,
      SubscriptionStatus.PAST_DUE,
      SubscriptionStatus.UNPAID,
    ];

    if (!validStatuses.includes(subscription.status)) {
      throw new BadRequestError(
        `Cannot force renewal on a subscription with status "${subscription.status}"`
      );
    }

    this.appendHistory(
      subscription,
      'force_renewal',
      adminId,
      'Admin forced immediate renewal'
    );

    await this.em.flush();
    await this.attemptCharge(subscription);
    await this.em.refresh(subscription);

    const success = subscription.status === SubscriptionStatus.ACTIVE;

    return createServiceResponse(
      success ? 200 : 402,
      success ? 'Renewal successful' : 'Renewal charge failed',
      success,
      { subscription }
    );
  }

  /**
   * Extiende el período actual de una suscripción añadiendo días gratuitos.
   */
  public async extendPeriod(
    subscriptionId: string,
    days: number,
    adminId: string,
    reason: string,
    requesterCompanyId?: string
  ): Promise<ServiceResponse> {
    if (!days || days <= 0) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.DAYS_MUST_BE_POSITIVE);
    }
    if (!reason) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.REASON_REQUIRED);
    }

    const subscription = await this.em.findOne(
      Subscription,
      { id: subscriptionId },
      { populate: ['plan', 'user', 'customer', 'defaultPaymentMethod'] }
    );

    if (!subscription) throw new NotFoundError('Subscription');
    this.assertBelongsToCompany(subscription, requesterCompanyId);

    const oldEnd = subscription.currentPeriodEnd ?? new Date();
    const newEnd = this.addDays(oldEnd, days);

    subscription.currentPeriodEnd = newEnd;
    subscription.nextBillingDate = newEnd;

    this.appendHistory(
      subscription,
      'period_extended',
      adminId,
      `[ADMIN] Period extended by ${days} days. New end: ${newEnd.toISOString()}. Reason: ${reason}`
    );

    await this.em.flush();

    return createServiceResponse(200, `Period extended by ${days} days`, true, {
      subscription,
    });
  }

  /**
   * Aplica un crédito al siguiente cobro de una suscripción.
   */
  public async applyCredit(
    subscriptionId: string,
    amountInCents: number,
    adminId: string,
    reason: string,
    requesterCompanyId?: string
  ): Promise<ServiceResponse> {
    if (!amountInCents || amountInCents <= 0) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.CREDIT_AMOUNT_POSITIVE);
    }
    if (!reason) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.REASON_REQUIRED);
    }

    const subscription = await this.em.findOne(
      Subscription,
      { id: subscriptionId },
      { populate: ['plan'] }
    );

    if (!subscription) throw new NotFoundError('Subscription');
    this.assertBelongsToCompany(subscription, requesterCompanyId);

    if (amountInCents > subscription.plan.amount) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.CREDIT_EXCEED_PLAN);
    }

    const existing = subscription.metadata?.pendingCredit ?? 0;
    subscription.metadata = {
      ...subscription.metadata,
      pendingCredit: existing + amountInCents,
      pendingCreditReason: reason,
    };

    this.appendHistory(
      subscription,
      'credit_applied',
      adminId,
      `[ADMIN] Credit of ${amountInCents} cents applied. Reason: ${reason}`
    );

    await this.em.flush();

    return createServiceResponse(
      200,
      `Credit of ${(amountInCents / 100).toFixed(2)} applied to next billing`,
      true,
      { subscription }
    );
  }

  public async getSubscription(
    subscriptionId: string,
    requesterCompanyId?: string
  ): Promise<ServiceResponse> {
    if (!subscriptionId)
      throw new BadRequestError(BAD_REQUEST_ERRORS.SUBSCRIPTION_ID_REQUIRED);

    const subscription = await this.em.findOne(
      Subscription,
      { id: subscriptionId },
      { populate: ['user', 'plan', 'customer', 'defaultPaymentMethod'] }
    );

    if (!subscription) throw new NotFoundError('Subscription');
    this.assertBelongsToCompany(subscription, requesterCompanyId);

    return createServiceResponse(
      200,
      'Subscription fetched successfully',
      true,
      {
        subscription,
      }
    );
  }

  public async listUserSubscriptions(userId: string): Promise<ServiceResponse> {
    if (!userId) throw new BadRequestError(BAD_REQUEST_ERRORS.USER_ID_REQUIRED);

    const user = await this.em.findOne(User, { id: userId });
    if (!user) throw new NotFoundError('User');

    const subscriptions = await this.em.find(Subscription, { user }, {
      populate: ['plan', 'defaultPaymentMethod'],
      orderBy: { created_at: QueryOrder.DESC },
    } as any);

    return createServiceResponse(
      200,
      'Subscriptions fetched successfully',
      true,
      {
        subscriptions,
      }
    );
  }

  public async getActiveSubscription(userId: string): Promise<ServiceResponse> {
    if (!userId) throw new BadRequestError(BAD_REQUEST_ERRORS.USER_ID_REQUIRED);

    const user = await this.em.findOne(User, { id: userId });
    if (!user) throw new NotFoundError('User');

    const activeSubscriptions = await this.em.find(
      Subscription,
      {
        user,
        status: {
          $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
      },
      {
        populate: ['plan', 'defaultPaymentMethod'],
        orderBy: { currentPeriodStart: QueryOrder.ASC },
      } as any
    );

    const activeSubscription = activeSubscriptions[0] ?? null;

    return createServiceResponse(
      200,
      'Active subscription fetched successfully',
      true,
      {
        subscription: activeSubscription,
        subscriptions: activeSubscriptions,
      }
    );
  }

  /**
   * Devuelve el audit log de cambios de estado de una suscripción.
   */
  public async getSubscriptionHistory(
    subscriptionId: string
  ): Promise<ServiceResponse> {
    const subscription = await this.em.findOne(Subscription, {
      id: subscriptionId,
    });

    if (!subscription) throw new NotFoundError('Subscription');

    const history = subscription.metadata?.history ?? [];

    return createServiceResponse(200, 'History fetched successfully', true, {
      history,
    });
  }

  public async getSubscriptionsStats(
    currentUser: CurrentUser
  ): Promise<ServiceResponse> {
    if (!currentUser) throw new UnauthorizedError();

    try {
      const subscriptions = await this.em
        .getRepository(Subscription)
        .find(
          { status: SubscriptionStatus.ACTIVE },
          { fields: ['plan.id', 'plan.name'] }
        );

      const grouped = new Map<string, { planName: string; count: number }>();

      for (const sub of subscriptions) {
        const plan = sub.plan;
        if (!plan) continue;
        const existing = grouped.get(plan.id);
        if (existing) {
          existing.count += 1;
        } else {
          grouped.set(plan.id, { planName: plan.name, count: 1 });
        }
      }

      const stats = Array.from(grouped.entries()).map(([planId, data]) => ({
        planId,
        planName: data.planName,
        count: data.count,
      }));

      return createServiceResponse(200, 'Stats calculated successfully', true, {
        stats,
      });
    } catch (error: any) {
      console.error(error);
      throw new InternalServerError(INTERNAL_ERRORS.ERROR_CALCULATING_STATS);
    }
  }

  /**
   * Punto de entrada del CRON de billing — ejecutar una vez al día (02:00 UTC).
   */
  public async processBillingCycle(): Promise<void> {
    console.log('[CRON] processBillingCycle — start');
    const now = moment().toDate();

    const pendingCancellations = await this.em.find(
      Subscription,
      {
        cancelAtPeriodEnd: true,
        currentPeriodEnd: { $lte: now },
      },
      { populate: ['user'] }
    );

    console.log(`[CRON] ${pendingCancellations.length} deferred cancellations`);
    for (const sub of pendingCancellations) {
      this.applyCanceledTransition(sub, now);
      this.appendHistory(
        sub,
        'canceled',
        'system',
        'Canceled at period end (scheduled)'
      );
    }

    if (pendingCancellations.length > 0) {
      await this.em.flush();
    }

    const expiringTrials = await this.em.find(
      Subscription,
      {
        status: SubscriptionStatus.TRIALING,
        trialEnd: { $lte: now },
      },
      { populate: ['user', 'plan', 'customer', 'defaultPaymentMethod'] }
    );

    console.log(`[CRON] ${expiringTrials.length} trials expiring`);
    for (const sub of expiringTrials) {
      await this.transitionTrialToActive(sub);
    }

    const dueSubscriptions = await this.em.find(
      Subscription,
      {
        status: SubscriptionStatus.ACTIVE,
        nextBillingDate: { $lte: now },
        // plan: { amount: { $gt: 0 } },
      },
      { populate: ['user', 'plan', 'customer', 'defaultPaymentMethod'] }
    );

    console.log(
      `[CRON] ${dueSubscriptions.length} subscriptions due for renewal`
    );
    for (const sub of dueSubscriptions) {
      await this.attemptCharge(sub);
    }

    console.log('[CRON] processBillingCycle — done');
  }

  /**
   * Notifica a los usuarios cuya suscripción vence mañana.
   */
  public async notifyExpiringSubscriptions(): Promise<number> {
    const tomorrow = moment().add(1, 'days');
    const from = tomorrow.clone().startOf('day').toDate();
    const to = tomorrow.clone().endOf('day').toDate();

    const expiringSubscriptions = await this.em.find(
      Subscription,
      {
        status: SubscriptionStatus.ACTIVE,
        endedAt: { $gte: from, $lte: to },
      },
      { populate: ['user', 'user.pushTokens'], filters: false }
    );

    if (!expiringSubscriptions.length) {
      console.log('[CRON] No subscriptions expiring tomorrow');
      return 0;
    }

    console.log(
      `[CRON] Notifying ${expiringSubscriptions.length} expiring subscriptions`
    );

    await Promise.allSettled(
      expiringSubscriptions.map(sub => this.notifyUser(sub))
    );
    return expiringSubscriptions.length;
  }

  // ═══════════════════════════════════════════
  // OPERACIONES DE ADMIN
  // ═══════════════════════════════════════════

  /**
   * Caso 1 y 2: el usuario ya tiene una suscripción activa relevante.
   * Si es al mismo plan, es un conflicto real. Si es a otro plan de la
   * misma empresa, se trata como cambio de plan (sin prorrateo, ya que
   * createSubscription no expone ese parámetro al frontend — para
   * prorratear explícitamente, el frontend debe llamar a changePlan).
   */
  private isUnusedFutureSubscription(subscription: Subscription): boolean {
    const now = moment();
    const currentStart = moment(subscription.currentPeriodStart);
    return now.isBefore(currentStart, 'day');
  }

  private async updateFutureSubscriptionDate(
    subscription: Subscription,
    newPlan: Plan,
    newStartDate?: string | Date
  ): Promise<void> {
    const newStart = newStartDate
      ? moment(newStartDate).startOf('day')
      : moment().startOf('day');
    const newStartJS = newStart.toDate();
    const newEndJS = this.calculatePeriodEnd(newStartJS, newPlan);

    subscription.currentPeriodStart = newStartJS;
    subscription.currentPeriodEnd = newEndJS;
    subscription.nextBillingDate = newEndJS;

    if (subscription.trialStart && subscription.trialEnd) {
      const trialDays = moment(subscription.trialEnd).diff(
        moment(subscription.trialStart),
        'days'
      );
      subscription.trialStart = newStartJS;
      subscription.trialEnd = this.addDays(newStartJS, trialDays);
      subscription.currentPeriodEnd = subscription.trialEnd;
      subscription.nextBillingDate = subscription.trialEnd;
    }

    await this.em.flush();
  }

  private async resolveExistingActiveSubscription(
    activeSubscription: Subscription,
    newPlan: Plan,
    input: CreateSubscriptionInput
  ): Promise<ServiceResponse> {
    if (activeSubscription.plan.id === newPlan.id) {
      if (this.isUnusedFutureSubscription(activeSubscription)) {
        await this.updateFutureSubscriptionDate(
          activeSubscription,
          newPlan,
          input.startDate
        );

        return createServiceResponse(
          200,
          'Subscription start date updated successfully',
          true,
          { subscription: activeSubscription }
        );
      }

      throw new ConflictError(CONFLICT_ERRORS.USER_ALREADY_ACTIVE_IN_PLAN);
    }

    return this.executePlanChange(activeSubscription, newPlan, false);
  }

  /**
   * Caso 3: no hay nada que sustituir ni cambiar — se crea la suscripción
   * desde cero, con o sin trial según el plan.
   */
  private async createSubscriptionFromScratch(
    user: User,
    plan: Plan,
    input: CreateSubscriptionInput
  ): Promise<ServiceResponse> {
    const customer = await this.customerService.getOrCreateCustomer(user);
    const billingCompanyId = this.resolveBillingCompanyId(
      plan,
      input.companyId
    );

    const paymentMethod = input.paymentMethodId
      ? await this.getPaymentMethodOrFail(input.paymentMethodId, customer)
      : await this.getDefaultPaymentMethod(customer);

    // Un Session Pack nunca lleva trial, venga de donde venga el valor.
    const trialDays = this.isSessionPack(plan)
      ? 0
      : (input.trialPeriodDays ?? plan.trialPeriodDays ?? 0);
    const now = moment().startOf('day').toDate();
    const baseStart = input.startDate
      ? moment(input.startDate).startOf('day').toDate()
      : now;
    const isTrialing = trialDays > 0;

    const trialStart = isTrialing ? baseStart : undefined;
    const trialEnd = isTrialing
      ? this.addDays(baseStart, trialDays)
      : undefined;
    const periodEnd = isTrialing
      ? trialEnd!
      : this.calculatePeriodEnd(baseStart, plan);

    const subscription = this.em.create(Subscription, {
      user,
      customer,
      plan,
      defaultPaymentMethod: paymentMethod ?? undefined,
      company: billingCompanyId,
      status: isTrialing
        ? SubscriptionStatus.TRIALING
        : SubscriptionStatus.INCOMPLETE,
      currentPeriodStart: baseStart,
      currentPeriodEnd: periodEnd,
      trialStart,
      trialEnd,
      nextBillingDate: periodEnd,
      quantity: input.quantity ?? 1,
      failedPaymentAttempts: 0,
      ...this.buildCreditSnapshot(plan),
      // TEMPORAL: toda suscripcion nueva nace marcada para cancelarse al
      // terminar su periodo actual. El CRON (processBillingCycle) ya
      // respeta este flag y la pasara a CANCELED en cuanto currentPeriodEnd
      // se cumpla, sin renovacion automatica. Pendiente: cuando se
      // implemente el flujo de renovacion real en produccion, este valor
      // dejara de ser fijo y pasara a depender de la decision del usuario
      // (ej. un toggle de "renovacion automatica" en el input).
      // EXCEPCION PERMANENTE: un Session Pack nunca se auto-renueva, asi que
      // para packs este flag seguira siendo true aunque llegue ese toggle.
      cancelAtPeriodEnd: true,
      metadata: {
        ...input.metadata,
        history: [
          this.buildHistoryEntry('created', 'system', 'Subscription created'),
        ],
      },
    });

    this.em.persist(subscription);
    await this.em.flush();

    if (!isTrialing) {
      await this.attemptCharge(subscription);
    }

    return createServiceResponse(
      201,
      'Subscription created successfully',
      true,
      { subscription }
    );
  }

  /**
   * Suscripción Retroactiva (imagen especular de la Suscripción Futura):
   * plan gratuito con fecha de inicio en el pasado. Modela una membresía en
   * efectivo/manual que el admin liquida fuera de la plataforma y registra
   * desde el día en que el miembro empezó a usar el gym.
   *
   * Se crea ACTIVE con las fechas retroactivas y SIN pasar por attemptCharge:
   *  - No hay nada que cobrar en un plan gratuito.
   *  - Evita el reset de fechas a hoy de la ruta de cobro (los días ya usados
   *    los absorbe el miembro: su período termina antes, no se le regalan).
   *
   * La validez del período (que aún no haya transcurrido entero) ya la
   * garantizó validateStartDateForPlan(). Aquí solo queda la comprobación de
   * colisión con otra entitlement activa del mismo usuario+empresa.
   */
  private async createBackdatedSubscription(
    user: User,
    plan: Plan,
    input: CreateSubscriptionInput
  ): Promise<ServiceResponse> {
    const backdatedStart = moment(input.startDate).startOf('day').toDate();
    const periodEnd = this.calculatePeriodEnd(backdatedStart, plan);
    // input.companyId es obligatorio (validateCreateInput) y resolveBilling
    // devuelve como mínimo ese valor, así que la empresa siempre está resuelta.
    const billingCompanyId =
      this.resolveBillingCompanyId(plan, input.companyId) ?? input.companyId;

    await this.assertNoOverlappingEntitlement(
      user,
      billingCompanyId,
      backdatedStart,
      periodEnd
    );

    const customer = await this.customerService.getOrCreateCustomer(user);

    const subscription = this.em.create(Subscription, {
      user,
      customer,
      plan,
      company: billingCompanyId,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: backdatedStart,
      currentPeriodEnd: periodEnd,
      nextBillingDate: periodEnd,
      quantity: input.quantity ?? 1,
      failedPaymentAttempts: 0,
      ...this.buildCreditSnapshot(plan),
      // Misma regla TEMPORAL que createSubscriptionFromScratch: nace marcada
      // para cancelarse al terminar su período; el CRON la pasará a CANCELED
      // cuando currentPeriodEnd venza. (Para packs, permanente: nunca renuevan.)
      cancelAtPeriodEnd: true,
      metadata: {
        ...input.metadata,
        backdated: true,
        history: [
          this.buildHistoryEntry(
            'backdated_cash',
            'system',
            `Backdated (cash/manual) subscription created. ` +
              `Backdated start ${moment(backdatedStart).format('YYYY-MM-DD')}, ` +
              `period ends ${moment(periodEnd).format('YYYY-MM-DD')}.`
          ),
        ],
      },
    });

    this.em.persist(subscription);
    await this.em.flush();

    return createServiceResponse(
      201,
      'Backdated subscription created successfully',
      true,
      { subscription }
    );
  }

  /**
   * Rechaza el backdating si existe alguna suscripción del mismo
   * usuario+empresa en estado ACTIVE/TRIALING/PAST_DUE/PAUSED cuyo período
   * pagado [currentPeriodStart, currentPeriodEnd] se solape con el span
   * completo de la nueva [start, end] (cola pasada y futura). Una suscripción
   * CANCELED nunca bloquea (un miembro que renunció puede rellenar el hueco).
   *
   * Dos intervalos [a1,a2] y [b1,b2] se solapan sii a1 <= b2 && b1 <= a2.
   */
  private async assertNoOverlappingEntitlement(
    user: User,
    companyId: string,
    newStart: Date,
    newEnd: Date
  ): Promise<void> {
    const overlapping = await this.em.findOne(Subscription, {
      user,
      company: companyId,
      status: {
        $in: [
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.TRIALING,
          SubscriptionStatus.PAST_DUE,
          SubscriptionStatus.PAUSED,
        ],
      },
      currentPeriodStart: { $lte: newEnd },
      currentPeriodEnd: { $gte: newStart },
    });

    if (overlapping) {
      throw new ConflictError(
        CONFLICT_ERRORS.BACKDATED_OVERLAPS_EXISTING_ENTITLEMENT
      );
    }
  }

  /**
   * Núcleo del cambio de plan, sin resolución de IDs: recibe la
   * Subscription y el Plan ya cargados.
   *
   * Reutilizado por:
   *  - changePlan() — cuando el frontend pide explícitamente un cambio
   *  - createSubscription() — cuando detecta que el usuario ya tiene esta
   *    suscripción activa a otro plan de la misma empresa y, en vez de
   *    crear una segunda entidad, debe migrar la existente con prorrateo.
   *
   * Dividido en pasos privados con nombre propio para mantener la
   * complejidad cognitiva baja.
   */
  private async executePlanChange(
    subscription: Subscription,
    newPlan: Plan,
    prorate?: boolean
  ): Promise<ServiceResponse> {
    const oldPlan = subscription.plan;
    const now = new Date();

    // No hay prorrateo con sentido entre días y créditos: un cambio hacia o
    // desde un Session Pack se rechaza siempre. La ruta correcta es
    // cancelación diferida + Suscripción Futura con el nuevo plan.
    if (this.isSessionPack(oldPlan) || this.isSessionPack(newPlan)) {
      throw new BadRequestError(
        BAD_REQUEST_ERRORS.CANNOT_CHANGE_PLAN_WITH_SESSION_PACK
      );
    }

    if (prorate) {
      await this.applyPlanChangeProration(subscription, oldPlan, newPlan, now);
    }

    this.applyNewPlanToSubscription(subscription, newPlan, now);

    this.appendHistory(
      subscription,
      'plan_changed',
      'user',
      `Plan changed from "${oldPlan.name}" to "${newPlan.name}"${
        prorate ? ' with proration' : ''
      }`
    );

    await this.em.flush();

    return createServiceResponse(200, 'Plan changed successfully', true, {
      subscription,
    });
  }

  // ═══════════════════════════════════════════
  // LECTURA
  // ═══════════════════════════════════════════

  /**
   * Resuelve y valida la suscripción y el plan nuevo para changePlan.
   * Agrupa las cuatro validaciones de entrada en un solo paso.
   */
  private async resolveChangePlanTargets(
    input: ChangePlanInput
  ): Promise<{ subscription: Subscription; newPlan: Plan }> {
    if (!input.subscriptionId || !input.newPlanId) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.SUB_AND_PLAN_REQUIRED);
    }

    const subscription = await this.em.findOne(
      Subscription,
      { id: input.subscriptionId },
      { populate: ['user', 'plan', 'customer', 'defaultPaymentMethod'] }
    );

    if (!subscription) throw new NotFoundError('Subscription');
    if (!subscription.isActive) {
      throw new BadRequestError(
        BAD_REQUEST_ERRORS.ONLY_ACTIVE_OR_TRIAL_CAN_CHANGE_PLAN
      );
    }

    const newPlan = await this.em.findOne(
      Plan,
      { id: input.newPlanId, isActive: true },
      { filters: { companyContext: false }, populate: ['company'] }
    );

    if (!newPlan) throw new NotFoundError('New plan not found or inactive');
    if (newPlan.id === subscription.plan.id) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.NEW_PLAN_SAME_AS_CURRENT);
    }

    return { subscription, newPlan };
  }

  /**
   * Calcula la fracción de período restante y la diferencia prorrateada
   * entre el plan viejo y el nuevo en el instante `now`.
   */
  private calculateProration(
    subscription: Subscription,
    oldPlan: Plan,
    newPlan: Plan,
    now: Date
  ): { fractionRemaining: number; proratedDiff: number } | null {
    if (!subscription.currentPeriodStart || !subscription.currentPeriodEnd) {
      return null;
    }

    const periodTotal =
      subscription.currentPeriodEnd.getTime() -
      subscription.currentPeriodStart.getTime();
    const periodElapsed =
      now.getTime() - subscription.currentPeriodStart.getTime();
    const periodRemaining = Math.max(0, periodTotal - periodElapsed);
    const fractionRemaining = periodRemaining / periodTotal;

    const oldPlanCredit = Math.round(oldPlan.amount * fractionRemaining);
    const newPlanCharge = Math.round(newPlan.amount * fractionRemaining);

    return {
      fractionRemaining,
      proratedDiff: newPlanCharge - oldPlanCredit,
    };
  }

  /**
   * Orquesta el prorrateo: si es upgrade cobra la diferencia ahora, si es
   * downgrade acredita la diferencia para el siguiente cobro.
   * No hace nada si no se puede calcular el prorrateo (faltan fechas de
   * período) o si la diferencia es cero.
   */
  private async applyPlanChangeProration(
    subscription: Subscription,
    oldPlan: Plan,
    newPlan: Plan,
    now: Date
  ): Promise<void> {
    const proration = this.calculateProration(
      subscription,
      oldPlan,
      newPlan,
      now
    );
    if (!proration) return;

    const { proratedDiff, fractionRemaining } = proration;

    if (proratedDiff > 0) {
      await this.chargePlanUpgradeProration(
        subscription,
        oldPlan,
        newPlan,
        proratedDiff,
        fractionRemaining,
        now
      );
    } else if (proratedDiff < 0) {
      this.creditPlanDowngradeProration(
        subscription,
        oldPlan,
        newPlan,
        proratedDiff
      );
    }
  }

  /**
   * Cobra la diferencia prorrateada de un upgrade: crea la Invoice, ejecuta
   * el cargo, y la marca pagada o la anula según el resultado.
   * Si no hay métdo de pago válido, no hace nada (el plan se aplicará sin
   * cobro retroactivo — comportamiento previo conservado).
   */
  private async chargePlanUpgradeProration(
    subscription: Subscription,
    oldPlan: Plan,
    newPlan: Plan,
    proratedDiff: number,
    fractionRemaining: number,
    now: Date
  ): Promise<void> {
    const pm = subscription.defaultPaymentMethod;
    const isPaymentMethodReady =
      !!pm?.externalToken && pm?.status === PaymentMethodStatus.ACTIVE;
    if (!isPaymentMethodReady) {
      return;
    }

    const description = `Plan upgrade proration: ${oldPlan.name} → ${newPlan.name}`;
    const companyId = this.extractCompanyId(subscription.company);

    const prorationInvoice = await this.invoiceService.createInvoice({
      userId: subscription.user.id,
      subscriptionId: subscription.id,
      subtotal: proratedDiff,
      currency: newPlan.currency,
      dueDate: now,
      description,
      lineItems: [
        {
          description: `Prorated upgrade from "${oldPlan.name}" to "${newPlan.name}"`,
          amount: proratedDiff,
          currency: newPlan.currency,
          fractionRemaining,
        },
      ],
      companyId,
    });

    const chargeResult = await this.transactionService.createCharge({
      userId: subscription.user.id,
      amount: proratedDiff,
      currency: newPlan.currency,
      paymentMethodId: pm.id,
      invoiceId: prorationInvoice.id,
      subscriptionId: subscription.id,
      description,
      companyId,
    });

    const { transaction } = chargeResult.data as {
      transaction?: { status?: string };
    };

    if (transaction?.status !== 'succeeded') {
      await this.invoiceService.voidInvoice(prorationInvoice.id);
      throw new BadRequestError(BAD_REQUEST_ERRORS.PRORATION_CHARGE_FAILED);
    }

    await this.invoiceService.markAsPaid(prorationInvoice.id, now);
  }

  /**
   * Acredita en metadata.pendingCredit la diferencia de un downgrade, para
   * descontarla del siguiente cobro de renovación.
   */
  private creditPlanDowngradeProration(
    subscription: Subscription,
    oldPlan: Plan,
    newPlan: Plan,
    proratedDiff: number
  ): void {
    const credit = Math.abs(proratedDiff);
    subscription.metadata = {
      ...subscription.metadata,
      pendingCredit: (subscription.metadata?.pendingCredit ?? 0) + credit,
      pendingCreditReason: `Plan downgrade: ${oldPlan.name} → ${newPlan.name}`,
    };
  }

  // ═══════════════════════════════════════════
  // CRON: CICLO DE FACTURACIÓN
  // ═══════════════════════════════════════════

  /**
   * Aplica el nuevo plan a la suscripción y recalcula su período/próximo cobro.
   */
  private applyNewPlanToSubscription(
    subscription: Subscription,
    newPlan: Plan,
    now: Date
  ): void {
    subscription.plan = newPlan;
    subscription.currentPeriodEnd = this.calculatePeriodEnd(
      subscription.currentPeriodStart ?? now,
      newPlan
    );
    subscription.nextBillingDate = subscription.currentPeriodEnd;
  }

  // ═══════════════════════════════════════════
  // LÓGICA DE COBRO Y DUNNING
  // ═══════════════════════════════════════════

  private async attemptCharge(subscription: Subscription): Promise<void> {
    const now = moment().startOf('day').toDate();
    const isFuture =
      subscription.currentPeriodStart && subscription.currentPeriodStart > now;

    if (subscription.plan.amount === 0) {
      subscription.status = SubscriptionStatus.ACTIVE;
      // Endurecemos el guard: no reescribimos las fechas a hoy salvo que el
      // período empiece HOY. Antes se reescribía en todo lo "no futuro", lo
      // que aplastaba las fechas de una Suscripción Retroactiva (inicio
      // pasado) si llegaba hasta aquí. Defensivo: la ruta dedicada de
      // backdating ni siquiera invoca attemptCharge.
      const startsToday =
        !subscription.currentPeriodStart ||
        moment(subscription.currentPeriodStart).isSame(now, 'day');
      if (startsToday) {
        subscription.currentPeriodStart = now;
        subscription.currentPeriodEnd = this.calculatePeriodEnd(
          now,
          subscription.plan
        );
        subscription.nextBillingDate = subscription.currentPeriodEnd;
      }
      this.appendHistory(
        subscription,
        'renewed',
        'system',
        'Free plan — no charge required'
      );
      await this.em.flush();
      return;
    }

    let invoice: Invoice;
    try {
      invoice = await this.invoiceService.createForSubscription(subscription);
    } catch (err: any) {
      console.error(
        `[Billing] Could not create invoice for subscription ${subscription.id}:`,
        err.message
      );
      return;
    }

    const pm = subscription.defaultPaymentMethod;

    if (!pm?.externalToken || pm.status !== PaymentMethodStatus.ACTIVE) {
      console.warn(
        `[Billing] Subscription ${subscription.id} has no valid payment method`
      );
      await this.handleFailedPayment(subscription, invoice);
      return;
    }

    const pendingCredit: number = subscription.metadata?.pendingCredit ?? 0;
    const baseAmount = subscription.plan.amount;
    const chargeAmount = Math.max(0, baseAmount - pendingCredit);

    if (chargeAmount === 0) {
      await this.invoiceService.markAsPaid(invoice.id, now);

      subscription.status = SubscriptionStatus.ACTIVE;
      if (!isFuture) {
        subscription.currentPeriodStart = now;
        subscription.currentPeriodEnd = this.calculatePeriodEnd(
          now,
          subscription.plan
        );
        subscription.nextBillingDate = subscription.currentPeriodEnd;
      }
      subscription.failedPaymentAttempts = 0;
      subscription.metadata = {
        ...subscription.metadata,
        pendingCredit: 0,
        pendingCreditReason: undefined,
      };

      this.appendHistory(
        subscription,
        'renewed',
        'system',
        'Renewed using pending credit (no charge)'
      );
      await this.em.flush();
      return;
    }

    const chargeResponse = await this.transactionService.createCharge({
      userId: subscription.user.id,
      amount: chargeAmount,
      currency: subscription.plan.currency,
      paymentMethodId: pm.id,
      invoiceId: invoice.id,
      subscriptionId: subscription.id,
      description: `Renewal — ${subscription.plan.name}`,
      companyId: this.extractCompanyId(subscription.company),
    });

    const { transaction } = chargeResponse as {
      transaction?: { status?: string };
    };

    if (transaction?.status === 'succeeded') {
      await this.invoiceService.markAsPaid(invoice.id, now);

      subscription.status = SubscriptionStatus.ACTIVE;
      if (!isFuture) {
        subscription.currentPeriodStart = now;
        subscription.currentPeriodEnd = this.calculatePeriodEnd(
          now,
          subscription.plan
        );
        subscription.nextBillingDate = subscription.currentPeriodEnd;
      }
      subscription.failedPaymentAttempts = 0;

      if (pendingCredit > 0) {
        subscription.metadata = {
          ...subscription.metadata,
          pendingCredit: 0,
          pendingCreditReason: undefined,
        };
      }

      this.appendHistory(
        subscription,
        'renewed',
        'system',
        `Renewed successfully. Charged: ${chargeAmount} cents`
      );
      await this.em.flush();

      console.log(
        `[Billing] Subscription ${subscription.id} renewed successfully`
      );
    } else {
      await this.handleFailedPayment(subscription, invoice);
    }
  }

  private async handleFailedPayment(
    subscription: Subscription,
    _invoice: Invoice
  ): Promise<void> {
    subscription.failedPaymentAttempts += 1;

    const attempt = subscription.failedPaymentAttempts;
    const { maxAttempts, retryIntervalDays } = DUNNING_CONFIG;

    if (attempt >= maxAttempts) {
      subscription.status = SubscriptionStatus.PAST_DUE;
      subscription.nextBillingDate = undefined;

      this.appendHistory(
        subscription,
        'past_due',
        'system',
        `Moved to PAST_DUE after ${attempt} failed payment attempts`
      );

      console.warn(
        `[Billing] Subscription ${subscription.id} → PAST_DUE after ${attempt} attempts`
      );

      await this.notifyPaymentFailed(subscription);
    } else {
      const daysUntilRetry =
        retryIntervalDays[attempt - 1] ?? retryIntervalDays.at(-1)!;

      subscription.nextBillingDate = this.addDays(new Date(), daysUntilRetry);

      this.appendHistory(
        subscription,
        'payment_failed',
        'system',
        `Payment attempt ${attempt}/${maxAttempts} failed. Next retry in ${daysUntilRetry} days`
      );

      console.warn(
        `[Billing] Subscription ${subscription.id} charge failed ` +
          `(attempt ${attempt}/${maxAttempts}). Next retry in ${daysUntilRetry} days`
      );
    }

    await this.em.flush();
  }

  private async transitionTrialToActive(
    subscription: Subscription
  ): Promise<void> {
    const now = new Date();
    const isFree = subscription.plan.amount === 0;
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = this.calculatePeriodEnd(
      now,
      subscription.plan
    );
    subscription.failedPaymentAttempts = 0;
    subscription.nextBillingDate = subscription.currentPeriodEnd;

    this.appendHistory(
      subscription,
      'trial_ended',
      'system',
      'Trial period ended — transitioning to active'
    );

    await this.em.flush();

    if (isFree) {
      console.log(
        `[Billing] Trial ended for free subscription ${subscription.id}. No charge needed.`
      );
    } else {
      console.log(
        `[Billing] Trial ended for subscription ${subscription.id}. Attempting first charge.`
      );
      await this.attemptCharge(subscription);
    }
  }

  // ═══════════════════════════════════════════
  // AUDIT LOG
  // ═══════════════════════════════════════════

  /**
   * Transición común a CANCELED que comparten las dos únicas rutas vivas: el
   * CRON de billing (cancelación diferida) y la cancelación radical de admin.
   * Fija el estado y las fechas de cancelación/fin y limpia el próximo cobro.
   * Cada llamador añade su propia entrada de historial, y la ruta radical trunca
   * además currentPeriodEnd = now. Ver ADR 0003.
   */
  private applyCanceledTransition(subscription: Subscription, now: Date): void {
    subscription.status = SubscriptionStatus.CANCELED;
    subscription.canceledAt = now;
    subscription.endedAt = now;
    subscription.nextBillingDate = undefined;
  }

  private appendHistory(
    subscription: Subscription,
    event: string,
    actor: string,
    detail: string
  ): void {
    const entry = this.buildHistoryEntry(event, actor, detail);
    const current: any[] = subscription.metadata?.history ?? [];
    subscription.metadata = {
      ...subscription.metadata,
      history: [...current, entry],
    };
  }

  private buildHistoryEntry(
    event: string,
    actor: string,
    detail: string
  ): Record<string, any> {
    return {
      event,
      actor,
      detail,
      timestamp: new Date().toISOString(),
    };
  }

  // ═══════════════════════════════════════════
  // HELPERS PRIVADOS
  // ═══════════════════════════════════════════

  private validateCreateInput(input: CreateSubscriptionInput): void {
    if (!input.userId || !input.planId || !input.companyId) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.REQUIRED_FIELDS);
    }
    if (input.quantity !== undefined && input.quantity <= 0) {
      throw new BadRequestError(
        BAD_REQUEST_ERRORS.QUANTITY_MUST_BE_GREATER_THAN_0
      );
    }
    if (input.trialPeriodDays !== undefined && input.trialPeriodDays < 0) {
      throw new BadRequestError(BAD_REQUEST_ERRORS.TRIAL_PERIOD_NEGATIVE);
    }
    if (input.startDate) {
      const start = moment(input.startDate);
      if (!start.isValid()) {
        throw new BadRequestError(BAD_REQUEST_ERRORS.INVALID_START_DATE);
      }
      // NOTA: la validación de "pasado/hoy/futuro" según el plan NO se hace
      // aquí — este validador corre antes de cargar el Plan y no puede ver
      // plan.amount. La autoridad única sobre la fecha de inicio es
      // validateStartDateForPlan(), que sí conoce el plan (backdating solo
      // se permite para planes gratuitos). Aquí solo validamos el formato.
    }
  }

  /**
   * Autoridad única sobre la fecha de inicio, ya con el Plan cargado (algo
   * que validateCreateInput no puede saber). Reglas:
   *
   *  - Plan de pago (amount > 0): SIEMPRE debe empezar hoy. Ni pasado ni
   *    futuro — el cobro es inmediato, no tiene sentido diferirlo ni
   *    retroactivarlo.
   *
   *  - Plan gratuito (amount === 0) con inicio en el PASADO → Suscripción
   *    Retroactiva. Permitida solo si el período resultante (calculado desde
   *    la fecha retroactiva) termina estrictamente después de hoy; si el
   *    período completo ya transcurrió, se rechaza.
   *
   *  - Plan gratuito con inicio hoy o en el futuro → sin cambios (el flujo
   *    de Suscripción Futura existente lo gestiona).
   *
   * La colisión con otras suscripciones activas NO se comprueba aquí — es
   * asíncrona y vive en la rama de backdating de createSubscription().
   */
  private validateStartDateForPlan(
    plan: Plan,
    startDate?: string | Date
  ): void {
    if (!startDate) return;

    const start = moment(startDate);
    const today = moment();

    if (plan.amount > 0) {
      if (!start.isSame(today, 'day')) {
        throw new BadRequestError(
          BAD_REQUEST_ERRORS.PAID_PLAN_MUST_START_TODAY
        );
      }
      return;
    }

    // Plan gratuito con inicio en el pasado: solo si aún queda período vivo.
    if (start.isBefore(today, 'day')) {
      const periodEnd = this.calculatePeriodEnd(
        moment(startDate).startOf('day').toDate(),
        plan
      );
      if (!moment(periodEnd).isAfter(today, 'day')) {
        throw new BadRequestError(
          BAD_REQUEST_ERRORS.BACKDATED_PERIOD_ALREADY_ELAPSED
        );
      }
    }
  }

  /**
   * ¿Esta petición es una Suscripción Retroactiva? Plan gratuito con fecha
   * de inicio en el pasado. La validez del período ya la garantizó
   * validateStartDateForPlan() antes de llegar aquí.
   */
  private isBackdatedFreeRequest(
    plan: Plan,
    startDate?: string | Date
  ): boolean {
    return (
      plan.amount === 0 &&
      !!startDate &&
      moment(startDate).isBefore(moment(), 'day')
    );
  }

  private async getUserOrFail(userId: string): Promise<User> {
    const user = await this.em.findOne(User, { id: userId });
    if (!user) throw new NotFoundError('User');
    return user;
  }

  private async getActivePlanOrFail(planId: string): Promise<Plan> {
    const plan = await this.em.findOne(
      Plan,
      { id: planId, isActive: true },
      { filters: { companyContext: false }, populate: ['company'] }
    );
    if (!plan) throw new NotFoundError('Plan not found or inactive');
    return plan;
  }

  /**
   * Extrae de forma segura el ID de una relacion ManyToOne sin importar si
   * llego populada (objeto con .id), como Reference sin inicializar de
   * MikroORM, o ya como string plano.
   *
   * Centraliza la logica que antes estaba duplicada (y rota) en 5 sitios
   * distintos como (entity.relation as any)?.id ?? entity.relation ??
   * undefined - ese patron fallaba silenciosamente cuando la relacion no
   * estaba populada, devolviendo undefined en vez del id real.
   */
  private extractCompanyId(relation: unknown): string | undefined {
    if (!relation) return undefined;
    if (typeof relation === 'string') return relation;
    if (typeof relation === 'object' && 'id' in (relation as any)) {
      return (relation as any).id as string;
    }
    const ref = relation as any;
    if (typeof ref.getEntity === 'function') {
      try {
        return ref.getEntity()?.id;
      } catch {
        // entidad no cargada en memoria - seguimos con el siguiente accesor
      }
    }
    if (typeof ref.unwrap === 'function') {
      return ref.unwrap()?.id;
    }
    return undefined;
  }

  /**
   * Resuelve a que empresa pertenece el cobro de una suscripcion.
   *
   * Regla: si el plan pertenece a una empresa (plan.company), esa empresa
   * es SIEMPRE la que debe recibir el dinero via Stripe Connect -
   * independientemente de cual sea la empresa activa del usuario que se
   * suscribe. Si el plan es global (sin empresa, plan.company es null),
   * se respeta el companyId recibido en el input.
   */
  private resolveBillingCompanyId(
    plan: Plan,
    inputCompanyId?: string
  ): string | undefined {
    const planCompanyId = this.extractCompanyId(plan.company);

    if (planCompanyId) {
      if (inputCompanyId && inputCompanyId !== planCompanyId) {
        console.warn(
          `[SubscriptionService] companyId mismatch: plan belongs to company ` +
            `${planCompanyId} but request came from company ${inputCompanyId}. ` +
            `Using the plan's company for billing.`
        );
      }
      return planCompanyId;
    }

    return inputCompanyId;
  }

  /**
   * Verifica que una suscripcion pertenece a la empresa activa del usuario
   * que esta intentando operarla.
   */
  private assertBelongsToCompany(
    subscription: Subscription,
    requesterCompanyId?: string
  ): void {
    if (!requesterCompanyId) return;

    const subscriptionCompanyId = this.extractCompanyId(subscription.company);

    if (!subscriptionCompanyId) return;

    if (subscriptionCompanyId !== requesterCompanyId) {
      throw new ForbiddenError(
        'This subscription does not belong to your active company'
      );
    }
  }

  /**
   * Busca si el usuario ya tiene una suscripcion ACTIVE/TRIALING relevante
   * para el plan que intenta crear, y decide que hacer con ella.
   *
   * - Plan SIN empresa (global): solo bloquea si es exactamente el mismo
   *   plan.
   * - Plan CON empresa: busca cualquier suscripcion activa o en trial en
   *   esa misma empresa, sin importar el plan exacto. Esto es lo que
   *   permite que createSubscription() la detecte y la trate como un
   *   cambio de plan en lugar de dejar coexistir dos membresias activas
   *   pagando a la vez en el mismo gym.
   *
   * IMPORTANTE: requiere que `plan` venga con 'company' populado (ver
   * getActivePlanOrFail) - de lo contrario planCompanyId sale undefined
   * y esta funcion compara por plan exacto en lugar de por empresa,
   * dejando pasar el bug que origino esta correccion.
   */
  private async findActiveAndFutureSubscriptions(
    user: User,
    plan: Plan
  ): Promise<Subscription[]> {
    const planCompanyId = this.extractCompanyId(plan.company);

    if (!planCompanyId) {
      return this.em.find(
        Subscription,
        {
          user,
          plan,
          status: {
            $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
          },
        },
        { populate: ['plan'] }
      );
    }

    return this.em.find(
      Subscription,
      {
        user,
        company: planCompanyId,
        status: {
          $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
      },
      { populate: ['user', 'customer', 'plan', 'defaultPaymentMethod'] }
    );
  }

  private async getPaymentMethodOrFail(
    paymentMethodId: string,
    customer: Customer
  ): Promise<PaymentMethod> {
    const pm = await this.em.findOne(PaymentMethod, {
      id: paymentMethodId,
      customer,
      status: PaymentMethodStatus.ACTIVE,
    });
    if (!pm) throw new NotFoundError('Payment method not found or inactive');
    return pm;
  }

  private async getDefaultPaymentMethod(
    customer: Customer
  ): Promise<PaymentMethod | null> {
    return this.em.findOne(PaymentMethod, {
      customer,
      isDefault: true,
      status: PaymentMethodStatus.ACTIVE,
    });
  }

  /** Un plan es Session Pack si tiene un nº finito de créditos. */
  private isSessionPack(plan: Plan): boolean {
    return plan.sessionCount !== null && plan.sessionCount !== undefined;
  }

  /**
   * Snapshot de créditos al crear una suscripción (ver CONTEXT.md → Session
   * Credit). Se copia `plan.sessionCount` para que editar el plan después no
   * altere los packs ya vendidos. null ⇒ ilimitado.
   */
  private buildCreditSnapshot(plan: Plan): {
    creditsTotal: number | null;
    creditsUsed: number;
  } {
    return {
      creditsTotal: plan.sessionCount ?? null,
      creditsUsed: 0,
    };
  }

  private calculatePeriodEnd(start: Date, plan: Plan): Date {
    const count = plan.intervalCount ?? 1;
    switch (plan.interval) {
      case PlanInterval.DAY:
        return this.addDays(start, count);
      case PlanInterval.WEEK:
        return this.addDays(start, count * 7);
      case PlanInterval.MONTH:
        return this.addMonths(start, count);
      case PlanInterval.YEAR:
        return this.addYears(start, count);
      default:
        return this.addMonths(start, 1);
    }
  }

  private async notifyUser(subscription: Subscription): Promise<void> {
    const { user } = subscription;
    const expiryDate = subscription.endedAt?.toLocaleDateString('es-ES', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });

    const config: EmailConfig = {
      from: process.env.GMAIL_USER!,
      to: user.email!,
      subject: 'Tu suscripción está a punto de vencer',
      html: sendSubscriptionExpiryWarning(
        expiryDate ?? moment().format('YYYY-MM-DD')
      ),
    };

    await Promise.allSettled([
      this.emailService.sendEmail(config),
      this.notificationService.sendToUser(
        user.id,
        '⚠️ Suscripción por vencer',
        `Tu suscripción vence el ${expiryDate}. Contacta con el administrador para renovarla.`
      ),
    ]);
  }

  private async notifyPaymentFailed(subscription: Subscription): Promise<void> {
    const { user } = subscription;

    const config: EmailConfig = {
      from: process.env.GMAIL_USER!,
      to: user.email!,
      subject: 'No hemos podido procesar tu pago',
      html: `<p>Hola ${user.name},</p>
             <p>No hemos podido cobrar la renovación de tu suscripción <strong>${subscription.plan.name}</strong>.</p>
             <p>Por favor actualiza tu método de pago para continuar disfrutando del servicio.</p>`,
    };

    await Promise.allSettled([
      this.emailService.sendEmail(config),
      this.notificationService.sendToUser(
        user.id,
        '❌ Pago fallido',
        'No hemos podido procesar el pago de tu suscripción. Actualiza tu método de pago.'
      ),
    ]);
  }
}
